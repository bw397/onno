import { FsError, path, type VirtualFS } from "../fs";
import { ParseError } from "./lexer";
import { parse } from "./parser";
import type { AndOrList, Builtin, ExitStatus, IO, Pipeline, ShellHost, SimpleCommand, Word } from "./types";

const MAX_SCRIPT_DEPTH = 32;
/** Exit status for a command interrupted by Ctrl+C (128 + SIGINT). */
export const INTERRUPTED = 130;

export interface ShellOptions {
  cwd?: string;
  env?: Record<string, string>;
  host?: ShellHost;
}

type Resolution =
  | { kind: "builtin"; builtin: Builtin }
  | { kind: "file"; path: string }
  | { kind: "error"; message: string; status: ExitStatus };

/**
 * Executes shell source. Commands resolve to a builtin first, then to a file on the
 * virtual disk (by path if the name contains `/`, otherwise by searching $PATH).
 * Files are run as shell scripts, with their arguments available as $1, $2, ... $@.
 */
export class Shell {
  readonly env: Record<string, string>;
  lastStatus: ExitStatus = 0;
  /** UI services from the app, if any (see ShellHost). */
  host: ShellHost | undefined;
  private _cwd: string;
  /** Positional parameter frames ($0, $1, ...) for running scripts. */
  private positional: string[][] = [["onno"]];

  constructor(
    readonly fs: VirtualFS,
    readonly builtins: ReadonlyMap<string, Builtin>,
    opts: ShellOptions = {},
  ) {
    this.env = { HOME: "/home/user", USER: "user", PATH: "/bin", ...opts.env };
    this.host = opts.host;
    this._cwd = "/";
    this.setCwd(opts.cwd ?? this.env.HOME!);
  }

  get cwd(): string {
    return this._cwd;
  }

  /** Change the working directory. Throws FsError if `dir` isn't a directory. */
  setCwd(dir: string): void {
    const p = this.resolvePath(dir);
    const node = this.fs.stat(p);
    if (!node) throw new FsError("ENOENT", p);
    if (node.type !== "dir") throw new FsError("ENOTDIR", p);
    this._cwd = p;
    this.env.PWD = p;
  }

  resolvePath(p: string): string {
    return path.resolve(this._cwd, p);
  }

  /** Parse and run a line (or a whole script). Returns the final exit status. */
  async run(source: string, io: IO): Promise<ExitStatus> {
    let script;
    try {
      script = parse(source);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      io.stderr(`onno: ${err.message}\n`);
      return (this.lastStatus = 2);
    }
    for (const list of script) {
      if (io.signal?.aborted) return (this.lastStatus = INTERRUPTED);
      await this.runAndOr(list, io);
    }
    return this.lastStatus;
  }

  private async runAndOr(list: AndOrList, io: IO): Promise<void> {
    this.lastStatus = await this.runPipeline(list.first, io);
    for (const { op, pipeline } of list.rest) {
      if (io.signal?.aborted) return;
      const ok = this.lastStatus === 0;
      if ((op === "&&" && ok) || (op === "||" && !ok)) {
        this.lastStatus = await this.runPipeline(pipeline, io);
      }
    }
  }

  /** Pipes are buffered: each stage runs to completion before the next starts. */
  private async runPipeline(pipeline: Pipeline, io: IO): Promise<ExitStatus> {
    let input = "";
    let status: ExitStatus = 0;
    const { commands } = pipeline;
    for (let i = 0; i < commands.length; i++) {
      if (io.signal?.aborted) return INTERRUPTED;
      const isLast = i === commands.length - 1;
      let captured = "";
      const stdout = isLast ? io.stdout : (s: string) => void (captured += s);
      status = await this.runCommand(commands[i]!, input, { ...io, stdout });
      input = captured;
    }
    return status;
  }

  /** Run one command, then save its disk changes; a failed save fails the command. */
  private async runCommand(cmd: SimpleCommand, stdin: string, io: IO): Promise<ExitStatus> {
    const status = await this.execCommand(cmd, stdin, io);
    try {
      await this.fs.flush();
    } catch (err) {
      if (!(err instanceof FsError)) throw err;
      io.stderr(`onno: ${err.message}\n`);
      return 1;
    }
    return status;
  }

  private async execCommand(cmd: SimpleCommand, stdin: string, io: IO): Promise<ExitStatus> {
    const argv = cmd.argv.map((w) => this.expand(w));

    let outFile: string | null = null;
    for (const r of cmd.redirects) {
      const target = this.expand(r.target);
      const abs = this.resolvePath(target);
      try {
        if (r.op === "<") {
          stdin = this.fs.readFile(abs);
        } else {
          // Create / truncate now so errors surface before the command runs.
          this.fs.writeFile(abs, "", { append: r.op === ">>" });
          outFile = abs;
        }
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        io.stderr(`onno: ${target}: ${err.message}\n`);
        return 1;
      }
    }

    if (argv.length === 0) return 0;

    let buffered = "";
    const stdout = outFile ? (s: string) => void (buffered += s) : io.stdout;
    const status = await this.invoke(argv, stdin, { ...io, stdout });
    if (outFile) {
      try {
        this.fs.writeFile(outFile, buffered, { append: true });
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        io.stderr(`onno: ${outFile}: ${err.message}\n`);
        return 1;
      }
    }
    return status;
  }

  /**
   * Run one command from an already-split argument list, with no parsing or expansion
   * (for builtins that launch commands, like find -exec).
   */
  runArgv(argv: string[], io: IO, stdin = ""): Promise<ExitStatus> {
    if (!argv.length) return Promise.resolve(0);
    return this.invoke(argv, stdin, io);
  }

  private async invoke(argv: string[], stdin: string, io: IO): Promise<ExitStatus> {
    const [name, ...args] = argv as [string, ...string[]];
    const target = this.resolveCommand(name);

    if (target.kind === "error") {
      io.stderr(`onno: ${target.message}\n`);
      return target.status;
    }

    if (target.kind === "file") {
      // A WebAssembly module is run by the `wasm` builtin (if installed), like a binary.
      const runner = this.builtins.get("wasm");
      if (runner && this.isWasmFile(target.path)) return this.runBuiltin(runner, "wasm", [target.path, ...args], stdin, io);
      return this.runScript(target.path, name, args, io);
    }

    return this.runBuiltin(target.builtin, name, args, stdin, io);
  }

  private isWasmFile(path: string): boolean {
    const node = this.fs.stat(path);
    if (node?.type !== "file" || typeof node.content === "string") return false;
    const b = node.content;
    return b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d; // "\0asm"
  }

  private async runBuiltin(builtin: Builtin, name: string, args: string[], stdin: string, io: IO): Promise<ExitStatus> {
    try {
      return await builtin.run({
        name,
        args,
        stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        shell: this,
        fs: this.fs,
        cwd: this._cwd,
        env: this.env,
        signal: io.signal,
        resolvePath: (p) => this.resolvePath(p),
      });
    } catch (err) {
      io.stderr(`${name}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  resolveCommand(name: string): Resolution {
    const builtin = this.builtins.get(name);
    if (builtin) return { kind: "builtin", builtin };

    if (name.includes("/")) {
      const p = this.resolvePath(name);
      const node = this.fs.stat(p);
      if (!node) return { kind: "error", message: `${name}: No such file or directory`, status: 127 };
      if (node.type === "dir") return { kind: "error", message: `${name}: Is a directory`, status: 126 };
      return { kind: "file", path: p };
    }

    for (const dir of (this.env.PATH ?? "").split(":")) {
      if (!dir) continue;
      const p = path.join(this.resolvePath(dir), name);
      if (this.fs.stat(p)?.type === "file") return { kind: "file", path: p };
    }
    return { kind: "error", message: `${name}: command not found`, status: 127 };
  }

  private async runScript(file: string, name: string, args: string[], io: IO): Promise<ExitStatus> {
    if (this.positional.length > MAX_SCRIPT_DEPTH) {
      io.stderr(`onno: ${name}: maximum script nesting depth exceeded\n`);
      return 1;
    }
    const source = this.fs.readFile(file);
    this.positional.push([name, ...args]);
    try {
      return await this.run(source, io);
    } finally {
      this.positional.pop();
    }
  }

  private expand(word: Word): string {
    return word.map((part) => (part.kind === "literal" ? part.value : this.lookup(part.name))).join("");
  }

  private lookup(name: string): string {
    const frame = this.positional[this.positional.length - 1]!;
    if (name === "?") return String(this.lastStatus);
    if (name === "#") return String(frame.length - 1);
    if (name === "@") return frame.slice(1).join(" ");
    if (/^[0-9]+$/.test(name)) return frame[Number(name)] ?? "";
    return this.env[name] ?? "";
  }
}
