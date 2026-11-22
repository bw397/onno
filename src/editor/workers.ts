/**
 * Server-side: bundles Monaco's web workers. Bun's bundler doesn't follow
 * `new Worker(new URL(..., import.meta.url))`, so each worker is built separately and
 * served at /monaco/<name>.worker.js (see src/index.ts), or written to dist/ by
 * scripts/build-workers.ts. src/editor/monaco.ts loads them from there.
 */

export const MONACO_WORKERS = {
  "editor.worker.js": "monaco-editor/editor/editor.worker",
  "json.worker.js": "monaco-editor/language/json/json.worker",
  "css.worker.js": "monaco-editor/language/css/css.worker",
  "html.worker.js": "monaco-editor/language/html/html.worker",
  "ts.worker.js": "monaco-editor/language/typescript/ts.worker",
} as const;

export type WorkerName = keyof typeof MONACO_WORKERS;

/** Bundle every worker; returns file name -> JavaScript source. */
export async function buildMonacoWorkers(minify = false): Promise<Map<WorkerName, string>> {
  const out = new Map<WorkerName, string>();
  await Promise.all(
    (Object.entries(MONACO_WORKERS) as [WorkerName, string][]).map(async ([name, specifier]) => {
      const result = await Bun.build({
        entrypoints: [Bun.resolveSync(specifier, import.meta.dir)],
        target: "browser",
        format: "esm",
        minify,
      });
      if (!result.success) {
        throw new AggregateError(result.logs, `failed to bundle Monaco worker ${name}`);
      }
      out.set(name, await result.outputs[0]!.text());
    }),
  );
  return out;
}
