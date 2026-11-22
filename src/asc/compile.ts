import { FsError, path, type FileContent, type VirtualFS } from "../fs";

/**
 * Runs the AssemblyScript compiler (assemblyscript/asc). Arguments go to asc.main()
 * unchanged, exactly as the `asc` executable passes them, so every compiler option works;
 * only file access is redirected, relative to the shell's working directory.
 *
 * In the browser this runs inside a Web Worker (worker.ts / client.ts), where file access
 * is forwarded to the main thread; tests run it in-process (inprocess.ts). This module
 * must not import assemblyscript itself (only its types): any import() of it in app code
 * would pull the 20 MB compiler into the main bundle.
 */

/** Disk access and output for one compiler run. Paths are absolute. Methods may be async. */
export interface AscHost {
  cwd: string;
  readFile(path: string): string | null | Promise<string | null>;
  writeFile(path: string, contents: FileContent): void | Promise<void>;
  listFiles(path: string): string[] | null | Promise<string[] | null>;
  stdout(text: string): void;
  stderr(text: string): void;
}

export type AscModule = typeof import("assemblyscript/asc");

export const BINARY_STDOUT_MESSAGE =
  "asc: the WebAssembly binary wasn't written: it can't go to the terminal or through a pipe (they carry text). Use -o FILE.\n";

/** Run asc with `argv` (as typed after "asc"). Returns the exit status, like bin/asc.js. */
export async function compileWith(asc: AscModule, argv: string[], host: AscHost): Promise<number> {
  // asc passes paths relative to a baseDir, which is itself relative to the working directory.
  const resolve = (file: string, baseDir = ".") => path.resolve(path.resolve(host.cwd, baseDir), file);
  const decoder = new TextDecoder();
  let droppedBinary = false;

  const { error } = await asc.main(argv, {
    // Minimal streams: no isTTY, so asc doesn't emit colour codes.
    stdout: {
      write(chunk: string | Uint8Array) {
        // `-o` without a file name writes the binary module to stdout; shell output is
        // text, so refuse rather than corrupt it.
        if (typeof chunk === "string") host.stdout(chunk);
        else droppedBinary = true;
        return true;
      },
    } as never,
    stderr: {
      write(chunk: string | Uint8Array) {
        host.stderr(typeof chunk === "string" ? chunk : decoder.decode(chunk));
        return true;
      },
    } as never,
    readFile: (file, baseDir) => host.readFile(resolve(file, baseDir)),
    writeFile: (file, contents, baseDir) => host.writeFile(resolve(file, baseDir), contents),
    listFiles: (dirname, baseDir) => host.listFiles(resolve(dirname, baseDir)),
  });

  if (droppedBinary) {
    host.stderr(BINARY_STDOUT_MESSAGE);
    return 1;
  }
  return error ? 1 : 0;
}

/** Disk access straight against a VirtualFS (used in-process, and by the worker client). */
export function fsAccess(fs: VirtualFS) {
  return {
    readFile(abs: string): string | null {
      return fs.stat(abs)?.type === "file" ? fs.readFile(abs) : null;
    },
    writeFile(abs: string, contents: FileContent): void {
      // Like asc on Node, create the output directory if needed.
      fs.mkdir(path.dirname(abs), { recursive: true });
      fs.writeFile(abs, contents);
    },
    listFiles(abs: string): string[] | null {
      try {
        return fs.readdir(abs).filter((name) => fs.stat(path.join(abs, name))?.type === "file");
      } catch (err) {
        if (err instanceof FsError) return null;
        throw err;
      }
    },
  };
}
