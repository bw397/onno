import { assemblyScriptImports, WasmAbort, type WasmOutput } from "./imports";
import { DEFERRED_START_EXPORT, deferStart, formatSig, inspectWasm, type FuncSig, type ModuleInfo, type ValType } from "./inspect";

/**
 * Runs a WebAssembly module: instantiates it (which runs its start function, i.e.
 * AssemblyScript top-level code), then calls the requested export, or `_start` / `main`
 * if none was named, with arguments converted to the function's parameter types.
 * Works on any thread; the browser runs it in a Web Worker (worker.ts).
 */

export interface RunRequest {
  bytes: Uint8Array;
  /** Name to show in messages (the path as typed). */
  name: string;
  /** Export to call; undefined = `_start`, else `main`, else just instantiate. */
  func?: string;
  args: string[];
  /** List the exports instead of running. */
  list?: boolean;
}

class ArgError extends Error {}

function parseArg(arg: string, type: ValType | undefined, index: number): number | bigint {
  const fail = (what: string): never => {
    throw new ArgError(`argument ${index + 1} ('${arg}') isn't ${what}`);
  };
  switch (type) {
    case "i64":
      try {
        return BigInt(arg);
      } catch {
        return fail("an integer (i64)");
      }
    case "f32":
    case "f64": {
      const lower = arg.toLowerCase();
      if (lower === "nan") return NaN;
      if (lower === "inf" || lower === "infinity") return Infinity;
      if (lower === "-inf" || lower === "-infinity") return -Infinity;
      const n = Number(arg);
      return arg.trim() !== "" && !Number.isNaN(n) ? n : fail(`a number (${type})`);
    }
    case "i32":
    case undefined: {
      if (arg === "true") return 1;
      if (arg === "false") return 0;
      const n = Number(arg);
      if (arg.trim() === "" || !Number.isInteger(n)) return fail("an integer (i32)");
      if (n < -(2 ** 31) || n >= 2 ** 32) return fail("in i32 range");
      return n;
    }
    default:
      return fail(`passable from the command line (${type})`);
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (value === undefined) return "";
  return String(value);
}

/** Report an error thrown while instantiating or calling. Returns the exit status. */
function report(err: unknown, out: WasmOutput): number {
  if (err instanceof WasmAbort) out.stderr(`wasm: abort: ${err.message}\n`);
  else if (err instanceof WebAssembly.RuntimeError) out.stderr(`wasm: trap: ${err.message}\n`);
  else if (err instanceof RangeError && /call stack/i.test(err.message)) out.stderr("wasm: trap: call stack exhausted\n");
  else out.stderr(`wasm: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

function functionList(info: ModuleInfo | null, exports: WebAssembly.Exports): string[] {
  if (info) return info.exports.filter((e) => e.kind === "function").map((e) => formatSig(e.name, e.sig));
  return Object.keys(exports).filter((k) => k !== DEFERRED_START_EXPORT && typeof exports[k] === "function");
}

export async function runWasm(req: RunRequest, out: WasmOutput): Promise<number> {
  // Run the start function ourselves, after instantiation, so host functions can read
  // the strings it passes (see deferStart).
  const deferred = deferStart(req.bytes);
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile((deferred ?? req.bytes) as BufferSource);
  } catch (err) {
    out.stderr(`wasm: ${req.name}: invalid module: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  // Signatures are a convenience: without them, arguments are passed as plain numbers.
  let info: ModuleInfo | null = null;
  try {
    info = inspectWasm(req.bytes);
  } catch {
    info = null;
  }

  if (req.list) {
    const lines = info
      ? info.exports.map((e) => (e.kind === "function" ? formatSig(e.name, e.sig) : `${e.name} (${e.kind})`))
      : WebAssembly.Module.exports(module)
          .filter((e) => e.name !== DEFERRED_START_EXPORT)
          .map((e) => `${e.name} (${e.kind})`);
    out.stdout(lines.length ? lines.join("\n") + "\n" : "(no exports)\n");
    return 0;
  }

  // Imports: the AssemblyScript host functions, plus memory/table if the module imports them.
  let memory: WebAssembly.Memory | undefined;
  const env: Record<string, unknown> = assemblyScriptImports(() => memory, out);
  const missing: string[] = [];
  for (const imp of WebAssembly.Module.imports(module)) {
    const limits = info?.imports.find((i) => i.module === imp.module && i.name === imp.name)?.limits;
    if (imp.module === "env" && imp.kind === "memory") {
      memory = new WebAssembly.Memory({ initial: limits?.min ?? 1, maximum: limits?.max });
      env[imp.name] = memory;
    } else if (imp.module === "env" && imp.kind === "table") {
      env[imp.name] = new WebAssembly.Table({ initial: limits?.min ?? 0, maximum: limits?.max, element: "anyfunc" });
    } else if (imp.module !== "env" || !(imp.name in env)) {
      missing.push(`${imp.module}.${imp.name} (${imp.kind})`);
    }
  }
  if (missing.length) {
    out.stderr(`wasm: ${req.name} needs imports onno doesn't provide:\n${missing.map((m) => `  ${m}\n`).join("")}`);
    return 1;
  }

  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(module, { env: env as WebAssembly.ModuleImports });
  } catch (err) {
    return report(err, out);
  }
  const exportedMemory = instance.exports.memory;
  if (exportedMemory instanceof WebAssembly.Memory) memory = exportedMemory;
  if (deferred) {
    try {
      (instance.exports[DEFERRED_START_EXPORT] as () => void)();
    } catch (err) {
      return report(err, out); // the start function (top-level code) failed
    }
  }

  const exported = (name: string) =>
    name !== DEFERRED_START_EXPORT && typeof instance.exports[name] === "function"
      ? (instance.exports[name] as (...a: unknown[]) => unknown)
      : undefined;
  const sigOf = (name: string): FuncSig | undefined => info?.exports.find((e) => e.name === name && e.kind === "function")?.sig;

  // Which function to call.
  let func = req.func;
  const implicit = func === undefined;
  if (implicit) {
    func = exported("_start") ? "_start" : exported("main") ? "main" : undefined;
    if (func === undefined) {
      if (!info?.hasStart) {
        const fns = functionList(info, instance.exports);
        out.stderr(
          `wasm: ${req.name} has no main or _start function to run.\n` +
            (fns.length ? `Its exported functions:\n${fns.map((f) => `  ${f}\n`).join("")}Call one: wasm ${req.name} NAME [ARG...]\n` : ""),
        );
      }
      return 0;
    }
  }
  const fn = exported(func!);
  if (!fn) {
    const fns = functionList(info, instance.exports);
    out.stderr(`wasm: ${req.name} doesn't export a function '${func}'${fns.length ? `; it has:\n${fns.map((f) => `  ${f}\n`).join("")}` : "\n"}`);
    return 1;
  }

  const sig = sigOf(func!);
  let args: (number | bigint)[];
  try {
    if (sig && req.args.length !== sig.params.length) {
      throw new ArgError(`expects ${sig.params.length} argument${sig.params.length === 1 ? "" : "s"}, got ${req.args.length}`);
    }
    args = req.args.map((a, i) => parseArg(a, sig?.params[i], i));
  } catch (err) {
    if (!(err instanceof ArgError)) throw err;
    out.stderr(`wasm: ${formatSig(func!, sig)}: ${err.message}\n`);
    return 2;
  }

  let result: unknown;
  try {
    result = fn(...args);
  } catch (err) {
    return report(err, out);
  }

  // An implicit main/_start returning an integer is the exit status (the C convention);
  // an explicitly called function's results are printed.
  if (implicit && typeof result === "number") return result & 0xff;
  const values = Array.isArray(result) ? result : sig?.results.length || result !== undefined ? [result] : [];
  if (values.length) out.stdout(values.map(formatValue).join(" ") + "\n");
  return 0;
}
