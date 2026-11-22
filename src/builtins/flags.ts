/**
 * Parse short flags (`-a`, `-la`) from the front of an argument list. Flags may
 * appear anywhere until `--`; a lone `-` is an operand.
 * Returns the set of flags seen and the remaining operands, or the first unknown flag.
 */
export function parseFlags(
  args: string[],
  allowed: string,
): { flags: Set<string>; operands: string[] } | { invalid: string } {
  const flags = new Set<string>();
  const operands: string[] = [];
  let done = false;
  for (const arg of args) {
    if (!done && arg === "--") {
      done = true;
    } else if (!done && arg.startsWith("-") && arg.length > 1) {
      for (const flag of arg.slice(1)) {
        if (!allowed.includes(flag)) return { invalid: flag };
        flags.add(flag);
      }
    } else {
      operands.push(arg);
    }
  }
  return { flags, operands };
}
