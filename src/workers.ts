/**
 * Server-side: bundles the app's Web Workers. Bun's bundler doesn't follow
 * `new Worker(new URL(..., import.meta.url))`, so each worker is built separately here,
 * served from memory by src/index.ts, and written to dist/ by scripts/build-workers.ts.
 * Keys are the URL paths the browser code loads them from (relative to the page).
 */

const WORKERS = {
  // Monaco language services (loaded by src/editor/monaco.ts)
  "monaco/editor.worker.js": "monaco-editor/editor/editor.worker",
  "monaco/json.worker.js": "monaco-editor/language/json/json.worker",
  "monaco/css.worker.js": "monaco-editor/language/css/css.worker",
  "monaco/html.worker.js": "monaco-editor/language/html/html.worker",
  "monaco/ts.worker.js": "monaco-editor/language/typescript/ts.worker",
  // The AssemblyScript compiler (loaded by src/asc/client.ts)
  "asc/asc.worker.js": "./asc/worker.ts",
  // Runs WebAssembly modules for the `wasm` command (loaded by src/wasm/client.ts)
  "wasm/run.worker.js": "./wasm/worker.ts",
} as const;

export type WorkerPath = keyof typeof WORKERS;

const NODE_BUILTINS = ["fs", "module", "path", "url", "crypto", "worker_threads", "child_process", "os"];

export const WORKER_PATHS = Object.keys(WORKERS) as WorkerPath[];

/** Bundle one worker; returns its JavaScript source. */
export async function buildWorker(name: WorkerPath, minify = false): Promise<string> {
  const result = await Bun.build({
    entrypoints: [Bun.resolveSync(WORKERS[name], import.meta.dir)],
    target: "browser",
    format: "esm",
    minify,
    // asc (and Binaryen) import Node built-ins only behind a "running in Node?" check,
    // which is false in a browser. Leave those imports as they are instead of failing.
    external: NODE_BUILTINS,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `failed to bundle worker ${name}`);
  }
  return result.outputs[0]!.text();
}

/** Bundle every worker; returns URL path -> JavaScript source. */
export async function buildWorkers(minify = false): Promise<Map<WorkerPath, string>> {
  const built = await Promise.all(WORKER_PATHS.map(async (name) => [name, await buildWorker(name, minify)] as const));
  return new Map(built);
}
