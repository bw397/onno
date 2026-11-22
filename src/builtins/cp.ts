import { FsError, path, type FsNode } from "../fs";
import type { Builtin, CommandContext } from "../shell";
import { OptionError, parseOptions } from "./options";
import { planTransfers } from "./transfer";

/** Copy a file or (recursively) a directory. Contents are copied exactly, text or binary. */
function copyTree(ctx: CommandContext, from: string, to: string, node: FsNode, verbose: boolean, display: string) {
  if (node.type === "file") {
    ctx.fs.writeFile(to, node.content);
    if (verbose) ctx.stdout(`'${display}' -> '${to}'\n`);
    return;
  }
  if (!ctx.fs.isDir(to)) ctx.fs.mkdir(to);
  if (verbose) ctx.stdout(`'${display}' -> '${to}'\n`);
  for (const name of ctx.fs.readdir(from)) {
    const child = path.join(from, name);
    copyTree(ctx, child, path.join(to, name), ctx.fs.stat(child)!, verbose, path.join(display, name));
  }
}

export const cp: Builtin = {
  name: "cp",
  summary: "copy files and directories",
  usage: `cp [-r] [-n] [-v] SOURCE DEST
cp [-r] [-n] [-v] SOURCE... DIRECTORY
  -r, -R, --recursive   copy directories and their contents
  -n, --no-clobber      don't overwrite an existing file
  -v, --verbose         say what is being copied`,
  description:
    "Copy SOURCE to DEST, or each SOURCE into DIRECTORY. Contents are copied exactly, so " +
    "binary files (images, .wasm modules) stay intact, unlike cat a > b, which is text " +
    "only. Directories need -r; a directory can't be copied into itself.",
  examples: [
    { command: "cp welcome.txt welcome.bak", description: "Copy a file." },
    { command: "mkdir -p backup && cp welcome.txt /etc/motd backup", description: "Copy several files into a directory." },
    { command: "cp -r backup backup2", description: "Copy a directory and everything in it." },
  ],
  run(ctx) {
    let parsed;
    try {
      parsed = parseOptions(ctx.args, [
        { key: "r", short: "r", long: "recursive" },
        { key: "r", short: "R" },
        { key: "n", short: "n", long: "no-clobber" },
        { key: "v", short: "v", long: "verbose" },
        { key: "f", short: "f", long: "force" }, // the default; accepted for compatibility
      ]);
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`cp: ${err.message}\nusage: ${cp.usage}\n`);
      return 2;
    }
    const has = (k: string) => parsed.options.some((o) => o.key === k);
    const plan = planTransfers(ctx, "cp", parsed.operands);
    if (!plan) return 2;

    let status = 0;
    const fail = (msg: string) => {
      ctx.stderr(`cp: ${msg}\n`);
      status = 1;
    };
    for (const { source, from, to } of plan) {
      const node = ctx.fs.stat(from);
      if (!node) {
        fail(`cannot stat '${source}': No such file or directory`);
        continue;
      }
      if (node.type === "dir" && !has("r")) {
        fail(`-r not specified; omitting directory '${source}'`);
        continue;
      }
      if (from === to) {
        fail(`'${source}' and '${to}' are the same file`);
        continue;
      }
      if (node.type === "dir" && to.startsWith(from + "/")) {
        fail(`cannot copy a directory, '${source}', into itself`);
        continue;
      }
      const existing = ctx.fs.stat(to);
      if (existing && has("n")) continue;
      if (existing?.type === "dir" && node.type === "file") {
        fail(`cannot overwrite directory '${to}' with non-directory`);
        continue;
      }
      if (existing && existing.type !== "dir" && node.type === "dir") {
        fail(`cannot overwrite non-directory '${to}' with directory '${source}'`);
        continue;
      }
      try {
        copyTree(ctx, from, to, node, has("v"), source);
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        fail(`cannot copy '${source}' to '${to}': ${err.message}`);
      }
    }
    return status;
  },
};
