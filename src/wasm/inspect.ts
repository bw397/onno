/**
 * Reads a WebAssembly binary's signatures. The JS API (WebAssembly.Module.exports) gives
 * export names and kinds but not parameter or result types, which `wasm` needs to convert
 * command-line arguments, so the type, import, function, export and start sections are
 * parsed here. Everything else is skipped.
 */

export type ValType = "i32" | "i64" | "f32" | "f64" | "v128" | "funcref" | "externref";

export interface FuncSig {
  params: ValType[];
  results: ValType[];
}

export interface Limits {
  min: number;
  max?: number;
}

export type ExternKind = "function" | "table" | "memory" | "global" | "tag";

export interface ModuleImport {
  module: string;
  name: string;
  kind: ExternKind;
  sig?: FuncSig;
  /** For memory and table imports. */
  limits?: Limits;
}

export interface ModuleExport {
  name: string;
  kind: ExternKind;
  sig?: FuncSig;
}

export interface ModuleInfo {
  imports: ModuleImport[];
  exports: ModuleExport[];
  /** True if the module has a start function (AssemblyScript top-level code), run on instantiation. */
  hasStart: boolean;
}

export const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

export function isWasm(bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((b, i) => bytes[i] === b);
}

const VALTYPES: Record<number, ValType> = {
  0x7f: "i32",
  0x7e: "i64",
  0x7d: "f32",
  0x7c: "f64",
  0x7b: "v128",
  0x70: "funcref",
  0x6f: "externref",
};

const KINDS: ExternKind[] = ["function", "table", "memory", "global", "tag"];

export class WasmFormatError extends Error {
  override name = "WasmFormatError";
}

export function inspectWasm(bytes: Uint8Array): ModuleInfo {
  if (!isWasm(bytes)) throw new WasmFormatError("not a WebAssembly module (bad magic number)");
  let pos = 8; // magic + version
  const decoder = new TextDecoder();

  const byte = () => {
    if (pos >= bytes.length) throw new WasmFormatError("unexpected end of module");
    return bytes[pos++]!;
  };
  const u32 = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = byte();
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new WasmFormatError("bad LEB128 integer");
    }
  };
  const name = () => {
    const len = u32();
    const s = decoder.decode(bytes.subarray(pos, pos + len));
    pos += len;
    return s;
  };
  const valtype = () => {
    const code = byte();
    const t = VALTYPES[code];
    if (!t) throw new WasmFormatError(`unsupported value type 0x${code.toString(16)}`);
    return t;
  };
  const vec = <T>(item: () => T): T[] => Array.from({ length: u32() }, item);
  const limits = (): Limits => {
    const flags = byte();
    const min = u32();
    return flags & 1 ? { min, max: u32() } : { min };
  };

  const types: FuncSig[] = [];
  const imports: ModuleImport[] = [];
  const importedFuncTypes: number[] = [];
  const definedFuncTypes: number[] = [];
  const rawExports: { name: string; kind: ExternKind; index: number }[] = [];
  let hasStart = false;

  while (pos < bytes.length) {
    const id = byte();
    const size = u32();
    const end = pos + size;
    switch (id) {
      case 1: // type
        for (let i = 0, n = u32(); i < n; i++) {
          const form = byte();
          if (form !== 0x60) throw new WasmFormatError(`unsupported type form 0x${form.toString(16)}`);
          types.push({ params: vec(valtype), results: vec(valtype) });
        }
        break;
      case 2: // import
        for (let i = 0, n = u32(); i < n; i++) {
          const imp: ModuleImport = { module: name(), name: name(), kind: KINDS[byte()] ?? "function" };
          if (imp.kind === "function") {
            const typeIndex = u32();
            importedFuncTypes.push(typeIndex);
            imp.sig = types[typeIndex];
          } else if (imp.kind === "table") {
            byte(); // element type
            imp.limits = limits();
          } else if (imp.kind === "memory") {
            imp.limits = limits();
          } else if (imp.kind === "global") {
            valtype();
            byte(); // mutability
          } else {
            byte(); // tag attribute
            u32(); // type index
          }
          imports.push(imp);
        }
        break;
      case 3: // function
        for (let i = 0, n = u32(); i < n; i++) definedFuncTypes.push(u32());
        break;
      case 7: // export
        for (let i = 0, n = u32(); i < n; i++) {
          rawExports.push({ name: name(), kind: KINDS[byte()] ?? "function", index: u32() });
        }
        break;
      case 8: // start
        hasStart = true;
        break;
    }
    pos = end;
  }

  const funcSig = (index: number): FuncSig | undefined => {
    const typeIndex =
      index < importedFuncTypes.length ? importedFuncTypes[index] : definedFuncTypes[index - importedFuncTypes.length];
    return typeIndex === undefined ? undefined : types[typeIndex];
  };

  return {
    imports,
    exports: rawExports.map(({ name, kind, index }) => (kind === "function" ? { name, kind, sig: funcSig(index) } : { name, kind })),
    hasStart,
  };
}

export function formatSig(name: string, sig: FuncSig | undefined): string {
  if (!sig) return `${name}(?)`;
  const results = sig.results.length === 0 ? "" : ` -> ${sig.results.join(", ")}`;
  return `${name}(${sig.params.join(", ")})${results}`;
}

/** Name under which deferStart() exports the module's start function. */
export const DEFERRED_START_EXPORT = "__onno_start";

function encodeU32(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

/**
 * Rewrite a module so its start function doesn't run during instantiation: the start
 * section is removed and the function is exported as DEFERRED_START_EXPORT instead.
 *
 * Why: the start function (AssemblyScript top-level code) runs inside
 * WebAssembly.instantiate(), before the caller has the instance and its exported memory,
 * so host functions like console.log couldn't read the strings it passes. Deferring it
 * lets the runner pick up the memory first and then call the start function itself.
 * Returns null if the module has no start section.
 */
export function deferStart(bytes: Uint8Array): Uint8Array | null {
  if (!isWasm(bytes)) return null;
  // Section boundaries: [id, payload start, end].
  const sections: { id: number; start: number; payload: number; end: number }[] = [];
  let pos = 8;
  const u32At = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[pos++]!;
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
    }
  };
  while (pos < bytes.length) {
    const start = pos;
    const id = bytes[pos++]!;
    const size = u32At();
    sections.push({ id, start, payload: pos, end: pos + size });
    pos += size;
  }
  const startSection = sections.find((s) => s.id === 8);
  if (!startSection) return null;
  pos = startSection.payload;
  const startFunc = u32At();

  const name = new TextEncoder().encode(DEFERRED_START_EXPORT);
  const entry = [...encodeU32(name.length), ...name, 0x00 /* function */, ...encodeU32(startFunc)];
  const exportSection = sections.find((s) => s.id === 7);
  let newExport: number[];
  if (exportSection) {
    pos = exportSection.payload;
    const count = u32At();
    const rest = Array.from(bytes.subarray(pos, exportSection.end));
    const payload = [...encodeU32(count + 1), ...rest, ...entry];
    newExport = [7, ...encodeU32(payload.length), ...payload];
  } else {
    const payload = [...encodeU32(1), ...entry];
    newExport = [7, ...encodeU32(payload.length), ...payload];
  }

  // Rebuild: drop the start section; put the export section where it was (or, if the
  // module had none, where the start section was, which keeps sections in order).
  const parts: number[][] = [Array.from(bytes.subarray(0, 8))];
  for (const s of sections) {
    if (s.id === 7) parts.push(newExport);
    else if (s.id === 8) {
      if (!exportSection) parts.push(newExport);
    } else parts.push(Array.from(bytes.subarray(s.start, s.end)));
  }
  return new Uint8Array(parts.flat());
}
