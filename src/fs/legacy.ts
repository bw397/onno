import { byteLength } from "./content";
import type { FsNode } from "./VirtualFS";

/** Where versions before IndexedDB kept the whole disk, as one JSON blob. */
export const LEGACY_STORAGE_KEY = "onno:fs:v1";

/** Read a pre-IndexedDB disk from localStorage, or null if there isn't a valid one. */
export function readLegacyDisk(storage: Pick<Storage, "getItem">): Map<string, FsNode> | null {
  try {
    const raw = storage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Record<string, { type?: string; content?: unknown; mtime?: number }>;
    if (data["/"]?.type !== "dir") return null;
    const nodes = new Map<string, FsNode>();
    for (const [path, node] of Object.entries(data)) {
      const mtime = typeof node.mtime === "number" ? node.mtime : Date.now();
      if (node.type === "dir") nodes.set(path, { type: "dir", mtime });
      else if (node.type === "file" && typeof node.content === "string") {
        nodes.set(path, { type: "file", content: node.content, size: byteLength(node.content), mtime });
      }
    }
    return nodes;
  } catch {
    return null;
  }
}
