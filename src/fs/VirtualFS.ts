import { basename, dirname, normalize } from "./path";
import { isEnumerable, measureStorage, usedChars, type EnumerableStore, type StorageUsage } from "./quota";
import { defaultSeed, type Seed } from "./seed";

export interface FileNode {
  type: "file";
  content: string;
  mtime: number;
}

export interface DirNode {
  type: "dir";
  mtime: number;
}

export type FsNode = FileNode | DirNode;

/** The subset of the Web Storage API the filesystem needs. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type FsErrorCode = "ENOENT" | "ENOTDIR" | "EISDIR" | "EEXIST" | "ENOTEMPTY" | "EINVAL" | "ENOSPC";

const MESSAGES: Record<FsErrorCode, string> = {
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EEXIST: "File exists",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device (browser storage is full)",
};

export class FsError extends Error {
  override name = "FsError";
  constructor(
    public readonly code: FsErrorCode,
    public readonly path: string,
  ) {
    super(MESSAGES[code]);
  }
}

/**
 * In-memory store, used for tests or when localStorage is unavailable. Mirrors the
 * Web Storage API, including an optional quota (in characters of keys + values)
 * that throws QuotaExceededError like a full localStorage.
 */
export class MemoryStore implements EnumerableStore {
  private data = new Map<string, string>();
  constructor(private readonly quota = Infinity) {}
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    const current = this.data.get(key);
    const used = usedChars(this) - (current === undefined ? 0 : key.length + current.length);
    if (used + key.length + value.length > this.quota) {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    }
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

export const DEFAULT_STORAGE_KEY = "onno:fs:v1";

/**
 * A flat path -> node map persisted as a single JSON blob in a KeyValueStore
 * (localStorage in the browser). Every mutation is written through immediately.
 */
export class VirtualFS {
  private nodes = new Map<string, FsNode>();

  constructor(
    private readonly store: KeyValueStore = new MemoryStore(),
    private readonly storageKey: string = DEFAULT_STORAGE_KEY,
    seed: Seed = defaultSeed,
  ) {
    if (!this.load()) {
      this.nodes.set("/", { type: "dir", mtime: Date.now() });
      seed(this);
      this.persist();
    }
  }

  /**
   * Usage of the underlying store, plus how much of it is this disk. Null if the store
   * can't be enumerated. The first call may probe the quota (see quota.ts).
   */
  storageUsage(): (StorageUsage & { disk: number; entries: number }) | null {
    if (!isEnumerable(this.store)) return null;
    const blob = this.store.getItem(this.storageKey) ?? "";
    return { ...measureStorage(this.store), disk: this.storageKey.length + blob.length, entries: this.nodes.size };
  }

  stat(path: string): FsNode | null {
    return this.nodes.get(normalize(path)) ?? null;
  }

  exists(path: string): boolean {
    return this.nodes.has(normalize(path));
  }

  isDir(path: string): boolean {
    return this.stat(path)?.type === "dir";
  }

  readFile(path: string): string {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new FsError("ENOENT", p);
    if (node.type === "dir") throw new FsError("EISDIR", p);
    return node.content;
  }

  writeFile(path: string, content: string, opts: { append?: boolean } = {}): void {
    const p = normalize(path);
    this.commit(() => {
      if (p === "/") throw new FsError("EISDIR", p);
      this.requireParentDir(p);
      const existing = this.nodes.get(p);
      if (existing?.type === "dir") throw new FsError("EISDIR", p);
      const prev = opts.append && existing ? existing.content : "";
      this.nodes.set(p, { type: "file", content: prev + content, mtime: Date.now() });
    });
  }

  mkdir(path: string, opts: { recursive?: boolean } = {}): void {
    const p = normalize(path);
    this.commit(() => {
      const existing = this.nodes.get(p);
      if (existing) {
        if (opts.recursive && existing.type === "dir") return;
        throw new FsError("EEXIST", p);
      }
      if (opts.recursive) {
        const parent = dirname(p);
        if (!this.nodes.has(parent)) this.mkdir(parent, opts);
      }
      this.requireParentDir(p);
      this.nodes.set(p, { type: "dir", mtime: Date.now() });
    });
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

  remove(path: string, opts: { recursive?: boolean } = {}): void {
    const p = normalize(path);
    this.commit(() => {
      if (p === "/") throw new FsError("EINVAL", p);
      const node = this.nodes.get(p);
      if (!node) throw new FsError("ENOENT", p);
      if (node.type === "dir") {
        const prefix = p + "/";
        const children = [...this.nodes.keys()].filter((k) => k.startsWith(prefix));
        if (children.length && !opts.recursive) throw new FsError("ENOTEMPTY", p);
        for (const k of children) this.nodes.delete(k);
      }
      this.nodes.delete(p);
    });
  }

  private commitDepth = 0;

  /**
   * Run a mutation and persist it. If anything throws (including the store being
   * full), the in-memory tree is restored so memory and storage never disagree.
   * Nested calls (e.g. recursive mkdir) join the outermost commit.
   */
  private commit(mutate: () => void): void {
    if (this.commitDepth > 0) return mutate();
    const snapshot = new Map(this.nodes);
    this.commitDepth++;
    try {
      mutate();
      this.persist();
    } catch (err) {
      this.nodes = snapshot;
      throw err;
    } finally {
      this.commitDepth--;
    }
  }

  private requireParentDir(path: string) {
    const parent = dirname(path);
    const node = this.nodes.get(parent);
    if (!node) throw new FsError("ENOENT", parent);
    if (node.type !== "dir") throw new FsError("ENOTDIR", parent);
  }

  private load(): boolean {
    try {
      const raw = this.store.getItem(this.storageKey);
      if (!raw) return false;
      const data = JSON.parse(raw) as Record<string, FsNode>;
      if (data["/"]?.type !== "dir") return false;
      this.nodes = new Map(Object.entries(data));
      return true;
    } catch {
      return false;
    }
  }

  private persist() {
    try {
      this.store.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this.nodes)));
    } catch {
      // localStorage throws QuotaExceededError when full
      throw new FsError("ENOSPC", "/");
    }
  }
}
