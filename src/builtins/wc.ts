import type { Builtin } from "../shell";
import { OptionError, parseOptions } from "./options";
import { readInputs } from "./text-input";

type Count = "lines" | "words" | "chars" | "bytes";

export const wc: Builtin = {
  name: "wc",
  summary: "count lines, words and bytes",
  usage: `wc [-l] [-w] [-m] [-c] [FILE]...
  -l   lines (newline characters)
  -w   words (runs of non-whitespace)
  -m   characters
  -c   bytes`,
  description:
    "Print line, word and byte counts for each FILE (or standard input), plus a total " +
    "when there are several files. Options choose which counts to show; they always " +
    "appear in the order lines, words, characters, bytes.",
  examples: [
    { command: "wc welcome.txt", description: "Lines, words and bytes." },
    { command: "wc -l welcome.txt /etc/motd", description: "Line counts for two files, and a total." },
    { command: "ls / | wc -w", description: "Count words in another command's output." },
  ],
  run(ctx) {
    let parsed;
    try {
      parsed = parseOptions(ctx.args, [
        { key: "lines", short: "l", long: "lines" },
        { key: "words", short: "w", long: "words" },
        { key: "chars", short: "m", long: "chars" },
        { key: "bytes", short: "c", long: "bytes" },
      ]);
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`wc: ${err.message}\nusage: ${wc.usage}\n`);
      return 2;
    }
    const chosen = new Set(parsed.options.map((o) => o.key as Count));
    const order: Count[] = ["lines", "words", "chars", "bytes"];
    const shown = chosen.size ? order.filter((c) => chosen.has(c)) : (["lines", "words", "bytes"] as Count[]);

    const { inputs, failed } = readInputs(ctx, "wc", parsed.operands);
    const rows = inputs.map((input) => {
      const text = new TextDecoder().decode(input.bytes);
      const counts: Record<Count, number> = {
        lines: (text.match(/\n/g) ?? []).length,
        words: (text.match(/\S+/g) ?? []).length,
        chars: [...text].length,
        bytes: input.bytes.length,
      };
      return { name: input.name, counts };
    });
    if (rows.length > 1) {
      const total = { lines: 0, words: 0, chars: 0, bytes: 0 };
      for (const r of rows) for (const c of order) total[c] += r.counts[c];
      rows.push({ name: "total", counts: total });
    }

    // Right-align every number to the widest one, as GNU wc does. With standard input
    // (size unknown in advance) and several counts, GNU uses a minimum width of 7.
    const fromStdin = inputs.some((i) => i.name === null || i.name === "-");
    const width = Math.max(
      fromStdin && shown.length > 1 ? 7 : 1,
      ...rows.flatMap((r) => shown.map((c) => String(r.counts[c]).length)),
    );
    for (const r of rows) {
      const nums = shown.map((c) => String(r.counts[c]).padStart(width)).join(" ");
      ctx.stdout(r.name === null ? `${nums}\n` : `${nums} ${r.name}\n`);
    }
    return failed ? 1 : 0;
  },
};
