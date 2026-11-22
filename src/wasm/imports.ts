/**
 * Host functions a module compiled by asc imports from "env", implemented for the
 * terminal: console.* prints, abort() reports where an assertion failed, trace() prints
 * its message and values, and seed()/Date.now()/performance.now() give times.
 *
 * AssemblyScript passes strings as pointers into linear memory: UTF-16LE data whose byte
 * length is stored in the 4 bytes before the pointer (the object header's rtSize).
 */

export interface WasmOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Thrown by abort(): an AssemblyScript assertion or explicit abort. */
export class WasmAbort extends Error {
  override name = "WasmAbort";
}

export function readAsString(memory: WebAssembly.Memory | undefined, ptr: number): string {
  if (!ptr) return "null";
  if (!memory) return `<string @${ptr}>`;
  const buffer = memory.buffer;
  const byteLength = new DataView(buffer).getUint32(ptr - 4, true);
  return new TextDecoder("utf-16le").decode(new Uint8Array(buffer, ptr, byteLength));
}

export function assemblyScriptImports(getMemory: () => WebAssembly.Memory | undefined, out: WasmOutput) {
  const str = (ptr: number) => readAsString(getMemory(), ptr);
  const timers = new Map<string, number>();
  const line = (write: (t: string) => void) => (ptr: number) => write(str(ptr) + "\n");

  return {
    abort(msg: number, file: number, lineNo: number, column: number): never {
      const where = file ? ` in ${str(file)}(${lineNo}:${column})` : "";
      throw new WasmAbort(`${msg ? str(msg) : "abort"}${where}`);
    },
    trace(msg: number, n: number, ...values: number[]) {
      out.stdout(`trace: ${str(msg)}${n > 0 ? " " + values.slice(0, n).join(", ") : ""}\n`);
    },
    seed: () => Date.now(),
    "Date.now": () => Date.now(),
    "performance.now": () => performance.now(),
    "console.log": line(out.stdout),
    "console.info": line(out.stdout),
    "console.debug": line(out.stdout),
    "console.warn": line(out.stderr),
    "console.error": line(out.stderr),
    "console.assert"(condition: number, msg: number) {
      if (!condition) out.stderr(`Assertion failed: ${str(msg)}\n`);
    },
    "console.time"(label: number) {
      timers.set(str(label), performance.now());
    },
    "console.timeLog"(label: number) {
      const l = str(label);
      const start = timers.get(l);
      if (start !== undefined) out.stdout(`${l}: ${(performance.now() - start).toFixed(3)}ms\n`);
    },
    "console.timeEnd"(label: number) {
      const l = str(label);
      const start = timers.get(l);
      if (start !== undefined) out.stdout(`${l}: ${(performance.now() - start).toFixed(3)}ms\n`);
      timers.delete(l);
    },
  };
}
