import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemoryBackend, VirtualFS } from "../fs";
import { parse, Shell } from "../shell";
import { builtins, createBuiltinRegistry } from ".";
import { runAscInProcess } from "../asc/inprocess";
import { setAscRunner } from "./asc";

// Compile for real, so asc's examples are checked like the others.
beforeAll(() => setAscRunner(runAscInProcess));
afterAll(() => setAscRunner());

/** A shell on the default seeded disk, plus a few files the examples mention. */
async function freshShell() {
  const fs = await VirtualFS.open(new MemoryBackend());
  for (const f of ["a.txt", "b.txt", "old.txt"]) fs.writeFile(`/home/user/${f}`, `${f}\n`);
  fs.mkdir("/home/user/build");
  fs.writeFile("/home/user/build/out.js", "x");
  return new Shell(fs, createBuiltinRegistry());
}

async function run(line: string, shell?: Shell) {
  shell ??= await freshShell();
  let stdout = "";
  let stderr = "";
  const status = await shell.run(line, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { stdout, stderr, status };
}

/** Names of every command in a command line (first word of each simple command). */
function commandNames(line: string): string[] {
  return parse(line).flatMap((list) =>
    [list.first, ...list.rest.map((r) => r.pipeline)].flatMap((p) =>
      p.commands.map((c) => c.argv[0]!.map((part) => (part.kind === "literal" ? part.value : "")).join("")),
    ),
  );
}

describe("builtin documentation", () => {
  test.each(builtins.map((b) => [b.name, b] as const))("%s is fully documented", (_, b) => {
    expect(b.summary).toMatch(/^[a-z]/);
    expect(b.summary).not.toEndWith(".");
    expect(b.usage).toBeTruthy();
    expect(b.description).toBeTruthy();
    expect(b.examples?.length).toBeGreaterThanOrEqual(2);
  });

  const examples = builtins.flatMap((b) => (b.examples ?? []).map((e) => [b.name, e.command] as const));

  test.each(examples)("%s example parses and uses real commands: %s", async (_, command) => {
    const shell = await freshShell();
    for (const name of commandNames(command)) {
      // A path (./prog.wasm) may be a file an earlier example creates; the in-order run
      // below checks those. Command names must exist already.
      if (name.includes("/")) continue;
      expect(shell.resolveCommand(name).kind).not.toBe("error");
    }
  });

  // Each builtin's examples run in order in one shell, so later ones may build on earlier
  // ones (like reading a man page). curl's need the network; the rest use the seeded disk.
  test.each(builtins.filter((b) => b.name !== "curl").map((b) => [b.name, b] as const))(
    "%s examples run cleanly, in order",
    async (_, b) => {
      const shell = await freshShell();
      for (const { command } of b.examples ?? []) {
        const r = await run(command, shell);
        expect({ command, stderr: r.stderr }).not.toMatchObject({
          stderr: expect.stringMatching(/invalid option|unrecognized|unknown predicate|missing argument|usage:|parse error|not found/),
        });
        expect({ command, status: r.status }).not.toEqual({ command, status: 2 });
      }
    },
  );
});

describe("man", () => {
  test("builtin page has all sections, built from the source", async () => {
    const { stdout, status } = await run("man ls");
    expect(status).toBe(0);
    for (const s of ["NAME", "SYNOPSIS", "DESCRIPTION", "OPTIONS", "EXAMPLES", "SOURCE"]) {
      expect(stdout).toMatch(new RegExp(`^${s}$`, "m"));
    }
    expect(stdout).toContain("       ls - list directory contents\n");
    expect(stdout).toContain("       ls [-a] [-l] [-h] [PATH]...\n");
    expect(stdout).toContain("       -a   include names starting with");
    expect(stdout).toContain("       $ ls -la /\n           Long listing");
    expect(stdout).toContain("src/builtins/ls.ts");
  });

  test("strips the 'usage:' prefix and keeps nested indentation", async () => {
    const { stdout } = await run("man find");
    expect(stdout).toContain("       find [PATH...] [EXPRESSION]\n");
    expect(stdout).toContain("       Tests:\n         -name GLOB");
  });

  test("long descriptions wrap within 78 columns", async () => {
    const { stdout } = await run("man df");
    const description = stdout.split("DESCRIPTION\n")[1]!.split("\n\n")[0]!;
    expect(description.split("\n").length).toBeGreaterThan(1);
    for (const line of description.split("\n")) expect(line.length).toBeLessThanOrEqual(78);
  });

  test("pages without options omit the section", async () => {
    const { stdout } = await run("man pwd");
    expect(stdout).not.toContain("OPTIONS");
  });

  test("script pages come from the leading comment block", async () => {
    const shell = await freshShell();
    shell.fs.writeFile("/bin/greet", "#!/bin/onno\n# say hello to someone\n# Usage: greet NAME\n#\n# Prints a greeting.\necho hello $1\n# not part of the docs\n");
    const { stdout } = await run("man greet", shell);
    expect(stdout).toContain("       greet - say hello to someone\n");
    expect(stdout).toContain("DESCRIPTION\n       Usage: greet NAME\n\n       Prints a greeting.\n");
    expect(stdout).not.toContain("not part of the docs");
    expect(stdout).toContain("script /bin/greet");
    expect((await run("man motd")).stdout).toContain("motd - Print the message of the day");
  });

  test("undocumented scripts say so", async () => {
    const shell = await freshShell();
    shell.fs.writeFile("/bin/bare", "echo hi\n");
    expect((await run("man bare", shell)).stdout).toContain("bare - (no description");
  });

  test("several pages at once", async () => {
    const { stdout } = await run("man pwd cd");
    expect(stdout.match(/^NAME$/gm)).toHaveLength(2);
  });

  test("-k searches names and summaries, including scripts", async () => {
    expect((await run("man -k director")).stdout).toBe(
      "cd    - change the working directory\n" +
        "cp    - copy files and directories\n" +
        "find  - search for files in a directory hierarchy\n" +
        "ls    - list directory contents\n" +
        "mkdir - make directories\n" +
        "mv    - move or rename files and directories\n" +
        "pwd   - print the current working directory\n" +
        "rm    - remove files or directories\n",
    );
    const all = (await run("man -k .")).stdout;
    expect(all.split("\n").filter(Boolean)).toHaveLength(builtins.length + 1); // + /bin/motd
    // An invalid regex falls back to a literal search.
    expect((await run("man -k '(via'")).stdout).toBe("curl - transfer a URL (via the browser's fetch)\n");
  });

  test("errors", async () => {
    expect(await run("man")).toMatchObject({ status: 1, stderr: expect.stringContaining("What manual page") });
    expect(await run("man nope")).toEqual({ stdout: "", stderr: "No manual entry for nope\n", status: 16 });
    const mixed = await run("man nope pwd");
    expect(mixed.status).toBe(16);
    expect(mixed.stdout).toContain("pwd - print");
    expect((await run("man -k zzzz")).stderr).toBe("zzzz: nothing appropriate.\n");
    expect((await run("man -z")).status).toBe(2);
  });

  test("output can be piped", async () => {
    expect((await run("man grep | grep -c '^       \\$ '")).stdout).toBe("5\n");
  });
});
