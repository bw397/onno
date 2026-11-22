import type { Builtin } from "../shell";
import { OptionError, parseOptions, type OptionSpec } from "./options";

const USAGE = `usage: df [-h] [-k] [-v] [FILE]...
  -h   human-readable sizes (K, M)
  -k   1K blocks (default)
  -v   also show the disk's share and entry count`;

const SPECS: OptionSpec[] = [
  { key: "human", short: "h", long: "human-readable" },
  { key: "kilo", short: "k" },
  { key: "verbose", short: "v", long: "verbose" },
];

/** GNU df -h style: powers of 1024, one decimal below 10. */
function human(n: number): string {
  const units = ["", "K", "M", "G", "T"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return String(n);
  // GNU rounds up so it never under-reports.
  const rounded = value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value);
  return (value < 10 ? rounded.toFixed(1) : String(rounded)) + units[unit];
}

const blocks = (n: number) => String(Math.ceil(n / 1024));

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows
    .map((r) =>
      r
        .map((cell, c) => {
          // First and last columns are left-aligned text; the numbers in between align right.
          if (c === 0) return cell.padEnd(widths[c]!);
          if (c === r.length - 1) return cell;
          return cell.padStart(widths[c]!);
        })
        .join(" "),
    )
    .join("\n") + "\n";
}

export const df: Builtin = {
  name: "df",
  summary: "report localStorage space usage",
  usage: USAGE,
  description:
    "Show space used and available in the browser's localStorage, which holds the " +
    "disk as a single entry. Used space counts every localStorage key for this site. " +
    "Browsers don't report the quota (usually 5 MiB), so it's measured on first use by " +
    "probing how much more localStorage accepts. Sizes count characters of stored " +
    "text: one byte each for ASCII.",
  examples: [
    { command: "df", description: "Show usage in 1K blocks." },
    { command: "df -h", description: "Human-readable sizes." },
    { command: "df -hv", description: "Also show how much is the disk vs. other keys." },
  ],
  run(ctx) {
    let options;
    let operands: string[];
    try {
      ({ options, operands } = parseOptions(ctx.args, SPECS));
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`df: ${err.message}\n${USAGE}\n`);
      return 1;
    }
    const lastUnit = options.findLast((o) => o.key === "human" || o.key === "kilo")?.key;
    const isHuman = lastUnit === "human";
    const verbose = options.some((o) => o.key === "verbose");

    // Every path is on the same "filesystem"; just check they exist.
    let status = 0;
    for (const file of operands) {
      if (!ctx.fs.exists(ctx.resolvePath(file))) {
        ctx.stderr(`df: ${file}: No such file or directory\n`);
        status = 1;
      }
    }
    if (operands.length && status !== 0 && operands.every((f) => !ctx.fs.exists(ctx.resolvePath(f)))) {
      return status;
    }

    const usage = ctx.fs.storageUsage();
    if (!usage) {
      ctx.stderr("df: storage usage is unavailable for this disk\n");
      return 1;
    }

    const limited = Number.isFinite(usage.quota);
    const fmt = isHuman ? human : blocks;
    const pct = limited && usage.quota > 0 ? `${Math.ceil((usage.used * 100) / usage.quota)}%` : "-";
    const header = isHuman
      ? ["Filesystem", "Size", "Used", "Avail", "Use%", "Mounted on"]
      : ["Filesystem", "1K-blocks", "Used", "Available", "Use%", "Mounted on"];
    ctx.stdout(
      table([
        header,
        [
          "localStorage",
          limited ? fmt(usage.quota) : "-",
          fmt(usage.used),
          limited ? fmt(usage.available) : "-",
          pct,
          "/",
        ],
      ]),
    );

    if (verbose) {
      const size = (n: number) => (isHuman ? human(n) : `${n}`);
      ctx.stdout(
        `\ndisk (files + directories): ${size(usage.disk)}, ${usage.entries} entries\n` +
          `other localStorage keys:    ${size(usage.used - usage.disk)}\n` +
          (limited ? "" : "(no quota: this disk is in memory and won't persist)\n"),
      );
    }
    return status;
  },
};
