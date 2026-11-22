import { beforeEach, describe, expect, test } from "bun:test";
import { createBuiltinRegistry } from "../builtins";
import { MemoryBackend, VirtualFS } from "../fs";
import { Shell } from "./Shell";

let fs: VirtualFS;
let shell: Shell;

beforeEach(async () => {
  fs = await VirtualFS.open(new MemoryBackend(), {
    seed: (f) => {
      f.mkdir("/home/user", { recursive: true });
      f.mkdir("/bin");
      f.writeFile("/home/user/a.txt", "alpha\n");
    },
  });
  shell = new Shell(fs, createBuiltinRegistry());
});

/**
 * Run `line` with a fake terminal: `typed` is what the user enters, one entry per read
 * (null = Ctrl+D). Records each read, and the order of reads and output.
 */
async function runTyped(line: string, typed: (string | null)[], opts: { abortAfterReads?: number } = {}) {
  let stdout = "";
  let stderr = "";
  const events: string[] = [];
  let reads = 0;
  const controller = new AbortController();
  const status = await shell.run(line, {
    stdout: (s) => {
      stdout += s;
      events.push(`out:${s}`);
    },
    stderr: (s) => void (stderr += s),
    signal: controller.signal,
    readLine: async () => {
      reads++;
      if (opts.abortAfterReads !== undefined && reads > opts.abortAfterReads) {
        controller.abort(); // the user pressed Ctrl+C while the command waited
        return null;
      }
      const next = typed.length ? typed.shift()! : null;
      events.push(`read:${next}`);
      return next;
    },
  });
  return { stdout, stderr, status, reads, events };
}

describe("reading standard input from the terminal", () => {
  test("cat > file writes what's typed, until Ctrl+D", async () => {
    const r = await runTyped("cat > notes.txt", ["first line\n", "second line\n", null]);
    expect(r).toMatchObject({ status: 0, stdout: "", reads: 3 });
    expect(fs.readFile("/home/user/notes.txt")).toBe("first line\nsecond line\n");
    expect(fs.hasPendingChanges).toBe(false); // saved
  });

  test("cat >> appends", async () => {
    await runTyped("cat >> a.txt", ["beta\n", null]);
    expect(fs.readFile("/home/user/a.txt")).toBe("alpha\nbeta\n");
  });

  test("plain cat echoes each line as it arrives, not all at the end", async () => {
    const r = await runTyped("cat", ["one\n", "two\n", null]);
    expect(r.stdout).toBe("one\ntwo\n");
    expect(r.events).toEqual(["read:one\n", "out:one\n", "read:two\n", "out:two\n", "read:null"]);
  });

  test("Ctrl+D mid-line sends the partial line without a newline", async () => {
    await runTyped("cat > partial.txt", ["no newline", null]);
    expect(fs.readFile("/home/user/partial.txt")).toBe("no newline");
  });

  test("Ctrl+C while waiting interrupts (status 130) and keeps what was typed", async () => {
    const r = await runTyped("cat > kept.txt; echo after", ["typed before ^C\n"], { abortAfterReads: 1 });
    expect(r.status).toBe(130);
    expect(r.stdout).not.toContain("after"); // the rest of the line doesn't run
    expect(fs.readFile("/home/user/kept.txt")).toBe("typed before ^C\n");
  });

  test("other commands read typed input too", async () => {
    expect((await runTyped("wc -l", ["a\n", "b\n", "c\n", null])).stdout).toBe("3\n");
    expect((await runTyped("grep -c x", ["x1\n", "y\n", "x2\n", null])).stdout).toBe("2\n");
    expect((await runTyped("head -n 1", ["first\n", "second\n", null])).stdout).toBe("first\n");
    expect((await runTyped("cat a.txt - a.txt", ["middle\n", null])).stdout).toBe("alpha\nmiddle\nalpha\n");
  });

  test("a pipeline's first command reads the terminal; later ones read the pipe", async () => {
    const r = await runTyped("cat | grep b | wc -l", ["abc\n", "xyz\n", "bcd\n", null]);
    expect(r.stdout).toBe("2\n");
  });

  test("commands that don't read stdin never wait", async () => {
    const r = await runTyped("ls; echo hi; mkdir d", []);
    expect(r).toMatchObject({ reads: 0, status: 0 });
  });

  test("pipes and < redirection never touch the terminal", async () => {
    expect(await runTyped("echo piped | cat", [])).toMatchObject({ stdout: "piped\n", reads: 0 });
    expect(await runTyped("cat < a.txt", [])).toMatchObject({ stdout: "alpha\n", reads: 0 });
  });

  test("each command in a line can read the terminal again after Ctrl+D", async () => {
    const r = await runTyped("cat > one.txt; cat > two.txt", ["1\n", null, "2\n", null]);
    expect(r.status).toBe(0);
    expect(fs.readFile("/home/user/one.txt")).toBe("1\n");
    expect(fs.readFile("/home/user/two.txt")).toBe("2\n");
  });

  test("scripts share their standard input", async () => {
    fs.writeFile("/bin/upper", "cat\n");
    expect((await runTyped("upper", ["from terminal\n", null])).stdout).toBe("from terminal\n");
    expect(await runTyped("echo from pipe | upper", [])).toMatchObject({ stdout: "from pipe\n", reads: 0 });
  });

  test("without a terminal, standard input is empty (no waiting)", async () => {
    let stdout = "";
    const status = await shell.run("cat > empty.txt; wc -c < empty.txt", { stdout: (s) => void (stdout += s), stderr: () => {} });
    expect(status).toBe(0);
    expect(stdout).toBe("0\n");
  });
});
