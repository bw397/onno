import { serve } from "bun";
import { buildMonacoWorkers } from "./editor/workers";
import index from "./index.html";

// Monaco's web workers are bundled separately (Bun's bundler can't follow them) and
// served from memory. Takes ~0.4 s at startup.
const monacoWorkers = await buildMonacoWorkers(true);

const server = serve({
  routes: {
    "/monaco/:file": (req) => {
      const js = monacoWorkers.get(req.params.file as never);
      if (!js) return new Response("Not found", { status: 404 });
      return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    },

    // The app is entirely client-side; serve index.html for every other route.
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`onno running at ${server.url}`);
