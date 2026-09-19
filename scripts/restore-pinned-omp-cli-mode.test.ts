import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { restorePinnedOmpCliMode } from "./restore-pinned-omp-cli-mode";

const roots: string[] = [];
const bytes = Buffer.from("#!/usr/bin/env bun\nconsole.log('pinned omp fixture');\n");

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(options: { rootVersion?: string; packageVersion?: string; bin?: unknown; outside?: boolean; externalNodeModules?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-omp-cli-mode-"));
  roots.push(root);
  const nodeModules = join(root, "node_modules");
  if (options.externalNodeModules) {
    const external = await mkdtemp(join(tmpdir(), "agent-desktop-external-node-modules-"));
    roots.push(external);
    await symlink(external, nodeModules);
  }
  const store = options.outside ? join(root, "outside/package") : join(nodeModules, ".bun/store/node_modules/@oh-my-pi/pi-coding-agent");
  const selected = join(nodeModules, "@oh-my-pi/pi-coding-agent");
  const cache = join(root, "cache/dist/cli.js");
  await Promise.all([mkdir(dirname(selected), { recursive: true }), mkdir(join(store, "dist"), { recursive: true }), mkdir(dirname(cache), { recursive: true })]);
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@oh-my-pi/pi-coding-agent": options.rootVersion ?? "18.1.10" } }));
  await writeFile(join(store, "package.json"), JSON.stringify({
    name: "@oh-my-pi/pi-coding-agent",
    version: options.packageVersion ?? "18.1.10",
    bin: options.bin ?? { omp: "dist/cli.js" },
  }));
  await writeFile(cache, bytes, { mode: 0o777 });
  await chmod(cache, 0o777);
  await link(cache, join(store, "dist/cli.js"));
  await symlink(store, selected);
  return { root, store, target: join(store, "dist/cli.js"), cache };
}

describe("pinned OMP CLI mode restoration", () => {
  test("replaces only the selected hardlinked bin and preserves its bytes and cache inode", async () => {
    const { root, target, cache } = await fixture();
    const cacheBefore = await lstat(cache);
    expect((await lstat(target)).ino).toBe(cacheBefore.ino);

    expect(await restorePinnedOmpCliMode(root)).toMatchObject({ status: "repaired", previousMode: 0o777, mode: 0o755 });

    const [cacheAfter, targetAfter] = await Promise.all([lstat(cache), lstat(target)]);
    expect({ inode: cacheAfter.ino, mode: cacheAfter.mode & 0o777, bytes: await readFile(cache) })
      .toEqual({ inode: cacheBefore.ino, mode: 0o777, bytes });
    expect(targetAfter.ino).not.toBe(cacheAfter.ino);
    expect(targetAfter.mode & 0o777).toBe(0o755);
    expect(await readFile(target)).toEqual(bytes);
  });

  test("does not write an already-correct selected bin", async () => {
    const { root, target } = await fixture();
    await chmod(target, 0o755);
    const before = await lstat(target);
    expect(await restorePinnedOmpCliMode(root)).toMatchObject({ status: "unchanged", previousMode: 0o755, mode: 0o755 });
    const after = await lstat(target);
    expect({ dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs });
  });

  test("removes its private copy when atomic replacement fails", async () => {
    const { root, store, target, cache } = await fixture();
    const before = await lstat(cache);
    await expect(restorePinnedOmpCliMode(root, async () => { throw new Error("fixture replace failure"); }))
      .rejects.toThrow("fixture replace failure");
    expect((await lstat(target)).ino).toBe(before.ino);
    expect((await lstat(cache)).mode & 0o777).toBe(0o777);
    expect((await readdir(join(store, "dist"))).filter(name => name.includes(".mode-fix-"))).toEqual([]);
  });

  test("rejects unpinned manifests, unexpected bins, escaping packages and non-regular targets", async () => {
    const wrongRoot = await fixture({ rootVersion: "18.1.11" });
    await expect(restorePinnedOmpCliMode(wrongRoot.root)).rejects.toThrow("dependency 18.1.10");
    const wrongPackage = await fixture({ packageVersion: "18.1.11" });
    await expect(restorePinnedOmpCliMode(wrongPackage.root)).rejects.toThrow("selected @oh-my-pi/pi-coding-agent package 18.1.10");
    const wrongBin = await fixture({ bin: { omp: "other.js" } });
    await expect(restorePinnedOmpCliMode(wrongBin.root)).rejects.toThrow("declare only omp: dist/cli.js");
    const escaping = await fixture({ outside: true });
    await expect(restorePinnedOmpCliMode(escaping.root)).rejects.toThrow("escapes this repository's node_modules");
    const externalNodeModules = await fixture({ externalNodeModules: true });
    await expect(restorePinnedOmpCliMode(externalNodeModules.root)).rejects.toThrow("node_modules directory to be project-local");
    const nonRegular = await fixture();
    await rm(nonRegular.target);
    await symlink(nonRegular.cache, nonRegular.target);
    await expect(restorePinnedOmpCliMode(nonRegular.root)).rejects.toThrow("regular file");
  });
});
