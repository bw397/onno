import { FsError, type VirtualFS } from "../fs";
import { fsAccess } from "./compile";
import type { FromWorker, ToWorker } from "./protocol";

/**
 * Main-thread side of the compiler worker: starts it, services its disk requests from
 * the VirtualFS, and relays output. One compile at a time; the worker is kept between
 * runs (loading the compiler takes ~0.5 s) and killed on Ctrl+C or failure.
 *
 * Work is only posted after the worker says "ready" (its message handler is installed),
 * and a worker that never gets ready is reported rather than waited on forever.
 */

export interface WorkerRunIO {
  fs: VirtualFS;
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  signal?: AbortSignal;
}

/** How long a new worker may take to start (download ~21 MB, then evaluate). */
export const READY_TIMEOUT_MS = 20_000;

interface LiveWorker {
  worker: Worker;
  /** Resolves when the worker reports "ready"; rejects if it fails to load or times out. */
  ready: Promise<void>;
}

let live: LiveWorker | null = null;
let busy = false;

function startWorker(): LiveWorker {
  const worker = new Worker(new URL("asc/asc.worker.js", document.baseURI), { type: "module" });
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent<FromWorker>) => {
      if (event.data?.type !== "ready") return;
      cleanup();
      resolve();
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(`the compiler failed to load: ${event.message || "the worker script couldn't be run"}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`the compiler didn't start within ${READY_TIMEOUT_MS / 1000} s`));
    }, READY_TIMEOUT_MS);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
  ready.catch(() => {}); // reported by whichever run is waiting on it
  return { worker, ready };
}

function discardWorker() {
  live?.worker.terminate();
  live = null;
}

/** Resolves with "aborted" if the signal fires first. */
function untilAborted(signal: AbortSignal | undefined): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) return resolve("aborted");
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

export async function runAscInWorker(argv: string[], io: WorkerRunIO): Promise<number> {
  if (busy) {
    io.stderr("asc: another compile is still running\n");
    return 1;
  }
  busy = true;
  try {
    const current = (live ??= startWorker());

    // Wait for the worker to be ready (instant after the first run).
    try {
      if ((await Promise.race([current.ready.then(() => "ready" as const), untilAborted(io.signal)])) === "aborted") {
        discardWorker();
        return 130;
      }
    } catch (err) {
      discardWorker();
      io.stderr(`asc: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }

    return await run(current.worker, argv, io);
  } finally {
    busy = false;
  }
}

/** Post one compile to a ready worker and service it until it finishes. */
function run(w: Worker, argv: string[], io: WorkerRunIO): Promise<number> {
  const disk = fsAccess(io.fs);

  return new Promise<number>((resolve) => {
    const finish = (status: number) => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      io.signal?.removeEventListener("abort", onAbort);
      resolve(status);
    };

    const onAbort = () => {
      // The compiler can't be interrupted mid-pass, so stop the whole worker.
      discardWorker();
      finish(130);
    };

    const onError = (event: ErrorEvent) => {
      io.stderr(`asc: the compiler crashed: ${event.message || "unknown error"}\n`);
      discardWorker();
      finish(1);
    };

    const onMessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      switch (msg.type) {
        case "stdout":
          io.stdout(msg.text);
          break;
        case "stderr":
          io.stderr(msg.text);
          break;
        case "fs": {
          const reply = (result: string | string[] | null | undefined) =>
            w.postMessage({ type: "fs-result", id: msg.id, result } satisfies ToWorker);
          try {
            if (msg.op === "readFile") reply(disk.readFile(msg.path));
            else if (msg.op === "listFiles") reply(disk.listFiles(msg.path));
            else {
              disk.writeFile(msg.path, msg.contents);
              reply(undefined);
            }
          } catch (err) {
            const error = err instanceof FsError || err instanceof Error ? err.message : String(err);
            w.postMessage({ type: "fs-result", id: msg.id, error } satisfies ToWorker);
          }
          break;
        }
        case "done":
          finish(msg.status);
          break;
        case "crash":
          io.stderr(`asc: internal compiler error: ${msg.message}\n`);
          discardWorker(); // its state may be broken
          finish(1);
          break;
        case "ready":
          break; // handled by startWorker
      }
    };

    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    io.signal?.addEventListener("abort", onAbort, { once: true });
    if (io.signal?.aborted) return onAbort();
    w.postMessage({ type: "run", argv, cwd: io.cwd } satisfies ToWorker);
  });
}
