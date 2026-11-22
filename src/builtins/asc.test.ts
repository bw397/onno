import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runAscInProcess } from "../asc/inprocess";
import { MemoryBackend, VirtualFS } from "../fs";
import { Shell } from "../shell";
import { createBuiltinRegistry } from ".";
import { setAscRunner } from "./asc";

let shell: Shell;
let backend: MemoryBackend;

beforeAll(() => setAscRunner(runAscInProcess));
afterAll(() => setAscRunner());

beforeEach(async () => {
  backend = new MemoryBackend();
  const fs = await VirtualFS.open(backend, {
    seed: (f) => {
      f.mkdir("/home/user/proj/assembly", { recursive: true });
      f.writeFile(
        "/home/user/proj/assembly/index.ts",
        'import { double } from "./util";\nexport function add(a: i32, b: i32): i32 {\n  return double(a) + b;\n}\n',
      );
      f.writeFile("/home/user/proj/assembly/util.ts", "export function double(x: i32): i32 {\n  return x * 2;\n}\n");
      f.writeFile("/home/user/proj/bad.ts", 'export function f(): i32 { return "str"; }\n');
      f.writeFile(
        "/home/user/proj/asconfig.json",
        JSON.stringify({
          entries: ["assembly/index.ts"],
          targets: {
            debug: { outFile: "build/debug.wasm", textFile: "build/debug.wat", debug: true },
            release: { outFile: "build/release.wasm", optimizeLevel: 3, shrinkLevel: 0 },
          },
        }),
      );
    },
  });
  shell = new Shell(fs, createBuiltinRegistry(), { cwd: "/home/user/proj" });
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

async function instantiate(path: string) {
  const { instance } = await WebAssembly.instantiate(shell.fs.readBytes(path), { env: { abort() {} } });
  return instance.exports as Record<string, (...args: number[]) => number>;
}

describe("asc", () => {
  test("--version", async () => {
    expect(await run("asc --version")).toEqual({ stdout: "Version 0.28.20\n", stderr: "", status: 0 });
  });

  test("compiles to binary and text, following imports; the module runs", async () => {
    const r = await run("asc assembly/index.ts -o build/out.wasm -t build/out.wat -O3");
    expect(r).toMatchObject({ status: 0, stderr: "" });
    expect(shell.fs.isBinary("/home/user/proj/build/out.wasm")).toBe(true); // output dir was created
    expect(shell.fs.readFile("/home/user/proj/build/out.wat")).toContain('(export "add"');
    expect((await instantiate("/home/user/proj/build/out.wasm")).add!(20, 2)).toBe(42);
  });

  test("output is saved to the disk", async () => {
    await run("asc assembly/index.ts -o out.wasm");
    const reopened = await VirtualFS.open(backend);
    expect(reopened.isBinary("/home/user/proj/out.wasm")).toBe(true);
  });

  test("--bindings esm writes JavaScript and typings", async () => {
    expect((await run("asc assembly/index.ts -o out.wasm --bindings esm")).status).toBe(0);
    expect(shell.fs.readFile("/home/user/proj/out.js")).toContain("add");
    expect(shell.fs.readFile("/home/user/proj/out.d.ts")).toContain("export declare function add");
  });

  test("asconfig.json targets (--config, --target)", async () => {
    expect((await run("asc --config asconfig.json --target debug")).status).toBe(0);
    expect(shell.fs.exists("/home/user/proj/build/debug.wasm")).toBe(true);
    expect(shell.fs.exists("/home/user/proj/build/debug.wat")).toBe(true);
    expect((await run("asc --config asconfig.json --target release")).status).toBe(0);
    expect((await instantiate("/home/user/proj/build/release.wasm")).add!(1, 1)).toBe(3);
  });

  test("paths are relative to the shell's working directory", async () => {
    expect((await run("cd assembly && asc index.ts -o ../rel.wasm")).status).toBe(0);
    expect(shell.fs.exists("/home/user/proj/rel.wasm")).toBe(true);
    expect((await run("asc /home/user/proj/assembly/util.ts -o /tmp-out/u.wasm")).status).toBe(0);
    expect(shell.fs.exists("/tmp-out/u.wasm")).toBe(true);
  });

  test("-t with no file prints the text format", async () => {
    const r = await run("asc assembly/util.ts -t");
    expect(r.status).toBe(0);
    expect(r.stdout).toStartWith("(module");
  });

  test("-o with no file refuses to send binary to text output", async () => {
    const r = await run("asc assembly/util.ts -o");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Use -o FILE");
  });

  test("compile errors: diagnostics on stderr, exit 1, no output", async () => {
    const r = await run("asc bad.ts -o bad.wasm");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ERROR TS2322");
    expect(r.stderr).toContain("in bad.ts(1,35)");
    expect(r.stderr).not.toContain("\u001b["); // no colour codes
    expect(shell.fs.exists("/home/user/proj/bad.wasm")).toBe(false);
    expect((await run("asc bad.ts -o bad.wasm || echo failed")).stdout).toBe("failed\n");
  });

  test("missing files and unknown options are reported by asc itself", async () => {
    expect((await run("asc nope.ts")).stderr).toContain("nope.ts");
    expect((await run("asc nope.ts")).status).toBe(1);
    expect((await run("asc --bogus assembly/util.ts")).stderr).toContain("Unknown option '--bogus'");
  });

  test("--help lists the compiler's own options", async () => {
    const r = await run("asc --help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--outFile, -o");
    expect(r.stdout).toContain("--optimizeLevel");
  });

  test("without a runner environment it explains", async () => {
    setAscRunner();
    const r = await run("asc --version");
    expect(r).toMatchObject({ status: 1, stderr: expect.stringContaining("Web Worker") });
    setAscRunner(runAscInProcess);
  });
});
