import { FsError, path } from "../fs";
import type { Builtin, CommandContext } from "../shell";
import { OptionError, parseOptions, type OptionSpec } from "./options";

const USAGE = `usage: grep [options] PATTERN [FILE]...
  -e PATTERN       use PATTERN (repeatable; matches any)
  -F               PATTERN is a fixed string, not a regex
  -i               ignore case
  -v               select non-matching lines
  -w / -x          match whole words / whole lines only
  -n               show line numbers
  -c               print only a count of matching lines per file
  -l / -L          print only names of files with / without matches
  -o               print only the matching parts
  -q               quiet: no output, exit 0 on first match
  -s               suppress file error messages
  -H / -h          always / never show file names
  -r               search directories recursively
  -m NUM           stop after NUM matching lines per file
  -A / -B / -C NUM print NUM lines of trailing / leading / both context`;

const SPECS: OptionSpec[] = [
  { key: "regexp", short: "e", long: "regexp", value: true },
  { key: "fixed", short: "F", long: "fixed-strings" },
  { key: "extended", short: "E", long: "extended-regexp" },
  { key: "ignoreCase", short: "i", long: "ignore-case" },
  { key: "invert", short: "v", long: "invert-match" },
  { key: "word", short: "w", long: "word-regexp" },
  { key: "line", short: "x", long: "line-regexp" },
  { key: "lineNumber", short: "n", long: "line-number" },
  { key: "count", short: "c", long: "count" },
  { key: "filesWith", short: "l", long: "files-with-matches" },
  { key: "filesWithout", short: "L", long: "files-without-match" },
  { key: "only", short: "o", long: "only-matching" },
  { key: "quiet", short: "q", long: "quiet" },
  { key: "quiet", long: "silent" },
  { key: "noMessages", short: "s", long: "no-messages" },
  { key: "withFilename", short: "H", long: "with-filename" },
  { key: "noFilename", short: "h", long: "no-filename" },
  { key: "recursive", short: "r", long: "recursive" },
  { key: "recursive", short: "R", long: "dereference-recursive" },
  { key: "maxCount", short: "m", long: "max-count", value: true },
  { key: "after", short: "A", long: "after-context", value: true },
  { key: "before", short: "B", long: "before-context", value: true },
  { key: "context", short: "C", long: "context", value: true },
];

interface Config {
  regex: RegExp;
  invert: boolean;
  lineNumber: boolean;
  count: boolean;
  filesWith: boolean;
  filesWithout: boolean;
  only: boolean;
  quiet: boolean;
  noMessages: boolean;
  withFilename?: boolean; // undefined = decide from number of inputs
  recursive: boolean;
  maxCount: number;
  after: number;
  before: number;
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: "\\s",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  word: "\\w",
};

/** Translate grep-isms that JavaScript regexes don't understand. */
function translatePattern(pattern: string): string {
  return pattern
    .replace(/\[:(\w+):\]/g, (whole, name: string) => POSIX_CLASSES[name] ?? whole)
    .replace(/\\[<>]/g, "\\b");
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function nonNegativeInt(value: string, option: string): number {
  if (!/^\d+$/.test(value)) throw new OptionError(`invalid ${option} argument '${value}'`);
  return Number(value);
}

function parseConfig(args: string[]): { config: Config; inputs: string[] } {
  const { options, operands } = parseOptions(args, SPECS);
  const has = (key: string) => options.some((o) => o.key === key);
  const last = (key: string) => options.findLast((o) => o.key === key)?.value;

  const patterns = options.filter((o) => o.key === "regexp").map((o) => o.value!);
  if (!patterns.length) {
    const first = operands.shift();
    if (first === undefined) throw new OptionError("no pattern given");
    patterns.push(first);
  }

  // GNU grep: -e "" (empty pattern) matches every line.
  let source = patterns.map((p) => `(?:${has("fixed") ? escapeRegex(p) : translatePattern(p)})`).join("|");
  if (has("word")) source = `(?<!\\w)(?:${source})(?!\\w)`;
  if (has("line")) source = `^(?:${source})$`;

  let regex: RegExp;
  try {
    regex = new RegExp(source, has("ignoreCase") ? "gi" : "g");
  } catch (err) {
    throw new OptionError(`invalid regular expression: ${(err as Error).message.replace(/^Invalid regular expression: /, "")}`);
  }

  const context = last("context");
  const after = last("after") ?? context;
  const before = last("before") ?? context;
  const maxCount = last("maxCount");

  // The last of -H / -h wins.
  const filenameFlag = options.findLast((o) => o.key === "withFilename" || o.key === "noFilename")?.key;

  return {
    config: {
      regex,
      invert: has("invert"),
      lineNumber: has("lineNumber"),
      count: has("count"),
      filesWith: has("filesWith"),
      filesWithout: has("filesWithout"),
      only: has("only"),
      quiet: has("quiet"),
      noMessages: has("noMessages"),
      withFilename: filenameFlag === undefined ? undefined : filenameFlag === "withFilename",
      recursive: has("recursive"),
      maxCount: maxCount === undefined ? Infinity : nonNegativeInt(maxCount, "max count"),
      after: after === undefined ? 0 : nonNegativeInt(after, "context length"),
      before: before === undefined ? 0 : nonNegativeInt(before, "context length"),
    },
    inputs: operands,
  };
}

function matches(regex: RegExp, line: string): boolean {
  regex.lastIndex = 0;
  return regex.test(line);
}

function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Search one input. Returns the number of selected lines and writes output via `out`.
 * `name` is the input's display name; `label` is the prefix for output lines, or null.
 */
function searchContent(
  content: string,
  name: string,
  label: string | null,
  cfg: Config,
  out: (s: string) => void,
): number {
  const lines = splitLines(content);
  const prefix = (n: number, sep: ":" | "-") =>
    (label !== null ? label + sep : "") + (cfg.lineNumber ? `${n + 1}${sep}` : "");
  const listing = cfg.quiet || cfg.count || cfg.filesWith || cfg.filesWithout;
  const showContext = !listing && !cfg.only && (cfg.after > 0 || cfg.before > 0);

  let selected = 0;
  let lastPrinted = -1; // index of the last line printed (for context / separators)
  let afterRemaining = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isMatch = matches(cfg.regex, line) !== cfg.invert;

    if (!isMatch) {
      if (showContext && afterRemaining > 0) {
        out(prefix(i, "-") + line + "\n");
        lastPrinted = i;
        afterRemaining--;
      }
      continue;
    }

    if (selected >= cfg.maxCount) break;
    selected++;
    if (listing) {
      if (cfg.quiet || cfg.filesWith || cfg.filesWithout) break; // one match is enough
      continue;
    }

    if (showContext) {
      const from = Math.max(i - cfg.before, lastPrinted + 1);
      if (lastPrinted >= 0 && from > lastPrinted + 1) out("--\n");
      for (let j = from; j < i; j++) out(prefix(j, "-") + lines[j] + "\n");
      afterRemaining = cfg.after;
    }

    if (cfg.only && !cfg.invert) {
      cfg.regex.lastIndex = 0;
      for (const m of line.matchAll(cfg.regex)) if (m[0]) out(prefix(i, ":") + m[0] + "\n");
    } else if (!cfg.only) {
      out(prefix(i, ":") + line + "\n");
    }
    lastPrinted = i;
  }

  // Trailing context after the last allowed match (when -m stopped us early).
  if (showContext && selected >= cfg.maxCount) {
    for (let i = lastPrinted + 1; i < lines.length && afterRemaining > 0; i++, afterRemaining--) {
      out(prefix(i, "-") + lines[i] + "\n");
    }
  }

  if (cfg.count && !cfg.quiet) out((label !== null ? label + ":" : "") + selected + "\n");
  if (cfg.filesWith && !cfg.quiet && selected > 0) out(name + "\n");
  if (cfg.filesWithout && !cfg.quiet && selected === 0) out(name + "\n");
  return selected;
}

/** Expand operands into [display name, absolute path | null for stdin] pairs. */
function collectInputs(
  ctx: CommandContext,
  inputs: string[],
  cfg: Config,
  error: (msg: string) => void,
  implicitDot: boolean,
) {
  const files: { name: string; abs: string | null }[] = [];
  const walk = (name: string, abs: string) => {
    for (const child of ctx.fs.readdir(abs)) {
      const childAbs = path.join(abs, child);
      // GNU grep: `grep -r x` prints "file", `grep -r x .` prints "./file".
      const childName = implicitDot && name === "." ? child : name.endsWith("/") ? name + child : `${name}/${child}`;
      if (ctx.fs.isDir(childAbs)) walk(childName, childAbs);
      else files.push({ name: childName, abs: childAbs });
    }
  };

  for (const input of inputs) {
    if (input === "-") {
      files.push({ name: "(standard input)", abs: null });
      continue;
    }
    const abs = ctx.resolvePath(input);
    const node = ctx.fs.stat(abs);
    if (!node) error(`${input}: No such file or directory`);
    else if (node.type === "file") files.push({ name: input, abs });
    else if (cfg.recursive) walk(input, abs);
    else error(`${input}: Is a directory`);
  }
  return files;
}

export const grep: Builtin = {
  name: "grep",
  summary: "print lines that match a pattern",
  usage: USAGE,
  description:
    "Print lines of each FILE that match PATTERN. With no FILE, or when FILE is -, " +
    "read standard input. Patterns are JavaScript regular expressions (like grep -E: " +
    "a|b, a+, a{2,} need no backslashes), plus POSIX classes such as [[:digit:]] and " +
    "the word boundaries \\< and \\>. Exit status is 0 if a line matched, 1 if none " +
    "did, 2 on error.",
  examples: [
    { command: "grep -n storage /etc/motd", description: "Show matching lines with line numbers." },
    { command: "grep -ri 'todo|fixme' .", description: "Search everything below here, ignoring case." },
    { command: "grep -v '^#' /bin/motd", description: "Hide comment lines." },
    { command: "grep -c . welcome.txt", description: "Count non-empty lines." },
    { command: "cat welcome.txt | grep -o '[a-z]+\\.txt'", description: "Print just the matched text, from a pipe." },
  ],
  run(ctx) {
    let config: Config;
    let inputs: string[];
    try {
      ({ config, inputs } = parseConfig(ctx.args));
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`grep: ${err.message}\n${USAGE}\n`);
      return 2;
    }

    let hadError = false;
    const error = (msg: string) => {
      hadError = true;
      if (!config.noMessages) ctx.stderr(`grep: ${msg}\n`);
    };

    const implicit = !inputs.length;
    if (implicit) inputs = [config.recursive ? "." : "-"];
    const files = collectInputs(ctx, inputs, config, error, implicit);
    // Like GNU grep, decided by the operands given, not by how many files were found.
    const showNames = config.withFilename ?? (inputs.length > 1 || config.recursive);

    let matched = false;
    for (const file of files) {
      let content: string;
      try {
        content = file.abs === null ? ctx.stdin : ctx.fs.readFile(file.abs);
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        error(`${file.name}: ${err.message}`);
        continue;
      }
      // Like GNU grep, don't print lines from binary files; just say whether they match.
      const binary = file.abs !== null && ctx.fs.isBinary(file.abs);
      const listsOnly = config.quiet || config.count || config.filesWith || config.filesWithout;
      const out = binary && !listsOnly ? () => {} : ctx.stdout;
      const count = searchContent(content, file.name, showNames ? file.name : null, config, out);
      if (binary && !listsOnly && count > 0) ctx.stdout(`grep: ${file.name}: binary file matches\n`);
      if (count > 0) {
        matched = true;
        if (config.quiet) return 0;
      }
    }

    if (hadError) return 2;
    return matched ? 0 : 1;
  },
};
