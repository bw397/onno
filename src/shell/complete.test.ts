import { beforeEach, describe, expect, test } from "bun:test";
import { createBuiltinRegistry } from "../builtins";
import { MemoryStore, VirtualFS } from "../fs";
import { complete } from "./complete";
import { Shell } from "./Shell";

let shell: Shell;

beforeEach(() => {
  const fs = new VirtualFS(new MemoryStore(), "test", (f) => {
    f.mkdir("/home/user/documents", { recursive: true });
    f.mkdir("/home/user/downloads");
    f.mkdir("/home/user/my dir");
    f.mkdir("/bin");
    f.writeFile("/bin/motd", "");
    f.writeFile("/bin/mkthing", "");
    f.writeFile("/home/user/notes.txt", "");
    f.writeFile("/home/user/.secret", "");
    f.writeFile("/home/user/documents/report.txt", "");
  });
  shell = new Shell(fs, createBuiltinRegistry());
});

/** Complete with the cursor at the end of `line` (or at the `█` marker). */
function tab(line: string) {
  const cursor = line.includes("█") ? line.indexOf("█") : line.length;
  const r = complete(shell, line.replace("█", ""), cursor);
  return { ...r, marked: r.line.slice(0, r.cursor) + "█" + r.line.slice(r.cursor) };
}

describe("command completion", () => {
  test("unique builtin", () => {
    expect(tab("pw").line).toBe("pwd ");
  });

  test("includes scripts on $PATH", () => {
    expect(tab("mo").line).toBe("motd ");
  });

  test("ambiguous: common prefix, then candidates", () => {
    expect(tab("m").line).toBe("m"); // man, mkdir, mkthing, motd share only "m"
    expect(tab("m").candidates).toEqual(["man", "mkdir", "mkthing", "motd"]);
    expect(tab("mk").candidates).toEqual(["mkdir", "mkthing"]);
  });

  test("command position after operators", () => {
    expect(tab("ls; pw").line).toBe("ls; pwd ");
    expect(tab("cat x | ec").line).toBe("cat x | echo ");
    expect(tab("pwd && ech").line).toBe("pwd && echo ");
  });

  test("no match leaves the line alone", () => {
    expect(tab("zz")).toMatchObject({ line: "zz", candidates: [] });
  });
});

describe("path completion", () => {
  test("files get a trailing space, directories a slash", () => {
    expect(tab("cat no").line).toBe("cat notes.txt ");
    expect(tab("cd docu").line).toBe("cd documents/");
    expect(tab("cat documents/r").line).toBe("cat documents/report.txt ");
  });

  test("common prefix and candidates", () => {
    expect(tab("cd d").line).toBe("cd do");
    expect(tab("cd do").candidates).toEqual(["documents/", "downloads/"]);
  });

  test("empty word lists the directory, hiding dotfiles", () => {
    expect(tab("ls ").candidates).toEqual(["documents/", "downloads/", "my dir/", "notes.txt"]);
    expect(tab("cat .s").line).toBe("cat .secret ");
  });

  test("absolute, relative and ~ paths", () => {
    expect(tab("ls /b").line).toBe("ls /bin/");
    expect(tab("cat ../user/no").line).toBe("cat ../user/notes.txt ");
    expect(tab("cat ~/no").line).toBe("cat ~/notes.txt ");
    expect(tab("cd ~").line).toBe("cd ~/");
  });

  test("paths as command names", () => {
    expect(tab("/bin/mo").line).toBe("/bin/motd ");
  });

  test("after redirection", () => {
    expect(tab("echo hi > no").line).toBe("echo hi > notes.txt ");
  });

  test("escapes special characters, or respects an open quote", () => {
    expect(tab("cd my").line).toBe("cd my\\ dir/");
    expect(tab("cd my\\ d").line).toBe("cd my\\ dir/");
    expect(tab('cd "my').line).toBe('cd "my dir/');
    expect(tab("cat 'no").line).toBe("cat 'notes.txt' ");
  });

  test("completes at the cursor, keeping text after it", () => {
    expect(tab("cat no█ && pwd").marked).toBe("cat notes.txt █ && pwd");
  });
});
