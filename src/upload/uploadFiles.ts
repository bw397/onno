import { FsError, path, type VirtualFS } from "../fs";

export type UploadResult =
  | { ok: true; name: string; path: string; size: number; renamed: boolean }
  | { ok: false; name: string; error: string };

/** The parts of a browser File we use (so tests can pass plain objects too). */
export interface UploadSource {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

class BinaryFileError extends Error {}

/** Decode as UTF-8 text, rejecting anything that looks binary. */
function decodeText(bytes: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BinaryFileError();
  }
  if (text.includes("\u0000")) throw new BinaryFileError();
  return text;
}

/** `notes.txt` -> `notes-1.txt`, `notes-2.txt`, ... until the name is free. */
export function uniqueName(fs: VirtualFS, dir: string, name: string): string {
  if (!fs.exists(path.join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.exists(path.join(dir, candidate))) return candidate;
  }
}

/**
 * Copy files from the user's machine into `dir` on the virtual disk. Existing files
 * are never overwritten; a numbered name is chosen instead. Each file succeeds or
 * fails on its own.
 */
export async function uploadFiles(fs: VirtualFS, dir: string, files: Iterable<UploadSource>): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  for (const file of files) {
    try {
      const content = decodeText(await file.arrayBuffer());
      const name = uniqueName(fs, dir, file.name);
      const target = path.join(dir, name);
      fs.writeFile(target, content);
      results.push({ ok: true, name: file.name, path: target, size: file.size, renamed: name !== file.name });
    } catch (err) {
      let error: string;
      if (err instanceof BinaryFileError) error = "binary files aren't supported (the disk stores text)";
      else if (err instanceof FsError) error = err.message;
      else error = err instanceof Error ? err.message : String(err);
      results.push({ ok: false, name: file.name, error });
    }
  }
  return results;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
