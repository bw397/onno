import { FsError, path, type FsNode } from "../fs";
import type { Builtin, CommandContext } from "../shell";

const USAGE = `usage: find [PATH...] [EXPRESSION]
Tests:
  -name GLOB / -iname GLOB   base name matches (* ? [...]); -iname ignores case
  -path GLOB / -ipath GLOB   whole path matches (* also matches /)
  -type f|d                  regular file / directory
  -size [+-]N[ckMG]          size in 512-byte blocks, or bytes/KiB/MiB/GiB
  -mtime [+-]N, -mmin [+-]N  modified N days / minutes ago (+N more, -N less)
  -newer FILE                modified more recently than FILE
  -empty                     empty file or directory
Actions:
  -print                     print the path (default if no action is given)
  -delete                    delete matches (processes contents before directories)
  -prune                     don't descend into this directory
  -exec CMD {} ;             run CMD per match ({} = path); true if it exits 0
  -exec CMD {} +             run CMD once with all matches
Operators: ( EXPR )  ! EXPR  -not  EXPR -a EXPR  EXPR -o EXPR   (adjacent = and)
Options:   -maxdepth N  -mindepth N`;

interface Entry {
  /** Path as displayed (built from the starting operand). */
  display: string;
  abs: string;
  node: FsNode;
  depth: number;
  /** Set by -prune. */
  prune: boolean;
}

type Pred = (e: Entry) => boolean | Promise<boolean>;

class FindError extends Error {}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shell glob (* ? [...] [!...] and \ escapes) to an anchored regex. */
export function globToRegex(glob: string, ignoreCase = false): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "\\" && i + 1 < glob.length) re += escapeRegex(glob[++i]!);
    else if (c === "[") {
      // A "]" right after "[" or "[!" is a literal member.
      let j = i + 1;
      if (glob[j] === "!") j++;
      if (glob[j] === "]") j++;
      const close = glob.indexOf("]", j);
      if (close === -1) {
        re += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      const negate = body.startsWith("!");
      if (negate) body = body.slice(1);
      re += `[${negate ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = close;
    } else re += escapeRegex(c);
  }
  return new RegExp(`^${re}$`, ignoreCase ? "is" : "s");
}

/** Parse "+N", "-N", or "N" for numeric tests. */
function numericTest(arg: string, primary: string): (value: number) => boolean {
  const m = /^([+-]?)(\d+)$/.exec(arg);
  if (!m) throw new FindError(`invalid argument '${arg}' to '${primary}'`);
  const n = Number(m[2]);
  if (m[1] === "+") return (v) => v > n;
  if (m[1] === "-") return (v) => v < n;
  return (v) => v === n;
}

const SIZE_UNITS: Record<string, number> = { b: 512, c: 1, w: 2, k: 1024, M: 1024 ** 2, G: 1024 ** 3 };

function baseName(display: string): string {
  const trimmed = display.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function sizeOf(node: FsNode): number {
  return node.type === "file" ? new TextEncoder().encode(node.content).length : 0;
}

interface Plan {
  pred: Pred;
  maxDepth: number;
  minDepth: number;
  /** -delete implies a depth-first (contents before directory) walk. */
  depthFirst: boolean;
  /** Pending `-exec ... {} +` batches, run after the walk. */
  batches: { argv: string[]; paths: string[] }[];
}

/** Recursive-descent parser for find expressions. */
function compile(tokens: string[], ctx: CommandContext, state: { hadError: boolean }): Plan {
  const plan: Plan = { pred: () => true, maxDepth: Infinity, minDepth: 0, depthFirst: false, batches: [] };
  let hasAction = false;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const arg = (primary: string) => {
    const v = next();
    if (v === undefined) throw new FindError(`missing argument to '${primary}'`);
    return v;
  };

  const and = (a: Pred, b: Pred): Pred => async (e) => (await a(e)) && (await b(e));
  const or = (a: Pred, b: Pred): Pred => async (e) => (await a(e)) || (await b(e));
  const not = (a: Pred): Pred => async (e) => !(await a(e));

  function parsePrimary(tok: string): Pred {
    switch (tok) {
      case "-name":
      case "-iname": {
        const re = globToRegex(arg(tok), tok === "-iname");
        return (e) => re.test(baseName(e.display));
      }
      case "-path":
      case "-ipath":
      case "-wholename": {
        const re = globToRegex(arg(tok), tok === "-ipath");
        return (e) => re.test(e.display);
      }
      case "-type": {
        const t = arg(tok);
        if (t !== "f" && t !== "d") throw new FindError(`unknown argument to -type: ${t} (only f and d exist here)`);
        const want = t === "f" ? "file" : "dir";
        return (e) => e.node.type === want;
      }
      case "-size": {
        const raw = arg(tok);
        const m = /^([+-]?\d+)([bcwkMG]?)$/.exec(raw);
        if (!m) throw new FindError(`invalid argument '${raw}' to '-size'`);
        const unit = SIZE_UNITS[m[2] || "b"]!;
        const test = numericTest(m[1]!, tok);
        // Like GNU find, sizes round up to whole units.
        return (e) => test(Math.ceil(sizeOf(e.node) / unit));
      }
      case "-mtime":
      case "-mmin": {
        const test = numericTest(arg(tok), tok);
        const unit = tok === "-mtime" ? 86_400_000 : 60_000;
        const now = Date.now();
        return (e) => test(Math.floor((now - e.node.mtime) / unit));
      }
      case "-newer": {
        const file = arg(tok);
        const ref = ctx.fs.stat(ctx.resolvePath(file));
        if (!ref) throw new FindError(`'${file}': No such file or directory`);
        return (e) => e.node.mtime > ref.mtime;
      }
      case "-empty":
        return (e) =>
          e.node.type === "file" ? e.node.content === "" : ctx.fs.readdir(e.abs).length === 0;
      case "-true":
        return () => true;
      case "-false":
        return () => false;
      case "-maxdepth":
      case "-mindepth": {
        const v = arg(tok);
        if (!/^\d+$/.test(v)) throw new FindError(`invalid argument '${v}' to '${tok}'`);
        if (tok === "-maxdepth") plan.maxDepth = Number(v);
        else plan.minDepth = Number(v);
        return () => true;
      }
      case "-print":
        hasAction = true;
        return (e) => {
          ctx.stdout(e.display + "\n");
          return true;
        };
      case "-prune":
        return (e) => {
          e.prune = true;
          return true;
        };
      case "-delete":
        hasAction = true;
        plan.depthFirst = true;
        return (e) => {
          // Never strand the shell in a deleted directory (this also skips ".").
          const cwd = ctx.shell.cwd;
          if (cwd === e.abs || cwd.startsWith(e.abs === "/" ? "/" : e.abs + "/")) {
            if (e.display !== ".") {
              ctx.stderr(`find: cannot delete '${e.display}': it contains the current directory\n`);
              state.hadError = true;
            }
            return false;
          }
          try {
            ctx.fs.remove(e.abs);
            return true;
          } catch (err) {
            if (!(err instanceof FsError)) throw err;
            ctx.stderr(`find: cannot delete '${e.display}': ${err.message}\n`);
            state.hadError = true;
            return false;
          }
        };
      case "-exec": {
        hasAction = true;
        const argv: string[] = [];
        for (;;) {
          const t = next();
          if (t === undefined || (argv.length === 0 && (t === ";" || t === "+"))) {
            throw new FindError("missing argument to '-exec' (end it with \\; or {} +)");
          }
          if (t === ";") break;
          if (t === "+" && argv[argv.length - 1] === "{}") {
            const batch = { argv: argv.slice(0, -1), paths: [] as string[] };
            plan.batches.push(batch);
            return (e) => {
              batch.paths.push(e.display);
              return true;
            };
          }
          argv.push(t);
        }
        return async (e) => {
          const status = await ctx.shell.runArgv(
            argv.map((a) => a.replaceAll("{}", e.display)),
            { stdout: ctx.stdout, stderr: ctx.stderr, signal: ctx.signal },
          );
          return status === 0;
        };
      }
      default:
        throw new FindError(tok.startsWith("-") ? `unknown predicate '${tok}'` : `paths must precede expression: '${tok}'`);
    }
  }

  function parseUnary(): Pred {
    const tok = next();
    if (tok === undefined) throw new FindError("expected an expression");
    if (tok === "!" || tok === "-not") return not(parseUnary());
    if (tok === "(") {
      const inner = parseOr();
      if (next() !== ")") throw new FindError("missing ')'");
      return inner;
    }
    if (tok === ")") throw new FindError("unexpected ')'");
    return parsePrimary(tok);
  }

  function parseAnd(): Pred {
    let left = parseUnary();
    for (let t = peek(); t !== undefined && t !== "-o" && t !== "-or" && t !== ")"; t = peek()) {
      if (t === "-a" || t === "-and") next();
      left = and(left, parseUnary());
    }
    return left;
  }

  function parseOr(): Pred {
    let left = parseAnd();
    while (peek() === "-o" || peek() === "-or") {
      next();
      left = or(left, parseAnd());
    }
    return left;
  }

  if (tokens.length) {
    plan.pred = parseOr();
    if (i < tokens.length) throw new FindError(`unexpected '${tokens[i]}'`);
  }
  if (!hasAction) {
    // No action given: print whatever the expression selects.
    const selected = plan.pred;
    plan.pred = async (e) => {
      if (await selected(e)) ctx.stdout(e.display + "\n");
      return true;
    };
  }
  return plan;
}

const isExpressionStart = (a: string) => (a.startsWith("-") && a.length > 1) || a === "(" || a === "!";

export const find: Builtin = {
  name: "find",
  summary: "search for files in a directory hierarchy",
  usage: USAGE,
  description:
    "Walk each PATH (default .) and evaluate EXPRESSION on every file and directory, " +
    "left to right with short-circuiting. With no action in the expression, matches are " +
    "printed. In the shell, escape ; and ( ) as \\; \\( \\); quoting globs like '*.txt' " +
    "is optional, since this shell doesn't expand them.",
  examples: [
    { command: "find . -name '*.txt'", description: "Find .txt files below the current directory." },
    { command: "find / -maxdepth 1 -type d", description: "List top-level directories." },
    { command: "find . -name node_modules -prune -o -type f -print", description: "List files, skipping node_modules." },
    { command: "find . -type f -exec grep -l TODO {} +", description: "Names of files containing TODO." },
    { command: "find /tmp -type f -mmin +60 -delete", description: "Delete files in /tmp older than an hour." },
  ],
  async run(ctx) {
    const firstExpr = ctx.args.findIndex(isExpressionStart);
    const starts = firstExpr === -1 ? ctx.args : ctx.args.slice(0, firstExpr);
    const tokens = firstExpr === -1 ? [] : ctx.args.slice(firstExpr);
    if (tokens[0] === "--help") {
      ctx.stdout(USAGE + "\n");
      return 0;
    }

    const state = { hadError: false };
    let plan: Plan;
    try {
      plan = compile(tokens, ctx, state);
    } catch (err) {
      if (!(err instanceof FindError)) throw err;
      ctx.stderr(`find: ${err.message}\n`);
      return 1;
    }

    const visit = async (entry: Entry): Promise<boolean> => {
      if (ctx.signal?.aborted) return false;
      const inRange = entry.depth >= plan.minDepth;
      if (!plan.depthFirst && inRange) await plan.pred(entry);

      if (entry.node.type === "dir" && entry.depth < plan.maxDepth && !entry.prune) {
        const sep = entry.display.endsWith("/") ? "" : "/";
        for (const name of ctx.fs.readdir(entry.abs)) {
          const abs = path.join(entry.abs, name);
          const node = ctx.fs.stat(abs);
          if (!node) continue; // removed meanwhile (e.g. by -exec rm)
          if (!(await visit({ display: entry.display + sep + name, abs, node, depth: entry.depth + 1, prune: false }))) {
            return false;
          }
        }
      }

      if (plan.depthFirst && inRange) await plan.pred(entry);
      return !ctx.signal?.aborted;
    };

    for (const start of starts.length ? starts : ["."]) {
      const abs = ctx.resolvePath(start);
      const node = ctx.fs.stat(abs);
      if (!node) {
        ctx.stderr(`find: '${start}': No such file or directory\n`);
        state.hadError = true;
        continue;
      }
      if (!(await visit({ display: start, abs, node, depth: 0, prune: false }))) return 130;
    }

    for (const batch of plan.batches) {
      if (!batch.paths.length) continue;
      const status = await ctx.shell.runArgv([...batch.argv, ...batch.paths], {
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        signal: ctx.signal,
      });
      if (status !== 0) state.hadError = true;
    }

    return state.hadError ? 1 : 0;
  },
};
