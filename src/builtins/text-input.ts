import { FsError } from "../fs";
import type { CommandContext } from "../shell";

/** One input for head/tail/wc: a file's bytes, or standard input. */
export interface Input {
  /** Name for headers and wc's output; null for standard input. */
  name: string | null;
  bytes: Uint8Array;
}

/**
 * Read each operand (no operands, or "-", means standard input). Errors are reported as
 * `cmd: file: message` and the input skipped; returns the inputs and whether any failed.
 */
export async function readInputs(ctx: CommandContext, cmd: string, operands: string[]): Promise<{ inputs: Input[]; failed: boolean }> {
  const inputs: Input[] = [];
  let failed = false;
  for (const op of operands.length ? operands : ["-"]) {
    if (op === "-") {
      inputs.push({ name: operands.length ? "-" : null, bytes: new TextEncoder().encode(await ctx.readStdin()) });
      continue;
    }
    try {
      inputs.push({ name: op, bytes: ctx.fs.readBytes(ctx.resolvePath(op)) });
    } catch (err) {
      if (!(err instanceof FsError)) throw err;
      ctx.stderr(`${cmd}: ${op}: ${err.message}\n`);
      failed = true;
    }
  }
  return { inputs, failed };
}

/** Split into lines, keeping each line's "\n" (the last line may lack one). */
export function splitLinesKeepEnds(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** GNU allows the old `-5` form for `-n 5`, except as the value of -n/-c (`-n -5`). */
export function expandNumericShorthand(args: string[]): string[] {
  const takesValue = new Set(["-n", "-c", "--lines", "--bytes"]);
  return args.flatMap((a, i) => (/^-\d+$/.test(a) && !takesValue.has(args[i - 1] ?? "") ? ["-n", a.slice(1)] : [a]));
}
