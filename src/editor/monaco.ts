/**
 * Monaco setup. Imported lazily (`await import("./monaco")`) the first time the editor
 * opens, so the multi-megabyte editor isn't part of the initial page load.
 */
import * as monaco from "monaco-editor";

// Monaco runs language services in web workers. They're bundled separately and served
// from /monaco/ (see src/workers.ts and src/index.ts).
const WORKER_FOR_LABEL: Record<string, string> = {
  json: "json.worker.js",
  css: "css.worker.js",
  scss: "css.worker.js",
  less: "css.worker.js",
  html: "html.worker.js",
  handlebars: "html.worker.js",
  razor: "html.worker.js",
  typescript: "ts.worker.js",
  javascript: "ts.worker.js",
};

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    const file = WORKER_FOR_LABEL[label] ?? "editor.worker.js";
    return new Worker(new URL(`monaco/${file}`, document.baseURI), { type: "module" });
  },
};

// Themes matching the app's palette (see index.css).
monaco.editor.defineTheme("onno-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#101216", "editorGutter.background": "#101216" },
});
monaco.editor.defineTheme("onno-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#fbfbfa", "editorGutter.background": "#fbfbfa" },
});

/** Monaco language id for a file name, from the extensions/filenames languages declare. */
export function languageFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === lower)) return lang.id;
    if (lang.extensions?.some((ext) => lower.endsWith(ext.toLowerCase()))) return lang.id;
  }
  return "plaintext";
}

export { monaco };
