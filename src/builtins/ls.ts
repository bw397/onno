import { path, type FsNode } from "../fs";
import type { Builtin, CommandContext } from "../shell";
import { parseFlags } from "./flags";
import { human } from "./units";

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

interface FormatOptions {
  long: boolean;
  /** Sizes like 1.5K / 4.0M instead of bytes (only shown with long). */
  humanSizes: boolean;
}

function format(entries: Entry[], { long, humanSizes }: FormatOptions): string {
  if (!entries.length) return "";
  const label = (e: Entry) => (e.node.type === "dir" ? `${e.name}/` : e.name);
  if (!long) return entries.map(label).join("  ") + "\n";

  const size = (e: Entry) => (e.node.type !== "file" ? "-" : humanSizes ? human(e.node.size) : String(e.node.size));
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
  usage: `ls [-a] [-l] [-h] [PATH]...
  -a   include names starting with ".", plus . and ..
  -l   long format: type, size, modification time, name
  -h   with -l, human-readable sizes (1.5K, 4.0M, ...)`,
  description:
    "List the contents of each directory PATH (default: the current directory). " +
    "A file PATH lists just that file. Directories are shown with a trailing /. " +
    "Sizes are in bytes; with -h they use K, M and G (powers of 1024, rounded up, like " +
    "GNU ls).",
  examples: [
    { command: "ls", description: "List the current directory." },
    { command: "ls -la /", description: "Long listing of the root, including hidden entries." },
    { command: "ls ~ /tmp", description: "List two directories, each under a header." },
    { command: "ls -lh /bin", description: "Long listing with human-readable sizes." },
  ],
  run(ctx) {
    const parsed = parseFlags(ctx.args, "alh");
    if ("invalid" in parsed) {
      ctx.stderr(`ls: invalid option -- '${parsed.invalid}'\nusage: ${ls.usage}\n`);
      return 2;
    }
    const all = parsed.flags.has("a");
    const long = parsed.flags.has("l");
    const formatOptions: FormatOptions = { long, humanSizes: parsed.flags.has("h") };
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
    if (files.length) sections.push(format(files, formatOptions));
    const withHeaders = operands.length > 1;
    for (const dir of dirs) {
      const body = format(listDir(ctx, dir.abs, all), formatOptions);
      sections.push(withHeaders ? `${dir.name}:\n${body}` : body);
    }
    ctx.stdout(sections.join(withHeaders ? "\n" : ""));
    return status;
  },
};
