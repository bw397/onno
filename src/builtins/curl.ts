import { concat, FsError, fromBytes, path, type FileContent } from "../fs";
import type { Builtin, CommandContext } from "../shell";
import { OptionError, parseOptions, type OptionSpec } from "./options";

/**
 * A browser-backed subset of curl, built on fetch(). Browser rules apply:
 * cross-origin URLs only work if the server sends CORS headers, some request
 * headers can't be set, only CORS-exposed response headers are visible, redirects
 * are always followed, and bodies are decoded as UTF-8 text.
 */

const USAGE = `usage: curl [options] URL
  -X, --request METHOD   HTTP method
  -H, --header 'K: V'    add a request header (repeatable)
  -d, --data DATA        send a body (POST); @file reads a file, stripping newlines
      --data-raw DATA    like -d, without @file handling
      --data-binary DATA like -d, but @file keeps newlines
  -o, --output FILE      write the body to FILE
  -O, --remote-name      write the body to a file named after the URL
  -i, --include          print response headers before the body
  -I, --head             send HEAD and print only headers
  -f, --fail             exit 22 without printing the body on HTTP errors (>= 400)
  -s, --silent           don't print errors (unless -S)
  -S, --show-error       print errors even with -s
  -v, --verbose          print request and response headers to stderr
  -m, --max-time SECS    give up after SECS seconds
  -L, --location         follow redirects (always on in the browser)`;

// curl exit codes
const EXIT = { usage: 2, badUrl: 3, connect: 7, http: 22, write: 23, timeout: 28, interrupted: 130 };

type DataMode = "data" | "raw" | "binary";

interface Options {
  method?: string;
  headers: [string, string][];
  data: { mode: DataMode; value: string }[];
  output?: string;
  remoteName: boolean;
  include: boolean;
  head: boolean;
  fail: boolean;
  silent: boolean;
  showError: boolean;
  verbose: boolean;
  maxTime?: number;
  url?: string;
}

const SPECS: OptionSpec[] = [
  { key: "request", short: "X", long: "request", value: true },
  { key: "header", short: "H", long: "header", value: true },
  { key: "data", short: "d", long: "data", value: true },
  { key: "data-raw", long: "data-raw", value: true },
  { key: "data-binary", long: "data-binary", value: true },
  { key: "output", short: "o", long: "output", value: true },
  { key: "max-time", short: "m", long: "max-time", value: true },
  { key: "remoteName", short: "O", long: "remote-name" },
  { key: "include", short: "i", long: "include" },
  { key: "head", short: "I", long: "head" },
  { key: "fail", short: "f", long: "fail" },
  { key: "silent", short: "s", long: "silent" },
  { key: "showError", short: "S", long: "show-error" },
  { key: "verbose", short: "v", long: "verbose" },
  { key: "location", short: "L", long: "location" }, // redirects are always followed
];

function parseArgs(args: string[]): Options {
  const { options, operands } = parseOptions(args, SPECS);
  const opts: Options = {
    headers: [],
    data: [],
    remoteName: false,
    include: false,
    head: false,
    fail: false,
    silent: false,
    showError: false,
    verbose: false,
  };

  for (const { key, value = "" } of options) {
    switch (key) {
      case "request":
        opts.method = value.toUpperCase();
        break;
      case "header": {
        const colon = value.indexOf(":");
        if (colon <= 0) throw new OptionError(`invalid header '${value}' (expected 'Name: value')`);
        opts.headers.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()]);
        break;
      }
      case "data":
        opts.data.push({ mode: "data", value });
        break;
      case "data-raw":
        opts.data.push({ mode: "raw", value });
        break;
      case "data-binary":
        opts.data.push({ mode: "binary", value });
        break;
      case "output":
        opts.output = value;
        break;
      case "max-time": {
        const secs = Number(value);
        if (!(secs > 0)) throw new OptionError(`invalid --max-time '${value}'`);
        opts.maxTime = secs;
        break;
      }
      case "remoteName":
      case "include":
      case "head":
      case "fail":
      case "silent":
      case "showError":
      case "verbose":
        opts[key] = true;
        break;
    }
  }

  if (operands.length > 1) throw new OptionError("only one URL is supported");
  opts.url = operands[0];
  return opts;
}

function parseUrl(raw: string): URL | null {
  // Like curl, assume http:// when no scheme is given.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function buildBody(ctx: CommandContext, data: Options["data"], stdin: string): FileContent | undefined {
  if (!data.length) return undefined;
  const parts = data.map(({ mode, value }): FileContent => {
    if (mode === "raw" || !value.startsWith("@")) return value;
    const file = value.slice(1);
    if (file === "-") return mode === "data" ? stdin.replace(/[\r\n]/g, "") : stdin;
    const abs = ctx.resolvePath(file);
    // --data-binary sends a file's exact bytes; -d sends text with newlines removed.
    if (mode === "binary") return ctx.fs.isBinary(abs) ? ctx.fs.readBytes(abs) : ctx.fs.readFile(abs);
    return ctx.fs.readFile(abs).replace(/[\r\n]/g, "");
  });
  return parts.reduce((acc, part) => concat(concat(acc, "&"), part));
}

function formatHeaders(res: Response): string {
  let out = `HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}\n`;
  res.headers.forEach((value, name) => {
    out += `${name}: ${value}\n`;
  });
  return out;
}

export const curl: Builtin = {
  name: "curl",
  summary: "transfer a URL (via the browser's fetch)",
  usage: USAGE,
  description:
    "Transfer a URL with the browser's fetch(). Browser rules apply: other sites only " +
    "work if they send CORS headers, some headers can't be set or read, redirects are " +
    "always followed, and bodies are treated as text. Ctrl+C cancels a request.",
  examples: [
    { command: "curl https://api.github.com/zen", description: "GET a URL and print the body (this API allows CORS)." },
    { command: "curl -i https://api.github.com/zen", description: "Include the response status and headers." },
    { command: "curl -o zen.txt https://api.github.com/zen", description: "Save the body to a file on the disk." },
    {
      command: `curl -X POST -H 'Content-Type: application/json' -d '{"a":1}' https://httpbin.org/post`,
      description: "POST a JSON body.",
    },
    { command: "curl -fsS -m 5 https://example.com || echo failed", description: "Fail quietly (no CORS here), with a 5 s limit." },
  ],
  async run(ctx) {
    let opts: Options;
    try {
      opts = parseArgs(ctx.args);
    } catch (err) {
      if (!(err instanceof OptionError)) throw err;
      ctx.stderr(`curl: ${err.message}\n${USAGE}\n`);
      return EXIT.usage;
    }
    const error = (code: number, message: string) => {
      if (!opts.silent || opts.showError) ctx.stderr(`curl: (${code}) ${message}\n`);
      return code;
    };

    if (!opts.url) {
      ctx.stderr(`curl: no URL specified\n${USAGE}\n`);
      return EXIT.usage;
    }
    const url = parseUrl(opts.url);
    if (!url) return error(EXIT.badUrl, `URL rejected: ${opts.url}`);

    let outputPath: string | undefined;
    if (opts.output) outputPath = ctx.resolvePath(opts.output);
    else if (opts.remoteName) {
      const name = path.basename(url.pathname);
      if (!name || name === "/") return error(EXIT.write, "Remote file name has no length");
      outputPath = ctx.resolvePath(name);
    }

    let body: FileContent | undefined;
    try {
      const needsStdin = opts.data.some((d) => d.mode !== "raw" && d.value === "@-");
      body = buildBody(ctx, opts.data, needsStdin ? await ctx.readStdin() : "");
    } catch (err) {
      if (!(err instanceof FsError)) throw err;
      return error(EXIT.usage, `can't read data file: ${err.message}`);
    }

    const headers = new Headers();
    for (const [name, value] of opts.headers) {
      try {
        headers.append(name, value);
      } catch {
        return error(EXIT.usage, `invalid header '${name}'`);
      }
    }
    if (body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const method = opts.method ?? (opts.head ? "HEAD" : body !== undefined ? "POST" : "GET");

    const timeout = opts.maxTime ? AbortSignal.timeout(opts.maxTime * 1000) : undefined;
    const signals = [ctx.signal, timeout].filter((s): s is AbortSignal => !!s);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;

    if (opts.verbose) {
      ctx.stderr(`> ${method} ${url.href}\n`);
      headers.forEach((value, name) => ctx.stderr(`> ${name}: ${value}\n`));
      ctx.stderr(">\n");
    }

    let res: Response;
    let text = "";
    let bytes: Uint8Array | undefined;
    try {
      res = await fetch(url, {
        method,
        headers,
        // Our bytes are always backed by a plain ArrayBuffer, which is what fetch() takes.
        body: method === "GET" || method === "HEAD" ? undefined : (body as BodyInit | undefined),
        signal,
        redirect: "follow",
      });
      // Saving to a file keeps the exact bytes (images, archives...); stdout is text.
      if (method !== "HEAD") {
        if (outputPath && !opts.head) bytes = new Uint8Array(await res.arrayBuffer());
        else text = await res.text();
      }
    } catch (err) {
      if (ctx.signal?.aborted) return EXIT.interrupted;
      if (timeout?.aborted) return error(EXIT.timeout, `Operation timed out after ${opts.maxTime! * 1000} milliseconds`);
      // Browsers give a generic message ("Failed to fetch", "NetworkError ...", "Load failed");
      // only include the reason when it says something more.
      const reason = err instanceof Error ? err.message : String(err);
      const detail = /failed to fetch|networkerror|load failed/i.test(reason) ? "" : ` (${reason})`;
      return error(
        EXIT.connect,
        `Failed to fetch ${url.href}${detail}. The host may be unreachable, or it doesn't allow ` +
          `cross-origin requests (CORS); browsers don't say which.`,
      );
    }

    if (opts.verbose) {
      for (const line of formatHeaders(res).split("\n").filter(Boolean)) ctx.stderr(`< ${line}\n`);
      ctx.stderr("<\n");
    }

    if (opts.fail && res.status >= 400) {
      return error(EXIT.http, `The requested URL returned error: ${res.status}`);
    }

    const head = opts.include || opts.head ? formatHeaders(res) + "\n" : "";
    if (outputPath) {
      try {
        ctx.fs.writeFile(outputPath, bytes ? concat(head, fromBytes(bytes)) : head);
        await ctx.fs.flush(); // save now, so a full disk is reported as curl's exit 23
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        return error(EXIT.write, `Failed writing to ${opts.output ?? path.basename(outputPath)}: ${err.message}`);
      }
    } else {
      ctx.stdout(head + (opts.head ? "" : text));
    }
    return 0;
  },
};
