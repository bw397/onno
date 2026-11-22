import { MemoryBackend, nodeSize, type StorageBackend } from "./backend";
import { byteLength, concat, toBytes, toText, type FileContent } from "./content";
import { basename, dirname, normalize } from "./path";
import { defaultSeed, type Seed } from "./seed";

export interface FileNode {
  type: "file";
  content: FileContent;
  /** Size in bytes (UTF-8 for text). */
  size: number;
  mtime: number;
}

export interface DirNode {
  type: "dir";
  mtime: number;
}

export type FsNode = FileNode | DirNode;

export type FsErrorCode = "ENOENT" | "ENOTDIR" | "EISDIR" | "EEXIST" | "ENOTEMPTY" | "EINVAL" | "ENOSPC" | "EIO";

const MESSAGES: Record<FsErrorCode, string> = {
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EEXIST: "File exists",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device (browser storage is full)",
  EIO: "Input/output error",
};

export class FsError extends Error {
  override name = "FsError";
  constructor(
    public readonly code: FsErrorCode,
    public readonly path: string,
    detail?: string,
  ) {
    super(detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code]);
  }
}

export interface StorageUsage {
  /** Bytes used by this site, as reported by the browser (or the disk size if it can't say). */
  used: number;
  /** Bytes available to this site in total (Infinity if unknown or unlimited). */
  quota: number;
  available: number;
  /** Approximate bytes taken by the disk itself. */
  disk: number;
  /** Number of files and directories. */
  entries: number;
  /** False for the in-memory fallback: nothing survives a reload. */
  durable: boolean;
  /** Whether the browser promised not to evict the data; null if unknown. */
  persisted: boolean | null;
}

export interface OpenOptions {
  /** Populates a brand-new disk (default: defaultSeed). */
  seed?: Seed;
  /** Returns an older disk to import into a brand-new one, instead of seeding. */
  migrate?: () => Map<string, FsNode> | null;
  /** Called after a migrated disk has been saved, e.g. to delete the old copy. */
  onMigrated?: () => void;
}

/**
 * The disk. Everything lives in memory, so the API is synchronous; changes are queued
 * and saved to the backend (IndexedDB in the browser) by flush(), which the shell calls
 * after every command. If saving fails, the queued changes are undone in memory too, so
 * memory always matches what's stored.
 */
export class VirtualFS {
  private nodes = new Map<string, FsNode>();
  /** Changes since the last flush (null = deleted). */
  private pending = new Map<string, FsNode | null>();
  /** Each pending path's value before this batch (undefined = didn't exist), for rollback. */
  private previous = new Map<string, FsNode | undefined>();

  private constructor(readonly backend: StorageBackend) {}

  /** Load the disk from `backend`; a new, empty one is migrated or seeded and saved. */
  static async open(backend: StorageBackend = new MemoryBackend(), opts: OpenOptions = {}): Promise<VirtualFS> {
    const fs = new VirtualFS(backend);
    const loaded = await backend.loadAll();
    if (loaded.size) {
      fs.nodes = loaded;
      if (loaded.get("/")?.type !== "dir") fs.set("/", { type: "dir", mtime: Date.now() });
      await fs.flush();
      return fs;
    }

    fs.set("/", { type: "dir", mtime: Date.now() });
    const legacy = opts.migrate?.();
    if (legacy) {
      // Sorted, so parents come before children.
      for (const path of [...legacy.keys()].sort()) {
        if (path !== "/") fs.set(path, legacy.get(path)!);
      }
    } else {
      (opts.seed ?? defaultSeed)(fs);
    }
    await fs.flush();
    if (legacy) opts.onMigrated?.();
    return fs;
  }

  // ---- reading -----------------------------------------------------------

  stat(path: string): FsNode | null {
    return this.nodes.get(normalize(path)) ?? null;
  }

  exists(path: string): boolean {
    return this.nodes.has(normalize(path));
  }

  isDir(path: string): boolean {
    return this.stat(path)?.type === "dir";
  }

  /** True for a file stored as bytes (not valid UTF-8 text). */
  isBinary(path: string): boolean {
    const node = this.stat(path);
    return node?.type === "file" && typeof node.content !== "string";
  }

  /** File content as text (binary content is decoded as UTF-8, lossily). */
  readFile(path: string): string {
    return toText(this.fileNode(path).content);
  }

  readBytes(path: string): Uint8Array {
    return toBytes(this.fileNode(path).content);
  }

  /** Names (not paths) of the entries in a directory, sorted. */
  readdir(path: string): string[] {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new FsError("ENOENT", p);
    if (node.type !== "dir") throw new FsError("ENOTDIR", p);
    const names: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key !== "/" && dirname(key) === p) names.push(basename(key));
    }
    return names.sort();
  }

  // ---- writing (validate first, then apply, so a failed call changes nothing) ----

  writeFile(path: string, content: FileContent, opts: { append?: boolean } = {}): void {
    const p = normalize(path);
    if (p === "/") throw new FsError("EISDIR", p);
    this.requireParentDir(p);
    const existing = this.nodes.get(p);
    if (existing?.type === "dir") throw new FsError("EISDIR", p);
    const data = opts.append && existing ? concat(existing.content, content) : content;
    this.set(p, { type: "file", content: data, size: byteLength(data), mtime: Date.now() });
  }

  mkdir(path: string, opts: { recursive?: boolean } = {}): void {
    const p = normalize(path);
    const existing = this.nodes.get(p);
    if (existing) {
      if (opts.recursive && existing.type === "dir") return;
      throw new FsError("EEXIST", p);
    }
    if (!opts.recursive) {
      this.requireParentDir(p);
      this.set(p, { type: "dir", mtime: Date.now() });
      return;
    }
    // Check every ancestor before creating any of them.
    const missing: string[] = [];
    for (let dir = p; !this.nodes.has(dir); dir = dirname(dir)) missing.unshift(dir);
    const deepestExisting = dirname(missing[0]!);
    if (this.nodes.get(deepestExisting)?.type !== "dir") throw new FsError("ENOTDIR", deepestExisting);
    for (const dir of missing) this.set(dir, { type: "dir", mtime: Date.now() });
  }

  remove(path: string, opts: { recursive?: boolean } = {}): void {
    const p = normalize(path);
    if (p === "/") throw new FsError("EINVAL", p);
    const node = this.nodes.get(p);
    if (!node) throw new FsError("ENOENT", p);
    if (node.type === "dir") {
      const prefix = p + "/";
      const children = [...this.nodes.keys()].filter((k) => k.startsWith(prefix));
      if (children.length && !opts.recursive) throw new FsError("ENOTEMPTY", p);
      for (const k of children) this.set(k, null);
    }
    this.set(p, null);
  }

  /** Set an existing file's or directory's modification time to now. */
  touch(path: string): void {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new FsError("ENOENT", p);
    this.set(p, { ...node, mtime: Date.now() });
  }

  /**
   * Move a file or directory (with everything under it) to `to`, like rename(2):
   * an existing file at `to` is replaced; an existing directory only if both are
   * directories and it's empty. Timestamps are kept.
   */
  rename(from: string, to: string): void {
    const f = normalize(from);
    const t = normalize(to);
    if (f === "/") throw new FsError("EINVAL", f);
    const node = this.nodes.get(f);
    if (!node) throw new FsError("ENOENT", f);
    if (f === t) return;
    if (t.startsWith(f + "/")) throw new FsError("EINVAL", t); // into itself
    this.requireParentDir(t);
    const existing = this.nodes.get(t);
    if (existing) {
      if (node.type === "dir" && existing.type !== "dir") throw new FsError("ENOTDIR", t);
      if (node.type !== "dir" && existing.type === "dir") throw new FsError("EISDIR", t);
      if (existing.type === "dir" && this.readdir(t).length) throw new FsError("ENOTEMPTY", t);
    }
    const moving = [f, ...[...this.nodes.keys()].filter((k) => k.startsWith(f + "/"))];
    const entries = moving.map((k) => [k, this.nodes.get(k)!] as const);
    for (const [k] of entries) this.set(k, null);
    for (const [k, n] of entries) this.set(t + k.slice(f.length), n);
  }

  // ---- persistence -------------------------------------------------------

  get hasPendingChanges(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Save queued changes in one atomic commit. On failure, undo them in memory and throw
   * FsError (ENOSPC when storage is full, EIO otherwise).
   */
  async flush(): Promise<void> {
    if (!this.pending.size) return;
    const changes = this.pending;
    const previous = this.previous;
    this.pending = new Map();
    this.previous = new Map();

    try {
      await this.backend.commit(changes);
    } catch (err) {
      for (const [path, node] of changes) {
        const prev = previous.get(path);
        if ((this.nodes.get(path) ?? null) !== node) {
          // Changed again while the commit was in flight: keep the newer value, but make
          // its rollback point the last saved value rather than the one that just failed.
          if (this.previous.has(path) && (this.previous.get(path) ?? null) === node) this.previous.set(path, prev);
          continue;
        }
        if (prev === undefined) this.nodes.delete(path);
        else this.nodes.set(path, prev);
      }
      const name = (err as { name?: string } | null)?.name;
      if (name === "QuotaExceededError") throw new FsError("ENOSPC", "/");
      throw new FsError("EIO", "/", err instanceof Error ? err.message : String(err));
    }
  }

  async storageUsage(): Promise<StorageUsage> {
    let disk = 0;
    for (const [path, node] of this.nodes) disk += nodeSize(path, node);
    const [estimate, persisted] = await Promise.all([this.backend.estimate(), this.backend.persisted()]);
    const used = estimate?.usage ?? disk;
    const quota = estimate?.quota ?? Infinity;
    return {
      used,
      quota,
      available: Math.max(0, quota - used),
      disk,
      entries: this.nodes.size,
      durable: this.backend.durable,
      persisted,
    };
  }

  // ---- internals ---------------------------------------------------------

  private fileNode(path: string): FileNode {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new FsError("ENOENT", p);
    if (node.type === "dir") throw new FsError("EISDIR", p);
    return node;
  }

  private set(path: string, node: FsNode | null): void {
    if (!this.previous.has(path)) this.previous.set(path, this.nodes.get(path));
    this.pending.set(path, node);
    if (node) this.nodes.set(path, node);
    else this.nodes.delete(path);
  }

  private requireParentDir(path: string) {
    const parent = dirname(path);
    const node = this.nodes.get(parent);
    if (!node) throw new FsError("ENOENT", parent);
    if (node.type !== "dir") throw new FsError("ENOTDIR", parent);
  }
}
