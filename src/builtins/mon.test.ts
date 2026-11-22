import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryBackend, VirtualFS } from "../fs";
import { Shell, type ShellHost } from "../shell";
import { createBuiltinRegistry } from ".";

let shell: Shell;
let opened: string[];

beforeEach(async () => {
  const fs = await VirtualFS.open(new MemoryBackend(), {
    seed: (f) => {
      f.mkdir("/home/user/docs", { recursive: true });
      f.writeFile("/home/user/notes.txt", "hi\n");
      f.writeFile("/home/user/img.png", new Uint8Array([0x89, 0x50, 0x00, 0xff]));
    },
  });
  opened = [];
  const host: ShellHost = {
    openEditor: (path) => {
      opened.push(path);
      return null;
    },
  };
  shell = new Shell(fs, createBuiltinRegistry(), { host });
});

async function run(line: string) {
  let stdout = "";
  let stderr = "";
  const status = await shell.run(line, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { stdout, stderr, status };
}

describe("mon", () => {
  test("opens an existing file by absolute path", async () => {
    const r = await run("mon notes.txt");
    expect(r).toEqual({ stdout: "mon: editing /home/user/notes.txt. Ctrl+S saves.\n", stderr: "", status: 0 });
    expect(opened).toEqual(["/home/user/notes.txt"]);
  });

  test("a new file in an existing directory is allowed (created on save)", async () => {
    const r = await run("mon docs/new.md");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("(new file)");
    expect(opened).toEqual(["/home/user/docs/new.md"]);
    expect(shell.fs.exists("/home/user/docs/new.md")).toBe(false); // not created until saved
  });

  test("refuses directories, binary files and missing parents", async () => {
    expect(await run("mon docs")).toEqual({ stdout: "", stderr: "mon: docs: Is a directory\n", status: 1 });
    expect((await run("mon img.png")).stderr).toBe("mon: img.png: binary file (mon edits text)\n");
    expect((await run("mon nope/x.txt")).stderr).toBe("mon: nope/x.txt: No such file or directory\n");
    expect((await run("mon notes.txt/x")).stderr).toBe("mon: notes.txt/x: Not a directory\n");
    expect(opened).toEqual([]);
  });

  test("exactly one file", async () => {
    expect((await run("mon")).status).toBe(2);
    expect((await run("mon a b")).status).toBe(2);
  });

  test("reports the host's refusal", async () => {
    shell.host = { openEditor: () => "~/a.txt has unsaved changes; save or close it first" };
    expect(await run("mon notes.txt")).toEqual({
      stdout: "",
      stderr: "mon: ~/a.txt has unsaved changes; save or close it first\n",
      status: 1,
    });
  });

  test("without a host (no UI) it says so", async () => {
    shell.host = undefined;
    expect(await run("mon notes.txt")).toMatchObject({ status: 1, stderr: "mon: no editor is available here\n" });
  });
});
