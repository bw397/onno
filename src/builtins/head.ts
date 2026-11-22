import type { Builtin } from "../shell";
import { OptionError, parseOptions } from "./options";
import { expandNumericShorthand, readInputs, splitLinesKeepEnds } from "./text-input";

/** Shared by head and tail: parse -n/-c (and -q/-v), returning a mode and count. */
export function parseCount(args: string[], cmd: string) {
  const { options, operands } = parseOptions(expandNumericShorthand(args), [
    { key: "n", short: "n", long: "lines", value: true },
    { key: "c", short: "c", long: "bytes", value: true },
    { key: "q", short: "q", long: "quiet" },
    { key: "v", short: "v", long: "verbose" },
  ]);
  const last = options.findLast((o) => o.key === "n" || o.key === "c");
  const raw = last?.value ?? "10";
  const m = /^([+-]?)(\d+)$/.exec(raw);
  if (!m) throw new OptionError(`invalid number of ${last?.key === "c" ? "bytes" : "lines"}: '${raw}'`);
  const headers = options.findLast((o) => o.key === "q" || o.key === "v")?.key;
  return {
    bytes: last?.key === "c",
    count: Number(m[2]),
    sign: m[1] as "" | "+" | "-",
    operands,
    headers: headers === "v" ? true : headers === "q" ? false : undefined,
    cmd,
  };
}

export const head: Builtin = {
  name: "head",
  summary: "print the first lines of files",
  usage: `head [-n N] [-c N] [-q] [-v] [FILE]...
  -n N    print the first N lines (default 10); -n -N prints all but the last N
  -c N    print the first N bytes; -c -N prints all but the last N
  -q, -v  never / always print "==> FILE <==" headers`,
  description:
    "Print the beginning of each FILE (or standard input). With several files, each is " +
    "preceded by a header. head -5 is short for head -n 5.",
  examples: [
    { command: "head -n 3 welcome.txt", description: "The first three lines." },
    { command: "head -c 7 /etc/motd", description: "The first seven bytes." },
    { command: "head -1 welcome.txt /etc/motd", description: "The first line of each file, with headers." },
    { command: "man ls | head", description: "The first ten lines of a command's output." },
  ],
  async run(ctx) {
    let opts;
    try {
      opts = parseCount(ctx.args, "head");
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`head: ${err.message}\nusage: ${head.usage}\n`);
      return 2;
    }
    const { inputs, failed } = await readInputs(ctx, "head", opts.operands);
    const showHeaders = opts.headers ?? opts.operands.length > 1;
    inputs.forEach((input, i) => {
      if (showHeaders) ctx.stdout(`${i ? "\n" : ""}==> ${input.name ?? "standard input"} <==\n`);
      if (opts.bytes) {
        const end = opts.sign === "-" ? Math.max(0, input.bytes.length - opts.count) : opts.count;
        ctx.stdout(new TextDecoder().decode(input.bytes.subarray(0, end)));
      } else {
        const lines = splitLinesKeepEnds(new TextDecoder().decode(input.bytes));
        const end = opts.sign === "-" ? Math.max(0, lines.length - opts.count) : opts.count;
        ctx.stdout(lines.slice(0, end).join(""));
      }
    });
    return failed ? 1 : 0;
  },
};
