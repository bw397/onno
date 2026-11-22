/// <reference lib="webworker" />
/**
 * Web Worker that runs the AssemblyScript compiler off the main thread. File access is
 * forwarded to the main thread (client.ts), which owns the VirtualFS. Bundled separately
 * (see src/workers.ts) and served at /asc/asc.worker.js.
 */
import { compileWith } from "./compile";
import type { FromWorker, ToWorker } from "./protocol";

// Loaded with import(), not a static import: the compiler uses top-level await, and a
// static import would delay this module (and the onmessage handler below) until it had
// loaded. Messages that arrive before a handler exists are silently dropped.
const ascReady = import("assemblyscript/asc");

const post = (msg: FromWorker) => self.postMessage(msg);

let nextId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();

/** A disk request without its id (Omit applied to each union member). */
type FsRequest = Extract<FromWorker, { type: "fs" }> extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

/** Ask the main thread to perform a disk operation, and wait for the answer. */
function fsCall<T>(msg: FsRequest): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ ...msg, id } as FromWorker);
  });
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  if (msg.type === "fs-result") {
    const call = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error !== undefined) call?.reject(new Error(msg.error));
    else call?.resolve(msg.result ?? null);
    return;
  }

  try {
    const asc = await ascReady;
    const status = await compileWith(asc, msg.argv, {
      cwd: msg.cwd,
      readFile: (path) => fsCall<string | null>({ type: "fs", op: "readFile", path }),
      listFiles: (path) => fsCall<string[] | null>({ type: "fs", op: "listFiles", path }),
      writeFile: (path, contents) => fsCall<void>({ type: "fs", op: "writeFile", path, contents }),
      stdout: (text) => post({ type: "stdout", text }),
      stderr: (text) => post({ type: "stderr", text }),
    });
    post({ type: "done", status });
  } catch (err) {
    post({ type: "crash", message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
};

// The handler is installed: tell the client it's safe to send work.
post({ type: "ready" });
