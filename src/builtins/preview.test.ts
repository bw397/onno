import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryBackend, VirtualFS } from "../fs";
import { Shell, type ShellHost } from "../shell";
import { createBuiltinRegistry } from ".";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

let shell: Shell;
let previewed: string[];

beforeEach(async () => {
  const fs = await VirtualFS.open(new MemoryBackend(), {
    seed: (f) => {
      f.mkdir("/home/user/pics", { recursive: true });
      f.writeFile("/home/user/pics/cat.png", PNG);
      f.writeFile("/home/user/pics/misnamed.dat", PNG);
      f.writeFile("/home/user/doc.pdf", "%PDF-1.4\n%fake\n");
      f.writeFile("/home/user/notes.txt", "hello\n");
      f.writeFile("/home/user/empty.png", "");
      f.writeFile("/home/user/blob.bin", new Uint8Array([0x50, 0x4b, 3, 4, 0xff, 0]));
    },
  });
  previewed = [];
  const host: ShellHost = {
    openEditor: () => null,
    openPreview: (path) => {
      previewed.push(path);
      return null;
    },
  };
  shell = new Shell(fs, createBuiltinRegistry(), { host });
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

describe("preview", () => {
  test("opens images and PDFs by absolute path, reporting the detected type", async () => {
    expect(await run("preview pics/cat.png")).toEqual({
      stdout: "preview: showing /home/user/pics/cat.png (image/png, 12 B)\n",
      stderr: "",
      status: 0,
    });
    expect((await run("preview doc.pdf")).stdout).toContain("(application/pdf, ");
    expect(previewed).toEqual(["/home/user/pics/cat.png", "/home/user/doc.pdf"]);
  });

  test("detects by content, not name", async () => {
    expect((await run("preview pics/misnamed.dat")).stdout).toContain("image/png");
  });

  test("SVG written with echo is previewable", async () => {
    const r = await run(`echo '<svg xmlns="http://www.w3.org/2000/svg"></svg>' > dot.svg && preview dot.svg`);
    expect(r.stdout).toContain("image/svg+xml");
  });

  test("explains what it can't show", async () => {
    expect((await run("preview notes.txt")).stderr).toBe("preview: notes.txt: can't preview this file (it's text; try cat or mon)\n");
    expect((await run("preview empty.png")).stderr).toBe("preview: empty.png: can't preview this file (it's empty)\n");
    expect((await run("preview blob.bin")).stderr).toBe("preview: blob.bin: can't preview this file (unknown file type)\n");
    expect((await run("preview pics")).stderr).toBe("preview: pics: Is a directory\n");
    expect((await run("preview nope.png")).stderr).toBe("preview: nope.png: No such file or directory\n");
    expect(previewed).toEqual([]);
  });

  test("exactly one file; host refusal and absence are reported", async () => {
    expect((await run("preview")).status).toBe(2);
    expect((await run("preview a b")).status).toBe(2);
    shell.host = { openEditor: () => null, openPreview: () => "~/x.txt has unsaved changes; save or close it first" };
    expect((await run("preview pics/cat.png")).stderr).toBe("preview: ~/x.txt has unsaved changes; save or close it first\n");
    shell.host = undefined;
    expect((await run("preview pics/cat.png")).stderr).toBe("preview: no viewer is available here\n");
  });
});
