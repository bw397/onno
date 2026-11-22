import { runAscInWorker, type WorkerRunIO } from "../asc/client";
import type { Builtin } from "../shell";

/** Runs the compiler; swappable so tests can compile in-process (see asc/inprocess.ts). */
export type AscRunner = (argv: string[], io: WorkerRunIO) => Promise<number>;

const defaultRunner: AscRunner = (argv, io) => {
  if (typeof document === "undefined" || typeof Worker === "undefined") {
    io.stderr("asc: the compiler runs in a browser Web Worker, which isn't available here\n");
    return Promise.resolve(1);
  }
  return runAscInWorker(argv, io);
};

let runner: AscRunner = defaultRunner;

/** Replace how asc runs the compiler (tests use the in-process runner). Pass nothing to reset. */
export function setAscRunner(next?: AscRunner) {
  runner = next ?? defaultRunner;
}

export const asc: Builtin = {
  name: "asc",
  summary: "compile AssemblyScript to WebAssembly",
  usage: `asc [entryFile ...] [options]
  (the real AssemblyScript compiler: every option of the asc executable works;
  run "asc --help" for the full list)`,
  description:
    "The AssemblyScript compiler, running in the browser. Arguments are passed to the " +
    "compiler unchanged, exactly as the asc executable does, so options, asconfig.json " +
    "files (--config, --target) and output files all behave as documented; files are read " +
    "from and written to the disk, relative to the current directory, and output " +
    "directories are created as needed. .wasm output is stored as binary. The compiler " +
    "(about 20 MB) loads in the background the first time asc runs, then compiles off " +
    "the main thread; Ctrl+C stops a compile. Binary output to stdout (-o with no file) " +
    "isn't possible, because pipes and the terminal carry text: name an output file.",
  examples: [
    { command: "asc --version", description: "Show the compiler version." },
    {
      command: "mkdir -p as && echo 'export function add(a: i32, b: i32): i32 { return a + b; }' > as/add.ts",
      description: "Write a tiny AssemblyScript module.",
    },
    { command: "asc as/add.ts -o as/add.wasm -t as/add.wat -O3", description: "Compile it, optimized, to binary and text formats." },
    { command: "asc as/add.ts -o as/add.wasm --bindings esm", description: "Also emit JavaScript bindings (add.js, add.d.ts)." },
    { command: "asc as/add.ts -t", description: "Print the text format (.wat) to the terminal." },
  ],
  run(ctx) {
    return runner(ctx.args, {
      fs: ctx.fs,
      cwd: ctx.cwd,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      signal: ctx.signal,
    });
  },
};
