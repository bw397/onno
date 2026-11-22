import type { StorageBackend } from "./backend";
import type { FsNode } from "./VirtualFS";

const DB_VERSION = 1;
const STORE = "nodes";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Saves the disk in IndexedDB: one record per path (key) holding its node, so file
 * content can be a string or a Uint8Array and only changed paths are written.
 */
export class IndexedDBBackend implements StorageBackend {
  readonly durable = true;

  private constructor(private readonly db: IDBDatabase) {
    // Let a newer version of the app (in another tab) upgrade the schema.
    db.onversionchange = () => db.close();
  }

  static async open(name = "onno", factory: IDBFactory | undefined = globalThis.indexedDB): Promise<IndexedDBBackend> {
    if (!factory) throw new Error("IndexedDB is not available");
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    return new IndexedDBBackend(await request(req));
  }

  async loadAll() {
    const store = this.db.transaction(STORE, "readonly").objectStore(STORE);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return new Map(keys.map((key, i) => [String(key), values[i] as FsNode]));
  }

  commit(changes: ReadonlyMap<string, FsNode | null>): Promise<void> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = this.db.transaction(STORE, "readwrite");
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve();
      // A failed request aborts the whole transaction, so nothing is half-written.
      tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
      try {
        const store = tx.objectStore(STORE);
        for (const [path, node] of changes) {
          if (node) store.put(node, path);
          else store.delete(path);
        }
      } catch (err) {
        tx.abort();
        reject(err);
      }
    });
  }

  async estimate() {
    const storage = globalThis.navigator?.storage;
    if (!storage?.estimate) return null;
    const { usage = 0, quota = Infinity } = await storage.estimate();
    return { usage, quota };
  }

  async persisted() {
    const storage = globalThis.navigator?.storage;
    return storage?.persisted ? storage.persisted() : null;
  }

  close() {
    this.db.close();
  }
}
