import type { Builtin } from "../shell";
import { parseCount } from "./head";
import { OptionError } from "./options";
import { readInputs, splitLinesKeepEnds } from "./text-input";

export const tail: Builtin = {
  name: "tail",
  summary: "print the last lines of files",
  usage: `tail [-n N] [-c N] [-q] [-v] [FILE]...
  -n N    print the last N lines (default 10); -n +N starts at line N
  -c N    print the last N bytes; -c +N starts at byte N
  -q, -v  never / always print "==> FILE <==" headers`,
  description:
    "Print the end of each FILE (or standard input). With several files, each is preceded " +
    "by a header. tail -5 is short for tail -n 5.",
  examples: [
    { command: "tail -n 2 welcome.txt", description: "The last two lines." },
    { command: "tail -n +3 welcome.txt", description: "Everything from line 3 on." },
    { command: "man grep | tail -3", description: "The last three lines of a command's output." },
  ],
  async run(ctx) {
    let opts;
    try {
      opts = parseCount(ctx.args, "tail");
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`tail: ${err.message}\nusage: ${tail.usage}\n`);
      return 2;
    }
    const { inputs, failed } = await readInputs(ctx, "tail", opts.operands);
    const showHeaders = opts.headers ?? opts.operands.length > 1;
    // +N counts from the start (1-based); otherwise from the end.
    const from = (length: number) => (opts.sign === "+" ? Math.max(0, opts.count - 1) : Math.max(0, length - opts.count));
    inputs.forEach((input, i) => {
      if (showHeaders) ctx.stdout(`${i ? "\n" : ""}==> ${input.name ?? "standard input"} <==\n`);
      if (opts.bytes) {
        ctx.stdout(new TextDecoder().decode(input.bytes.subarray(from(input.bytes.length))));
      } else {
        const lines = splitLinesKeepEnds(new TextDecoder().decode(input.bytes));
        ctx.stdout(lines.slice(from(lines.length)).join(""));
      }
    });
    return failed ? 1 : 0;
  },
};
