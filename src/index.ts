import { serve } from "bun";
import index from "./index.html";

const server = serve({
  routes: {
    // The app is entirely client-side; serve index.html for every route.
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
