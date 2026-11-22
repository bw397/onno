import type { Builtin } from "../shell";
import { wc } from "./wc";
import { touch } from "./touch";
import { tail } from "./tail";
import { mv } from "./mv";
import { head } from "./head";
import { cp } from "./cp";
import { asc } from "./asc";
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
import { wasm } from "./wasm";

/** To add a builtin: create a file exporting a `Builtin`, then list it here. */
export const builtins: Builtin[] = [
  asc, cat, cd, cp, curl, df, echo, find, grep, head, ls, man, mkdir, mon, mv, preview, pwd, rm, tail, touch, wasm, wc,
];

export function createBuiltinRegistry(list: Builtin[] = builtins): Map<string, Builtin> {
  return new Map(list.map((b) => [b.name, b]));
}
