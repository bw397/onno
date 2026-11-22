import type { WasmOutput } from "./imports";
import type { FromWorker, ToWorker } from "./protocol";
import type { RunRequest } from "./run";

/**
 * Runs a module in a fresh Web Worker: no state leaks between runs, an endless loop can't
 * freeze the page, and Ctrl+C terminates it (exit status 130).
 */

const READY_TIMEOUT_MS = 10_000;

export function runWasmInWorker(req: RunRequest, io: WasmOutput & { signal?: AbortSignal }): Promise<number> {
  const worker = new Worker(new URL("wasm/run.worker.js", document.baseURI), { type: "module" });

  return new Promise<number>((resolve) => {
    let started = false;
    const finish = (status: number) => {
      clearTimeout(timer);
      io.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      resolve(status);
    };
    const onAbort = () => finish(130);
    const timer = setTimeout(() => {
      if (started) return;
      io.stderr(`wasm: the runner didn't start within ${READY_TIMEOUT_MS / 1000} s\n`);
      finish(1);
    }, READY_TIMEOUT_MS);

    worker.onerror = (event) => {
      io.stderr(`wasm: the runner failed: ${event.message || "the worker script couldn't be run"}\n`);
      finish(1);
    };
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      if (msg.type === "ready") {
        started = true;
        // Copy the bytes, so the caller's buffer stays usable.
        worker.postMessage({ type: "run", req: { ...req, bytes: req.bytes.slice() } } satisfies ToWorker);
      } else if (msg.type === "stdout") io.stdout(msg.text);
      else if (msg.type === "stderr") io.stderr(msg.text);
      else if (msg.type === "done") finish(msg.status);
    };

    io.signal?.addEventListener("abort", onAbort, { once: true });
    if (io.signal?.aborted) onAbort();
  });
}
