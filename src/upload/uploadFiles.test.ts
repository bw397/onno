import { beforeEach, describe, expect, test } from "bun:test";
import { FsError, MemoryStore, VirtualFS, type KeyValueStore } from "../fs";
import { uniqueName, uploadFiles } from "./uploadFiles";

let fs: VirtualFS;

beforeEach(() => {
  fs = new VirtualFS(new MemoryStore(), "test", (f) => {
    f.mkdir("/home/user", { recursive: true });
    f.writeFile("/home/user/notes.txt", "original");
  });
});

const text = (name: string, content: string) => new File([content], name);

describe("uploadFiles", () => {
  test("writes text files into the directory", async () => {
    const [r] = await uploadFiles(fs, "/home/user", [text("hello.txt", "hi there\n")]);
    expect(r).toEqual({ ok: true, name: "hello.txt", path: "/home/user/hello.txt", size: 9, renamed: false });
    expect(fs.readFile("/home/user/hello.txt")).toBe("hi there\n");
  });

  test("never overwrites: picks a numbered name", async () => {
    const results = await uploadFiles(fs, "/home/user", [text("notes.txt", "new"), text("notes.txt", "newer")]);
    expect(results.map((r) => r.ok && r.path)).toEqual(["/home/user/notes-1.txt", "/home/user/notes-2.txt"]);
    expect(results.every((r) => r.ok && r.renamed)).toBe(true);
    expect(fs.readFile("/home/user/notes.txt")).toBe("original");
  });

  test("handles UTF-8 and strips a BOM", async () => {
    await uploadFiles(fs, "/home/user", [new File([new Uint8Array([0xef, 0xbb, 0xbf]), "héllo ✓"], "u.txt")]);
    expect(fs.readFile("/home/user/u.txt")).toBe("héllo ✓");
  });

  test("rejects binary files, but keeps going", async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])], "img.png");
    const nul = new File(["abc\u0000def"], "nul.bin");
    const results = await uploadFiles(fs, "/home/user", [png, nul, text("ok.txt", "fine")]);
    expect(results.map((r) => r.ok)).toEqual([false, false, true]);
    expect(results[0]).toMatchObject({ error: expect.stringContaining("binary") });
    expect(fs.exists("/home/user/img.png")).toBe(false);
  });

  test("empty files are fine", async () => {
    expect((await uploadFiles(fs, "/home/user", [text("empty", "")]))[0]!.ok).toBe(true);
    expect(fs.readFile("/home/user/empty")).toBe("");
  });
});

describe("uniqueName", () => {
  test("variants", () => {
    expect(uniqueName(fs, "/home/user", "free.txt")).toBe("free.txt");
    expect(uniqueName(fs, "/home/user", "notes.txt")).toBe("notes-1.txt");
    fs.writeFile("/home/user/.bashrc", "");
    expect(uniqueName(fs, "/home/user", ".bashrc")).toBe(".bashrc-1");
    fs.writeFile("/home/user/Makefile", "");
    expect(uniqueName(fs, "/home/user", "Makefile")).toBe("Makefile-1");
  });
});

describe("storage quota", () => {
  /** A store that refuses values over `limit` characters, like a full localStorage. */
  class TinyStore implements KeyValueStore {
    data = new Map<string, string>();
    constructor(private limit: number) {}
    getItem(k: string) {
      return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      if (v.length > this.limit) throw new DOMException("quota", "QuotaExceededError");
      this.data.set(k, v);
    }
  }

  test("a write that doesn't fit fails with ENOSPC and leaves memory and storage unchanged", async () => {
    const store = new TinyStore(2000);
    const small = new VirtualFS(store, "q", (f) => f.mkdir("/home", { recursive: true }));
    const before = store.data.get("q");

    expect(() => small.writeFile("/home/big", "x".repeat(5000))).toThrow(FsError);
    expect(small.exists("/home/big")).toBe(false);
    expect(store.data.get("q")).toBe(before!);

    const [r] = await uploadFiles(small, "/home", [text("big.txt", "y".repeat(5000))]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("No space left") });

    // Smaller writes still work afterwards.
    small.writeFile("/home/ok", "fits");
    expect(new VirtualFS(store, "q").readFile("/home/ok")).toBe("fits");
  });

  test("a failed recursive mkdir rolls back the parents it created", () => {
    const store = new TinyStore(150);
    const small = new VirtualFS(store, "q", () => {});
    expect(() => small.mkdir("/a/very/long/path/that/will/not/fit/in/the/store", { recursive: true })).toThrow();
    expect(small.exists("/a")).toBe(false);
  });
});
