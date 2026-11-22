import type { VirtualFS } from "../fs";
import type { Shell } from "./Shell";

// ---- Tokens -------------------------------------------------------------

export type Operator = "|" | "||" | "&&" | ";" | ">" | ">>" | "<";

/** A word is a sequence of literal text and variable references, expanded at run time. */
export type WordPart = { kind: "literal"; value: string } | { kind: "var"; name: string };
export type Word = WordPart[];

export type WordToken = { type: "word"; parts: Word };
export type OpToken = { type: "op"; value: Operator };
export type Token = WordToken | OpToken;

// ---- AST ----------------------------------------------------------------

export interface Redirect {
  op: ">" | ">>" | "<";
  target: Word;
}

export interface SimpleCommand {
  argv: Word[];
  redirects: Redirect[];
}

export interface Pipeline {
  commands: SimpleCommand[];
}

export interface AndOrList {
  first: Pipeline;
  rest: { op: "&&" | "||"; pipeline: Pipeline }[];
}

/** Top level: and/or lists separated by `;` or newlines. */
export type Script = AndOrList[];

// ---- Execution ----------------------------------------------------------

/**
 * Services the surrounding app offers commands (an editor, ...). Absent in tests and
 * headless use, so commands must check for it.
 */
export interface ShellHost {
  /** Open an absolute path in the editor. Returns an error message if it can't. */
  openEditor(path: string): string | null;
  /** Show an absolute path in the viewer (images, PDF, media). Returns an error message if it can't. */
  openPreview(path: string): string | null;
}

export interface IO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Aborted when the user interrupts (Ctrl+C). Long-running commands should honor it. */
  signal?: AbortSignal;
}

export interface CommandContext extends IO {
  /** The name the command was invoked as. */
  name: string;
  /** Arguments, not including the command name. */
  args: string[];
  /** Everything piped / redirected into the command. */
  stdin: string;
  shell: Shell;
  fs: VirtualFS;
  cwd: string;
  env: Record<string, string>;
  /** Resolve a path relative to the shell's working directory. */
  resolvePath(path: string): string;
}

/** Exit status. 0 = success. */
export type ExitStatus = number;

export interface Example {
  /** A command line, as typed at the prompt. */
  command: string;
  /** What it does. */
  description: string;
}

/**
 * A command implemented in JS. `summary`, `usage`, `description` and `examples`
 * double as its manual page (see the `man` builtin).
 */
export interface Builtin {
  name: string;
  /** One line, lower case, no period: shown by `man -k` and in NAME. */
  summary: string;
  /** Synopsis line, optionally followed by option lines. Also printed on usage errors. */
  usage?: string;
  /** Longer prose for the manual page. */
  description?: string;
  examples?: Example[];
  run(ctx: CommandContext): ExitStatus | Promise<ExitStatus>;
}
