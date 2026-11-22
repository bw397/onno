import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryBackend, VirtualFS } from "../fs";
import { Shell } from "../shell";
import { createBuiltinRegistry } from ".";
import { OptionError, parseOptions } from "./options";

let shell: Shell;

beforeEach(async () => {
  const fs = await VirtualFS.open(new MemoryBackend(), {
    seed: (f) => {
      f.mkdir("/home/user/src/lib", { recursive: true });
      f.writeFile("/home/user/fruit.txt", "apple\nBanana\ncherry\napple pie\npineapple\n");
      f.writeFile("/home/user/nums.txt", "one 1\ntwo 22\nthree\nfour 4444\n");
      f.writeFile("/home/user/src/main.js", "import x\n// TODO: fix\nconsole.log(x)\n");
      f.writeFile("/home/user/src/lib/util.js", "export const a = 1; // TODO\n");
      f.writeFile("/home/user/lines.txt", ["a", "b", "MATCH 1", "c", "d", "e", "f", "MATCH 2", "g"].join("\n"));
    },
  });
  shell = new Shell(fs, createBuiltinRegistry());
});

async function run(line: string) {
  let stdout = "";
  let stderr = "";
  const status = await shell.run(line, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { stdout, stderr, status };
}
const out = async (line: string) => (await run(line)).stdout;

describe("grep basics", () => {
  test("matching lines, exit status", async () => {
    expect(await run("grep apple fruit.txt")).toEqual({ stdout: "apple\napple pie\npineapple\n", stderr: "", status: 0 });
    expect(await run("grep kiwi fruit.txt")).toEqual({ stdout: "", stderr: "", status: 1 });
  });

  test("regex (extended syntax)", async () => {
    expect(await out("grep '^a' fruit.txt")).toBe("apple\napple pie\n");
    expect(await out("grep 'e$' fruit.txt")).toBe("apple\napple pie\npineapple\n");
    expect(await out("grep 'cherry|Banana' fruit.txt")).toBe("Banana\ncherry\n");
    expect(await out("grep '[0-9]{2,}' nums.txt")).toBe("two 22\nfour 4444\n");
  });

  test("POSIX classes and \\< \\>", async () => {
    expect(await out("grep '[[:digit:]]+$' nums.txt")).toBe("one 1\ntwo 22\nfour 4444\n");
    expect(await out("grep '\\<apple\\>' fruit.txt")).toBe("apple\napple pie\n");
  });

  test("-i -v -w -x -F", async () => {
    expect(await out("grep -i banana fruit.txt")).toBe("Banana\n");
    expect(await out("grep -v apple fruit.txt")).toBe("Banana\ncherry\n");
    expect(await out("grep -w apple fruit.txt")).toBe("apple\napple pie\n");
    expect(await out("grep -x apple fruit.txt")).toBe("apple\n");
    expect(await out("grep -c 'a.p' fruit.txt")).toBe("3\n"); // "." matches any char
    expect(await out("grep -cF 'a.p' fruit.txt")).toBe("0\n"); // literal "a.p"
    expect(await out("grep -F '(x)' src/main.js")).toBe("console.log(x)\n");
  });

  test("multiple -e patterns", async () => {
    expect(await out("grep -e cherry -e Ban fruit.txt")).toBe("Banana\ncherry\n");
  });

  test("-n -c -o -m", async () => {
    expect(await out("grep -n apple fruit.txt")).toBe("1:apple\n4:apple pie\n5:pineapple\n");
    expect(await out("grep -c apple fruit.txt")).toBe("3\n");
    expect(await out("grep -o '[0-9]+' nums.txt")).toBe("1\n22\n4444\n");
    expect(await out("grep -m1 apple fruit.txt")).toBe("apple\n");
    expect(await out("grep -c -v apple fruit.txt")).toBe("2\n");
  });

  test("bundled and attached options", async () => {
    expect(await out("grep -inw APPLE fruit.txt")).toBe("1:apple\n4:apple pie\n");
    expect(await out("grep -m 2 -- apple fruit.txt")).toBe("apple\napple pie\n");
    expect(await out("grep --max-count=1 --line-number apple fruit.txt")).toBe("1:apple\n");
  });
});

describe("grep inputs", () => {
  test("stdin, pipes, and -", async () => {
    expect(await out("cat fruit.txt | grep cherry")).toBe("cherry\n");
    expect(await out("echo hello | grep -c l")).toBe("1\n");
    expect(await out("grep cherry < fruit.txt")).toBe("cherry\n");
    expect(await out("echo apple | grep -H apple - fruit.txt")).toBe(
      "(standard input):apple\nfruit.txt:apple\nfruit.txt:apple pie\nfruit.txt:pineapple\n",
    );
  });

  test("multiple files show names; -h hides, -H forces", async () => {
    expect(await out("grep one fruit.txt nums.txt")).toBe("nums.txt:one 1\n");
    expect(await out("grep -h one fruit.txt nums.txt")).toBe("one 1\n");
    expect(await out("grep -H cherry fruit.txt")).toBe("fruit.txt:cherry\n");
    expect(await out("grep -c e fruit.txt nums.txt")).toBe("fruit.txt:4\nnums.txt:2\n");
  });

  test("-l and -L", async () => {
    expect(await out("grep -l apple fruit.txt nums.txt")).toBe("fruit.txt\n");
    expect(await out("grep -l apple fruit.txt")).toBe("fruit.txt\n");
    expect(await out("grep -L apple fruit.txt nums.txt")).toBe("nums.txt\n");
  });

  test("-r searches directories (default: .)", async () => {
    expect(await out("grep -r TODO src")).toBe("src/lib/util.js:export const a = 1; // TODO\nsrc/main.js:// TODO: fix\n");
    expect(await out("grep -rh TODO src/")).toBe("export const a = 1; // TODO\n// TODO: fix\n");
    expect(await out("cd src; grep -rl TODO")).toBe("lib/util.js\nmain.js\n");
    expect(await out("grep -rl TODO .")).toBe("./lib/util.js\n./main.js\n"); // still in src
  });

  test("errors: missing files and directories (exit 2, -s silences)", async () => {
    const r = await run("grep apple missing fruit.txt");
    expect(r.stdout).toBe("fruit.txt:apple\nfruit.txt:apple pie\nfruit.txt:pineapple\n");
    expect(r.stderr).toBe("grep: missing: No such file or directory\n");
    expect(r.status).toBe(2);
    expect((await run("grep x src")).stderr).toBe("grep: src: Is a directory\n");
    expect(await run("grep -s apple missing")).toEqual({ stdout: "", stderr: "", status: 2 });
  });

  test("-q: no output, exit 0 on match even with errors", async () => {
    expect(await run("grep -q apple fruit.txt")).toEqual({ stdout: "", stderr: "", status: 0 });
    expect((await run("grep -q kiwi fruit.txt")).status).toBe(1);
    expect((await run("grep -qs apple missing fruit.txt")).status).toBe(0);
    expect(await out("grep -q cherry fruit.txt && echo found")).toBe("found\n");
  });
});

describe("grep binary files", () => {
  test("reports a match instead of printing bytes; counts and lists still work", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x41, 0x42, 0x43, 0x0a]);
    shell.fs.writeFile("/home/user/img.png", bytes);
    // Wording and stream (stdout) match GNU grep 3.12.
    expect(await run("grep ABC img.png")).toEqual({ stdout: "grep: img.png: binary file matches\n", stderr: "", status: 0 });
    expect((await run("grep XYZ img.png")).status).toBe(1);
    expect(await out("grep -c ABC img.png")).toBe("1\n");
    expect(await out("grep -l ABC img.png fruit.txt")).toBe("img.png\n");
    expect(await out("grep -r ABC .")).toBe("grep: ./img.png: binary file matches\n");
    expect(await out("grep -r ABC")).toBe("grep: img.png: binary file matches\n");
  });
});

describe("grep context", () => {
  test("-A -B -C with separators", async () => {
    expect(await out("grep -A1 MATCH lines.txt")).toBe("MATCH 1\nc\n--\nMATCH 2\ng\n");
    expect(await out("grep -B1 MATCH lines.txt")).toBe("b\nMATCH 1\n--\nf\nMATCH 2\n");
    expect(await out("grep -nC1 MATCH lines.txt")).toBe("2-b\n3:MATCH 1\n4-c\n--\n7-f\n8:MATCH 2\n9-g\n");
  });

  test("overlapping context merges without a separator", async () => {
    expect(await out("grep -C3 MATCH lines.txt")).toBe("a\nb\nMATCH 1\nc\nd\ne\nf\nMATCH 2\ng\n");
  });

  test("-m stops but still prints trailing context", async () => {
    expect(await out("grep -m1 -A2 MATCH lines.txt")).toBe("MATCH 1\nc\nd\n");
  });
});

describe("grep usage errors", () => {
  test("exit 2", async () => {
    expect((await run("grep")).stderr).toContain("no pattern given");
    expect((await run("grep -Z x")).stderr).toContain("invalid option -- 'Z'");
    expect((await run("grep '(' fruit.txt")).stderr).toContain("invalid regular expression");
    expect((await run("grep -m x a fruit.txt")).status).toBe(2);
    expect((await run("grep -e")).stderr).toContain("requires an argument");
  });
});

describe("parseOptions", () => {
  const specs = [
    { key: "a", short: "a" },
    { key: "v", short: "v", long: "val", value: true },
  ];

  test("forms", () => {
    expect(parseOptions(["-av1", "x", "--val=2", "--val", "3", "-", "--", "-a"], specs)).toEqual({
      options: [{ key: "a" }, { key: "v", value: "1" }, { key: "v", value: "2" }, { key: "v", value: "3" }],
      operands: ["x", "-", "-a"],
    });
  });

  test("errors", () => {
    expect(() => parseOptions(["-z"], specs)).toThrow(OptionError);
    expect(() => parseOptions(["--nope"], specs)).toThrow(OptionError);
    expect(() => parseOptions(["-v"], specs)).toThrow(OptionError);
    expect(() => parseOptions(["--a=1"], [{ key: "a", long: "a" }])).toThrow(OptionError);
  });
});
