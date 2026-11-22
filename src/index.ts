import { serve } from "bun";
import { watch } from "node:fs";
import index from "./index.html";
import { buildWorker, buildWorkers, WORKER_PATHS, type WorkerPath } from "./workers";

const development = process.env.NODE_ENV !== "production";

// Web Workers (Monaco's language services, the AssemblyScript compiler) are bundled
// separately, since Bun's bundler can't follow them, and served from memory. ~1 s at startup.
const workers = await buildWorkers(true);

// `bun --hot` only reloads modules the server imports, and worker sources are built from
// a path rather than imported, so it would keep serving stale workers. In development,
// watch src/ and rebuild a worker on its next request after anything changes.
const stale = new Set<WorkerPath>();
if (development) {
  watch(import.meta.dir, { recursive: true }, () => WORKER_PATHS.forEach((p) => stale.add(p)));
}

async function workerSource(path: WorkerPath): Promise<string> {
  if (stale.delete(path)) workers.set(path, await buildWorker(path, true));
  return workers.get(path)!;
}

const workerRoutes = Object.fromEntries(
  WORKER_PATHS.map((path) => [
    `/${path}`,
    async () =>
      new Response(await workerSource(path), {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          // Always revalidate, so a rebuilt worker is picked up on the next load.
          "cache-control": "no-cache",
        },
      }),
  ]),
);

const server = serve({
  routes: {
    ...workerRoutes,

    // The app is entirely client-side; serve index.html for every other route.
    "/*": index,
  },

  development: development && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`onno running at ${server.url}`);
