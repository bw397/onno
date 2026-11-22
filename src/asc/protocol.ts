import type { FileContent } from "../fs";

/** Messages between the main thread (client.ts) and the compiler worker (worker.ts). */

export type ToWorker =
  | { type: "run"; argv: string[]; cwd: string }
  | { type: "fs-result"; id: number; result?: string | string[] | null; error?: string };

export type FromWorker =
  | { type: "fs"; id: number; op: "readFile"; path: string }
  | { type: "fs"; id: number; op: "listFiles"; path: string }
  | { type: "fs"; id: number; op: "writeFile"; path: string; contents: FileContent }
  /** Sent once the worker's message handler is installed; the client waits for it before sending "run". */
  | { type: "ready" }
  | { type: "stdout" | "stderr"; text: string }
  | { type: "done"; status: number }
  | { type: "crash"; message: string };
