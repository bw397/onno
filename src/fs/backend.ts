import type { FsNode } from "./VirtualFS";

export interface StorageEstimate {
  /** Bytes used by this site (all storage types, as the browser reports it). */
  usage: number;
  /** Bytes this site may use. */
  quota: number;
}

/** Where the disk is saved. VirtualFS keeps everything in memory and commits changes here. */
export interface StorageBackend {
  /** False if data won't outlive the page (the in-memory fallback). */
  readonly durable: boolean;
  /** Every node, keyed by absolute path. Empty for a new disk. */
  loadAll(): Promise<Map<string, FsNode>>;
  /** Apply changes atomically (null = delete). Rejects (e.g. QuotaExceededError) with nothing applied. */
  commit(changes: ReadonlyMap<string, FsNode | null>): Promise<void>;
  estimate(): Promise<StorageEstimate | null>;
  /** Whether the browser has promised not to evict this site's data. Null if unknown. */
  persisted(): Promise<boolean | null>;
}

/** Approximate stored size of a node, used for quota checks and `df`. */
export function nodeSize(path: string, node: FsNode): number {
  return path.length + (node.type === "file" ? node.size : 0);
}

/**
 * In-memory backend for tests, and the fallback when IndexedDB is unavailable.
 * An optional quota (bytes, see nodeSize) makes commits fail like a full browser store.
 */
export class MemoryBackend implements StorageBackend {
  readonly durable: boolean = false;
  private data = new Map<string, FsNode>();

  constructor(private readonly quota = Infinity) {}

  async loadAll() {
    return new Map(this.data);
  }

  async commit(changes: ReadonlyMap<string, FsNode | null>) {
    const next = new Map(this.data);
    for (const [path, node] of changes) {
      if (node) next.set(path, node);
      else next.delete(path);
    }
    if (MemoryBackend.total(next) > this.quota) {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    }
    this.data = next;
  }

  async estimate() {
    return { usage: MemoryBackend.total(this.data), quota: this.quota };
  }

  async persisted(): Promise<boolean | null> {
    return null;
  }

  private static total(data: Map<string, FsNode>): number {
    let total = 0;
    for (const [path, node] of data) total += nodeSize(path, node);
    return total;
  }
}
