/// <reference lib="webworker" />
/**
 * Web Worker that runs one WebAssembly module, so a long or endless computation can't
 * freeze the page and Ctrl+C can stop it (the client terminates the worker). Bundled
 * separately (see src/workers.ts) and served at /wasm/run.worker.js.
 */
import type { FromWorker, ToWorker } from "./protocol";
import { runWasm } from "./run";

const post = (msg: FromWorker) => self.postMessage(msg);

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  let status: number;
  try {
    status = await runWasm(event.data.req, {
      stdout: (text) => post({ type: "stdout", text }),
      stderr: (text) => post({ type: "stderr", text }),
    });
  } catch (err) {
    post({ type: "stderr", text: `wasm: internal error: ${err instanceof Error ? err.message : String(err)}\n` });
    status = 1;
  }
  post({ type: "done", status });
};

post({ type: "ready" });
