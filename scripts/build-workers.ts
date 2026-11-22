// Writes Monaco's web workers to dist/monaco/ for the static build (`bun run build`).
import { buildMonacoWorkers } from "../src/editor/workers";

const outDir = process.argv[2] ?? "dist/monaco";
for (const [name, js] of await buildMonacoWorkers(true)) {
  await Bun.write(`${outDir}/${name}`, js);
  console.log(`  ${outDir}/${name}  ${(js.length / 1024).toFixed(0)} KB`);
}
