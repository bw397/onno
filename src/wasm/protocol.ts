import type { RunRequest } from "./run";

/** Messages between the main thread (client.ts) and a wasm run worker (worker.ts). */
export type ToWorker = { type: "run"; req: RunRequest };

export type FromWorker =
  /** Sent once the message handler is installed; the client waits for it before "run". */
  | { type: "ready" }
  | { type: "stdout" | "stderr"; text: string }
  | { type: "done"; status: number };
