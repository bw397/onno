export * from "./VirtualFS";
export * as path from "./path";
export { defaultSeed, type Seed } from "./seed";
export { MemoryBackend, nodeSize, type StorageBackend, type StorageEstimate } from "./backend";
export { IndexedDBBackend } from "./idb";
export { readLegacyDisk, LEGACY_STORAGE_KEY } from "./legacy";
export { byteLength, concat, fromBytes, toBytes, toText, type FileContent } from "./content";
