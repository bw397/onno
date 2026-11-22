import { FsError } from "../fs";
import type { Builtin } from "../shell";
import { OptionError, parseOptions } from "./options";
import { containsCwd, planTransfers } from "./transfer";

export const mv: Builtin = {
  name: "mv",
  summary: "move or rename files and directories",
  usage: `mv [-n] [-v] SOURCE DEST
mv [-n] [-v] SOURCE... DIRECTORY
  -n, --no-clobber   don't overwrite an existing file
  -v, --verbose      say what is being moved`,
  description:
    "Rename SOURCE to DEST, or move each SOURCE into DIRECTORY. Directories move with " +
    "everything in them. An existing file at the destination is replaced (unless -n); an " +
    "existing directory only by a directory, and only if it's empty. A directory can't be " +
    "moved into itself, and the working directory (or a parent of it) can't be moved.",
  examples: [
    { command: "echo hi > a.txt && mv a.txt b.txt", description: "Rename a file." },
    { command: "mkdir -p docs && mv b.txt docs", description: "Move a file into a directory." },
    { command: "mv -v docs notes", description: "Rename a directory, saying what moved." },
  ],
  run(ctx) {
    let parsed;
    try {
      parsed = parseOptions(ctx.args, [
        { key: "n", short: "n", long: "no-clobber" },
        { key: "v", short: "v", long: "verbose" },
        { key: "f", short: "f", long: "force" }, // the default; accepted for compatibility
      ]);
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`mv: ${err.message}\nusage: ${mv.usage}\n`);
      return 2;
    }
    const noClobber = parsed.options.some((o) => o.key === "n");
    const verbose = parsed.options.some((o) => o.key === "v");
    const plan = planTransfers(ctx, "mv", parsed.operands);
    if (!plan) return 2;

    let status = 0;
    const fail = (msg: string) => {
      ctx.stderr(`mv: ${msg}\n`);
      status = 1;
    };
    for (const { source, from, to } of plan) {
      const node = ctx.fs.stat(from);
      if (!node) {
        fail(`cannot stat '${source}': No such file or directory`);
        continue;
      }
      if (from === to) {
        fail(`'${source}' and '${source}' are the same file`);
        continue;
      }
      if (to.startsWith(from + "/")) {
        fail(`cannot move '${source}' to a subdirectory of itself`);
        continue;
      }
      if (node.type === "dir" && containsCwd(ctx, from)) {
        fail(`cannot move '${source}': it contains the current directory`);
        continue;
      }
      if (noClobber && ctx.fs.exists(to)) continue;
      try {
        ctx.fs.rename(from, to);
        if (verbose) ctx.stdout(`renamed '${source}' -> '${to}'\n`);
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        const reason =
          err.code === "EISDIR" ? `cannot overwrite directory '${to}' with non-directory`
          : err.code === "ENOTDIR" && err.path === to ? `cannot overwrite non-directory '${to}' with directory '${source}'`
          : `cannot move '${source}' to '${to}': ${err.message}`;
        fail(reason);
      }
    }
    return status;
  },
};
