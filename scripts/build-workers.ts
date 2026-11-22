// Writes the app's Web Workers (Monaco, the AssemblyScript compiler) into dist/ for the
// static build (`bun run build`), at the paths the app loads them from.
import { buildWorkers } from "../src/workers";

const outDir = process.argv[2] ?? "dist";
for (const [path, js] of await buildWorkers(true)) {
  await Bun.write(`${outDir}/${path}`, js);
  console.log(`  ${outDir}/${path}  ${(js.length / 1024).toFixed(0)} KB`);
}
