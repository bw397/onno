import { FsError } from "../fs";
import type { Builtin } from "../shell";
import { runWasmInWorker } from "../wasm/client";
import { isWasm } from "../wasm/inspect";
import { runWasm } from "../wasm/run";

export const wasm: Builtin = {
  name: "wasm",
  summary: "run a WebAssembly module",
  usage: `wasm [-l] FILE [FUNCTION [ARG...]]
  -l, --list   list the module's exports and their signatures`,
  description:
    "Instantiate the WebAssembly module FILE (running its start function, i.e. " +
    "AssemblyScript top-level code), then call FUNCTION with ARGs and print what it " +
    "returns. ARGs are converted to the function's parameter types (i32, i64, f32, f64; " +
    "true/false work as 1/0). Without FUNCTION, wasm calls _start or main if the module " +
    "exports one (an integer result becomes the exit status), or lists the functions it " +
    "could call. Modules built by asc can print with console.log, and a failed " +
    "assert() or abort() is reported with its message and source position. A .wasm file " +
    "can also be run directly like a script (./prog.wasm FUNCTION ARG...). Each run is " +
    "isolated in its own worker; Ctrl+C stops a long or endless computation.",
  examples: [
    {
      command: "echo 'export function add(a: i32, b: i32): i32 { return a + b; }' > add.ts && asc add.ts -o add.wasm",
      description: "Compile a module with asc.",
    },
    { command: "wasm add.wasm add 2 40", description: "Call an exported function: prints 42." },
    { command: "wasm -l add.wasm", description: "List what the module exports." },
    { command: "./add.wasm add 1 2", description: "Run the .wasm file directly." },
    {
      command: `echo 'console.log("hello from wasm")' > hello.ts && asc hello.ts -o hello.wasm && wasm hello.wasm`,
      description: "Top-level code runs on start; console.log prints to the terminal.",
    },
  ],
  run(ctx) {
    let list = false;
    let i = 0;
    // Options only before FILE: after it, "-5" is an argument.
    for (; i < ctx.args.length && ctx.args[i]!.startsWith("-") && ctx.args[i] !== "-"; i++) {
      const opt = ctx.args[i]!;
      if (opt === "-l" || opt === "--list") list = true;
      else {
        ctx.stderr(`wasm: invalid option '${opt}'\nusage: ${wasm.usage}\n`);
        return 2;
      }
    }
    const file = ctx.args[i];
    if (file === undefined) {
      ctx.stderr(`wasm: expected a .wasm file\nusage: ${wasm.usage}\n`);
      return 2;
    }

    let bytes: Uint8Array;
    try {
      bytes = ctx.fs.readBytes(ctx.resolvePath(file));
    } catch (err) {
      if (!(err instanceof FsError)) throw err;
      ctx.stderr(`wasm: ${file}: ${err.message}\n`);
      return 1;
    }
    if (!isWasm(bytes)) {
      ctx.stderr(`wasm: ${file}: not a WebAssembly module\n`);
      return 1;
    }

    const req = { bytes, name: file, func: ctx.args[i + 1], args: ctx.args.slice(i + 2), list };
    const io = { stdout: ctx.stdout, stderr: ctx.stderr, signal: ctx.signal };
    // In the browser, isolate each run in a worker; elsewhere (tests) run in-process.
    const inBrowser = typeof document !== "undefined" && typeof Worker !== "undefined";
    return inBrowser ? runWasmInWorker(req, io) : runWasm(req, io);
  },
};
