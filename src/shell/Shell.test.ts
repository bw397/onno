import { beforeEach, describe, expect, test } from "bun:test";
import { createBuiltinRegistry } from "../builtins";
import { MemoryStore, VirtualFS } from "../fs";
import { Shell } from "./Shell";

let store: MemoryStore;
let fs: VirtualFS;
let shell: Shell;

beforeEach(() => {
  store = new MemoryStore();
  fs = new VirtualFS(store, "test", (f) => {
    f.mkdir("/home/user", { recursive: true });
    f.mkdir("/bin");
    f.writeFile("/home/user/a.txt", "alpha\n");
    f.writeFile("/home/user/b.txt", "beta\n");
  });
  shell = new Shell(fs, createBuiltinRegistry());
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

describe("Shell", () => {
  test("starts in $HOME", async () => {
    expect(await run("pwd")).toEqual({ stdout: "/home/user\n", stderr: "", status: 0 });
  });

  test("unknown command", async () => {
    const r = await run("nope");
    expect(r.status).toBe(127);
    expect(r.stderr).toBe("onno: nope: command not found\n");
  });

  test("parse error reports status 2", async () => {
    const r = await run("cat 'oops");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unterminated single quote");
  });

  test("pipes feed stdout to stdin", async () => {
    expect((await run("cat a.txt | cat")).stdout).toBe("alpha\n");
    expect((await run("cat a.txt | cat - b.txt")).stdout).toBe("alpha\nbeta\n");
  });

  test("redirection writes to disk", async () => {
    await run("cat a.txt > out.txt");
    expect(fs.readFile("/home/user/out.txt")).toBe("alpha\n");
    await run("cat b.txt >> out.txt");
    expect(fs.readFile("/home/user/out.txt")).toBe("alpha\nbeta\n");
    expect((await run("cat < out.txt")).stdout).toBe("alpha\nbeta\n");
  });

  test("output that doesn't fit in storage is an error, not a crash", async () => {
    const tiny = new VirtualFS(new MemoryStore(1000), "q", (f) => {
      f.mkdir("/home/user", { recursive: true });
      f.writeFile("/home/user/big", "x".repeat(300));
    });
    const sh = new Shell(tiny, createBuiltinRegistry());
    let stderr = "";
    // The empty out.txt fits, but 900 more characters don't.
    const status = await sh.run("cat big big big > out.txt", { stdout: () => {}, stderr: (s) => void (stderr += s) });
    expect(status).toBe(1);
    expect(stderr).toBe("onno: /home/user/out.txt: No space left on device (browser storage is full)\n");
    expect(tiny.readFile("/home/user/out.txt")).toBe(""); // truncated, then the write was rolled back
  });

  test("redirect to a missing directory fails before running", async () => {
    const r = await run("pwd > /missing/out");
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("No such file or directory");
  });

  test("&& / || short-circuit and $?", async () => {
    expect((await run("cat missing && pwd")).stdout).toBe("");
    expect((await run("cat missing || pwd")).stdout).toBe("/home/user\n");
    expect((await run("cat missing; cat $?")).stderr).toContain("cat: 1:");
  });

  test("variables and tilde", async () => {
    expect((await run("cat ~/a.txt")).stdout).toBe("alpha\n");
    expect((await run('cat "$HOME/b.txt"')).stdout).toBe("beta\n");
  });

  test("runs script files from $PATH and by path, with positional args", async () => {
    fs.writeFile("/bin/show", "# prints its first argument as a file\ncat $1\n");
    expect((await run("show a.txt")).stdout).toBe("alpha\n");
    expect((await run("/bin/show b.txt")).stdout).toBe("beta\n");

    fs.writeFile("/home/user/local", "cat a.txt b.txt");
    expect((await run("./local")).stdout).toBe("alpha\nbeta\n");
    expect((await run("local")).status).toBe(127); // not on $PATH
  });

  test("running a directory or missing path", async () => {
    expect((await run("/bin")).status).toBe(126);
    expect((await run("./nothing")).status).toBe(127);
  });

  test("runaway recursion is stopped", async () => {
    fs.writeFile("/bin/loop", "loop");
    const r = await run("loop");
    expect(r.stderr).toContain("maximum script nesting depth");
  });

  test("setCwd", () => {
    shell.setCwd("..");
    expect(shell.cwd).toBe("/home");
    expect(() => shell.setCwd("/home/user/a.txt")).toThrow("Not a directory");
  });

  test("disk persists across instances", async () => {
    await run("cat a.txt > keep.txt");
    const reopened = new VirtualFS(store, "test");
    expect(reopened.readFile("/home/user/keep.txt")).toBe("alpha\n");
  });
});

describe("builtins", () => {
  test("cat errors keep going", async () => {
    const r = await run("cat a.txt missing b.txt");
    expect(r.stdout).toBe("alpha\nbeta\n");
    expect(r.stderr).toBe("cat: missing: No such file or directory\n");
    expect(r.status).toBe(1);
    expect((await run("cat /home")).stderr).toBe("cat: /home: Is a directory\n");
  });

  test("ls", async () => {
    fs.writeFile("/home/user/.hidden", "");
    fs.mkdir("/home/user/sub");
    expect((await run("ls")).stdout).toBe("a.txt  b.txt  sub/\n");
    expect((await run("ls -a")).stdout).toBe("./  ../  .hidden  a.txt  b.txt  sub/\n");
    expect((await run("ls a.txt")).stdout).toBe("a.txt\n");
    expect((await run("ls / sub")).stdout).toBe("/:\nbin/  home/\n\nsub:\n");
  });

  test("ls -l", async () => {
    const lines = (await run("ls -l")).stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^-  6  \w{3} [ \d]\d \d\d:\d\d  a\.txt$/);
  });

  test("ls errors", async () => {
    const r = await run("ls nope");
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("ls: cannot access 'nope': No such file or directory\n");
    expect((await run("ls -z")).status).toBe(2);
  });
});
