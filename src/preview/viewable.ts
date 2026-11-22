/**
 * Which files the browser can display, and how. Content is sniffed from its first
 * bytes ("magic numbers") because names from uploads or curl -o can be wrong or
 * missing; the extension is only a fallback.
 */

export type ViewKind = "image" | "pdf" | "audio" | "video";

export interface Viewable {
  kind: ViewKind;
  mime: string;
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

/** Identify content by its signature. */
function sniff(bytes: Uint8Array): Viewable | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (ascii(bytes, 0, 4) === "GIF8") return { kind: "image", mime: "image/gif" };
  if (ascii(bytes, 0, 2) === "BM" && bytes.length > 14) return { kind: "image", mime: "image/bmp" };
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return { kind: "image", mime: "image/x-icon" };
  if (ascii(bytes, 0, 5) === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  if (ascii(bytes, 0, 4) === "fLaC") return { kind: "audio", mime: "audio/flac" };
  if (ascii(bytes, 0, 4) === "OggS") {
    // Ogg holds audio or video; Theora in the first page means video.
    return ascii(bytes, 28, 7).includes("theora") ? { kind: "video", mime: "video/ogg" } : { kind: "audio", mime: "audio/ogg" };
  }
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) {
    return { kind: "audio", mime: "audio/mpeg" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video", mime: "video/webm" };
  if (ascii(bytes, 0, 4) === "RIFF") {
    const type = ascii(bytes, 8, 4);
    if (type === "WEBP") return { kind: "image", mime: "image/webp" };
    if (type === "WAVE") return { kind: "audio", mime: "audio/wav" };
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    // ISO base media: the brand says what's inside.
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return { kind: "image", mime: "image/avif" };
    if (brand.startsWith("M4A") || brand.startsWith("M4B")) return { kind: "audio", mime: "audio/mp4" };
    if (brand === "qt  ") return { kind: "video", mime: "video/quicktime" };
    return { kind: "video", mime: "video/mp4" };
  }
  // SVG is text: look for an <svg> element near the start.
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return { kind: "image", mime: "image/svg+xml" };
  }
  return null;
}

const BY_EXTENSION: Record<string, Viewable> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  avif: { kind: "image", mime: "image/avif" },
  bmp: { kind: "image", mime: "image/bmp" },
  ico: { kind: "image", mime: "image/x-icon" },
  svg: { kind: "image", mime: "image/svg+xml" },
  pdf: { kind: "pdf", mime: "application/pdf" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  oga: { kind: "audio", mime: "audio/ogg" },
  flac: { kind: "audio", mime: "audio/flac" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  webm: { kind: "video", mime: "video/webm" },
  ogv: { kind: "video", mime: "video/ogg" },
  mov: { kind: "video", mime: "video/quicktime" },
};

/** How to display a file, or null if the browser can't show it. */
export function detectViewable(name: string, bytes: Uint8Array): Viewable | null {
  const sniffed = sniff(bytes);
  if (sniffed) return sniffed;
  // Unrecognised content: trust the extension, except for empty or plain-text files.
  if (bytes.length === 0) return null;
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const byExt = ext ? BY_EXTENSION[ext] : undefined;
  if (byExt && byExt.mime !== "image/svg+xml" && !isPlainText(bytes)) return byExt;
  return null;
}

/** True if the bytes are valid UTF-8 without NULs: probably a text file. */
export function isPlainText(bytes: Uint8Array): boolean {
  try {
    return !new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\u0000");
  } catch {
    return false;
  }
}
