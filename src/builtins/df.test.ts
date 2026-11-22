import { describe, expect, test } from "bun:test";
import { MemoryStore, measureStorage, probeAvailable, usedChars, VirtualFS } from "../fs";
import { Shell } from "../shell";
import { createBuiltinRegistry } from ".";

function setup(quota: number) {
  const store = new MemoryStore(quota);
  store.setItem("onno:settings", '{"theme":"dark","fontSize":14}');
  const fs = new VirtualFS(store, "disk", (f) => {
    f.mkdir("/home/user", { recursive: true });
    f.writeFile("/home/user/a.txt", "x".repeat(3000));
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
  return { store, fs, run };
}

describe("quota measurement", () => {
  test("used counts every key and value", () => {
    const store = new MemoryStore();
    store.setItem("ab", "cde");
    store.setItem("f", "");
    expect(usedChars(store)).toBe(6);
  });

  test("probe finds the remaining space within 1K and leaves nothing behind", () => {
    const store = new MemoryStore(5 * 1024 * 1024);
    store.setItem("k", "v".repeat(100_000));
    const available = probeAvailable(store);
    const exact = 5 * 1024 * 1024 - 100_001;
    expect(available).toBeLessThanOrEqual(exact);
    expect(available).toBeGreaterThan(exact - 1024 - 32);
    expect(store.length).toBe(1);
  });

  test("full store has nothing available; unlimited store is Infinity", () => {
    const full = new MemoryStore(20);
    full.setItem("k", "v".repeat(19));
    expect(probeAvailable(full)).toBe(0);
    expect(probeAvailable(new MemoryStore())).toBe(Infinity);
  });

  test("quota is cached; used is fresh", () => {
    const store = new MemoryStore(2 * 1024 * 1024);
    const first = measureStorage(store);
    store.setItem("big", "y".repeat(50_000));
    const second = measureStorage(store);
    expect(second.quota).toBe(first.quota);
    expect(second.used).toBe(first.used + 50_003);
    expect(second.available).toBe(second.quota - second.used);
  });
});

describe("df", () => {
  test("default output in 1K blocks", async () => {
    const { run, store } = setup(1024 * 1024);
    const r = await run("df");
    expect(r.status).toBe(0);
    const [header, row] = r.stdout.trimEnd().split("\n");
    expect(header).toMatch(/^Filesystem\s+1K-blocks\s+Used\s+Available\s+Use% Mounted on$/);
    const [name, size, used, avail, pct, mount] = row!.split(/\s+/);
    expect(name).toBe("localStorage");
    expect(mount).toBe("/");
    expect(Number(used)).toBe(Math.ceil(usedChars(store) / 1024));
    expect(Number(size)).toBeGreaterThanOrEqual(1023);
    expect(Number(size)).toBeLessThanOrEqual(1024);
    expect(Number(size) - Number(used) - Number(avail)).toBeLessThanOrEqual(1);
    expect(pct).toBe("1%");
  });

  test("-h human readable", async () => {
    const { run } = setup(5 * 1024 * 1024);
    const row = (await run("df -h")).stdout.trimEnd().split("\n")[1]!.split(/\s+/);
    expect(row[1]).toBe("5.0M");
    expect(row[2]).toBe("3.2K");
  });

  test("usage grows as files are written", async () => {
    const { run } = setup(1024 * 1024);
    const used = async () => Number((await run("df")).stdout.split("\n")[1]!.split(/\s+/)[2]);
    const before = await used();
    await run("echo " + "z".repeat(5000) + " > big.txt");
    expect(await used()).toBe(before + 5);
  });

  test("-v shows the disk's share", async () => {
    const { run } = setup(1024 * 1024);
    const out = (await run("df -v")).stdout;
    expect(out).toContain("disk (files + directories):");
    expect(out).toMatch(/4 entries/); // /, /home, /home/user, a.txt
    expect(out).toMatch(/other localStorage keys:\s+\d+/);
  });

  test("unlimited (in-memory) store shows dashes", async () => {
    const fs = new VirtualFS(new MemoryStore(), "disk");
    const shell = new Shell(fs, createBuiltinRegistry());
    let stdout = "";
    await shell.run("df -v", { stdout: (s) => void (stdout += s), stderr: () => {} });
    expect(stdout.split("\n")[1]).toMatch(/^localStorage\s+-\s+\d+\s+-\s+-\s+\/$/);
    expect(stdout).toContain("won't persist");
  });

  test("path operands", async () => {
    const { run } = setup(1024 * 1024);
    expect((await run("df /home/user")).status).toBe(0);
    const r = await run("df nope");
    expect(r).toMatchObject({ stdout: "", status: 1 });
    expect(r.stderr).toBe("df: nope: No such file or directory\n");
    expect((await run("df -x")).status).toBe(1);
  });

  test("a full disk: writes fail with ENOSPC and df shows ~100%", async () => {
    const { run } = setup(64 * 1024);
    const r = await run("echo " + "q".repeat(70_000) + " > huge.txt");
    expect(r.stderr).toContain("No space left on device");
    await run("echo " + "q".repeat(58_000) + " > fill.txt");
    const pct = (await run("df")).stdout.split("\n")[1]!.split(/\s+/)[4];
    expect(Number(pct!.replace("%", ""))).toBeGreaterThanOrEqual(90);
  });
});
