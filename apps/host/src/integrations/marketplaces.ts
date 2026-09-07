import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { NativeMarketplaceCatalog, NativePluginAcquisition } from "../../../../packages/shared/src/plugin-acquisition";
import { parseMarketplaceSourceOptions, type NativeMarketplaceSourceOptions } from "../../../../packages/shared/src/plugin-acquisition";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
  MarketplaceManager,
  getInstalledPluginsRegistryPath,
  getMarketplacesCacheDir,
  getPluginsCacheDir,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { parseMarketplaceCatalog } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/fetcher";
import { isValidNameSegment, parsePluginId } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/types";
import {
  getMarketplacesRegistryPath,
  getPluginsDir,
  getPluginsLockfile,
  getPluginsPackageJson,
} from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

const MAX_FILE = 1024 * 1024;
const MAX_MARKETPLACES = 256;
const MAX_PLUGINS = 4096;

type Scope = "user" | "project";
type MarketplaceEntry = {
  name: string;
  sourceType: "github" | "git" | "url" | "local";
  sourceUri: string;
  catalogPath: string;
  sourceOptions?: NativeMarketplaceSourceOptions;
};
type InstalledEntry = { scope: Scope; installPath: string; version: string; enabled?: boolean };
type InstalledRow = { id: string; entry: InstalledEntry };
type Context = {
  cwd: string;
  marketplaceRegistry: string;
  marketplaceCache: string;
  pluginsCache: string;
  userRegistry: string;
  userPackage: string;
  userLock: string;
  projectRegistry?: string;
  projectPackage?: string;
  projectLock?: string;
};

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function boundedText(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return undefined;
    throw new Error("Native plugin state is not a readable owned file");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE) throw new Error("Native plugin state is invalid or too large");
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    const link = await lstat(file);
    if (!link.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytesRead !== after.size ||
      after.dev !== link.dev || after.ino !== link.ino || after.mtimeMs !== link.mtimeMs || after.ctimeMs !== link.ctimeMs) {
      throw new Error("Native plugin state changed while it was read");
    }
    if (bytesRead > MAX_FILE) throw new Error("Native plugin state is too large");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: string | undefined, label: string): unknown {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { throw new Error(`${label} is malformed`); }
}

function parseMarketplaces(value: unknown): MarketplaceEntry[] {
  if (value === undefined) return [];
  if (!object(value) || value.version !== 1 || !Array.isArray(value.marketplaces) || value.marketplaces.length > MAX_MARKETPLACES) {
    throw new Error("Native marketplace registry is invalid");
  }
  return value.marketplaces.map((raw, index) => {
    if (!object(raw) || typeof raw.name !== "string" || !isValidNameSegment(raw.name) ||
      !["github", "git", "url", "local"].includes(String(raw.sourceType)) || typeof raw.sourceUri !== "string" ||
      typeof raw.catalogPath !== "string") throw new Error(`Native marketplace registry entry ${index} is invalid`);
    if (raw.sourceOptions !== undefined) parseMarketplaceSourceOptions(raw.sourceOptions);
    return raw as MarketplaceEntry;
  });
}

function parseInstalled(value: unknown, scope: Scope): InstalledRow[] {
  if (value === undefined) return [];
  if (!object(value) || typeof value.version !== "number" || !object(value.plugins)) throw new Error("Native installed plugin registry is invalid");
  const rows: Array<{ id: string; entry: InstalledEntry }> = [];
  for (const [id, entries] of Object.entries(value.plugins)) {
    if (!parsePluginId(id) || !Array.isArray(entries)) throw new Error("Native installed plugin registry entry is invalid");
    for (const raw of entries) {
      if (!object(raw) || raw.scope !== scope || typeof raw.installPath !== "string" || typeof raw.version !== "string" ||
        (raw.enabled !== undefined && typeof raw.enabled !== "boolean")) throw new Error("Native installed plugin registry entry is invalid");
      rows.push({ id, entry: raw as InstalledEntry });
      if (rows.length > MAX_PLUGINS) throw new Error("Native installed plugin registry is too large");
    }
  }
  return rows;
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
function validPackageName(value: string): boolean { return value.length <= 214 && PACKAGE_NAME.test(value); }

async function installedPackageName(entry: InstalledEntry, fallback: string): Promise<string> {
  const raw = parseJson(await boundedText(path.join(entry.installPath, "package.json")), "Installed plugin package");
  const name = object(raw) && typeof raw.name === "string" && raw.name ? raw.name : fallback;
  if (!validPackageName(name)) throw new Error("Installed plugin package name is invalid");
  return name;
}

function validateRuntime(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!object(value) || !object(value.plugins) || !object(value.settings)) throw new Error(`${label} is invalid`);
  for (const [name, state] of Object.entries(value.plugins)) {
    if (!object(state) || typeof state.version !== "string" || typeof state.enabled !== "boolean" ||
      !(state.enabledFeatures === null || (Array.isArray(state.enabledFeatures) && state.enabledFeatures.every(item => typeof item === "string")))) {
      throw new Error(`${label} contains an invalid plugin state`);
    }
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name) || name.length > 214) throw new Error(`${label} contains an invalid package name`);
  }
  for (const [name, settings] of Object.entries(value.settings)) {
    if (!object(settings) || name.length > 214) throw new Error(`${label} contains invalid settings`);
  }
}

async function lockTarget(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error("Native plugin lock target is not a regular file");
    return await realpath(file);
  } catch (error) {
    if (!missing(error)) throw error;
    let ancestor = path.dirname(file);
    const missingParts = [path.basename(file)];
    while (true) {
      try {
        const canonical = await realpath(ancestor);
        return path.join(canonical, ...missingParts.reverse());
      } catch (parentError) {
        if (!missing(parentError)) throw parentError;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw parentError;
        missingParts.push(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function nativeMutation<T>(operation: NativePluginAcquisition["operation"], run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch { throw new Error(`Native ${operation} operation failed`); }
}

export class NativeMarketplaces {
  #tail: Promise<unknown> = Promise.resolve();
  #revisions = new Map<string, { fingerprint: string; revision: string }>();

  async #context(cwd: string): Promise<Context> {
    const canonical = await realpath(cwd);
    if (!(await lstat(canonical)).isDirectory()) throw new Error("Plugin working directory must be a directory");
    const projectRegistry = await resolveActiveProjectRegistryPath(canonical) ?? undefined;
    const projectRoot = projectRegistry ? path.dirname(projectRegistry) : undefined;
    return {
      cwd: canonical,
      marketplaceRegistry: getMarketplacesRegistryPath(), marketplaceCache: getMarketplacesCacheDir(), pluginsCache: getPluginsCacheDir(),
      userRegistry: getInstalledPluginsRegistryPath(), userPackage: getPluginsPackageJson(), userLock: getPluginsLockfile(),
      projectRegistry, projectPackage: projectRoot ? path.join(projectRoot, "package.json") : undefined,
      projectLock: projectRoot ? path.join(projectRoot, "omp-plugins.lock.json") : undefined,
    };
  }

  #manager(context: Context): MarketplaceManager {
    return new MarketplaceManager({
      marketplacesRegistryPath: context.marketplaceRegistry, installedRegistryPath: context.userRegistry,
      ...(context.projectRegistry ? { projectInstalledRegistryPath: context.projectRegistry } : {}),
      marketplacesCacheDir: context.marketplaceCache, pluginsCacheDir: context.pluginsCache,
      clearPluginRootsCache: clearPluginRootsAndCaches,
    });
  }

  async #installed(context: Context, scope: Scope): Promise<InstalledRow[]> {
    const file = scope === "project" ? context.projectRegistry : context.userRegistry;
    if (!file) return [];
    return parseInstalled(parseJson(await boundedText(file), "Native installed plugin registry"), scope);
  }

  async #assertRuntimeLink(context: Context, scope: Scope, packageName: string, ownerId: string, ownerPaths: string[]): Promise<void> {
    if (!validPackageName(packageName)) throw new Error("Marketplace plugin package name is invalid");
    const root = path.dirname(scope === "project" ? context.projectRegistry! : context.userRegistry);
    const nodeModules = path.join(root, "node_modules");
    for (const parent of [nodeModules, ...(packageName.startsWith("@") ? [path.join(nodeModules, packageName.split("/")[0]!)] : [])]) {
      const parentInfo = await lstat(parent).catch(error => missing(error) ? undefined : Promise.reject(error));
      if (parentInfo && (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !within(await realpath(root), await realpath(parent)))) {
        throw new Error("Native plugin runtime parent belongs to another installation");
      }
    }
    const link = path.join(nodeModules, packageName);
    const info = await lstat(link).catch(error => missing(error) ? undefined : Promise.reject(error));
    if (info) {
      if (!info.isSymbolicLink()) throw new Error("Native plugin runtime path belongs to another installation");
      const target = await realpath(link);
      const allowed = new Set(await Promise.all(ownerPaths.map(item => realpath(item))));
      if (!allowed.has(target)) throw new Error("Native plugin runtime link belongs to another installation");
    }
    const rows = await this.#installed(context, scope);
    for (const row of rows) {
      if (row.id === ownerId) continue;
      const parsed = parsePluginId(row.id)!;
      if (await installedPackageName(row.entry, parsed.name) === packageName) {
        throw new Error("Another marketplace plugin owns the same native runtime package");
      }
    }
  }

  async #snapshot(cwd: string): Promise<{ context: Context; catalog: NativeMarketplaceCatalog }> {
    const context = await this.#context(cwd);
    const registryText = await boundedText(context.marketplaceRegistry);
    const userInstalledText = await boundedText(context.userRegistry);
    const projectInstalledText = context.projectRegistry ? await boundedText(context.projectRegistry) : undefined;
    const userPackageText = await boundedText(context.userPackage);
    const userLockText = await boundedText(context.userLock);
    const projectPackageText = context.projectPackage ? await boundedText(context.projectPackage) : undefined;
    const projectLockText = context.projectLock ? await boundedText(context.projectLock) : undefined;
    const entries = parseMarketplaces(parseJson(registryText, "Native marketplace registry"));
    const user = parseInstalled(parseJson(userInstalledText, "Native installed plugin registry"), "user");
    const project = context.projectRegistry ? parseInstalled(parseJson(projectInstalledText, "Project installed plugin registry"), "project") : [];
    validateRuntime(parseJson(userLockText, "User plugin runtime registry"), "User plugin runtime registry");
    validateRuntime(parseJson(projectLockText, "Project plugin runtime registry"), "Project plugin runtime registry");
    const hash = createHash("sha256");
    const files: Array<[string, string | undefined]> = [
      [context.marketplaceRegistry, registryText], [context.userRegistry, userInstalledText],
      [context.userPackage, userPackageText], [context.userLock, userLockText],
      ...(context.projectRegistry ? [[context.projectRegistry, projectInstalledText] as [string, string | undefined]] : []),
      ...(context.projectPackage ? [[context.projectPackage, projectPackageText] as [string, string | undefined]] : []),
      ...(context.projectLock ? [[context.projectLock, projectLockText] as [string, string | undefined]] : []),
    ];
    const marketplaces: NativeMarketplaceCatalog["marketplaces"] = [];
    const cacheRoot = await realpath(context.marketplaceCache).catch(() => path.resolve(context.marketplaceCache));
    for (const entry of entries) {
      const expected = path.resolve(context.marketplaceCache, entry.name, "marketplace.json");
      if (path.resolve(entry.catalogPath) !== expected) throw new Error("Native marketplace catalog path is outside its owned cache");
      const catalogDirectory = path.dirname(expected);
      const directoryInfo = await lstat(catalogDirectory).catch(error => missing(error) ? undefined : Promise.reject(error));
      if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !within(cacheRoot, await realpath(catalogDirectory)))) {
        throw new Error("Native marketplace catalog path is outside its owned cache");
      }
      const raw = await boundedText(expected);
      files.push([expected, raw]);
      if (raw === undefined) {
        marketplaces.push({ name: entry.name, sourceType: entry.sourceType, ...(entry.sourceOptions ? {sourceOptions:entry.sourceOptions} : {}), catalogAvailable: false, plugins: [] });
        continue;
      }
      const parsed = parseMarketplaceCatalog(raw, expected);
      if (parsed.name !== entry.name || parsed.plugins.length > MAX_PLUGINS) throw new Error("Native marketplace cache does not match its registry entry");
      marketplaces.push({
        name: entry.name, sourceType: entry.sourceType, catalogAvailable: true,
        ...(entry.sourceOptions ? {sourceOptions:entry.sourceOptions} : {}),
        ...(typeof parsed.metadata?.description === "string" ? { description: parsed.metadata.description } : {}),
        plugins: parsed.plugins.map(plugin => {
          const npm = typeof plugin.source === "object" && plugin.source.source === "npm";
          const relativeUrl = entry.sourceType === "url" && typeof plugin.source === "string";
          const installable = !npm && !relativeUrl;
          return { name: plugin.name,
            ...(typeof plugin.description === "string" ? { description: plugin.description } : {}),
            ...(typeof plugin.version === "string" ? { version: plugin.version } : {}), installable,
            ...(!installable ? { unavailabilityReason: npm
              ? "Native npm marketplace plugin sources are unsupported"
              : "Relative plugin sources require a local or Git marketplace" } : {}) };
        }),
      });
    }
    for (const [file, raw] of files.sort(([a], [b]) => a.localeCompare(b))) hash.update(file).update("\0").update(raw ?? "\0missing").update("\0");
    const fingerprint = hash.digest("hex");
    const prior = this.#revisions.get(context.cwd);
    const revision = prior?.fingerprint === fingerprint ? prior.revision : randomUUID();
    this.#revisions.set(context.cwd, { fingerprint, revision });
    return { context, catalog: {
      revision, projectScopeAvailable: !!context.projectRegistry,
      marketplaces: marketplaces.sort((a, b) => a.name.localeCompare(b.name)),
      installed: [...project, ...user]
        .map(({ id, entry }) => ({ id, scope: entry.scope, version: entry.version, enabled: entry.enabled !== false }))
        .sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope)),
    } };
  }

  async #locks(context: Context): Promise<string[]> {
    const targets = [context.marketplaceRegistry, context.userRegistry, context.userPackage, context.userLock,
      ...(context.projectRegistry ? [context.projectRegistry] : []),
      ...(context.projectPackage ? [context.projectPackage] : []),
      ...(context.projectLock ? [context.projectLock] : [])];
    return [...new Set(await Promise.all(targets.map(lockTarget)))].sort();
  }

  async #withLocks<T>(context: Context, operation: () => Promise<T>): Promise<T> {
    const locks = await this.#locks(context);
    for (const lock of locks) await mkdir(path.dirname(lock), { recursive: true });
    const run = async (index: number): Promise<T> => index === locks.length
      ? operation()
      : withFileLock(locks[index]!, () => run(index + 1));
    return run(0);
  }

  read(cwd: string): Promise<NativeMarketplaceCatalog> {
    const work = this.#tail.then(async () => {
      const context = await this.#context(cwd);
      return this.#withLocks(context, async () => (await this.#snapshot(context.cwd)).catalog);
    });
    this.#tail = work.catch(() => {});
    return work;
  }

  mutate(cwd: string, expectedRevision: string, action: NativePluginAcquisition): Promise<NativeMarketplaceCatalog> {
    const work = this.#tail.then(() => this.#mutate(cwd, expectedRevision, action));
    this.#tail = work.catch(() => {});
    return work;
  }

  async #mutate(cwd: string, expectedRevision: string, action: NativePluginAcquisition): Promise<NativeMarketplaceCatalog> {
    const initial = await this.#snapshot(cwd);
    if (initial.catalog.revision !== expectedRevision) throw new Error("Native marketplace state changed; reload before applying this action");
    if ((action.operation === "plugin.install" || action.operation === "plugin.upgrade" || action.operation === "plugin.uninstall") && action.scope === "project" && !initial.context.projectRegistry) {
      throw new Error("Project plugin installation is unavailable outside an active project");
    }
    return this.#withLocks(initial.context, () => this.#apply(initial.context.cwd, expectedRevision, action));
  }

  async #apply(cwd: string, expectedRevision: string, action: NativePluginAcquisition): Promise<NativeMarketplaceCatalog> {
    const current = await this.#snapshot(cwd);
    if (current.catalog.revision !== expectedRevision) throw new Error("Native marketplace state changed before its configuration locks were acquired");
    const manager = this.#manager(current.context);
    if (action.operation === "marketplace.add") {
      if (!action.source || action.source.includes("\0")) throw new Error("Marketplace source is invalid");
      const options = action.sourceOptions === undefined ? undefined : parseMarketplaceSourceOptions(action.sourceOptions);
      await nativeMutation(action.operation, () => manager.addMarketplace(action.source, options));
    } else if (action.operation === "marketplace.update" || action.operation === "marketplace.remove") {
      if (!isValidNameSegment(action.name) || !current.catalog.marketplaces.some(row => row.name === action.name)) throw new Error("Marketplace is unavailable");
      const cacheDir = path.join(current.context.marketplaceCache, action.name);
      const info = await lstat(cacheDir).catch(error => missing(error) ? undefined : Promise.reject(error));
      if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error("Marketplace cache ownership is invalid");
      if (action.operation === "marketplace.update") await nativeMutation(action.operation, () => manager.updateMarketplace(action.name));
      else await nativeMutation(action.operation, () => manager.removeMarketplace(action.name));
    } else if (action.operation === "plugin.install") {
      if (!isValidNameSegment(action.name) || !isValidNameSegment(action.marketplace)) throw new Error("Marketplace plugin identity is invalid");
      const listed = current.catalog.marketplaces.find(row => row.name === action.marketplace)?.plugins.find(row => row.name === action.name);
      if (!listed || !listed.installable) throw new Error(listed?.unavailabilityReason ?? "Marketplace plugin is unavailable");
      const identity = `${action.name}@${action.marketplace}`;
      await nativeMutation(action.operation, () => manager.installPlugin(action.name, action.marketplace, {
        scope: action.scope, reuseExistingCache: true,
        validatePackage: async packageName => {
          const afterFetch = await this.#snapshot(current.context.cwd);
          if (afterFetch.catalog.revision !== expectedRevision) {
            throw new Error("Native marketplace state changed while the plugin source was fetched");
          }
          await this.#assertRuntimeLink(afterFetch.context, action.scope, packageName, identity, []);
        },
      }));
    } else if (action.operation === "plugin.upgrade" || action.operation === "plugin.uninstall") {
      if (!parsePluginId(action.pluginId)) throw new Error("Marketplace plugin identity is invalid");
      const target = current.catalog.installed.find(row => row.id === action.pluginId && row.scope === action.scope);
      if (!target) throw new Error("Marketplace plugin is not installed in the requested scope");
      const registry = parseInstalled(parseJson(await boundedText(action.scope === "project" ? current.context.projectRegistry! : current.context.userRegistry), "Native installed plugin registry"), action.scope);
      const cacheRoot = await realpath(current.context.pluginsCache).catch(() => path.resolve(current.context.pluginsCache));
      for (const { id, entry } of registry.filter(row => row.id === action.pluginId)) {
        const canonical = await realpath(entry.installPath);
        const info = await lstat(entry.installPath);
        if (id !== action.pluginId || !info.isDirectory() || info.isSymbolicLink() || !within(cacheRoot, canonical)) throw new Error("Installed plugin cache ownership is invalid");
      }
      const owned = registry.filter(row => row.id === action.pluginId).map(row => row.entry);
      const parsed = parsePluginId(action.pluginId)!;
      const packageNames = new Set(await Promise.all(owned.map(entry => installedPackageName(entry, parsed.name))));
      for (const packageName of packageNames) await this.#assertRuntimeLink(current.context, action.scope, packageName, action.pluginId, owned.map(entry => entry.installPath));
      if (action.operation === "plugin.uninstall") {
        await nativeMutation(action.operation, () => manager.uninstallPlugin(action.pluginId, action.scope, { preserveCache: true }));
      } else {
        if (packageNames.size !== 1) throw new Error("Installed plugin package identity is ambiguous");
        const listed = current.catalog.marketplaces.find(row => row.name === parsed.marketplace)?.plugins.find(row => row.name === parsed.name);
        if (!listed || !listed.installable) throw new Error(listed?.unavailabilityReason ?? "Marketplace plugin is unavailable");
        const ownerPaths = owned.map(entry => entry.installPath);
        await nativeMutation(action.operation, () => manager.installPlugin(parsed.name, parsed.marketplace, {
          force: true, scope: action.scope, reuseExistingCache: true, preservePreviousCache: true,
          validatePackage: async candidate => {
            const afterFetch = await this.#snapshot(current.context.cwd);
            if (afterFetch.catalog.revision !== expectedRevision) {
              throw new Error("Native marketplace state changed while the plugin source was fetched");
            }
            await this.#assertRuntimeLink(afterFetch.context, action.scope, candidate, action.pluginId, ownerPaths);
          },
        }));
      }
    } else throw new Error("Unsupported native marketplace action");
    return (await this.#snapshot(cwd)).catalog;
  }
}
