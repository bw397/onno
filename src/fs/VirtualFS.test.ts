import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { FsError, IndexedDBBackend, LEGACY_STORAGE_KEY, MemoryBackend, readLegacyDisk, VirtualFS, type FsNode } from ".";

const empty = { seed: () => {} };

describe("VirtualFS.open", () => {
  test("seeds a new disk and saves it", async () => {
    const backend = new MemoryBackend();
    const fs = await VirtualFS.open(backend);
    expect(fs.readFile("/etc/motd")).toContain("Welcome to onno");
    expect(fs.hasPendingChanges).toBe(false);
    expect((await backend.loadAll()).has("/etc/motd")).toBe(true);
  });

  test("loads an existing disk instead of seeding", async () => {
    const backend = new MemoryBackend();
    const first = await VirtualFS.open(backend, empty);
    first.writeFile("/mine.txt", "kept");
    await first.flush();
    let seeded = false;
    const second = await VirtualFS.open(backend, { seed: () => void (seeded = true) });
    expect(seeded).toBe(false);
    expect(second.readFile("/mine.txt")).toBe("kept");
  });

  test("migrates a legacy disk instead of seeding, then reports it", async () => {
    const legacy = JSON.stringify({
      "/": { type: "dir", mtime: 1 },
      "/notes": { type: "dir", mtime: 2 },
      "/notes/a.txt": { type: "file", content: "héllo", mtime: 3 },
    });
    const storage = new Map([[LEGACY_STORAGE_KEY, legacy]]);
    let migrated = false;
    const fs = await VirtualFS.open(new MemoryBackend(), {
      migrate: () => readLegacyDisk({ getItem: (k) => storage.get(k) ?? null }),
      onMigrated: () => void (migrated = true),
    });
    expect(migrated).toBe(true);
    expect(fs.readFile("/notes/a.txt")).toBe("héllo");
    expect(fs.stat("/notes/a.txt")).toMatchObject({ size: 6, mtime: 3 }); // UTF-8 bytes
    expect(fs.exists("/etc/motd")).toBe(false); // not seeded
  });

  test("bad legacy data is ignored", () => {
    expect(readLegacyDisk({ getItem: () => "not json" })).toBeNull();
    expect(readLegacyDisk({ getItem: () => "{}" })).toBeNull();
    expect(readLegacyDisk({ getItem: () => null })).toBeNull();
  });
});

describe("saving", () => {
  test("changes are queued until flush, then saved together", async () => {
    const backend = new MemoryBackend();
    const fs = await VirtualFS.open(backend, empty);
    fs.mkdir("/a/b", { recursive: true });
    fs.writeFile("/a/b/f", "1");
    expect(fs.hasPendingChanges).toBe(true);
    expect((await backend.loadAll()).has("/a")).toBe(false);
    await fs.flush();
    expect([...(await backend.loadAll()).keys()].sort()).toEqual(["/", "/a", "/a/b", "/a/b/f"]);
  });

  test("a failed save rolls memory back to what's stored", async () => {
    const fs = await VirtualFS.open(new MemoryBackend(200), { seed: (f) => f.writeFile("/keep", "old") });
    fs.writeFile("/keep", "new value that is fine");
    fs.writeFile("/big", "x".repeat(500));
    fs.remove("/keep");
    const err = await fs.flush().catch((e) => e);
    expect(err).toBeInstanceOf(FsError);
    expect(err.code).toBe("ENOSPC");
    expect(fs.readFile("/keep")).toBe("old");
    expect(fs.exists("/big")).toBe(false);
    expect(fs.hasPendingChanges).toBe(false);
  });

  test("non-quota failures become EIO with the reason", async () => {
    const backend = new MemoryBackend();
    const fs = await VirtualFS.open(backend, empty);
    backend.commit = async () => {
      throw new Error("disk on fire");
    };
    fs.writeFile("/x", "1");
    const err = await fs.flush().catch((e) => e);
    expect(err.code).toBe("EIO");
    expect(err.message).toBe("Input/output error: disk on fire");
    expect(fs.exists("/x")).toBe(false);
  });

  test("rollback keeps changes made while the failing save was in flight", async () => {
    const backend = new MemoryBackend();
    const fs = await VirtualFS.open(backend, { seed: (f) => f.writeFile("/a", "saved") });
    let fail!: (e: unknown) => void;
    const realCommit = backend.commit.bind(backend);
    backend.commit = () => new Promise((_, reject) => (fail = reject));

    fs.writeFile("/a", "first");
    const flushing = fs.flush().catch((e) => e);
    fs.writeFile("/a", "second"); // newer change, queued for the next flush
    fs.writeFile("/b", "other");
    fail(new DOMException("full", "QuotaExceededError"));
    expect((await flushing).code).toBe("ENOSPC");

    expect(fs.readFile("/a")).toBe("second"); // not clobbered by the rollback
    backend.commit = realCommit;
    await fs.flush();
    expect((await VirtualFS.open(backend)).readFile("/a")).toBe("second");
  });

  test("rollback of a newer change goes back to the saved value, not the failed one", async () => {
    const backend = new MemoryBackend();
    const fs = await VirtualFS.open(backend, { seed: (f) => f.writeFile("/a", "saved") });
    backend.commit = () => Promise.reject(new DOMException("full", "QuotaExceededError"));
    fs.writeFile("/a", "first");
    const flushing = fs.flush().catch(() => {});
    fs.writeFile("/a", "second");
    await flushing;
    await fs.flush().catch(() => {});
    expect(fs.readFile("/a")).toBe("saved");
  });
});

describe("validation happens before any change", () => {
  test("recursive mkdir through a file changes nothing", async () => {
    const fs = await VirtualFS.open(new MemoryBackend(), { seed: (f) => f.writeFile("/file", "") });
    expect(() => fs.mkdir("/file/x/y", { recursive: true })).toThrow("Not a directory");
    expect(fs.hasPendingChanges).toBe(false);
  });

  test("non-empty rmdir without recursive changes nothing", async () => {
    const fs = await VirtualFS.open(new MemoryBackend(), { seed: (f) => f.mkdir("/d/e", { recursive: true }) });
    expect(() => fs.remove("/d")).toThrow("Directory not empty");
    expect(fs.hasPendingChanges).toBe(false);
  });
});

describe("binary content", () => {
  test("bytes round-trip; text views decode; sizes are bytes", async () => {
    const fs = await VirtualFS.open(new MemoryBackend(), empty);
    const bytes = new Uint8Array([0, 1, 2, 255]);
    fs.writeFile("/bin.dat", bytes);
    expect(fs.isBinary("/bin.dat")).toBe(true);
    expect(fs.readBytes("/bin.dat")).toEqual(bytes);
    expect(fs.stat("/bin.dat")).toMatchObject({ size: 4 });
    fs.writeFile("/t.txt", "é");
    expect(fs.stat("/t.txt")).toMatchObject({ size: 2 });
    expect(fs.readBytes("/t.txt")).toEqual(new Uint8Array([0xc3, 0xa9]));
  });

  test("appending text to bytes (and vice versa) yields bytes", async () => {
    const fs = await VirtualFS.open(new MemoryBackend(), empty);
    fs.writeFile("/f", new Uint8Array([0xff]));
    fs.writeFile("/f", "A", { append: true });
    expect(fs.readBytes("/f")).toEqual(new Uint8Array([0xff, 0x41]));
    fs.writeFile("/g", "A");
    fs.writeFile("/g", "B", { append: true });
    expect(fs.isBinary("/g")).toBe(false);
    expect(fs.readFile("/g")).toBe("AB");
  });
});

describe("IndexedDBBackend (fake-indexeddb)", () => {
  test("saves and reloads text and binary files", async () => {
    const factory = new IDBFactory();
    const fs = await VirtualFS.open(await IndexedDBBackend.open("t", factory), empty);
    fs.mkdir("/docs");
    fs.writeFile("/docs/a.txt", "hello");
    fs.writeFile("/docs/b.bin", new Uint8Array([9, 8, 7]));
    await fs.flush();
    fs.remove("/docs/a.txt");
    await fs.flush();

    const reloaded = await VirtualFS.open(await IndexedDBBackend.open("t", factory), empty);
    expect(reloaded.readdir("/docs")).toEqual(["b.bin"]);
    expect(reloaded.readBytes("/docs/b.bin")).toEqual(new Uint8Array([9, 8, 7]));
    expect(reloaded.isBinary("/docs/b.bin")).toBe(true);
  });

  test("commits are atomic: a failing write leaves nothing behind", async () => {
    const factory = new IDBFactory();
    const backend = await IndexedDBBackend.open("atomic", factory);
    const ok: FsNode = { type: "dir", mtime: 1 };
    // A function can't be stored (DataCloneError), which aborts the transaction.
    const bad = { type: "file", content: () => {}, size: 0, mtime: 1 } as unknown as FsNode;
    const err = await backend.commit(new Map([["/ok", ok], ["/bad", bad]])).catch((e) => e);
    expect(err).toBeTruthy();
    expect((await backend.loadAll()).size).toBe(0);
  });

  test("open fails clearly without IndexedDB", async () => {
    expect(IndexedDBBackend.open("x", undefined as unknown as IDBFactory)).rejects.toThrow("IndexedDB is not available");
  });
});
