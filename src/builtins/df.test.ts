import { describe, expect, test } from "bun:test";
import { MemoryBackend, VirtualFS, type StorageBackend } from "../fs";
import { Shell } from "../shell";
import { createBuiltinRegistry } from ".";
import { human } from "./df";

async function setup(backend: StorageBackend = new MemoryBackend(1024 * 1024)) {
  const fs = await VirtualFS.open(backend, {
    seed: (f) => {
      f.mkdir("/home/user", { recursive: true });
      f.writeFile("/home/user/a.txt", "x".repeat(3000));
    },
  });
  const shell = new Shell(fs, createBuiltinRegistry());
  const run = async (line: string) => {
    let stdout = "";
    let stderr = "";
    const status = await shell.run(line, {
      stdout: (s) => void (stdout += s),
      stderr: (s) => void (stderr += s),
    });
    return { stdout, stderr, status };
  };
  return { fs, run };
}

const row = (stdout: string) => stdout.split("\n")[1]!.split(/\s+/);

/** A durable backend whose estimate is fixed, standing in for IndexedDB + navigator.storage. */
class FakeBrowserBackend extends MemoryBackend {
  override readonly durable = true;
  constructor(
    private readonly report: { usage: number; quota: number },
    private readonly persist: boolean | null,
  ) {
    super();
  }
  override async estimate() {
    return this.report;
  }
  override async persisted() {
    return this.persist;
  }
}

describe("df", () => {
  test("reports the browser's estimate", async () => {
    const { run } = await setup(new FakeBrowserBackend({ usage: 3 * 1024 ** 2, quota: 100 * 1024 ** 3 }, false));
    const r = await run("df");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n")[0]).toMatch(/^Filesystem\s+1K-blocks\s+Used\s+Available\s+Use% Mounted on$/);
    expect(row(r.stdout)).toEqual(["indexeddb", String(100 * 1024 ** 2), "3072", String(100 * 1024 ** 2 - 3072), "1%", "/"]);
    expect(row((await run("df -h")).stdout)).toEqual(["indexeddb", "100G", "3.0M", "100G", "1%", "/"]);
  });

  test("-v shows the disk's size and persistence", async () => {
    const best = await setup(new FakeBrowserBackend({ usage: 0, quota: 1e9 }, false));
    const out = (await best.run("df -v")).stdout;
    expect(out).toMatch(/disk: \d+ bytes in 4 files and directories/); // /, /home, /home/user, a.txt
    expect(out).toContain("best-effort");
    const persistent = await setup(new FakeBrowserBackend({ usage: 0, quota: 1e9 }, true));
    expect((await persistent.run("df -v")).stdout).toContain("storage: persistent");
  });

  test("usage follows what's stored (memory backend)", async () => {
    const { run } = await setup();
    const used = async () => Number(row((await run("df")).stdout)[2]);
    const before = await used();
    await run("echo " + "z".repeat(5000) + " > big.txt");
    expect(await used()).toBe(before + 5);
  });

  test("in-memory disk without a quota shows dashes and says it won't persist", async () => {
    const { run } = await setup(new MemoryBackend());
    const out = (await run("df -v")).stdout;
    expect(out.split("\n")[1]).toMatch(/^memory\s+-\s+\d+\s+-\s+-\s+\/$/);
    expect(out).toContain("won't survive a reload");
  });

  test("path operands", async () => {
    const { run } = await setup();
    expect((await run("df /home/user")).status).toBe(0);
    expect(await run("df nope")).toEqual({ stdout: "", stderr: "df: nope: No such file or directory\n", status: 1 });
    expect((await run("df -x")).status).toBe(1);
  });

  test("a full disk: writes fail with ENOSPC and df shows it nearly full", async () => {
    const { run } = await setup(new MemoryBackend(64 * 1024));
    const r = await run("echo " + "q".repeat(70_000) + " > huge.txt");
    expect(r).toMatchObject({ status: 1, stderr: expect.stringContaining("No space left on device") });
    await run("echo " + "q".repeat(58_000) + " > fill.txt");
    expect(Number(row((await run("df")).stdout)[4]!.replace("%", ""))).toBeGreaterThanOrEqual(90);
  });

  test("human()", () => {
    expect(human(0)).toBe("0");
    expect(human(1023)).toBe("1023");
    expect(human(1024)).toBe("1.0K");
    expect(human(1536)).toBe("1.5K");
    expect(human(10 * 1024 + 1)).toBe("11K");
    expect(human(5 * 1024 ** 3)).toBe("5.0G");
    // Boundaries, checked against GNU ls -lh: the format follows the rounded-up value.
    expect(human(10239)).toBe("10K"); // 9.999K rounds up to 10K, not 10.0K
    expect(human(1048575)).toBe("1.0M"); // 1023.999K rounds up into the next unit
    expect(human(1048577)).toBe("1.1M");
    expect(human(1099511627775)).toBe("1.0T");
  });
});
