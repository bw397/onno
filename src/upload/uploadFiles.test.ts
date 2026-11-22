import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryBackend, VirtualFS } from "../fs";
import { uniqueName, uploadFiles } from "./uploadFiles";

let backend: MemoryBackend;
let fs: VirtualFS;

beforeEach(async () => {
  backend = new MemoryBackend();
  fs = await VirtualFS.open(backend, {
    seed: (f) => {
      f.mkdir("/home/user", { recursive: true });
      f.writeFile("/home/user/notes.txt", "original");
    },
  });
});

const text = (name: string, content: string) => new File([content], name);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

describe("uploadFiles", () => {
  test("writes text files into the directory, and saves them", async () => {
    const [r] = await uploadFiles(fs, "/home/user", [text("hello.txt", "hi there\n")]);
    expect(r).toEqual({ ok: true, name: "hello.txt", path: "/home/user/hello.txt", size: 9, renamed: false, binary: false });
    expect(fs.readFile("/home/user/hello.txt")).toBe("hi there\n");
    expect((await VirtualFS.open(backend)).readFile("/home/user/hello.txt")).toBe("hi there\n");
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
    expect(fs.isBinary("/home/user/u.txt")).toBe(false);
  });

  test("binary files are stored byte for byte", async () => {
    const [r] = await uploadFiles(fs, "/home/user", [new File([PNG], "img.png")]);
    expect(r).toMatchObject({ ok: true, binary: true, size: 10 });
    expect(fs.isBinary("/home/user/img.png")).toBe(true);
    expect(fs.readBytes("/home/user/img.png")).toEqual(PNG);
    expect(fs.stat("/home/user/img.png")).toMatchObject({ size: 10 });
    expect((await VirtualFS.open(backend)).readBytes("/home/user/img.png")).toEqual(PNG);
  });

  test("text containing NUL is treated as binary", async () => {
    await uploadFiles(fs, "/home/user", [text("nul.bin", "abc\u0000def")]);
    expect(fs.isBinary("/home/user/nul.bin")).toBe(true);
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
  test("a file that doesn't fit fails on its own; the others are saved", async () => {
    const small = await VirtualFS.open(new MemoryBackend(4000), { seed: (f) => f.mkdir("/home") });
    const results = await uploadFiles(small, "/home", [text("a.txt", "a"), text("big.txt", "y".repeat(5000)), text("b.txt", "b")]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]).toMatchObject({ error: expect.stringContaining("No space left") });
    expect(small.exists("/home/big.txt")).toBe(false);
    expect(small.readFile("/home/b.txt")).toBe("b");
  });
});
