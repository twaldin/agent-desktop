import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cachePlugin, getCachedPluginPath } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/cache";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-desktop-marketplace-cache-"));
  roots.push(root);
  const source = path.join(root, "source");
  const cache = path.join(root, "cache");
  await mkdir(source, { recursive: true });
  return { root, source, cache };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function stagingNames(cache: string): Promise<string[]> {
  return (await readdir(cache).catch(() => [] as string[])).filter(name => name.includes(".staging-"));
}

describe("patched native marketplace cache reuse", () => {
  test("reuses an identical large tree without replacing its inode", async () => {
    const { source, cache } = await fixture();
    const large = Buffer.alloc(196_731);
    for (let index = 0; index < large.length; index++) large[index] = index % 251;
    await writeFile(path.join(source, "large.bin"), large);
    await mkdir(path.join(source, "nested"));
    await writeFile(path.join(source, "nested", "value.txt"), "same\n");
    const target = await cachePlugin(source, cache, "market", "sample", "1.0.0");
    const before = await lstat(target);

    expect(await cachePlugin(source, cache, "market", "sample", "1.0.0", { reuseExisting: true })).toBe(target);
    const after = await lstat(target);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(path.join(target, "large.bin"))).toEqual(large);
    expect(await stagingNames(cache)).toEqual([]);
  });

  test("refuses changed bytes, executable bits, and symlink targets while preserving the prior tree", async () => {
    for (const [version, mutate] of [
      ["bytes", async (source: string) => writeFile(path.join(source, "file.txt"), "changed")],
      ["mode", async (source: string) => chmod(path.join(source, "file.txt"), 0o755)],
      ["link", async (source: string) => {
        await rm(path.join(source, "link"));
        await symlink("other-target", path.join(source, "link"));
      }],
    ] as const) {
      const { source, cache } = await fixture();
      await writeFile(path.join(source, "file.txt"), "original");
      await chmod(path.join(source, "file.txt"), 0o644);
      await symlink("file.txt", path.join(source, "link"));
      const target = await cachePlugin(source, cache, "market", "sample", version);
      const before = await lstat(target);
      const cachedLink = await readlink(path.join(target, "link"));
      await mutate(source);
      await expect(cachePlugin(source, cache, "market", "sample", version, { reuseExisting: true })).rejects.toThrow("differs");
      expect((await lstat(target)).ino).toBe(before.ino);
      expect(await readFile(path.join(target, "file.txt"), "utf8")).toBe("original");
      expect((await lstat(path.join(target, "file.txt"))).mode & 0o777).toBe(0o644);
      expect(await readlink(path.join(target, "link"))).toBe(cachedLink);
      expect(await stagingNames(cache)).toEqual([]);
    }
  });

  test("compares prepared embedded metadata and never promotes a failed preparation", async () => {
    const { source, cache } = await fixture();
    await writeFile(path.join(source, "package.json"), "{}\n");
    const prepare = (value: string) => async (staging: string) => {
      await writeFile(path.join(staging, ".lsp.json"), value);
    };
    const target = await cachePlugin(source, cache, "market", "sample", "prepared", { prepare: prepare("one") });
    const before = await lstat(target);
    expect(await cachePlugin(source, cache, "market", "sample", "prepared", {
      reuseExisting: true, prepare: prepare("one"),
    })).toBe(target);
    await expect(cachePlugin(source, cache, "market", "sample", "prepared", {
      reuseExisting: true, prepare: prepare("two"),
    })).rejects.toThrow("differs");
    expect((await lstat(target)).ino).toBe(before.ino);
    expect(await readFile(path.join(target, ".lsp.json"), "utf8")).toBe("one");

    const failedTarget = getCachedPluginPath(cache, "market", "sample", "failed");
    await expect(cachePlugin(source, cache, "market", "sample", "failed", {
      prepare: async staging => {
        await writeFile(path.join(staging, ".dap.json"), "partial");
        throw new Error("invalid embedded metadata");
      },
    })).rejects.toThrow("invalid embedded metadata");
    expect(await Bun.file(failedTarget).exists()).toBe(false);
    expect(await stagingNames(cache)).toEqual([]);
  });

  test("refuses a symlink cache root and permits a distinct new version", async () => {
    const { root, source, cache } = await fixture();
    await writeFile(path.join(source, "value.txt"), "v1");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, cache);
    await expect(cachePlugin(source, cache, "market", "sample", "1.0.0", { reuseExisting: true })).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);

    await rm(cache);
    const first = await cachePlugin(source, cache, "market", "sample", "1.0.0");
    await writeFile(path.join(source, "value.txt"), "v2");
    const second = await cachePlugin(source, cache, "market", "sample", "2.0.0", { reuseExisting: true });
    expect(second).not.toBe(first);
    expect(await readFile(path.join(first, "value.txt"), "utf8")).toBe("v1");
    expect(await readFile(path.join(second, "value.txt"), "utf8")).toBe("v2");
  });
});
