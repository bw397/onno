/**
 * File content is either text (a string) or binary (bytes). Valid UTF-8 is kept as a
 * string so text tools stay cheap; anything else is stored as raw bytes.
 */
export type FileContent = string | Uint8Array;

const encoder = new TextEncoder();

export function byteLength(content: FileContent): number {
  return typeof content === "string" ? encoder.encode(content).byteLength : content.byteLength;
}

/** Text view of content. Binary is decoded as UTF-8, with U+FFFD for invalid bytes. */
export function toText(content: FileContent): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

export function toBytes(content: FileContent): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

/** Bytes from a file or the network: a string if they're clean UTF-8 text, else bytes. */
export function fromBytes(bytes: Uint8Array): FileContent {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? bytes : text;
  } catch {
    return bytes;
  }
}

export function concat(a: FileContent, b: FileContent): FileContent {
  if (typeof a === "string" && typeof b === "string") return a + b;
  const left = toBytes(a);
  const right = toBytes(b);
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left);
  out.set(right, left.byteLength);
  return out;
}
