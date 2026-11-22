import type { Builtin } from "../shell";
import { OptionError, parseOptions, type OptionSpec } from "./options";

const USAGE = `usage: df [-h] [-k] [-v] [FILE]...
  -h   human-readable sizes (K, M, G)
  -k   1K blocks (default)
  -v   also show the disk's size, entry count and whether storage is persistent`;

const SPECS: OptionSpec[] = [
  { key: "human", short: "h", long: "human-readable" },
  { key: "kilo", short: "k" },
  { key: "verbose", short: "v", long: "verbose" },
];

/** GNU df -h style: powers of 1024, one decimal below 10, rounded up. */
export function human(n: number): string {
  const units = ["", "K", "M", "G", "T", "P"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return String(n);
  const rounded = value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value);
  return (value < 10 ? rounded.toFixed(1) : String(rounded)) + units[unit];
}

const blocks = (n: number) => String(Math.ceil(n / 1024));

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return (
    rows
      .map((r) =>
        r
          .map((cell, c) => {
            // First and last columns are text; the numbers in between align right.
            if (c === 0) return cell.padEnd(widths[c]!);
            if (c === r.length - 1) return cell;
            return cell.padStart(widths[c]!);
          })
          .join(" "),
      )
      .join("\n") + "\n"
  );
}

export const df: Builtin = {
  name: "df",
  summary: "report browser storage space usage",
  usage: USAGE,
  description:
    "Show space used and available for this site's browser storage, which holds the disk " +
    "in IndexedDB. Figures come from the browser (navigator.storage.estimate()): usage " +
    "covers everything this site stores and may be rounded or padded, and the quota is " +
    "usually a large share of free disk space. Browsers may evict non-persistent storage " +
    "when the device runs low on space; -v shows whether this site's storage is persistent.",
  examples: [
    { command: "df", description: "Show usage in 1K blocks." },
    { command: "df -h", description: "Human-readable sizes." },
    { command: "df -hv", description: "Also show the disk's own size and persistence." },
  ],
  async run(ctx) {
    let options;
    let operands: string[];
    try {
      ({ options, operands } = parseOptions(ctx.args, SPECS));
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`df: ${err.message}\n${USAGE}\n`);
      return 1;
    }
    const isHuman = options.findLast((o) => o.key === "human" || o.key === "kilo")?.key === "human";
    const verbose = options.some((o) => o.key === "verbose");

    // Every path is on the same "filesystem"; just check they exist.
    const missing = operands.filter((f) => !ctx.fs.exists(ctx.resolvePath(f)));
    for (const file of missing) ctx.stderr(`df: ${file}: No such file or directory\n`);
    if (operands.length && missing.length === operands.length) return 1;

    const usage = await ctx.fs.storageUsage();
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
          usage.durable ? "indexeddb" : "memory",
          limited ? fmt(usage.quota) : "-",
          fmt(usage.used),
          limited ? fmt(usage.available) : "-",
          pct,
          "/",
        ],
      ]),
    );

    if (verbose) {
      const size = (n: number) => (isHuman ? human(n) : `${n} bytes`);
      const persistence = !usage.durable
        ? "none: this disk is in memory and won't survive a reload"
        : usage.persisted === true
          ? "persistent (the browser won't evict it)"
          : usage.persisted === false
            ? "best-effort (the browser may evict it if the device runs low on space)"
            : "unknown";
      ctx.stdout(`\ndisk: ${size(usage.disk)} in ${usage.entries} files and directories\nstorage: ${persistence}\n`);
    }
    return missing.length ? 1 : 0;
  },
};
