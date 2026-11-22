import { FsError } from "../fs";
import type { Builtin } from "../shell";
import { parseFlags } from "./flags";

export const rm: Builtin = {
  name: "rm",
  summary: "remove files or directories",
  usage: `rm [-r] [-f] PATH...
  -r, -R   remove directories and their contents
  -f       ignore missing paths; never fail because of them`,
  description:
    "Remove each PATH. Directories need -r. For safety, rm refuses /, . and .., " +
    "and any directory containing the current working directory. There is no undo.",
  examples: [
    { command: "rm old.txt", description: "Remove a file." },
    { command: "rm -r build", description: "Remove a directory and everything in it." },
    { command: "rm -f maybe.txt", description: "Remove a file if it exists, silently." },
  ],
  run(ctx) {
    const parsed = parseFlags(ctx.args, "rRf");
    if ("invalid" in parsed) {
      ctx.stderr(`rm: invalid option -- '${parsed.invalid}'\nusage: ${rm.usage}\n`);
      return 2;
    }
    const recursive = parsed.flags.has("r") || parsed.flags.has("R");
    const force = parsed.flags.has("f");
    if (!parsed.operands.length) {
      if (force) return 0;
      ctx.stderr(`rm: missing operand\nusage: ${rm.usage}\n`);
      return 2;
    }

    let status = 0;
    const fail = (msg: string) => {
      ctx.stderr(`rm: ${msg}\n`);
      status = 1;
    };

    for (const operand of parsed.operands) {
      // Check the raw operand: path.basename would normalize "." away.
      const base = operand.replace(/\/+$/, "").split("/").pop();
      if (base === "." || base === "..") {
        fail(`refusing to remove '.' or '..' directory: skipping '${operand}'`);
        continue;
      }
      const abs = ctx.resolvePath(operand);
      if (abs === "/") {
        fail("it is dangerous to operate recursively on '/'");
        continue;
      }
      // Removing the working directory (or a parent of it) would strand the shell.
      if (ctx.shell.cwd === abs || ctx.shell.cwd.startsWith(abs + "/")) {
        fail(`cannot remove '${operand}': it contains the current directory`);
        continue;
      }
      const node = ctx.fs.stat(abs);
      if (!node) {
        if (!force) fail(`cannot remove '${operand}': No such file or directory`);
        continue;
      }
      if (node.type === "dir" && !recursive) {
        fail(`cannot remove '${operand}': Is a directory`);
        continue;
      }
      try {
        ctx.fs.remove(abs, { recursive });
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        fail(`cannot remove '${operand}': ${err.message}`);
      }
    }
    return status;
  },
};
