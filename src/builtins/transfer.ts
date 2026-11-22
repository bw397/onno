import { path } from "../fs";
import type { CommandContext } from "../shell";

/** One source and where it should end up, for mv and cp. */
export interface Transfer {
  /** As typed, for messages. */
  source: string;
  from: string;
  to: string;
}

/**
 * GNU mv/cp destination rules: with one source, DEST is the new name unless it's an
 * existing directory, in which case the source goes inside it; with several sources,
 * DEST must be an existing directory. Returns null (after reporting) on a usage problem.
 */
export function planTransfers(ctx: CommandContext, cmd: string, operands: string[]): Transfer[] | null {
  if (operands.length < 2) {
    ctx.stderr(operands.length ? `${cmd}: missing destination file operand after '${operands[0]}'\n` : `${cmd}: missing file operand\n`);
    return null;
  }
  const dest = operands[operands.length - 1]!;
  const sources = operands.slice(0, -1);
  const destAbs = ctx.resolvePath(dest);
  const destIsDir = ctx.fs.isDir(destAbs);
  if (sources.length > 1 && !destIsDir) {
    ctx.stderr(`${cmd}: target '${dest}' is not a directory\n`);
    return null;
  }
  return sources.map((source) => {
    const from = ctx.resolvePath(source);
    return { source, from, to: destIsDir ? path.join(destAbs, path.basename(from)) : destAbs };
  });
}

/** True if `abs` is the working directory or one of its parents. */
export function containsCwd(ctx: CommandContext, abs: string): boolean {
  const cwd = ctx.shell.cwd;
  return cwd === abs || cwd.startsWith(abs === "/" ? "/" : abs + "/");
}
