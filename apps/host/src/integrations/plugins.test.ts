import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let root = "";
let project = "";
let userPlugins = "";
let NativePluginsClass: typeof import("./plugins").NativePlugins;
const originalXdg = {
  data: process.env.XDG_DATA_HOME,
  state: process.env.XDG_STATE_HOME,
  cache: process.env.XDG_CACHE_HOME,
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function packageAt(directory: string, name: string, version = "1.0.0") {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), json({
    name, version, omp: {
      name: `${name} title`, description: `${name} description`,
      features: { base: { description: "Base feature", default: true }, extra: { default: false } },
      settings: {
        endpoint: { type: "string", default: "default.example" },
        token: { type: "string", secret: true, default: "must-not-leak" },
        count: { type: "number", min: 1, max: 4 },
      },
    },
  }));
}
function lock(plugins: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  return { plugins, settings };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "agent-desktop-native-plugins-"));
  const xdg = path.join(root, "xdg");
  await mkdir(path.join(xdg, "omp"), { recursive: true });
  process.env.XDG_DATA_HOME = xdg;
  process.env.XDG_STATE_HOME = xdg;
  process.env.XDG_CACHE_HOME = xdg;
  const dirs = await import("@oh-my-pi/pi-utils");
  dirs.refreshDirsFromEnv();
  userPlugins = dirs.getPluginsDir();
  project = path.join(root, "project");
  await mkdir(path.join(root, "project", ".git"), { recursive: true });
  await mkdir(project, { recursive: true });
  NativePluginsClass = (await import("./plugins")).NativePlugins;
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  for (const [key, value] of [["XDG_DATA_HOME", originalXdg.data], ["XDG_STATE_HOME", originalXdg.state], ["XDG_CACHE_HOME", originalXdg.cache]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  (await import("@oh-my-pi/pi-utils")).refreshDirsFromEnv();
});

async function resetFixture() {
  await rm(userPlugins, { recursive: true, force: true });
  await rm(path.join(root, "project", ".omp"), { recursive: true, force: true });
  const projectPlugins = path.join(root, "project", ".omp", "plugins");
  await mkdir(path.join(userPlugins, "node_modules"), { recursive: true });
  await mkdir(path.join(projectPlugins, "node_modules"), { recursive: true });
  await packageAt(path.join(userPlugins, "node_modules", "alpha"), "alpha");
  await packageAt(path.join(projectPlugins, "node_modules", "alpha"), "alpha", "2.0.0");
  await packageAt(path.join(projectPlugins, "node_modules", "project-only"), "project-only");
  await writeFile(path.join(userPlugins, "package.json"), json({ name: "omp-plugins", private: true, dependencies: { alpha: "1.0.0" } }));
  await writeFile(path.join(userPlugins, "omp-plugins.lock.json"), json(lock({ alpha: { version: "1.0.0", enabled: true, enabledFeatures: null } }, { alpha: { endpoint: "user.example", token: "user-secret", count: 2 } })));
  await writeFile(path.join(userPlugins, "installed_plugins.json"), json({ version: 2, plugins: {} }));
  await writeFile(path.join(projectPlugins, "package.json"), json({ name: "omp-project-plugins", private: true, dependencies: { alpha: "2.0.0" } }));
  await writeFile(path.join(projectPlugins, "omp-plugins.lock.json"), json(lock({
    alpha: { version: "2.0.0", enabled: true, enabledFeatures: ["extra"] },
    "project-only": { version: "1.0.0", enabled: false, enabledFeatures: null },
  }, { alpha: { token: "project-runtime-secret" } })));
  await writeFile(path.join(projectPlugins, "installed_plugins.json"), json({ version: 2, plugins: {} }));
  await writeFile(path.join(project, ".omp", "plugin-overrides.json"), json({ settings: { alpha: { endpoint: "project.example", token: "project-secret" } } }));
  return projectPlugins;
}

describe("NativePlugins", () => {
  test("catalogs user and project package installs, shadowing, overrides, and masked secrets", async () => {
    await resetFixture();
    const catalog = await new NativePluginsClass().read(project);
    const projectAlpha = catalog.plugins.find(plugin => plugin.id === "package:project:alpha")!;
    const userAlpha = catalog.plugins.find(plugin => plugin.id === "package:user:alpha")!;
    const projectOnly = catalog.plugins.find(plugin => plugin.id === "package:project:project-only")!;
    expect(catalog.application).toBe("new-sessions");
    expect(projectAlpha.version).toBe("2.0.0");
    expect(projectAlpha.canToggle).toBe(false);
    expect(projectAlpha.canSetSettings).toBe(false);
    expect(userAlpha.shadowed).toBe(true);
    expect(projectAlpha).not.toHaveProperty("acquisition");
    expect(userAlpha).not.toHaveProperty("acquisition");
    expect(projectOnly).not.toHaveProperty("acquisition");
    expect(projectOnly.enabled).toBe(false);
    expect(projectOnly).toBeTruthy(); // lock-only entries are retained, not omitted like manager.list().
    const endpoint = userAlpha.settings.find(setting => setting.key === "endpoint")!;
    const token = userAlpha.settings.find(setting => setting.key === "token")!;
    expect(endpoint).toMatchObject({ configured: true, overridden: true, value: "project.example", default: "default.example" });
    expect(token).toEqual(expect.objectContaining({ secret: true, configured: true, overridden: true }));
    expect(token).not.toHaveProperty("value");
    expect(token).not.toHaveProperty("default");
    expect(JSON.stringify(catalog)).not.toContain("user-secret");
    expect(JSON.stringify(catalog)).not.toContain("project-secret");
    expect(JSON.stringify(catalog)).not.toContain("must-not-leak");
  });

  test("applies exact user mutations, rejects stale revisions and project-setting fallthrough", async () => {
    const projectPlugins = await resetFixture();
    const plugins = new NativePluginsClass();
    const before = await plugins.read(project);
    const afterSetting = await plugins.mutate(project, { expectedRevision: before.revision, pluginId: "package:user:alpha", operation: "setting", key: "count", value: 4 });
    expect(afterSetting.revision).not.toBe(before.revision);
    const userLock = JSON.parse(await readFile(path.join(userPlugins, "omp-plugins.lock.json"), "utf8"));
    expect(userLock.settings.alpha.count).toBe(4);
    expect(userLock.settings.alpha.token).toBe("user-secret");
    await expect(plugins.mutate(project, { expectedRevision: before.revision, pluginId: "package:user:alpha", operation: "enabled", enabled: false })).rejects.toThrow("changed");
    const afterFeatures = await plugins.mutate(project, { expectedRevision: afterSetting.revision, pluginId: "package:user:alpha", operation: "features", features: ["extra"] });
    expect(afterFeatures.plugins.find(plugin => plugin.id === "package:user:alpha")!.enabledFeatures).toEqual(["extra"]);
    const afterDisabled = await plugins.mutate(project, { expectedRevision: afterFeatures.revision, pluginId: "package:user:alpha", operation: "enabled", enabled: false });
    expect(JSON.parse(await readFile(path.join(userPlugins, "omp-plugins.lock.json"), "utf8")).plugins.alpha.enabled).toBe(false);
    await expect(plugins.mutate(project, { expectedRevision: afterDisabled.revision, pluginId: "package:project:alpha", operation: "setting", key: "endpoint", value: "wrong.example" })).rejects.toThrow("Project-scoped");
    const unchangedProject = JSON.parse(await readFile(path.join(projectPlugins, "omp-plugins.lock.json"), "utf8"));
    expect(unchangedProject.settings.alpha.token).toBe("project-runtime-secret");
    const afterReset = await plugins.mutate(project, { expectedRevision: afterDisabled.revision, pluginId: "package:user:alpha", operation: "reset-setting", key: "count" });
    expect(afterReset.plugins.find(plugin => plugin.id === "package:user:alpha")!.settings.find(setting => setting.key === "count")!.configured).toBe(false);
    await expect(plugins.mutate(project, { expectedRevision: afterReset.revision, pluginId: "package:user:alpha", operation: "setting", key: "count", value: 9 })).rejects.toThrow("Must be <= 4");
  });

  test("catalogs both marketplace scopes and toggles only the addressed registry", async () => {
    const projectPlugins = await resetFixture();
    const userInstall = path.join(root, "cache", "user-market");
    const projectInstall = path.join(root, "cache", "project-market");
    await packageAt(userInstall, "market-runtime", "3.0.0");
    await packageAt(projectInstall, "market-runtime", "4.0.0");
    await symlink(userInstall, path.join(userPlugins, "node_modules", "market-runtime"));
    await symlink(projectInstall, path.join(projectPlugins, "node_modules", "market-runtime"));
    const entry = (scope: "user" | "project", installPath: string, version: string) => ({ scope, installPath, version, installedAt: "2026-09-06T00:00:00.000Z", lastUpdated: "2026-09-06T00:00:00.000Z", enabled: true });
    await writeFile(path.join(userPlugins, "installed_plugins.json"), json({ version: 2, plugins: { "market@local": [entry("user", userInstall, "3.0.0")] } }));
    await writeFile(path.join(projectPlugins, "installed_plugins.json"), json({ version: 2, plugins: { "market@local": [entry("project", projectInstall, "4.0.0")] } }));
    const userLockPath = path.join(userPlugins, "omp-plugins.lock.json");
    const projectLockPath = path.join(projectPlugins, "omp-plugins.lock.json");
    const userLock = JSON.parse(await readFile(userLockPath, "utf8"));
    userLock.plugins["market-runtime"] = { version: "3.0.0", enabled: true, enabledFeatures: null };
    await writeFile(userLockPath, json(userLock));
    const projectLock = JSON.parse(await readFile(projectLockPath, "utf8"));
    projectLock.plugins["market-runtime"] = { version: "4.0.0", enabled: true, enabledFeatures: null };
    await writeFile(projectLockPath, json(projectLock));
    const plugins = new NativePluginsClass();
    const before = await plugins.read(project);
    expect(before.plugins.filter(plugin => plugin.kind === "marketplace").map(plugin => ({
      scope: plugin.scope, shadowed: plugin.shadowed, acquisition: plugin.acquisition,
    }))).toEqual([
      { scope: "project", shadowed: undefined, acquisition: { pluginId: "market@local", scope: "project" } },
      { scope: "user", shadowed: true, acquisition: { pluginId: "market@local", scope: "user" } },
    ]);
    expect(before.plugins.some(plugin => plugin.id === "package:project:market-runtime")).toBe(false);
    const after = await plugins.mutate(project, { expectedRevision: before.revision, pluginId: "marketplace:project:market@local", operation: "enabled", enabled: false });
    expect(after.plugins.find(plugin => plugin.id === "marketplace:project:market@local")!.enabled).toBe(false);
    expect(after.plugins.find(plugin => plugin.id === "marketplace:user:market@local")!.enabled).toBe(true);
    expect(JSON.parse(await readFile(path.join(userPlugins, "installed_plugins.json"), "utf8")).plugins["market@local"][0].enabled).toBe(true);
    expect(JSON.parse(await readFile(path.join(projectPlugins, "installed_plugins.json"), "utf8")).plugins["market@local"][0].enabled).toBe(false);
  });

  test("fails closed on malformed native configuration instead of overwriting it", async () => {
    await resetFixture();
    const lockPath = path.join(userPlugins, "omp-plugins.lock.json");
    await writeFile(lockPath, "{broken");
    const before = await readFile(lockPath, "utf8");
    const plugins = new NativePluginsClass();
    await expect(plugins.read(project)).rejects.toThrow("User plugin runtime registry is invalid");
    expect(await readFile(lockPath, "utf8")).toBe(before);
  });

  test("rejects linked, oversized, and non-regular configuration inputs without following them", async () => {
    await resetFixture();
    const lockPath = path.join(userPlugins, "omp-plugins.lock.json");
    const outside = path.join(root, "outside-plugin-config.json");
    const original = json(lock({ alpha: { version: "1.0.0", enabled: true, enabledFeatures: null } }, { alpha: { token: "outside-secret" } }));
    await writeFile(outside, original);
    await rm(lockPath);
    await symlink(outside, lockPath);
    await expect(new NativePluginsClass().read(project)).rejects.toThrow("symbolic file link");
    expect(await readFile(outside, "utf8")).toBe(original);

    await rm(lockPath);
    await writeFile(lockPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await expect(new NativePluginsClass().read(project)).rejects.toThrow("1 MiB");

    const mkfifo = Bun.which("mkfifo");
    if (mkfifo) {
      await rm(lockPath);
      const made = Bun.spawnSync({ cmd: [mkfifo, lockPath], stdout: "ignore", stderr: "pipe" });
      expect(made.exitCode).toBe(0);
      const outcome = await Promise.race([
        new NativePluginsClass().read(project).then(() => "resolved", error => error instanceof Error ? error.message : String(error)),
        Bun.sleep(1000).then(() => "timed-out"),
      ]);
      expect(outcome).toContain("regular file");
    }
  });

  test("detects external configuration changes with an opaque revision", async () => {
    await resetFixture();
    const plugins = new NativePluginsClass();
    const before = await plugins.read(project);
    expect(before.revision).not.toMatch(/^[a-f0-9]{64}$/);
    const lockPath = path.join(userPlugins, "omp-plugins.lock.json");
    const state = JSON.parse(await readFile(lockPath, "utf8"));
    state.plugins.alpha.enabled = false;
    await writeFile(lockPath, json(state));
    const after = await plugins.read(project);
    expect(after.revision).not.toBe(before.revision);
    await expect(plugins.mutate(project, { expectedRevision: before.revision, pluginId: "package:user:alpha", operation: "enabled", enabled: true })).rejects.toThrow("changed");
  });

  test("serializes same-revision mutations so only one native write is accepted", async () => {
    await resetFixture();
    const plugins = new NativePluginsClass();
    const before = await plugins.read(project);
    const results = await Promise.allSettled([
      plugins.mutate(project, { expectedRevision: before.revision, pluginId: "package:user:alpha", operation: "enabled", enabled: false }),
      plugins.mutate(project, { expectedRevision: before.revision, pluginId: "package:user:alpha", operation: "features", features: ["extra"] }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const state = JSON.parse(await readFile(path.join(userPlugins, "omp-plugins.lock.json"), "utf8")).plugins.alpha;
    expect([state.enabled === false, Array.isArray(state.enabledFeatures) && state.enabledFeatures[0] === "extra"].filter(Boolean)).toHaveLength(1);
  });
});
