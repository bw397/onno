import { FsError } from "../fs";
import type { Builtin } from "../shell";
import { OptionError, parseOptions } from "./options";

export const touch: Builtin = {
  name: "touch",
  summary: "create files or update their timestamps",
  usage: `touch [-c] FILE...
  -c, --no-create   don't create files that don't exist`,
  description:
    "Set each FILE's modification time to now, creating it empty if it doesn't exist. " +
    "The contents of existing files are left alone.",
  examples: [
    { command: "touch new.txt", description: "Create an empty file." },
    { command: "touch welcome.txt && ls -l welcome.txt", description: "Update a file's modification time." },
    { command: "touch -c maybe.txt", description: "Only touch the file if it already exists." },
  ],
  run(ctx) {
    let parsed;
    try {
      parsed = parseOptions(ctx.args, [{ key: "c", short: "c", long: "no-create" }]);
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`touch: ${err.message}\nusage: ${touch.usage}\n`);
      return 2;
    }
    if (!parsed.operands.length) {
      ctx.stderr(`touch: missing file operand\nusage: ${touch.usage}\n`);
      return 2;
    }
    const noCreate = parsed.options.some((o) => o.key === "c");
    let status = 0;
    for (const file of parsed.operands) {
      const abs = ctx.resolvePath(file);
      const node = ctx.fs.stat(abs);
      try {
        if (node) ctx.fs.touch(abs);
        else if (!noCreate) ctx.fs.writeFile(abs, "");
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        ctx.stderr(`touch: cannot touch '${file}': ${err.message}\n`);
        status = 1;
      }
    }
    return status;
  },
};
