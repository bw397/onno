import type { Builtin, CommandContext, Example } from "../shell";
import { OptionError, parseOptions } from "./options";

/**
 * Manual pages are built from each builtin's own metadata (summary, usage,
 * description, examples). Scripts on disk are documented by the comment block at
 * the top of the file: the first comment line is the summary, the rest the description.
 */

const INDENT = "       ";
const WIDTH = 78;

function wrap(text: string, width = WIDTH - INDENT.length): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines;
}

const indent = (lines: string[], extra = "") => lines.map((l) => (l ? INDENT + extra + l : "")).join("\n");

interface Page {
  name: string;
  summary: string;
  synopsis: string;
  options?: string;
  description?: string;
  examples?: Example[];
  source: string;
}

function section(title: string, body: string): string {
  return `${title}\n${body}\n`;
}

function render(page: Page): string {
  const parts = [
    section("NAME", indent([`${page.name} - ${page.summary}`])),
    section("SYNOPSIS", indent(page.synopsis.split("\n"))),
  ];
  if (page.description) parts.push(section("DESCRIPTION", indent(wrap(page.description))));
  if (page.options) parts.push(section("OPTIONS", indent(page.options.split("\n"))));
  if (page.examples?.length) {
    const examples = page.examples.map((e) => `${INDENT}$ ${e.command}\n${indent(wrap(e.description, WIDTH - INDENT.length - 4), "    ")}`);
    parts.push(section("EXAMPLES", examples.join("\n\n")));
  }
  parts.push(section("SOURCE", indent([page.source])));
  return parts.join("\n");
}

/** Remove the indentation shared by all non-empty lines. */
function dedent(text: string): string {
  const lines = text.split("\n");
  const common = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(common)).join("\n");
}

function builtinPage(b: Builtin): Page {
  // usage: first line is the synopsis (minus any "usage: " prefix), the rest options.
  const [first = b.name, ...rest] = (b.usage ?? b.name).split("\n");
  const options = rest.join("\n").replace(/^\n+|\n+$/g, "");
  return {
    name: b.name,
    summary: b.summary,
    synopsis: first.replace(/^usage:\s*/, ""),
    options: options ? dedent(options) : undefined,
    description: b.description,
    examples: b.examples,
    source: `builtin (src/builtins/${b.name}.ts)`,
  };
}

/** The leading comment block of a script, without "#" markers or a #! line. */
function scriptComments(source: string): string[] {
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    if (line.startsWith("#!")) continue;
    if (!line.startsWith("#")) break;
    lines.push(line.replace(/^#\s?/, ""));
  }
  return lines;
}

function scriptPage(name: string, path: string, source: string): Page {
  const [summary = "(no description: add # comments at the top of the script)", ...rest] = scriptComments(source);
  return {
    name,
    summary,
    synopsis: `${name} [ARG]...`,
    description: rest.join("\n").trim() || undefined,
    source: `script ${path} (arguments are $1, $2, ... $@)`,
  };
}

function findPage(ctx: CommandContext, name: string): Page | null {
  const resolved = ctx.shell.resolveCommand(name);
  if (resolved.kind === "builtin") return builtinPage(resolved.builtin);
  if (resolved.kind === "file") return scriptPage(name, resolved.path, ctx.fs.readFile(resolved.path));
  return null;
}

/** Every documented command: builtins plus scripts on $PATH. */
function allPages(ctx: CommandContext): Page[] {
  const pages = new Map<string, Page>();
  for (const b of ctx.shell.builtins.values()) pages.set(b.name, builtinPage(b));
  for (const dir of (ctx.env.PATH ?? "").split(":")) {
    const abs = dir && ctx.resolvePath(dir);
    if (!abs || !ctx.fs.isDir(abs)) continue;
    for (const name of ctx.fs.readdir(abs)) {
      const path = `${abs === "/" ? "" : abs}/${name}`;
      if (!pages.has(name) && ctx.fs.stat(path)?.type === "file") {
        pages.set(name, scriptPage(name, path, ctx.fs.readFile(path)));
      }
    }
  }
  return [...pages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const man: Builtin = {
  name: "man",
  summary: "show the manual page for a command",
  usage: `man COMMAND...
man -k KEYWORD
  -k KEYWORD   list commands whose name or summary matches KEYWORD (a regex);
               "man -k ." lists everything`,
  description:
    "Show the manual for each COMMAND: a builtin, or a script on $PATH. Builtin pages " +
    "come from the command's own source code; a script's page is the comment block at " +
    "the top of the file (the first line is its summary).",
  examples: [
    { command: "man ls", description: "Read about ls." },
    { command: "man -k file", description: "Find commands related to files." },
    { command: "man -k .", description: "List every documented command." },
    { command: "man motd", description: "A script's page, from the comments at its top." },
    { command: "man grep | grep -A1 -- '-w'", description: "Search within a page." },
  ],
  run(ctx) {
    let parsed;
    try {
      parsed = parseOptions(ctx.args, [{ key: "keyword", short: "k", long: "apropos", value: true }]);
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`man: ${err.message}\nusage: ${man.usage}\n`);
      return 2;
    }

    const keyword = parsed.options.find((o) => o.key === "keyword")?.value;
    if (keyword !== undefined) {
      let re: RegExp;
      try {
        re = new RegExp(keyword, "i");
      } catch {
        re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      const hits = allPages(ctx).filter((p) => re.test(p.name) || re.test(p.summary));
      if (!hits.length) {
        ctx.stderr(`${keyword}: nothing appropriate.\n`);
        return 16;
      }
      const width = Math.max(...hits.map((p) => p.name.length));
      ctx.stdout(hits.map((p) => `${p.name.padEnd(width)} - ${p.summary}\n`).join(""));
      return 0;
    }

    if (!parsed.operands.length) {
      ctx.stderr("What manual page do you want?\nFor example, try 'man ls', or 'man -k .' to list them all.\n");
      return 1;
    }

    let status = 0;
    const pages: string[] = [];
    for (const name of parsed.operands) {
      const page = findPage(ctx, name);
      if (page) pages.push(render(page));
      else {
        ctx.stderr(`No manual entry for ${name}\n`);
        status = 16;
      }
    }
    ctx.stdout(pages.join("\n"));
    return status;
  },
};
