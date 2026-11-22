import { FsError } from "../fs";
import type { Builtin } from "../shell";
import { parseFlags } from "./flags";

export const mkdir: Builtin = {
  name: "mkdir",
  summary: "make directories",
  usage: `mkdir [-p] DIR...
  -p   create missing parent directories; no error if DIR already exists`,
  description: "Create each DIR. Its parent must exist unless -p is given.",
  examples: [
    { command: "mkdir notes", description: "Create a directory." },
    { command: "mkdir -p projects/onno/src", description: "Create a whole path at once." },
    { command: "mkdir a b c", description: "Create several directories." },
  ],
  run(ctx) {
    const parsed = parseFlags(ctx.args, "p");
    if ("invalid" in parsed) {
      ctx.stderr(`mkdir: invalid option -- '${parsed.invalid}'\nusage: ${mkdir.usage}\n`);
      return 2;
    }
    if (!parsed.operands.length) {
      ctx.stderr(`mkdir: missing operand\nusage: ${mkdir.usage}\n`);
      return 2;
    }
    const recursive = parsed.flags.has("p");
    let status = 0;
    for (const dir of parsed.operands) {
      try {
        ctx.fs.mkdir(ctx.resolvePath(dir), { recursive });
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        ctx.stderr(`mkdir: cannot create directory '${dir}': ${err.message}\n`);
        status = 1;
      }
    }
    return status;
  },
};
