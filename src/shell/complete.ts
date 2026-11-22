import { path } from "../fs";
import type { Shell } from "./Shell";

export interface CompletionResult {
  /** The (possibly) updated line and cursor position. */
  line: string;
  cursor: number;
  /**
   * When several matches exist and no further common prefix could be inserted,
   * their display names (for the UI to list). Otherwise empty.
   */
  candidates: string[];
}

interface CursorWord {
  /** Index in the line where the word starts. */
  start: number;
  /** The word's value with quotes and escapes removed. */
  value: string;
  /** Quote character still open at the cursor, if any. */
  openQuote: "'" | '"' | null;
  /** True if this word is a command name (first word of a command). */
  isCommand: boolean;
}

interface Match {
  /** Full replacement value for the word (directory prefix included). */
  value: string;
  /** What to show in a candidate list. */
  display: string;
  isDir: boolean;
}

/** Characters that must be backslash-escaped in an unquoted word. */
const NEEDS_ESCAPE = /[\s\\'"|&;<>()$`*?]/g;

/**
 * Find the word under the cursor, given only the text before it. Follows the lexer's
 * quoting rules closely enough for completion, without expanding variables.
 */
function wordAtCursor(before: string): CursorWord {
  let inWord = false;
  let start = before.length;
  let value = "";
  let quote: "'" | '"' | null = null;
  let commandNext = true; // the next word starts a command
  let isCommand = true;

  for (let i = 0; i < before.length; i++) {
    const c = before[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && i + 1 < before.length) value += before[++i];
      else value += c;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || "|&;<>".includes(c)) {
      if (inWord) commandNext = false;
      inWord = false;
      if ("|&;\n".includes(c)) commandNext = true;
      else if (c === "<" || c === ">") commandNext = false;
      continue;
    }
    if (!inWord) {
      inWord = true;
      start = i;
      value = "";
      isCommand = commandNext;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "\\" && i + 1 < before.length) value += before[++i];
    else value += c;
  }

  if (!inWord) return { start: before.length, value: "", openQuote: null, isCommand: commandNext };
  return { start, value, openQuote: quote, isCommand };
}

function commandMatches(shell: Shell, prefix: string): Match[] {
  const names = new Set<string>();
  for (const name of shell.builtins.keys()) if (name.startsWith(prefix)) names.add(name);
  for (const dir of (shell.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const abs = shell.resolvePath(dir);
    if (!shell.fs.isDir(abs)) continue;
    for (const name of shell.fs.readdir(abs)) {
      if (name.startsWith(prefix) && shell.fs.stat(path.join(abs, name))?.type === "file") names.add(name);
    }
  }
  return [...names].sort().map((name) => ({ value: name, display: name, isDir: false }));
}

function pathMatches(shell: Shell, word: string): Match[] {
  const slash = word.lastIndexOf("/");
  const dirPart = word.slice(0, slash + 1); // keeps the trailing "/" (or is "")
  const prefix = word.slice(slash + 1);

  let lookup = dirPart || ".";
  if (lookup === "~/" || lookup.startsWith("~/")) lookup = (shell.env.HOME ?? "/") + lookup.slice(1);
  const abs = shell.resolvePath(lookup);
  if (!shell.fs.isDir(abs)) return [];

  const showHidden = prefix.startsWith(".");
  return shell.fs
    .readdir(abs)
    .filter((name) => name.startsWith(prefix) && (showHidden || !name.startsWith(".")))
    .map((name) => {
      const isDir = shell.fs.isDir(path.join(abs, name));
      return { value: dirPart + name, display: isDir ? `${name}/` : name, isDir };
    });
}

function commonPrefix(strings: string[]): string {
  let prefix = strings[0] ?? "";
  for (const s of strings) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/** Render a word value back into shell syntax, matching how the user started it. */
function render(value: string, openQuote: CursorWord["openQuote"], close: boolean): string {
  if (openQuote) return openQuote + value + (close ? openQuote : "");
  return value.replace(NEEDS_ESCAPE, (c) => `\\${c}`);
}

/** Complete the word at `cursor` in `line`: a command name, or a path on the virtual disk. */
export function complete(shell: Shell, line: string, cursor: number): CompletionResult {
  const before = line.slice(0, cursor);
  const after = line.slice(cursor);
  const word = wordAtCursor(before);
  const unchanged: CompletionResult = { line, cursor, candidates: [] };

  if (word.value === "~") {
    // "~" -> "~/" so the next Tab lists the home directory.
    const text = before.slice(0, word.start) + "~/";
    return { line: text + after, cursor: text.length, candidates: [] };
  }

  const matches =
    word.isCommand && !word.value.includes("/")
      ? commandMatches(shell, word.value)
      : pathMatches(shell, word.value);
  if (!matches.length) return unchanged;

  const replace = (value: string, suffix: string, close: boolean) => {
    const text = before.slice(0, word.start) + render(value, word.openQuote, close) + suffix;
    return { line: text + after, cursor: text.length, candidates: [] };
  };

  if (matches.length === 1) {
    const only = matches[0]!;
    // Directories end in "/" so you can keep tabbing; files and commands end the word.
    return only.isDir ? replace(only.value + "/", "", false) : replace(only.value, " ", true);
  }

  const prefix = commonPrefix(matches.map((m) => m.value));
  if (prefix.length > word.value.length) return replace(prefix, "", false);
  return { ...unchanged, candidates: matches.map((m) => m.display) };
}
