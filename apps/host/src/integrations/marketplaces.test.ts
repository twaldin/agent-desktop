import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let root = "";
let project = "";
let projectB = "";
let marketplace = "";
let pluginsDir = "";
let NativeMarketplacesClass: typeof import("./marketplaces").NativeMarketplaces;
const prior = { data: process.env.XDG_DATA_HOME, state: process.env.XDG_STATE_HOME, cache: process.env.XDG_CACHE_HOME };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function git(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Fixture git command failed: ${stderr}`);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "agent-desktop-marketplaces-"));
  const xdg = path.join(root, "xdg");
  process.env.XDG_DATA_HOME = xdg;
  process.env.XDG_STATE_HOME = xdg;
  process.env.XDG_CACHE_HOME = xdg;
  const dirs = await import("@oh-my-pi/pi-utils");
  dirs.refreshDirsFromEnv();
  pluginsDir = dirs.getPluginsDir();
  project = path.join(root, "project");
  projectB = path.join(root, "project-b");
  marketplace = path.join(root, "fixture-marketplace");
  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(path.join(projectB, ".git"), { recursive: true });
  await mkdir(path.join(marketplace, ".omp-plugin"), { recursive: true });
  await mkdir(path.join(marketplace, "plugins", "sample"), { recursive: true });
  await writeFile(path.join(marketplace, "plugins", "sample", "package.json"), json({
    name: "fixture-sample", version: "1.2.3", scripts: { postinstall: `touch ${path.join(root, "must-not-run")}` }, omp: { name: "Fixture sample" },
  }));
  await writeFile(path.join(marketplace, ".omp-plugin", "marketplace.json"), json({
    name: "fixture-market", owner: { name: "Fixture" }, metadata: { description: "Cached fixture" },
    plugins: [
      { name: "sample", source: "./plugins/sample", description: "Sample plugin", version: "1.2.3" },
      { name: "npm-only", source: { source: "npm", package: "npm-only" }, version: "9.0.0" },
    ],
  }));
  await mkdir(pluginsDir, { recursive: true });
  NativeMarketplacesClass = (await import("./marketplaces")).NativeMarketplaces;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  for (const [key, value] of [["XDG_DATA_HOME", prior.data], ["XDG_STATE_HOME", prior.state], ["XDG_CACHE_HOME", prior.cache]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  (await import("@oh-my-pi/pi-utils")).refreshDirsFromEnv();
});

async function fresh() {
  await rm(pluginsDir, { recursive: true, force: true });
  await rm((await import("@oh-my-pi/pi-utils")).getMarketplacesRegistryPath(), { force: true });
  await rm(path.join(project, ".omp"), { recursive: true, force: true });
  await rm(path.join(projectB, ".omp"), { recursive: true, force: true });
  await mkdir(pluginsDir, { recursive: true });
  return new NativeMarketplacesClass();
}

describe("NativeMarketplaces", () => {
  test("uses cached catalogs and performs the native user lifecycle without executing plugin code", async () => {
    const adapter = await fresh();
    const empty = await adapter.read(project);
    expect(empty).toMatchObject({ projectScopeAvailable: true, marketplaces: [], installed: [] });

    const added = await adapter.mutate(project, empty.revision, { operation: "marketplace.add", source: marketplace });
    expect(added.marketplaces).toEqual([{
      name: "fixture-market", sourceType: "local", catalogAvailable: true, description: "Cached fixture",
      plugins: [
        { name: "sample", description: "Sample plugin", version: "1.2.3", installable: true },
        { name: "npm-only", version: "9.0.0", installable: false, unavailabilityReason: "Native npm marketplace plugin sources are unsupported" },
      ],
    }]);
    expect(JSON.stringify(added)).not.toContain(marketplace);
    expect(JSON.stringify(added)).not.toContain("catalogPath");
    expect(JSON.stringify(added)).not.toContain("sourceUri");
    await expect(adapter.mutate(project, added.revision, {
      operation: "plugin.install", name: "npm-only", marketplace: "fixture-market", scope: "user",
    })).rejects.toThrow("unsupported");
    expect((await adapter.read(project)).installed).toEqual([]);

    const installed = await adapter.mutate(project, added.revision, {
      operation: "plugin.install", name: "sample", marketplace: "fixture-market", scope: "user",
    });
    expect(installed.installed).toEqual([{ id: "sample@fixture-market", scope: "user", version: "1.2.3", enabled: true }]);
    expect(await Bun.file(path.join(root, "must-not-run")).exists()).toBe(false);

    const removedMarket = await adapter.mutate(project, installed.revision, { operation: "marketplace.remove", name: "fixture-market" });
    expect(removedMarket.marketplaces).toEqual([]);
    expect(removedMarket.installed).toHaveLength(1); // Native installs are independent cached copies.
    const uninstalled = await adapter.mutate(project, removedMarket.revision, {
      operation: "plugin.uninstall", pluginId: "sample@fixture-market", scope: "user",
    });
    expect(uninstalled.installed).toEqual([]);
  });

  test("updates local cached metadata and supports an actual project install", async () => {
    const adapter = await fresh();
    let catalog = await adapter.read(project);
    catalog = await adapter.mutate(project, catalog.revision, { operation: "marketplace.add", source: marketplace });
    await writeFile(path.join(marketplace, ".omp-plugin", "marketplace.json"), json({
      name: "fixture-market", owner: { name: "Fixture" }, metadata: { description: "Updated fixture" },
      plugins: [{ name: "sample", source: "./plugins/sample", version: "1.2.3" }],
    }));
    catalog = await adapter.mutate(project, catalog.revision, { operation: "marketplace.update", name: "fixture-market" });
    expect(catalog.marketplaces[0]?.description).toBe("Updated fixture");
    catalog = await adapter.mutate(project, catalog.revision, {
      operation: "plugin.install", name: "sample", marketplace: "fixture-market", scope: "project",
    });
    expect(catalog.installed).toContainEqual({ id: "sample@fixture-market", scope: "project", version: "1.2.3", enabled: true });
    expect(await realpath(path.join(project, ".omp", "plugins", "node_modules", "fixture-sample"))).toContain("cache/plugins/");
  });

  test("reports a missing cache without fetching and rejects stale revisions", async () => {
    const adapter = await fresh();
    const initial = await adapter.read(project);
    const added = await adapter.mutate(project, initial.revision, { operation: "marketplace.add", source: marketplace });
    await rm(path.join(pluginsDir, "cache", "marketplaces", "fixture-market", "marketplace.json"));
    const missing = await adapter.read(project);
    expect(missing.marketplaces[0]).toMatchObject({ name: "fixture-market", catalogAvailable: false, plugins: [] });
    expect(await Bun.file(path.join(pluginsDir, "cache", "marketplaces", "fixture-market", "marketplace.json")).exists()).toBe(false);
    await expect(adapter.mutate(project, added.revision, { operation: "marketplace.remove", name: "fixture-market" })).rejects.toThrow("changed");
  });

  test("refuses symlinked marketplace caches and installed paths outside the native cache", async () => {
    const adapter = await fresh();
    const initial = await adapter.read(project);
    const added = await adapter.mutate(project, initial.revision, { operation: "marketplace.add", source: marketplace });
    const cacheDir = path.join(pluginsDir, "cache", "marketplaces", "fixture-market");
    const outside = path.join(root, "outside-cache");
    await mkdir(outside, { recursive: true });
    await rm(cacheDir, { recursive: true });
    await symlink(outside, cacheDir);
    await expect(adapter.read(project)).rejects.toThrow("owned cache");
    await expect(adapter.mutate(project, added.revision, { operation: "marketplace.remove", name: "fixture-market" })).rejects.toThrow("owned cache");
    expect(await realpath(cacheDir)).toBe(await realpath(outside));

    await rm(cacheDir);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "marketplace.json"), await readFile(path.join(marketplace, ".omp-plugin", "marketplace.json")));
    const externalPlugin = path.join(root, "third-party-plugin");
    await mkdir(externalPlugin, { recursive: true });
    await writeFile(path.join(externalPlugin, "package.json"), json({ name: "fixture-sample", version: "1.2.3" }));
    await writeFile(path.join(pluginsDir, "installed_plugins.json"), json({ version: 2, plugins: {
      "sample@fixture-market": [{ scope: "user", installPath: externalPlugin, version: "1.2.3", installedAt: "x", lastUpdated: "x" }],
    } }));
    const hazardous = await adapter.read(project);
    await expect(adapter.mutate(project, hazardous.revision, {
      operation: "plugin.uninstall", pluginId: "sample@fixture-market", scope: "user",
    })).rejects.toThrow("ownership");
    expect(await Bun.file(path.join(externalPlugin, "package.json")).exists()).toBe(true);
    expect(added.revision).not.toBe(hazardous.revision);
  });

  test("marks project scope unavailable without an active project", async () => {
    const adapter = await fresh();
    const plain = path.join(root, "plain");
    await mkdir(plain, { recursive: true });
    const catalog = await adapter.read(plain);
    expect(catalog.projectScopeAvailable).toBe(false);
    await expect(adapter.mutate(plain, catalog.revision, {
      operation: "plugin.install", name: "sample", marketplace: "fixture-market", scope: "project",
    })).rejects.toThrow("unavailable");
  });

  test("refuses malformed runtime state and runtime paths owned by another installation", async () => {
    const adapter = await fresh();
    const initial = await adapter.read(project);
    const added = await adapter.mutate(project, initial.revision, { operation: "marketplace.add", source: marketplace });
    const runtimeLock = path.join(pluginsDir, "omp-plugins.lock.json");
    await writeFile(runtimeLock, "{broken");
    await expect(adapter.read(project)).rejects.toThrow("malformed");
    expect(await readFile(runtimeLock, "utf8")).toBe("{broken");

    await writeFile(runtimeLock, json({ plugins: {}, settings: {} }));
    const current = await adapter.read(project);
    const foreignRuntime = path.join(pluginsDir, "node_modules", "fixture-sample");
    await mkdir(foreignRuntime, { recursive: true });
    await writeFile(path.join(foreignRuntime, "owner.txt"), "foreign");
    await expect(adapter.mutate(project, current.revision, {
      operation: "plugin.install", name: "sample", marketplace: "fixture-market", scope: "user",
    })).rejects.toThrow("Native plugin.install operation failed");
    expect(await readFile(path.join(foreignRuntime, "owner.txt"), "utf8")).toBe("foreign");
    expect((await adapter.read(project)).installed).toEqual([]);
    expect(added.revision).not.toBe(current.revision);
  });

  test("shares an identical cache across projects and preserves it when one project uninstalls", async () => {
    const adapterA = await fresh();
    const adapterB = new NativeMarketplacesClass();
    let a = await adapterA.read(project);
    a = await adapterA.mutate(project, a.revision, { operation: "marketplace.add", source: marketplace });
    a = await adapterA.mutate(project, a.revision, {
      operation: "plugin.install", name: "sample", marketplace: "fixture-market", scope: "project",
    });
    a = await adapterA.mutate(project, a.revision, {
      operation: "plugin.install", name: "sample", marketplace: "fixture-market", scope: "user",
    });
    let b = await adapterB.read(projectB);
    b = await adapterB.mutate(projectB, b.revision, {
      operation: "plugin.install", name: "sample", marketplace: "fixture-market", scope: "project",
    });
    const linkA = path.join(project, ".omp", "plugins", "node_modules", "fixture-sample");
    const linkB = path.join(projectB, ".omp", "plugins", "node_modules", "fixture-sample");
    const linkUser = path.join(pluginsDir, "node_modules", "fixture-sample");
    const cache = await realpath(linkA);
    expect(await realpath(linkB)).toBe(cache);
    expect(await realpath(linkUser)).toBe(cache);
    expect(await readFile(path.join(cache, "package.json"), "utf8")).toContain("fixture-sample");

    const removed = await adapterA.mutate(project, a.revision, {
      operation: "plugin.uninstall", pluginId: "sample@fixture-market", scope: "project",
    });
    expect(removed.installed).toEqual([{ id: "sample@fixture-market", scope: "user", version: "1.2.3", enabled: true }]);
    expect(await realpath(linkB)).toBe(cache);
    expect(await realpath(linkUser)).toBe(cache);
    expect(await readFile(path.join(cache, "package.json"), "utf8")).toContain("fixture-sample");
    const removedUser = await adapterA.mutate(project, removed.revision, {
      operation: "plugin.uninstall", pluginId: "sample@fixture-market", scope: "user",
    });
    expect(removedUser.installed).toEqual([]);
    expect(await realpath(linkB)).toBe(cache);
    expect((await adapterB.read(projectB)).installed).toContainEqual({
      id: "sample@fixture-market", scope: "project", version: "1.2.3", enabled: true,
    });
  });

  test("installs an actual object URL source from a disposable local Git repository", async () => {
    const repository = path.join(root, "object-source-repository");
    await rm(repository, { recursive: true, force: true });
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, "package.json"), json({ name: "object-source-plugin", version: "3.4.5" }));
    await writeFile(path.join(repository, "content.txt"), "from object Git source\n");
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["add", "--", "package.json", "content.txt"]);
    await git(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
    const catalogFile = path.join(marketplace, ".omp-plugin", "marketplace.json");
    const priorCatalog = await readFile(catalogFile);
    try {
      await writeFile(catalogFile, json({
        name: "fixture-market", owner: { name: "Fixture" }, plugins: [{
          name: "object-source", source: { source: "url", url: repository }, version: "3.4.5",
        }],
      }));
      const adapter = await fresh();
      let catalog = await adapter.read(project);
      catalog = await adapter.mutate(project, catalog.revision, { operation: "marketplace.add", source: marketplace });
      expect(catalog.marketplaces[0]?.plugins).toEqual([{ name: "object-source", version: "3.4.5", installable: true }]);
      catalog = await adapter.mutate(project, catalog.revision, {
        operation: "plugin.install", name: "object-source", marketplace: "fixture-market", scope: "user",
      });
      expect(catalog.installed).toEqual([{ id: "object-source@fixture-market", scope: "user", version: "3.4.5", enabled: true }]);
      const installed = await realpath(path.join(pluginsDir, "node_modules", "object-source-plugin"));
      expect(await readFile(path.join(installed, "content.txt"), "utf8")).toBe("from object Git source\n");
    } finally {
      await writeFile(catalogFile, priorCatalog);
    }
  });
});
