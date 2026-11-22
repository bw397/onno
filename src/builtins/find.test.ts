import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryStore, VirtualFS } from "../fs";
import { Shell } from "../shell";
import { createBuiltinRegistry } from ".";
import { globToRegex } from "./find";

let fs: VirtualFS;
let shell: Shell;

beforeEach(() => {
  fs = new VirtualFS(new MemoryStore(), "test", (f) => {
    f.mkdir("/home/user/proj/src/lib", { recursive: true });
    f.mkdir("/home/user/proj/node_modules/dep", { recursive: true });
    f.mkdir("/home/user/proj/empty");
    f.writeFile("/home/user/proj/README.md", "# proj\n");
    f.writeFile("/home/user/proj/src/main.js", "x".repeat(2000));
    f.writeFile("/home/user/proj/src/lib/util.js", "export {}\n");
    f.writeFile("/home/user/proj/src/lib/Util.test.js", "");
    f.writeFile("/home/user/proj/node_modules/dep/index.js", "module.exports = 1\n");
  });
  shell = new Shell(fs, createBuiltinRegistry(), { cwd: "/home/user/proj" });
});

async function run(line: string, signal?: AbortSignal) {
  let stdout = "";
  let stderr = "";
  const status = await shell.run(line, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    signal,
  });
  return { stdout, stderr, status };
}
const lines = async (line: string) => (await run(line)).stdout.split("\n").filter(Boolean);

const ALL = [
  ".",
  "./README.md",
  "./empty",
  "./node_modules",
  "./node_modules/dep",
  "./node_modules/dep/index.js",
  "./src",
  "./src/lib",
  "./src/lib/Util.test.js",
  "./src/lib/util.js",
  "./src/main.js",
];

describe("find: walking", () => {
  test("defaults to . and prints everything, sorted, pre-order", async () => {
    expect(await lines("find")).toEqual(ALL);
    expect(await lines("find .")).toEqual(ALL);
  });

  test("paths are displayed from the operand", async () => {
    expect(await lines("find src/lib")).toEqual(["src/lib", "src/lib/Util.test.js", "src/lib/util.js"]);
    expect(await lines("find src/lib/")).toEqual(["src/lib/", "src/lib/Util.test.js", "src/lib/util.js"]);
    expect(await lines("find /home/user/proj/src/lib -type f")).toEqual([
      "/home/user/proj/src/lib/Util.test.js",
      "/home/user/proj/src/lib/util.js",
    ]);
  });

  test("multiple starting points, missing ones reported", async () => {
    const r = await run("find empty nope README.md");
    expect(r.stdout).toBe("empty\nREADME.md\n");
    expect(r.stderr).toBe("find: 'nope': No such file or directory\n");
    expect(r.status).toBe(1);
  });

  test("-maxdepth / -mindepth", async () => {
    expect(await lines("find . -maxdepth 1")).toEqual([".", "./README.md", "./empty", "./node_modules", "./src"]);
    expect(await lines("find . -mindepth 3 -type f")).toEqual([
      "./node_modules/dep/index.js",
      "./src/lib/Util.test.js",
      "./src/lib/util.js",
    ]);
    expect(await lines("find . -maxdepth 0")).toEqual(["."]);
  });
});

describe("find: tests", () => {
  test("-name / -iname globs", async () => {
    expect(await lines("find . -name '*.js'")).toEqual([
      "./node_modules/dep/index.js",
      "./src/lib/Util.test.js",
      "./src/lib/util.js",
      "./src/main.js",
    ]);
    expect(await lines("find . -name 'util.*'")).toEqual(["./src/lib/util.js"]);
    expect(await lines("find . -iname 'util.*'")).toEqual(["./src/lib/Util.test.js", "./src/lib/util.js"]);
    expect(await lines("find . -name '[A-Z]*'")).toEqual(["./README.md", "./src/lib/Util.test.js"]);
    expect(await lines("find . -name 'mai?.js'")).toEqual(["./src/main.js"]);
    expect(await lines("find src -name src")).toEqual(["src"]);
  });

  test("-path matches the whole path (* crosses /)", async () => {
    expect(await lines("find . -path '*lib/*'")).toEqual(["./src/lib/Util.test.js", "./src/lib/util.js"]);
  });

  test("-type", async () => {
    expect(await lines("find src -type d")).toEqual(["src", "src/lib"]);
    expect((await run("find . -type l")).stderr).toContain("unknown argument to -type");
  });

  test("-size", async () => {
    expect(await lines("find . -size +1k")).toEqual(["./src/main.js"]);
    expect(await lines("find . -type f -size -1")).toEqual(["./src/lib/Util.test.js"]); // 0 blocks
    expect(await lines("find . -size 7c")).toEqual(["./README.md"]);
    expect(await lines("find . -size 2k")).toEqual(["./src/main.js"]); // 2000 B rounds up to 2 KiB
  });

  test("-empty", async () => {
    expect(await lines("find . -empty")).toEqual(["./empty", "./src/lib/Util.test.js"]);
  });

  test("-mtime / -mmin / -newer", async () => {
    expect(await lines("find . -mmin -5 -name README.md")).toEqual(["./README.md"]);
    expect(await lines("find . -mtime +1")).toEqual([]);
    await Bun.sleep(5);
    fs.writeFile("/home/user/proj/fresh.txt", "new");
    expect(await lines("find . -newer README.md -type f")).toEqual(["./fresh.txt"]);
  });
});

describe("find: operators", () => {
  test("implicit and, -a, -o, !, parentheses", async () => {
    expect(await lines("find . -type f -name '*.md'")).toEqual(["./README.md"]);
    expect(await lines("find . -type f -a -name '*.md'")).toEqual(["./README.md"]);
    expect(await lines("find . -name '*.md' -o -name main.js")).toEqual(["./README.md", "./src/main.js"]);
    expect(await lines("find src ! -name '*.js'")).toEqual(["src", "src/lib"]);
    expect(await lines("find src -not -type d")).toHaveLength(3);
    expect(await lines("find . \\( -name '*.md' -o -name '*.test.js' \\) -type f")).toEqual([
      "./README.md",
      "./src/lib/Util.test.js",
    ]);
  });

  test("-prune skips a directory (classic idiom)", async () => {
    expect(await lines("find . -name node_modules -prune -o -name '*.js' -print")).toEqual([
      "./src/lib/Util.test.js",
      "./src/lib/util.js",
      "./src/main.js",
    ]);
  });
});

describe("find: actions", () => {
  test("-print is explicit: only prints where it's reached", async () => {
    expect(await lines("find . -name '*.md' -print -o -name main.js")).toEqual(["./README.md"]);
  });

  test("-exec ... ; per file", async () => {
    expect((await run("find . -name '*.md' -exec cat {} \\;")).stdout).toBe("# proj\n");
    expect(await lines("find src -type f -exec echo file: {} \\;")).toEqual([
      "file: src/lib/Util.test.js",
      "file: src/lib/util.js",
      "file: src/main.js",
    ]);
  });

  test("-exec as a test: true only when the command succeeds", async () => {
    expect(await lines("find . -type f -exec grep -q export {} \\; -print")).toEqual([
      "./node_modules/dep/index.js",
      "./src/lib/util.js",
    ]);
  });

  test("-exec ... {} + batches", async () => {
    expect(await lines("find src -type f -exec echo {} +")).toEqual([
      "src/lib/Util.test.js src/lib/util.js src/main.js",
    ]);
    expect((await run("find src -type f -exec grep -c . {} +")).stdout).toBe(
      "src/lib/Util.test.js:0\nsrc/lib/util.js:1\nsrc/main.js:1\n",
    );
  });

  test("-exec output can be piped", async () => {
    expect((await run("find . -name '*.md' -exec cat {} \\; | grep -c proj")).stdout).toBe("1\n");
  });

  test("-delete removes contents before directories", async () => {
    expect((await run("find node_modules -delete")).status).toBe(0);
    expect(fs.exists("/home/user/proj/node_modules")).toBe(false);
    await run("find . -name '*.test.js' -delete");
    expect(fs.exists("/home/user/proj/src/lib/Util.test.js")).toBe(false);
    expect(fs.exists("/home/user/proj/src/lib/util.js")).toBe(true);
  });

  test("-delete won't remove the working directory or its parents", async () => {
    const r = await run("find . -delete");
    expect(r.stderr).toBe(""); // "." is silently skipped, like GNU find
    expect(fs.isDir("/home/user/proj")).toBe(true);
    expect(fs.readdir("/home/user/proj")).toEqual([]);
    expect((await run("find /home/user -maxdepth 0 -delete")).stderr).toContain("current directory");
  });

  test("Ctrl+C stops the walk", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await run("find .", controller.signal)).status).toBe(130);
  });
});

describe("find: errors", () => {
  test("bad expressions exit 1", async () => {
    expect((await run("find . -bogus")).stderr).toBe("find: unknown predicate '-bogus'\n");
    expect((await run("find . -name")).stderr).toBe("find: missing argument to '-name'\n");
    expect((await run("find . \\( -name x")).stderr).toContain("missing ')'");
    expect((await run("find . -exec echo")).stderr).toContain("missing argument to '-exec'");
    expect((await run("find . -size big")).stderr).toContain("invalid argument");
    expect((await run("find . -name x stray")).stderr).toContain("paths must precede expression");
  });
});

describe("globToRegex", () => {
  test("syntax", () => {
    expect(globToRegex("*.txt").test("a.txt")).toBe(true);
    expect(globToRegex("*.txt").test("a.txt.bak")).toBe(false);
    expect(globToRegex("[!a]*").test("abc")).toBe(false);
    expect(globToRegex("[]x]").test("]")).toBe(true);
    expect(globToRegex("\\*").test("*")).toBe(true);
    expect(globToRegex("\\*").test("a")).toBe(false);
    expect(globToRegex("a[").test("a[")).toBe(true);
    expect(globToRegex("A*", true).test("abc")).toBe(true);
  });
});
