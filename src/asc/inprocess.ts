/**
 * Runs the compiler on the current thread. For tests (and other non-browser use) only:
 * importing this pulls in the whole compiler, so app code must not import it.
 */
import * as asc from "assemblyscript/asc";
import type { VirtualFS } from "../fs";
import { compileWith, fsAccess } from "./compile";

export function runAscInProcess(
  argv: string[],
  io: { fs: VirtualFS; cwd: string; stdout(text: string): void; stderr(text: string): void },
): Promise<number> {
  return compileWith(asc, argv, { cwd: io.cwd, stdout: io.stdout, stderr: io.stderr, ...fsAccess(io.fs) });
}
