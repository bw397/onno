/**
 * Getopt-style option parsing shared by builtins.
 *
 *   -abc          bundled short flags
 *   -e PAT, -ePAT short option with a value (separate or attached)
 *   --long, --long=VALUE, --long VALUE
 *   --            ends options; a lone "-" is an operand (usually stdin)
 *
 * Options and operands may be interleaved. Options are returned in order, so
 * repeatable ones (-e, -H) keep every value.
 */

export interface OptionSpec {
  /** Name the command uses to identify the option. */
  key: string;
  /** Single-letter form, without the dash. */
  short?: string;
  /** Long form, without the dashes. */
  long?: string;
  /** Whether the option takes a value. */
  value?: boolean;
}

export interface ParsedOption {
  key: string;
  value?: string;
}

export class OptionError extends Error {
  override name = "OptionError";
}

export function parseOptions(args: string[], specs: OptionSpec[]): { options: ParsedOption[]; operands: string[] } {
  const byShort = new Map(specs.filter((s) => s.short).map((s) => [s.short!, s]));
  const byLong = new Map(specs.filter((s) => s.long).map((s) => [s.long!, s]));
  const options: ParsedOption[] = [];
  const operands: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const nextValue = (label: string) => {
      const v = args[++i];
      if (v === undefined) throw new OptionError(`option '${label}' requires an argument`);
      return v;
    };

    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const spec = byLong.get(name);
      if (!spec) throw new OptionError(`unrecognized option '--${name}'`);
      if (spec.value) {
        options.push({ key: spec.key, value: eq === -1 ? nextValue(`--${name}`) : arg.slice(eq + 1) });
      } else {
        if (eq !== -1) throw new OptionError(`option '--${name}' doesn't allow an argument`);
        options.push({ key: spec.key });
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j]!;
        const spec = byShort.get(c);
        if (!spec) throw new OptionError(`invalid option -- '${c}'`);
        if (spec.value) {
          options.push({ key: spec.key, value: j + 1 < arg.length ? arg.slice(j + 1) : nextValue(`-${c}`) });
          break;
        }
        options.push({ key: spec.key });
      }
      continue;
    }

    operands.push(arg);
  }
  return { options, operands };
}
