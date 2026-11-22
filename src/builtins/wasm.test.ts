import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runAscInProcess } from "../asc/inprocess";
import { MemoryBackend, VirtualFS } from "../fs";
import { Shell } from "../shell";
import { DEFERRED_START_EXPORT, deferStart, inspectWasm } from "../wasm/inspect";
import { createBuiltinRegistry } from ".";
import { setAscRunner } from "./asc";

let shell: Shell;

async function run(line: string) {
  let stdout = "";
  let stderr = "";
  const status = await shell.run(line, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { stdout, stderr, status };
}

// AssemblyScript sources, compiled once with the real compiler.
const SOURCES: Record<string, string> = {
  "math.ts": `
export function add(a: i32, b: i32): i32 { return a + b; }
export function half(x: f64): f64 { return x / 2; }
export function big(x: i64): i64 { return x * 1000000000; }
export function not(b: bool): bool { return !b; }
export function nothing(): void {}
export const answer = 42;`,
  "hello.ts": `
console.log("hello from wasm");
console.error("to stderr");
trace("traced", 2, 1.5, 2.5);
console.log("sum: " + (1 + 2).toString());`,
  "fails.ts": `
export function check(n: i32): i32 { assert(n > 0, "n must be positive"); return n; }
export function crash(): void { unreachable(); }
export function deep(n: i32): i32 { return n == 0 ? 0 : 1 + deep(n - 1); }`,
  "exitcode.ts": `export function main(): i32 { console.log("in main"); return 3; }`,
  "start.ts": `let ran = false; export function _start(): void { console.log("_start ran"); }`,
  "needs.ts": `
@external("host", "ping") declare function ping(): void;
export function go(): void { ping(); }`,
};

beforeAll(async () => {
  setAscRunner(runAscInProcess);
  const fs = await VirtualFS.open(new MemoryBackend(), {
    seed: (f) => {
      f.mkdir("/home/user/w", { recursive: true });
      f.mkdir("/bin");
      for (const [name, src] of Object.entries(SOURCES)) f.writeFile(`/home/user/w/${name}`, src);
      f.writeFile("/home/user/w/junk.wasm", new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff]));
      f.writeFile("/home/user/w/notwasm.wasm", new Uint8Array([1, 2, 3]));
    },
  });
  shell = new Shell(fs, createBuiltinRegistry(), { cwd: "/home/user/w" });
  for (const name of Object.keys(SOURCES)) {
    const base = name.replace(".ts", "");
    const r = await run(`asc ${name} -o ${base}.wasm`);
    if (r.status !== 0) throw new Error(`fixture ${name} failed to compile:\n${r.stderr}`);
  }
  expect((await run("asc math.ts -o /bin/mathbin.wasm")).status).toBe(0);
  expect((await run("asc math.ts -o shared.wasm --importMemory")).status).toBe(0);
});
afterAll(() => setAscRunner());

describe("wasm: calling exports", () => {
  test("i32, including negatives", async () => {
    expect(await run("wasm math.wasm add 2 40")).toEqual({ stdout: "42\n", stderr: "", status: 0 });
    expect((await run("wasm math.wasm add -5 3")).stdout).toBe("-2\n");
    expect((await run("wasm math.wasm add 0x10 1")).stdout).toBe("17\n");
  });

  test("f64, i64, bool, void", async () => {
    expect((await run("wasm math.wasm half 5")).stdout).toBe("2.5\n");
    expect((await run("wasm math.wasm big 9000000000")).stdout).toBe("9000000000000000000\n");
    expect((await run("wasm math.wasm not true")).stdout).toBe("0\n");
    expect(await run("wasm math.wasm nothing")).toEqual({ stdout: "", stderr: "", status: 0 });
  });

  test("argument errors (exit 2)", async () => {
    expect(await run("wasm math.wasm add 1")).toMatchObject({ status: 2, stderr: "wasm: add(i32, i32) -> i32: expects 2 arguments, got 1\n" });
    expect((await run("wasm math.wasm add 1 x")).stderr).toBe("wasm: add(i32, i32) -> i32: argument 2 ('x') isn't an integer (i32)\n");
    expect((await run("wasm math.wasm add 1.5 1")).status).toBe(2);
    expect((await run("wasm math.wasm add 99999999999 1")).stderr).toContain("isn't in i32 range");
    expect((await run("wasm math.wasm half abc")).stderr).toContain("isn't a number (f64)");
  });

  test("unknown function lists what's there", async () => {
    const r = await run("wasm math.wasm nope");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("doesn't export a function 'nope'");
    expect(r.stderr).toContain("  add(i32, i32) -> i32\n");
  });

  test("-l lists exports with signatures", async () => {
    expect((await run("wasm -l math.wasm")).stdout).toBe(
      "add(i32, i32) -> i32\nhalf(f64) -> f64\nbig(i64) -> i64\nnot(i32) -> i32\nnothing()\nanswer (global)\nmemory (memory)\n",
    );
  });
});

describe("wasm: running programs", () => {
  test("top-level code runs on start; console.* and trace print", async () => {
    expect(await run("wasm hello.wasm")).toEqual({
      stdout: "hello from wasm\ntrace: traced 1.5, 2.5\nsum: 3\n",
      stderr: "to stderr\n",
      status: 0,
    });
  });

  test("main's integer result is the exit status; _start is called", async () => {
    expect(await run("wasm exitcode.wasm; echo status=$?")).toMatchObject({ stdout: "in main\nstatus=3\n" });
    expect((await run("wasm start.wasm")).stdout).toBe("_start ran\n");
  });

  test("a module with nothing to run says what it can call", async () => {
    const r = await run("wasm math.wasm");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("has no main or _start function");
    expect(r.stderr).toContain("Call one: wasm math.wasm NAME [ARG...]");
  });

  test("failures: assert/abort with source position, traps, stack overflow", async () => {
    expect(await run("wasm fails.wasm check 5")).toMatchObject({ stdout: "5\n", status: 0 });
    expect(await run("wasm fails.wasm check -1")).toEqual({
      stdout: "",
      stderr: "wasm: abort: n must be positive in fails.ts(2:38)\n",
      status: 1,
    });
    expect(await run("wasm fails.wasm crash")).toMatchObject({ status: 1, stderr: expect.stringMatching(/^wasm: trap: .*unreachable/i) });
    expect((await run("wasm fails.wasm deep 100000000")).stderr).toMatch(/^wasm: trap: /);
  });

  test("imported memory works (--importMemory)", async () => {
    expect((await run("wasm shared.wasm add 1 1")).stdout).toBe("2\n");
  });

  test("missing imports are listed instead of failing obscurely", async () => {
    expect(await run("wasm needs.wasm go")).toEqual({
      stdout: "",
      stderr: "wasm: needs.wasm needs imports onno doesn't provide:\n  host.ping (function)\n",
      status: 1,
    });
  });

  test("bad files", async () => {
    expect((await run("wasm notwasm.wasm")).stderr).toBe("wasm: notwasm.wasm: not a WebAssembly module\n");
    expect((await run("wasm junk.wasm")).stderr).toMatch(/^wasm: junk.wasm: invalid module: /);
    expect((await run("wasm nope.wasm")).stderr).toBe("wasm: nope.wasm: No such file or directory\n");
    expect((await run("wasm")).status).toBe(2);
    expect((await run("wasm -x math.wasm")).status).toBe(2);
  });
});

describe("running .wasm files directly", () => {
  test("by path, and from $PATH", async () => {
    expect((await run("./math.wasm add 20 22")).stdout).toBe("42\n");
    expect((await run("mathbin.wasm half 3")).stdout).toBe("1.5\n");
    expect((await run("./hello.wasm | grep -c wasm")).stdout).toBe("1\n");
  });

  test("text files are still shell scripts", async () => {
    shell.fs.writeFile("/home/user/w/script.sh", "echo from script");
    expect((await run("./script.sh")).stdout).toBe("from script\n");
  });
});

describe("inspectWasm", () => {
  test("signatures, imports and the start section", async () => {
    const math = inspectWasm(shell.fs.readBytes("/home/user/w/math.wasm"));
    expect(math.exports.find((e) => e.name === "big")).toEqual({ name: "big", kind: "function", sig: { params: ["i64"], results: ["i64"] } });
    expect(math.hasStart).toBe(false);
    expect(inspectWasm(shell.fs.readBytes("/home/user/w/hello.wasm")).hasStart).toBe(true);
    const needs = inspectWasm(shell.fs.readBytes("/home/user/w/needs.wasm"));
    expect(needs.imports).toContainEqual({ module: "host", name: "ping", kind: "function", sig: { params: [], results: [] } });
    const shared = inspectWasm(shell.fs.readBytes("/home/user/w/shared.wasm"));
    expect(shared.imports.find((i) => i.kind === "memory")).toMatchObject({ module: "env", name: "memory" });
    expect(() => inspectWasm(new Uint8Array([1, 2, 3, 4]))).toThrow("bad magic number");
  });

  test("deferStart moves the start function to an export, keeping the module valid", async () => {
    const original = shell.fs.readBytes("/home/user/w/hello.wasm");
    const deferred = deferStart(original)!;
    expect(WebAssembly.validate(deferred as BufferSource)).toBe(true);
    const info = inspectWasm(deferred);
    expect(info.hasStart).toBe(false);
    expect(info.exports.map((e) => e.name)).toContain(DEFERRED_START_EXPORT);
    expect(deferStart(shell.fs.readBytes("/home/user/w/math.wasm"))).toBeNull(); // no start section
  });
});
