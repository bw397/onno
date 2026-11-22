import type { Builtin } from "../shell";
import { cat } from "./cat";
import { cd } from "./cd";
import { curl } from "./curl";
import { df } from "./df";
import { echo } from "./echo";
import { find } from "./find";
import { grep } from "./grep";
import { ls } from "./ls";
import { man } from "./man";
import { mkdir } from "./mkdir";
import { mon } from "./mon";
import { preview } from "./preview";
import { pwd } from "./pwd";
import { rm } from "./rm";

/** To add a builtin: create a file exporting a `Builtin`, then list it here. */
export const builtins: Builtin[] = [cat, cd, curl, df, echo, find, grep, ls, man, mkdir, mon, preview, pwd, rm];

export function createBuiltinRegistry(list: Builtin[] = builtins): Map<string, Builtin> {
  return new Map(list.map((b) => [b.name, b]));
}
