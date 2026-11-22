import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryBackend, VirtualFS } from "../fs";
import { Shell } from "../shell";
import { createBuiltinRegistry } from ".";

let fs: VirtualFS;
let shell: Shell;

beforeEach(async () => {
  fs = await VirtualFS.open(new MemoryBackend(), {
    seed: (f) => {
      f.mkdir("/home/user/docs", { recursive: true });
      f.mkdir("/bin");
      f.writeFile("/home/user/a.txt", "alpha\n");
      f.writeFile("/home/user/docs/b.txt", "beta\n");
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

describe("cd", () => {
  test("relative, absolute, home, and -", async () => {
    await run("cd docs");
    expect(shell.cwd).toBe("/home/user/docs");
    await run("cd /");
    expect(shell.cwd).toBe("/");
    expect((await run("cd -")).stdout).toBe("/home/user/docs\n");
    await run("cd");
    expect(shell.cwd).toBe("/home/user");
    expect((await run("cd ..; pwd")).stdout).toBe("/home\n");
  });

  test("errors leave cwd unchanged", async () => {
    expect((await run("cd nope")).stderr).toBe("cd: nope: No such file or directory\n");
    expect((await run("cd a.txt")).stderr).toBe("cd: a.txt: Not a directory\n");
    expect((await run("cd a b")).status).toBe(1);
    expect(shell.cwd).toBe("/home/user");
  });

  test("relative paths in later commands follow cd", async () => {
    expect((await run("cd docs && cat b.txt")).stdout).toBe("beta\n");
  });
});

describe("echo", () => {
  test("joins args", async () => {
    expect((await run("echo hello   world")).stdout).toBe("hello world\n");
    expect((await run('echo "a  b" $HOME')).stdout).toBe("a  b /home/user\n");
    expect((await run("echo")).stdout).toBe("\n");
  });

  test("-n and -e", async () => {
    expect((await run("echo -n hi")).stdout).toBe("hi");
    expect((await run("echo -e 'a\\tb\\nc'")).stdout).toBe("a\tb\nc\n");
    expect((await run("echo 'a\\nb'")).stdout).toBe("a\\nb\n");
    expect((await run("echo -ne x")).stdout).toBe("x");
    expect((await run("echo -x")).stdout).toBe("-x\n");
  });

  test("writes files with redirection", async () => {
    await run("echo one > f; echo two >> f");
    expect(fs.readFile("/home/user/f")).toBe("one\ntwo\n");
  });

  test("makes scripts useful", async () => {
    fs.writeFile("/bin/greet", 'echo "hello, $1 ($# args)"');
    expect((await run("greet world x")).stdout).toBe("hello, world (2 args)\n");
  });
});

describe("mkdir", () => {
  test("creates directories", async () => {
    expect((await run("mkdir x y")).status).toBe(0);
    expect(fs.isDir("/home/user/x") && fs.isDir("/home/user/y")).toBe(true);
  });

  test("-p creates parents and tolerates existing", async () => {
    expect((await run("mkdir -p deep/er/est")).status).toBe(0);
    expect(fs.isDir("/home/user/deep/er/est")).toBe(true);
    expect((await run("mkdir -p deep")).status).toBe(0);
  });

  test("errors", async () => {
    expect((await run("mkdir docs")).stderr).toBe("mkdir: cannot create directory 'docs': File exists\n");
    expect((await run("mkdir a/b/c")).stderr).toContain("No such file or directory");
    expect((await run("mkdir a.txt/sub")).stderr).toContain("Not a directory");
    expect((await run("mkdir")).status).toBe(2);
  });
});

describe("rm", () => {
  test("removes files", async () => {
    expect((await run("rm a.txt")).status).toBe(0);
    expect(fs.exists("/home/user/a.txt")).toBe(false);
  });

  test("directories need -r", async () => {
    expect((await run("rm docs")).stderr).toBe("rm: cannot remove 'docs': Is a directory\n");
    expect(fs.exists("/home/user/docs/b.txt")).toBe(true);
    expect((await run("rm -r docs")).status).toBe(0);
    expect(fs.exists("/home/user/docs")).toBe(false);
    expect(fs.exists("/home/user/docs/b.txt")).toBe(false);
  });

  test("-f ignores missing", async () => {
    expect((await run("rm nope")).status).toBe(1);
    expect(await run("rm -f nope")).toEqual({ stdout: "", stderr: "", status: 0 });
  });

  test("keeps going after an error", async () => {
    const r = await run("rm nope a.txt");
    expect(r.status).toBe(1);
    expect(fs.exists("/home/user/a.txt")).toBe(false);
  });

  test("refuses dangerous targets", async () => {
    expect((await run("rm -rf /")).status).toBe(1);
    expect((await run("rm -r .")).stderr).toContain("refusing");
    expect((await run("rm -r /home")).stderr).toContain("current directory");
    expect(fs.isDir("/home/user")).toBe(true);
  });
});
