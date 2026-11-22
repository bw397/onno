import { path, type FsNode } from "../fs";
import type { Builtin, CommandContext } from "../shell";
import { parseFlags } from "./flags";

interface Entry {
  name: string;
  node: FsNode;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function format(entries: Entry[], long: boolean): string {
  if (!entries.length) return "";
  const label = (e: Entry) => (e.node.type === "dir" ? `${e.name}/` : e.name);
  if (!long) return entries.map(label).join("  ") + "\n";

  const size = (e: Entry) => (e.node.type === "file" ? String(e.node.content.length) : "-");
  const width = Math.max(...entries.map((e) => size(e).length));
  return entries
    .map((e) => `${e.node.type === "dir" ? "d" : "-"}  ${size(e).padStart(width)}  ${formatDate(e.node.mtime)}  ${label(e)}\n`)
    .join("");
}

function listDir(ctx: CommandContext, abs: string, all: boolean): Entry[] {
  const entries: Entry[] = [];
  if (all) {
    entries.push({ name: ".", node: ctx.fs.stat(abs)! });
    entries.push({ name: "..", node: ctx.fs.stat(path.dirname(abs))! });
  }
  for (const name of ctx.fs.readdir(abs)) {
    if (!all && name.startsWith(".")) continue;
    entries.push({ name, node: ctx.fs.stat(path.join(abs, name))! });
  }
  return entries;
}

export const ls: Builtin = {
  name: "ls",
  summary: "list directory contents",
  usage: `ls [-a] [-l] [PATH]...
  -a   include names starting with ".", plus . and ..
  -l   long format: type, size, modification time, name`,
  description:
    "List the contents of each directory PATH (default: the current directory). " +
    "A file PATH lists just that file. Directories are shown with a trailing /.",
  examples: [
    { command: "ls", description: "List the current directory." },
    { command: "ls -la /", description: "Long listing of the root, including hidden entries." },
    { command: "ls ~ /tmp", description: "List two directories, each under a header." },
  ],
  run(ctx) {
    const parsed = parseFlags(ctx.args, "al");
    if ("invalid" in parsed) {
      ctx.stderr(`ls: invalid option -- '${parsed.invalid}'\nusage: ${ls.usage}\n`);
      return 2;
    }
    const all = parsed.flags.has("a");
    const long = parsed.flags.has("l");
    const operands = parsed.operands.length ? parsed.operands : ["."];

    let status = 0;
    const files: Entry[] = [];
    const dirs: { name: string; abs: string }[] = [];
    for (const operand of operands) {
      const abs = ctx.resolvePath(operand);
      const node = ctx.fs.stat(abs);
      if (!node) {
        ctx.stderr(`ls: cannot access '${operand}': No such file or directory\n`);
        status = 2;
      } else if (node.type === "file") {
        files.push({ name: operand, node });
      } else {
        dirs.push({ name: operand, abs });
      }
    }

    const sections: string[] = [];
    if (files.length) sections.push(format(files, long));
    const withHeaders = operands.length > 1;
    for (const dir of dirs) {
      const body = format(listDir(ctx, dir.abs, all), long);
      sections.push(withHeaders ? `${dir.name}:\n${body}` : body);
    }
    ctx.stdout(sections.join(withHeaders ? "\n" : ""));
    return status;
  },
};
