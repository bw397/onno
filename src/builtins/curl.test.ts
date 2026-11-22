import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { MemoryStore, VirtualFS } from "../fs";
import { Shell } from "../shell";
import { createBuiltinRegistry } from ".";

// A real local server, so curl goes through the actual fetch().
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/hello":
        return new Response("hello world\n", { headers: { "x-test": "yes" } });
      case "/echo":
        return Response.json({
          method: req.method,
          contentType: req.headers.get("content-type"),
          custom: req.headers.get("x-custom"),
          body: await req.text(),
        });
      case "/slow":
        await Bun.sleep(2000);
        return new Response("late");
      case "/files/data.txt":
        return new Response("file contents");
      default:
        return new Response("not found", { status: 404, statusText: "Not Found" });
    }
  },
});
afterAll(() => server.stop(true));
const base = `http://localhost:${server.port}`;

let fs: VirtualFS;
let shell: Shell;

beforeEach(() => {
  fs = new VirtualFS(new MemoryStore(), "test", (f) => {
    f.mkdir("/home/user", { recursive: true });
    f.writeFile("/home/user/body.txt", "a=1\nb=2\n");
  });
  shell = new Shell(fs, createBuiltinRegistry());
});

async function run(line: string, signal?: AbortSignal) {
  let stdout = "";
  let stderr = "";
  const status = await shell.run(line, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    signal,
  });
  return { stdout, stderr, status };
}

const echoed = async (line: string) => JSON.parse((await run(line)).stdout);

describe("curl", () => {
  test("GET prints the body", async () => {
    expect(await run(`curl ${base}/hello`)).toEqual({ stdout: "hello world\n", stderr: "", status: 0 });
  });

  test("assumes http:// without a scheme", async () => {
    expect((await run(`curl localhost:${server.port}/hello`)).stdout).toBe("hello world\n");
  });

  test("-i and -I include headers", async () => {
    const inc = (await run(`curl -i ${base}/hello`)).stdout;
    expect(inc).toStartWith("HTTP 200");
    expect(inc).toContain("x-test: yes\n");
    expect(inc).toEndWith("\n\nhello world\n");

    const head = (await run(`curl -I ${base}/hello`)).stdout;
    expect(head).toStartWith("HTTP 200");
    expect(head).toContain("x-test: yes\n");
    expect(head).not.toContain("hello world");
  });

  test("-X and -H", async () => {
    const r = await echoed(`curl -X PUT -H 'X-Custom: abc' ${base}/echo`);
    expect(r).toMatchObject({ method: "PUT", custom: "abc" });
    expect(await echoed(`curl -XDELETE ${base}/echo`)).toMatchObject({ method: "DELETE" });
  });

  test("-d implies POST with a form content type, and joins with &", async () => {
    const r = await echoed(`curl -d a=1 -d b=2 ${base}/echo`);
    expect(r).toEqual({ method: "POST", contentType: "application/x-www-form-urlencoded", custom: null, body: "a=1&b=2" });
  });

  test("-d @file strips newlines; --data-binary keeps them; -H overrides content type", async () => {
    expect((await echoed(`curl -d @body.txt ${base}/echo`)).body).toBe("a=1b=2");
    expect((await echoed(`curl --data-binary @body.txt ${base}/echo`)).body).toBe("a=1\nb=2\n");
    expect((await echoed(`curl --data-raw @body.txt ${base}/echo`)).body).toBe("@body.txt");
    const json = await echoed(`curl -H 'Content-Type: application/json' --data '{"x":1}' ${base}/echo`);
    expect(json).toMatchObject({ contentType: "application/json", body: '{"x":1}' });
  });

  test("-d @- reads stdin", async () => {
    expect((await echoed(`echo -n piped | curl -d @- ${base}/echo`)).body).toBe("piped");
  });

  test("-o and -O write to the virtual disk", async () => {
    expect((await run(`curl -o out.txt ${base}/hello`)).stdout).toBe("");
    expect(fs.readFile("/home/user/out.txt")).toBe("hello world\n");
    await run(`curl -O ${base}/files/data.txt`);
    expect(fs.readFile("/home/user/data.txt")).toBe("file contents");
    expect((await run(`curl -O ${base}/`)).status).toBe(23);
    expect((await run(`curl -o /missing/x ${base}/hello`)).status).toBe(23);
  });

  test("HTTP errors: body by default, exit 22 with -f", async () => {
    expect(await run(`curl ${base}/nope`)).toMatchObject({ stdout: "not found", status: 0 });
    const r = await run(`curl -f ${base}/nope`);
    expect(r).toEqual({ stdout: "", stderr: "curl: (22) The requested URL returned error: 404\n", status: 22 });
    expect((await run(`curl -fs ${base}/nope`)).stderr).toBe("");
    expect((await run(`curl -fsS ${base}/nope`)).stderr).toContain("(22)");
  });

  test("connection failure", async () => {
    const r = await run("curl http://127.0.0.1:1/");
    expect(r.status).toBe(7);
    expect(r.stderr).toContain("curl: (7) Failed to fetch");
  });

  test("-m times out", async () => {
    const r = await run(`curl -m 0.1 ${base}/slow`);
    expect(r).toMatchObject({ status: 28, stdout: "" });
    expect(r.stderr).toContain("timed out");
  });

  test("abort signal (Ctrl+C) interrupts and stops the rest of the line", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await run(`curl ${base}/slow; echo after`, controller.signal);
    expect(r).toEqual({ stdout: "", stderr: "", status: 130 });
  });

  test("-v writes request/response headers to stderr", async () => {
    const r = await run(`curl -v ${base}/hello`);
    expect(r.stdout).toBe("hello world\n");
    expect(r.stderr).toContain(`> GET ${base}/hello`);
    expect(r.stderr).toContain("< HTTP 200");
  });

  test("usage errors", async () => {
    expect((await run("curl")).status).toBe(2);
    expect((await run("curl -Z x")).status).toBe(2);
    expect((await run("curl -H")).status).toBe(2);
    expect((await run("curl -H nocolon x")).status).toBe(2);
    expect((await run("curl ftp://example.com")).status).toBe(3);
  });
});
