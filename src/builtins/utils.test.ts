import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryBackend, VirtualFS } from "../fs";
import { Shell } from "../shell";
import { createBuiltinRegistry } from ".";

let fs: VirtualFS;
let shell: Shell;
const BIN = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff, 0x00, 0x10]);
const TEN = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

beforeEach(async () => {
  fs = await VirtualFS.open(new MemoryBackend(), {
    seed: (f) => {
      f.mkdir("/home/user/dir/sub", { recursive: true });
      f.writeFile("/home/user/a.txt", "alpha\n");
      f.writeFile("/home/user/b.txt", "beta\n");
      f.writeFile("/home/user/dir/sub/deep.txt", "deep\n");
      f.writeFile("/home/user/prog.wasm", BIN);
      f.writeFile("/home/user/twelve.txt", TEN);
      f.writeFile("/home/user/words.txt", "one two  three\nfour\n\nfive six é\n");
      f.writeFile("/home/user/nonl.txt", "no newline");
    },
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
const H = "/home/user";

describe("mv", () => {
  test("renames a file, keeping its timestamp", async () => {
    const mtime = fs.stat(`${H}/a.txt`)!.mtime;
    expect(await run("mv a.txt c.txt")).toEqual({ stdout: "", stderr: "", status: 0 });
    expect(fs.exists(`${H}/a.txt`)).toBe(false);
    expect(fs.readFile(`${H}/c.txt`)).toBe("alpha\n");
    expect(fs.stat(`${H}/c.txt`)!.mtime).toBe(mtime);
  });

  test("moves into a directory; several sources need a directory", async () => {
    await run("mv a.txt b.txt dir");
    expect(fs.readdir(`${H}/dir`)).toEqual(["a.txt", "b.txt", "sub"]);
    expect((await run("mv dir/a.txt dir/b.txt nope")).stderr).toBe("mv: target 'nope' is not a directory\n");
  });

  test("moves a directory with everything in it; binary content intact", async () => {
    await run("mv prog.wasm dir/sub && mv dir moved");
    expect(fs.exists(`${H}/dir`)).toBe(false);
    expect(fs.readFile(`${H}/moved/sub/deep.txt`)).toBe("deep\n");
    expect(fs.readBytes(`${H}/moved/sub/prog.wasm`)).toEqual(BIN);
  });

  test("overwrites files; -n doesn't; -v reports", async () => {
    await run("mv a.txt b.txt");
    expect(fs.readFile(`${H}/b.txt`)).toBe("alpha\n");
    fs.writeFile(`${H}/a.txt`, "again\n");
    await run("mv -n a.txt b.txt");
    expect(fs.readFile(`${H}/b.txt`)).toBe("alpha\n");
    expect(fs.exists(`${H}/a.txt`)).toBe(true);
    expect((await run("mv -v a.txt z.txt")).stdout).toBe("renamed 'a.txt' -> '/home/user/z.txt'\n");
  });

  test("refusals", async () => {
    expect((await run("mv nope x")).stderr).toBe("mv: cannot stat 'nope': No such file or directory\n");
    expect((await run("mv dir dir/sub")).stderr).toBe("mv: cannot move 'dir' to a subdirectory of itself\n");
    expect((await run("mv a.txt a.txt")).stderr).toBe("mv: 'a.txt' and 'a.txt' are the same file\n");
    expect((await run("mv a.txt")).stderr).toBe("mv: missing destination file operand after 'a.txt'\n");
    fs.mkdir(`${H}/dir/sub/a.txt`);
    expect((await run("mv a.txt dir/sub")).stderr).toBe("mv: cannot overwrite directory '/home/user/dir/sub/a.txt' with non-directory\n");
    expect((await run("cd dir && mv ../dir ../elsewhere")).stderr).toContain("contains the current directory");
  });

  test("a directory replaces only an empty directory", async () => {
    fs.mkdir(`${H}/empty`);
    fs.mkdir(`${H}/full`);
    fs.writeFile(`${H}/full/x`, "");
    fs.mkdir(`${H}/src`);
    expect((await run("mv src empty")).status).toBe(0); // moves *into* empty (it's a directory)
    expect(fs.isDir(`${H}/empty/src`)).toBe(true);
  });

  test("changes are saved", async () => {
    await run("mv a.txt saved.txt");
    expect(fs.hasPendingChanges).toBe(false);
  });
});

describe("cp", () => {
  test("copies files exactly, text and binary", async () => {
    await run("cp a.txt a2.txt && cp prog.wasm copy.wasm");
    expect(fs.readFile(`${H}/a2.txt`)).toBe("alpha\n");
    expect(fs.readBytes(`${H}/copy.wasm`)).toEqual(BIN);
    expect(fs.isBinary(`${H}/copy.wasm`)).toBe(true);
    expect(fs.readFile(`${H}/a.txt`)).toBe("alpha\n"); // source untouched
  });

  test("several files into a directory; -v", async () => {
    expect((await run("cp -v a.txt b.txt dir")).stdout).toBe("'a.txt' -> '/home/user/dir/a.txt'\n'b.txt' -> '/home/user/dir/b.txt'\n");
    expect(fs.readdir(`${H}/dir`)).toEqual(["a.txt", "b.txt", "sub"]);
  });

  test("directories need -r; copies recursively", async () => {
    expect((await run("cp dir dir2")).stderr).toBe("cp: -r not specified; omitting directory 'dir'\n");
    expect((await run("cp -r dir dir2")).status).toBe(0);
    expect(fs.readFile(`${H}/dir2/sub/deep.txt`)).toBe("deep\n");
    expect((await run("cp -R dir dir2")).status).toBe(0); // into existing dir2 -> dir2/dir
    expect(fs.isDir(`${H}/dir2/dir/sub`)).toBe(true);
  });

  test("-n, refusals", async () => {
    await run("cp -n a.txt b.txt");
    expect(fs.readFile(`${H}/b.txt`)).toBe("beta\n");
    expect((await run("cp -r dir dir/sub")).stderr).toBe("cp: cannot copy a directory, 'dir', into itself\n");
    expect((await run("cp a.txt a.txt")).stderr).toContain("are the same file");
    expect((await run("cp nope x")).stderr).toBe("cp: cannot stat 'nope': No such file or directory\n");
    expect((await run("cp -r dir a.txt")).stderr).toBe("cp: cannot overwrite non-directory '/home/user/a.txt' with directory 'dir'\n");
  });
});

describe("touch", () => {
  test("creates empty files, updates timestamps, keeps contents", async () => {
    await run("touch new.txt");
    expect(fs.readFile(`${H}/new.txt`)).toBe("");
    const before = fs.stat(`${H}/a.txt`)!.mtime;
    await Bun.sleep(5);
    await run("touch a.txt dir");
    expect(fs.stat(`${H}/a.txt`)!.mtime).toBeGreaterThan(before);
    expect(fs.readFile(`${H}/a.txt`)).toBe("alpha\n");
    expect(fs.stat(`${H}/dir`)!.mtime).toBeGreaterThan(before);
  });

  test("-c doesn't create; missing parents fail", async () => {
    await run("touch -c ghost.txt");
    expect(fs.exists(`${H}/ghost.txt`)).toBe(false);
    expect((await run("touch nope/x")).stderr).toBe("touch: cannot touch 'nope/x': No such file or directory\n");
    expect((await run("touch")).status).toBe(2);
  });
});

describe("head and tail", () => {
  test("default 10 lines", async () => {
    expect((await run("head twelve.txt")).stdout).toBe(TEN.split("\n").slice(0, 10).join("\n") + "\n");
    expect((await run("tail twelve.txt")).stdout).toBe(TEN.split("\n").slice(2, 12).join("\n") + "\n");
  });

  test("-n, -N shorthand, -n -N, -n +N", async () => {
    expect((await run("head -n 2 twelve.txt")).stdout).toBe("line 1\nline 2\n");
    expect((await run("head -2 twelve.txt")).stdout).toBe("line 1\nline 2\n");
    expect((await run("head -n -10 twelve.txt")).stdout).toBe("line 1\nline 2\n");
    expect((await run("tail -n 2 twelve.txt")).stdout).toBe("line 11\nline 12\n");
    expect((await run("tail -1 twelve.txt")).stdout).toBe("line 12\n");
    expect((await run("tail -n +11 twelve.txt")).stdout).toBe("line 11\nline 12\n");
  });

  test("-c bytes", async () => {
    expect((await run("head -c 3 a.txt")).stdout).toBe("alp");
    expect((await run("tail -c 3 a.txt")).stdout).toBe("ha\n");
    expect((await run("tail -c +2 a.txt")).stdout).toBe("lpha\n");
    expect((await run("head -c -2 a.txt")).stdout).toBe("alph");
  });

  test("headers for several files; -q / -v", async () => {
    expect((await run("head -1 a.txt b.txt")).stdout).toBe("==> a.txt <==\nalpha\n\n==> b.txt <==\nbeta\n");
    expect((await run("head -q -1 a.txt b.txt")).stdout).toBe("alpha\nbeta\n");
    expect((await run("tail -v -1 a.txt")).stdout).toBe("==> a.txt <==\nalpha\n");
  });

  test("stdin, a last line without newline, errors", async () => {
    expect((await run("cat twelve.txt | head -n 1")).stdout).toBe("line 1\n");
    expect((await run("tail -n 1 nonl.txt")).stdout).toBe("no newline");
    expect((await run("head nope a.txt")).stderr).toBe("head: nope: No such file or directory\n");
    expect((await run("head nope")).status).toBe(1);
    expect((await run("head -n x a.txt")).stderr).toContain("invalid number of lines: 'x'");
  });
});

describe("wc", () => {
  test("lines, words, bytes; aligned", async () => {
    expect((await run("wc words.txt")).stdout).toBe(" 4  7 33 words.txt\n");
  });

  test("selected counts keep their order; -m counts characters", async () => {
    expect((await run("wc -c -l words.txt")).stdout).toBe(" 4 33 words.txt\n");
    expect((await run("wc -m words.txt")).stdout).toBe("32 words.txt\n");
  });

  test("totals, stdin, no trailing newline", async () => {
    expect((await run("wc -l a.txt b.txt twelve.txt")).stdout).toBe(" 1 a.txt\n 1 b.txt\n12 twelve.txt\n14 total\n");
    expect((await run("cat a.txt | wc -w")).stdout).toBe("1\n");
    expect((await run("wc -l nonl.txt")).stdout).toBe("0 nonl.txt\n");
    expect((await run("wc prog.wasm")).stdout).toBe("0 1 7 prog.wasm\n");
  });
});
