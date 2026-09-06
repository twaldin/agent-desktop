import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { NativePlugin, NativePluginCatalog, NativePluginMutation, PluginSetting } from "@agent-desktop/shared";
import {
  PluginManager,
  validateSetting,
  type InstalledPlugin,
  type PluginManifest,
  type PluginRuntimeConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import {
  MarketplaceManager,
  getInstalledPluginsRegistryPath,
  getMarketplacesCacheDir,
  getPluginsCacheDir,
  type InstalledPluginEntry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
  getMarketplacesRegistryPath,
  getPluginsDir,
  getPluginsLockfile,
  getPluginsPackageJson,
  getProjectPluginOverridesPath,
} from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

const READ_ONLY_PROJECT = "Project-scoped plugin settings and features require a native scoped writer";
const EMPTY_RUNTIME: PluginRuntimeConfig = { plugins: {}, settings: {} };
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const MAX_FILE_BYTES = 1024 * 1024;

type JsonObject = Record<string, unknown>;
type ProjectOverrides = {
  disabled?: string[];
  features?: Record<string, string[]>;
  settings?: Record<string, Record<string, unknown>>;
};
type Context = {
  cwd: string;
  userRoot: string;
  userPackage: string;
  userLock: string;
  userRegistry: string;
  projectRegistry?: string;
  projectRoot?: string;
  projectPackage?: string;
  projectLock?: string;
  projectOverrides: string;
};
type Row = { public: NativePlugin; nativeName: string; manifest: PluginManifest };

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`);
  return value as JsonObject;
}
async function text(file: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Native plugin configuration contains an unsupported symbolic file link");
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("Native plugin configuration must be a regular file no larger than 1 MiB");
    const parts: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > MAX_FILE_BYTES) throw new Error("Native plugin configuration exceeds 1 MiB");
      parts.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const atPath = await lstat(file);
    if (!after.isFile() || atPath.isSymbolicLink() || !atPath.isFile() ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      after.dev !== atPath.dev || after.ino !== atPath.ino || size !== after.size) {
      throw new Error("Native plugin configuration changed while it was being read");
    }
    return Buffer.concat(parts, size).toString("utf8");
  } finally { await handle.close(); }
}
async function lockTarget(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Native plugin configuration is not an owned regular file");
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const canonicalMissing = async (candidate: string): Promise<string> => {
      try { return await realpath(candidate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw error;
        return path.join(await canonicalMissing(parent), path.basename(candidate));
      }
    };
    const parent = await canonicalMissing(path.dirname(file));
    return path.join(parent, path.basename(file));
  }
}
async function json(file: string, label: string): Promise<JsonObject | undefined> {
  const raw = await text(file);
  if (raw === undefined) return undefined;
  try { return object(JSON.parse(raw), label); }
  catch (error) { throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`); }
}
function runtime(value: JsonObject | undefined, label: string): PluginRuntimeConfig {
  if (!value) return structuredClone(EMPTY_RUNTIME);
  const plugins = object(value.plugins ?? {}, `${label}.plugins`);
  const settings = object(value.settings ?? {}, `${label}.settings`);
  for (const [name, raw] of Object.entries(plugins)) {
    const state = object(raw, `${label}.plugins.${name}`);
    if (typeof state.version !== "string" || typeof state.enabled !== "boolean" ||
      !(state.enabledFeatures === null || (Array.isArray(state.enabledFeatures) && state.enabledFeatures.every(item => typeof item === "string")))) {
      throw new Error(`${label}.plugins.${name} is invalid`);
    }
  }
  for (const [name, raw] of Object.entries(settings)) object(raw, `${label}.settings.${name}`);
  return value as unknown as PluginRuntimeConfig;
}
function overrides(value: JsonObject | undefined, label: string): ProjectOverrides {
  if (!value) return {};
  if (value.disabled !== undefined && (!Array.isArray(value.disabled) || !value.disabled.every(item => typeof item === "string"))) throw new Error(`${label}.disabled is invalid`);
  if (value.features !== undefined) for (const [name, featureNames] of Object.entries(object(value.features, `${label}.features`))) {
    if (!Array.isArray(featureNames) || !featureNames.every(item => typeof item === "string")) throw new Error(`${label}.features.${name} is invalid`);
  }
  if (value.settings !== undefined) for (const [name, settings] of Object.entries(object(value.settings, `${label}.settings`))) object(settings, `${label}.settings.${name}`);
  return value as ProjectOverrides;
}
function dependencies(value: JsonObject | undefined, label: string): string[] {
  if (!value) return [];
  const deps = object(value.dependencies ?? {}, `${label}.dependencies`);
  for (const [name, spec] of Object.entries(deps)) {
    if (!PACKAGE_NAME.test(name) || name.length > 214 || typeof spec !== "string") throw new Error(`${label}.dependencies.${name} is invalid`);
  }
  return Object.keys(deps);
}
function registry(value: JsonObject | undefined, label: string, scope: "user" | "project"): Record<string, InstalledPluginEntry[]> {
  if (!value) return {};
  if (value.version !== 2) throw new Error(`${label}.version must be 2`);
  const plugins = object(value.plugins, `${label}.plugins`);
  for (const [id, rawEntries] of Object.entries(plugins)) {
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) throw new Error(`${label}.plugins.${id} must be a non-empty array`);
    for (const raw of rawEntries) {
      const entry = object(raw, `${label}.plugins.${id} entry`);
      if (typeof entry.installPath !== "string" || typeof entry.version !== "string" ||
        (entry.scope !== undefined && entry.scope !== scope) ||
        (entry.enabled !== undefined && typeof entry.enabled !== "boolean")) throw new Error(`${label}.plugins.${id} entry is invalid`);
    }
  }
  return plugins as Record<string, InstalledPluginEntry[]>;
}
function manifest(value: unknown, version: string, label: string): PluginManifest {
  const raw = object(value ?? {}, label);
  if (raw.name !== undefined && typeof raw.name !== "string") throw new Error(`${label}.name is invalid`);
  if (raw.description !== undefined && typeof raw.description !== "string") throw new Error(`${label}.description is invalid`);
  const features = raw.features === undefined ? undefined : object(raw.features, `${label}.features`);
  for (const [name, value] of Object.entries(features ?? {})) {
    const feature = object(value, `${label}.features.${name}`);
    if (feature.description !== undefined && typeof feature.description !== "string") throw new Error(`${label}.features.${name}.description is invalid`);
    if (feature.default !== undefined && typeof feature.default !== "boolean") throw new Error(`${label}.features.${name}.default is invalid`);
    for (const key of ["extensions", "tools", "hooks", "commands"] as const) {
      if (feature[key] !== undefined && (!Array.isArray(feature[key]) || !(feature[key] as unknown[]).every(item => typeof item === "string"))) throw new Error(`${label}.features.${name}.${key} is invalid`);
    }
  }
  const settings = raw.settings === undefined ? undefined : object(raw.settings, `${label}.settings`);
  for (const [key, value] of Object.entries(settings ?? {})) {
    const schema = object(value, `${label}.settings.${key}`);
    if (!["string", "number", "boolean", "enum"].includes(String(schema.type))) throw new Error(`${label}.settings.${key}.type is invalid`);
    if (schema.description !== undefined && typeof schema.description !== "string") throw new Error(`${label}.settings.${key}.description is invalid`);
    if (schema.secret !== undefined && typeof schema.secret !== "boolean") throw new Error(`${label}.settings.${key}.secret is invalid`);
    if (schema.type === "enum" && (!Array.isArray(schema.values) || !schema.values.every(item => typeof item === "string"))) throw new Error(`${label}.settings.${key}.values is invalid`);
    if (schema.default !== undefined && ((schema.type === "number" && typeof schema.default !== "number") ||
      (schema.type === "boolean" && typeof schema.default !== "boolean") ||
      ((schema.type === "string" || schema.type === "enum") && typeof schema.default !== "string"))) throw new Error(`${label}.settings.${key}.default is invalid`);
    for (const numberKey of ["min", "max", "step"] as const) if (schema[numberKey] !== undefined && typeof schema[numberKey] !== "number") throw new Error(`${label}.settings.${key}.${numberKey} is invalid`);
  }
  return { ...raw, version } as unknown as PluginManifest;
}
async function installed(name: string, pluginPath: string, config: PluginRuntimeConfig, project: ProjectOverrides): Promise<InstalledPlugin | undefined> {
  const pkg = await json(path.join(pluginPath, "package.json"), `Plugin ${name} package`);
  if (!pkg) return undefined;
  const actual = typeof pkg.name === "string" && pkg.name ? pkg.name : name;
  if (!PACKAGE_NAME.test(actual) || actual.length > 214) throw new Error(`Plugin ${name} package name is invalid`);
  if (typeof pkg.version !== "string") throw new Error(`Plugin ${name} package version is invalid`);
  const pluginManifest = manifest(pkg.omp ?? pkg.pi ?? {}, pkg.version, `Plugin ${name} manifest`);
  const state = config.plugins[actual] ?? { version: pkg.version, enabled: true, enabledFeatures: null };
  return {
    name: actual, version: pkg.version, path: pluginPath, manifest: pluginManifest,
    enabled: state.enabled && !(project.disabled?.includes(actual) ?? false),
    enabledFeatures: project.features?.[actual] ?? state.enabledFeatures,
  };
}
function pluginSettings(plugin: InstalledPlugin, raw: Record<string, unknown>, project: Record<string, unknown>, writable: boolean): PluginSetting[] {
  return Object.entries(plugin.manifest.settings ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, schema]) => {
    const projectOwns = Object.hasOwn(project, key);
    const configured = projectOwns || Object.hasOwn(raw, key);
    const effective = projectOwns ? project[key] : raw[key] ?? schema.default;
    const secret = schema.secret === true;
    return {
      key, type: schema.type, ...(schema.description ? { description: schema.description } : {}), secret, configured,
      ...(projectOwns ? { overridden: true } : {}),
      ...(!secret && effective !== undefined ? { value: effective as string | number | boolean } : {}),
      ...(!secret && schema.default !== undefined ? { default: schema.default } : {}),
      ...(schema.type === "enum" ? { values: [...schema.values] } : {}),
      ...(schema.type === "number" && schema.min !== undefined ? { min: schema.min } : {}),
      ...(schema.type === "number" && schema.max !== undefined ? { max: schema.max } : {}),
      ...(schema.type === "number" && schema.step !== undefined ? { step: schema.step } : {}),
      ...(!writable && configured ? { configured: true } : {}),
    };
  });
}
function row(id: string, scope: "user" | "project", kind: "package" | "marketplace", plugin: InstalledPlugin,
  rawSettings: Record<string, unknown>, projectSettings: Record<string, unknown>, capabilities: { toggle: boolean; features: boolean; settings: boolean; reason?: string }, shadowed = false): Row {
  const definitions = plugin.manifest.features ?? {};
  const enabledSet = plugin.enabledFeatures === null ? null : new Set(plugin.enabledFeatures);
  return { nativeName: plugin.name, manifest: plugin.manifest, public: {
    id, name: plugin.name, title: plugin.manifest.name ?? plugin.name,
    ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
    version: plugin.version, scope, kind, enabled: plugin.enabled, ...(shadowed ? { shadowed: true } : {}),
    canToggle: capabilities.toggle, canSetFeatures: capabilities.features, canSetSettings: capabilities.settings,
    ...(capabilities.reason ? { configurationReason: capabilities.reason } : {}),
    features: Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)).map(([name, feature]) => ({
      name, ...(feature.description ? { description: feature.description } : {}), default: feature.default === true,
      enabled: enabledSet ? enabledSet.has(name) : feature.default === true,
    })),
    enabledFeatures: plugin.enabledFeatures ? [...plugin.enabledFeatures] : null,
    settings: pluginSettings(plugin, rawSettings, projectSettings, capabilities.settings),
  } as NativePlugin };
}

export class NativePlugins {
  #tail: Promise<unknown> = Promise.resolve();
  #fingerprints = new Map<string, { fingerprint: string; revision: string }>();

  async #context(cwd: string): Promise<Context> {
    const canonical = await realpath(cwd);
    if (!(await lstat(canonical)).isDirectory()) throw new Error("Plugin working directory must be a directory");
    const projectRegistry = await resolveActiveProjectRegistryPath(canonical) ?? undefined;
    const projectRoot = projectRegistry ? path.dirname(projectRegistry) : undefined;
    return {
      cwd: canonical, userRoot: getPluginsDir(), userPackage: getPluginsPackageJson(), userLock: getPluginsLockfile(),
      userRegistry: getInstalledPluginsRegistryPath(), projectRegistry, projectRoot,
      projectPackage: projectRoot ? path.join(projectRoot, "package.json") : undefined,
      projectLock: projectRoot ? path.join(projectRoot, "omp-plugins.lock.json") : undefined,
      projectOverrides: getProjectPluginOverridesPath(canonical),
    };
  }
  #marketplace(context: Context): MarketplaceManager {
    return new MarketplaceManager({
      marketplacesRegistryPath: getMarketplacesRegistryPath(), installedRegistryPath: context.userRegistry,
      ...(context.projectRegistry ? { projectInstalledRegistryPath: context.projectRegistry } : {}),
      marketplacesCacheDir: getMarketplacesCacheDir(), pluginsCacheDir: getPluginsCacheDir(), clearPluginRootsCache: clearPluginRootsAndCaches,
    });
  }
  async #load(context: Context): Promise<{ rows: Row[]; files: string[] }> {
    const files = [context.userPackage, context.userLock, context.userRegistry, context.projectOverrides,
      ...(context.projectPackage ? [context.projectPackage] : []), ...(context.projectLock ? [context.projectLock] : []),
      ...(context.projectRegistry ? [context.projectRegistry] : [])];
    const [userPackage, userRuntimeValue, userRegistryValue, projectPackage, projectRuntimeValue, projectRegistryValue, projectOverridesValue] = await Promise.all([
      json(context.userPackage, "User plugin package registry"), json(context.userLock, "User plugin runtime registry"), json(context.userRegistry, "User marketplace registry"),
      context.projectPackage ? json(context.projectPackage, "Project plugin package registry") : undefined,
      context.projectLock ? json(context.projectLock, "Project plugin runtime registry") : undefined,
      context.projectRegistry ? json(context.projectRegistry, "Project marketplace registry") : undefined,
      json(context.projectOverrides, "Project plugin overrides"),
    ]);
    const userRuntime = runtime(userRuntimeValue, "User plugin runtime registry");
    const projectRuntime = runtime(projectRuntimeValue, "Project plugin runtime registry");
    const project = overrides(projectOverridesValue, "Project plugin overrides");
    const userMarket = registry(userRegistryValue, "User marketplace registry", "user");
    const projectMarket = registry(projectRegistryValue, "Project marketplace registry", "project");
    const marketPaths = new Set(await Promise.all([...Object.values(userMarket), ...Object.values(projectMarket)].flat().map(async entry => {
      try { return await realpath(entry.installPath); } catch { return path.resolve(entry.installPath); }
    })));
    const projectNames = new Set([...dependencies(projectPackage, "Project plugin package registry"), ...Object.keys(projectRuntime.plugins)]);
    dependencies(userPackage, "User plugin package registry"); // Validate before native list(), which otherwise trusts this file.
    const rows: Row[] = [];
    const enabledProjectNames = new Set<string>();
    if (context.projectRoot) for (const name of projectNames) {
      const pluginPath = path.join(context.projectRoot, "node_modules", name);
      let canonicalPath: string; try { canonicalPath = await realpath(pluginPath); } catch { canonicalPath = path.resolve(pluginPath); }
      if (marketPaths.has(canonicalPath)) continue;
      const plugin = await installed(name, pluginPath, projectRuntime, project);
      if (!plugin) continue;
      if (plugin.enabled) enabledProjectNames.add(plugin.name);
      rows.push(row(`package:project:${plugin.name}`, "project", "package", plugin,
        projectRuntime.settings[plugin.name] ?? {}, project.settings?.[plugin.name] ?? {},
        { toggle: false, features: false, settings: false, reason: READ_ONLY_PROJECT }));
      files.push(path.join(pluginPath, "package.json"));
    }
    for (const plugin of await new PluginManager(context.cwd).list()) {
      rows.push(row(`package:user:${plugin.name}`, "user", "package", plugin,
        userRuntime.settings[plugin.name] ?? {}, project.settings?.[plugin.name] ?? {},
        { toggle: true, features: true, settings: true }, enabledProjectNames.has(plugin.name)));
      files.push(path.join(plugin.path, "package.json"));
    }
    const summaries = await this.#marketplace(context).listInstalledPlugins();
    for (const summary of summaries) {
      const entries = summary.entries;
      const entry = entries[0];
      if (!entry) continue;
      const pkg = await json(path.join(entry.installPath, "package.json"), `Marketplace plugin ${summary.id} package`);
      if (!pkg || typeof pkg.version !== "string") throw new Error(`Marketplace plugin ${summary.id} package is missing or invalid`);
      const nativeName = typeof pkg.name === "string" && pkg.name ? pkg.name : summary.id.split("@")[0]!;
      const scopedRuntime = summary.scope === "project" ? projectRuntime : userRuntime;
      const plugin = await installed(nativeName, entry.installPath, scopedRuntime, project);
      if (!plugin) throw new Error(`Marketplace plugin ${summary.id} package is missing`);
      plugin.enabled = entry.enabled !== false && plugin.enabled;
      const projectScoped = summary.scope === "project";
      rows.push(row(`marketplace:${summary.scope}:${summary.id}`, summary.scope, "marketplace", plugin,
        scopedRuntime.settings[plugin.name] ?? {}, project.settings?.[plugin.name] ?? {},
        { toggle: true, features: !projectScoped, settings: !projectScoped,
          ...(projectScoped ? { reason: READ_ONLY_PROJECT } : {}) }, summary.shadowedBy === "project"));
      files.push(path.join(entry.installPath, "package.json"));
    }
    rows.sort((a, b) => a.public.title.localeCompare(b.public.title) || a.public.id.localeCompare(b.public.id));
    return { rows, files };
  }
  async #fingerprint(files: string[]): Promise<string> {
    const hash = createHash("sha256");
    for (const file of [...new Set(files)].sort()) hash.update(file).update("\0").update((await text(file)) ?? "\0missing").update("\0");
    return hash.digest("hex");
  }
  async #read(cwd: string): Promise<{ catalog: NativePluginCatalog; rows: Row[]; context: Context }> {
    const context = await this.#context(cwd);
    const { rows, files } = await this.#load(context);
    const fingerprint = await this.#fingerprint(files);
    const prior = this.#fingerprints.get(context.cwd);
    const revision = prior?.fingerprint === fingerprint ? prior.revision : randomUUID();
    this.#fingerprints.set(context.cwd, { fingerprint, revision });
    return { context, rows, catalog: { revision, plugins: rows.map(item => item.public), application: "new-sessions" } };
  }
  read(cwd: string): Promise<NativePluginCatalog> {
    const work = this.#tail.then(async () => (await this.#read(cwd)).catalog);
    this.#tail = work.catch(() => {});
    return work;
  }
  mutate(cwd: string, mutation: NativePluginMutation): Promise<NativePluginCatalog> {
    const work = this.#tail.then(() => this.#mutate(cwd, mutation));
    this.#tail = work.catch(() => {});
    return work;
  }
  async #mutate(cwd: string, mutation: NativePluginMutation): Promise<NativePluginCatalog> {
    const initial = await this.#read(cwd);
    if (initial.catalog.revision !== mutation.expectedRevision) throw new Error("Plugin configuration changed; reload before applying this edit");
    const lockPaths = [...new Set(await Promise.all([
      initial.context.userLock, initial.context.userRegistry,
      ...(initial.context.projectLock ? [initial.context.projectLock] : []),
      ...(initial.context.projectRegistry ? [initial.context.projectRegistry] : []),
    ].map(lockTarget)))].sort();
    for (const lock of lockPaths) await mkdir(path.dirname(lock), { recursive: true });
    const locked = async (index: number): Promise<NativePluginCatalog> => index === lockPaths.length
      ? this.#apply(initial.context.cwd, mutation)
      : withFileLock(lockPaths[index]!, () => locked(index + 1));
    return locked(0);
  }
  async #apply(cwd: string, mutation: NativePluginMutation): Promise<NativePluginCatalog> {
    const current = await this.#read(cwd);
    if (current.catalog.revision !== mutation.expectedRevision) throw new Error("Plugin configuration changed before the native configuration lock was acquired");
    const target = current.rows.find(item => item.public.id === mutation.pluginId);
    if (!target) throw new Error("Plugin is no longer installed; reload its catalog");
    const project = target.public.scope === "project";
    if (mutation.operation === "enabled" && target.public.canToggle) {
      if (target.public.kind === "marketplace") {
        const nativeId = target.public.id.slice(`marketplace:${target.public.scope}:`.length);
        await this.#marketplace(current.context).setPluginEnabled(nativeId, mutation.enabled, target.public.scope);
      } else await new PluginManager(cwd).setEnabled(target.nativeName, mutation.enabled);
    } else if (mutation.operation === "features" && target.public.canSetFeatures) {
      const names = new Set(Object.keys(target.manifest.features ?? {}));
      if (mutation.features?.some(name => !names.has(name))) throw new Error("Requested plugin feature is not declared by this plugin");
      await new PluginManager(cwd).setEnabledFeatures(target.nativeName, mutation.features);
    } else if (mutation.operation === "setting" && !project) {
      const schema = target.manifest.settings?.[mutation.key];
      if (!schema) throw new Error("Requested plugin setting is not declared by this plugin");
      const validation = validateSetting(mutation.value, schema);
      if (!validation.valid) throw new Error(`Invalid plugin setting: ${validation.error}`);
      await new PluginManager(cwd).setPluginSetting(target.nativeName, mutation.key, mutation.value);
    } else if (mutation.operation === "reset-setting" && !project) {
      if (!target.manifest.settings?.[mutation.key]) throw new Error("Requested plugin setting is not declared by this plugin");
      await new PluginManager(cwd).deletePluginSetting(target.nativeName, mutation.key);
    } else throw new Error(target.public.configurationReason ?? "This plugin mutation is unavailable");
    return (await this.#read(cwd)).catalog;
  }
}
