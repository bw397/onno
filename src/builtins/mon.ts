import { path } from "../fs";
import type { Builtin } from "../shell";

export const mon: Builtin = {
  name: "mon",
  summary: "edit a file in the Monaco editor",
  usage: "mon FILE",
  description:
    "Open FILE in the Monaco editor (the editor from VS Code), which takes the top of " +
    "the screen while the terminal stays usable below it. Ctrl+S (or Save in the title " +
    "bar) writes the file to the disk; the title bar's close button closes the editor " +
    "and asks first if there are unsaved changes. A FILE that doesn't exist is created on " +
    "the first save. Syntax highlighting follows the file extension; TypeScript, " +
    "JavaScript, JSON, CSS and HTML also get errors and completions. Only text files can " +
    "be edited.",
  examples: [
    { command: "mon notes.txt", description: "Edit a file in the current directory (new or existing)." },
    { command: "mon /etc/motd", description: "Change the message of the day." },
    { command: "mon ~/config.json", description: "Edit JSON with validation and formatting." },
  ],
  run(ctx) {
    if (ctx.args.length !== 1) {
      ctx.stderr(`mon: expected one file\nusage: ${mon.usage}\n`);
      return 2;
    }
    const file = ctx.args[0]!;
    const abs = ctx.resolvePath(file);
    const node = ctx.fs.stat(abs);

    if (node?.type === "dir") {
      ctx.stderr(`mon: ${file}: Is a directory\n`);
      return 1;
    }
    if (node && ctx.fs.isBinary(abs)) {
      ctx.stderr(`mon: ${file}: binary file (mon edits text)\n`);
      return 1;
    }
    if (!node) {
      const parent = ctx.fs.stat(path.dirname(abs));
      if (parent?.type !== "dir") {
        ctx.stderr(`mon: ${file}: ${parent ? "Not a directory" : "No such file or directory"}\n`);
        return 1;
      }
    }

    const host = ctx.shell.host;
    if (!host) {
      ctx.stderr("mon: no editor is available here\n");
      return 1;
    }
    const error = host.openEditor(abs);
    if (error) {
      ctx.stderr(`mon: ${error}\n`);
      return 1;
    }
    ctx.stdout(`mon: editing ${abs}${node ? "" : " (new file)"}. Ctrl+S saves.\n`);
    return 0;
  },
};
