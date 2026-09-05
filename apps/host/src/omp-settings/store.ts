import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { OmpSettingState, OmpSettingsMutation, OmpSettingsSnapshot, SettingJson, OmpSettingOptions } from "@agent-desktop/shared";
import { Settings, type SettingPath, type SettingValue } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault, isCredential, getUi, getEnumValues, BUILTIN_COMPOSER_SHAPES } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getAvailableThemesWithPaths } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import { stringifyYamlConfig } from "@oh-my-pi/pi-coding-agent/config/config-file";
import { invalidate } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { replaceFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { describeSetting, OmpSettingsError, requireSetting, settingPaths, settingsCatalog, validateSettingValue } from "./schema";
import { OmpModelDefinitionsStore } from "./model-definitions";

export function readPath(record: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = record;
  for (const segment of dotted.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
function setPath(record: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let current = record;
  for (const part of parts.slice(0, -1)) {
    if (current[part] === undefined) current[part] = {};
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) {
      throw new OmpSettingsError("write-failed", "Existing project value shadows the requested settings group");
    }
    current = current[part] as Record<string, unknown>;
  }
  if (value === undefined) delete current[parts.at(-1)!];
  else current[parts.at(-1)!] = value;
}
function configured(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && (typeof value !== "object" || Object.keys(value).length > 0);
}
export function settingStates(settings: Settings): OmpSettingState[] {
  const global = settings.getGlobalSettings();
  const project = settings.getProjectSettings();
  return settingPaths.map(key => {
    const value = settings.get(key), globalValue = readPath(global, key), projectValue = readPath(project, key);
    const credential = isCredential(key);
    return {
      path: key, credential, configured: credential ? configured(value) : settings.isConfigured(key),
      globalConfigured: credential ? configured(globalValue) : globalValue !== undefined,
      projectConfigured: credential ? configured(projectValue) : projectValue !== undefined,
      ...(!credential ? {
        ...(value === undefined ? {} : { effective: structuredClone(value) as SettingJson }),
        ...(globalValue === undefined ? {} : { global: structuredClone(globalValue) as SettingJson }),
        ...(projectValue === undefined ? {} : { project: structuredClone(projectValue) as SettingJson }),
      } : {}),
      origin: !settings.isConfigured(key) ? "default"
        : projectValue !== undefined && Bun.deepEquals(projectValue, value) ? "project"
          : globalValue !== undefined && Bun.deepEquals(globalValue, value) ? "global" : "native-overlay-or-normalization",
    };
  });
}
async function textIfPresent(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Owning-host configuration service; values never enter global app preferences. */
export class OmpSettings {
  readonly agentDir: string;
  readonly cwd: string;
  #revision = crypto.randomUUID();
  #fingerprint?: string;
  #tail: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #models: OmpModelDefinitionsStore;
  private constructor(agentDir: string, cwd: string) { this.agentDir = agentDir; this.cwd = cwd; this.#models = new OmpModelDefinitionsStore(agentDir); }
  static async open(options: { agentDir?: string; cwd: string }): Promise<OmpSettings> {
    return new OmpSettings(path.resolve(options.agentDir ?? getAgentDir()), await realpath(options.cwd));
  }
  catalog() { return settingsCatalog(); }
  readModelDefinitions() { this.#active(); return this.#models.read(); }
  mutateModelDefinitions(mutation: import("@agent-desktop/shared").OmpModelDefinitionsMutation) { this.#active(); return this.#models.mutate(mutation); }
  async options(setting: string): Promise<OmpSettingOptions> {
    this.#active();
    const key = requireSetting(setting);
    if (key === "theme.dark" || key === "theme.light") {
      // Native registry locates its theme directory through the process profile.
      if (this.agentDir !== path.resolve(getAgentDir())) throw new OmpSettingsError("unsupported", "Theme options require a process configured for this native agent directory");
      return { path: key, options: (await getAvailableThemesWithPaths()).map(theme => ({ value: theme.name, label: theme.name })), source: "native-theme-registry", extensionCoverage: "not-applicable" };
    }
    if (key === "composer.shape") return { path: key, options: BUILTIN_COMPOSER_SHAPES.map(option => ({ ...option })), source: "native-composer-builtins", extensionCoverage: "requires-session-registry" };
    const options = getUi(key)?.options;
    return { path: key, options: Array.isArray(options) ? options.map(option => ({ ...option })) : (getEnumValues(key) ?? []).map(value => ({ value, label: value })), source: "native-static", extensionCoverage: "not-applicable" };
  }
  #active(): void { if (this.#disposed) throw new OmpSettingsError("unsupported", "OMP settings service is disposed"); }
  async #readNative(): Promise<{ settings: Settings; snapshot: OmpSettingsSnapshot }> {
    this.#active();
    try {
      const yml = path.join(this.agentDir, "config.yml"), yaml = path.join(this.agentDir, "config.yaml");
      const project = path.join(this.cwd, ".omp", "config.yml");
      invalidate(yml); invalidate(yaml); invalidate(project);
      const settings = await Settings.loadReadOnly({ agentDir: this.agentDir, cwd: this.cwd });
      const sourceText = await Promise.all([textIfPresent(yml), textIfPresent(yaml), textIfPresent(project)]);
      const fingerprint = createHash("sha256").update(JSON.stringify({ sourceText,
        global: settings.getGlobalSettings(), project: settings.getProjectSettings(),
        effective: settingPaths.map(key => settings.get(key)),
      })).digest("hex");
      // The digest contains credential-dependent material and remains private.
      // Clients receive random revisions, never hashes of configuration secrets.
      if (fingerprint !== this.#fingerprint) { this.#fingerprint = fingerprint; this.#revision = crypto.randomUUID(); }
      return { settings, snapshot: {
        revision: this.#revision, cwd: this.cwd, entries: settingStates(settings),
        sources: { globalPath: sourceText[0] !== undefined || sourceText[1] === undefined ? yml : yaml,
          projectWritePath: project, projectRead: "native-capability-merged", overlays: "native-process-configuration" },
        mutationEffects: "new-sessions-read-updated-config",
      } };
    } catch (error) {
      if (error instanceof OmpSettingsError) throw error;
      throw new OmpSettingsError("read-failed", "Native OMP configuration could not be read; no configuration values are included in this error");
    }
  }
  async read(): Promise<OmpSettingsSnapshot> { return (await this.#readNative()).snapshot; }
  mutate(request: OmpSettingsMutation): Promise<OmpSettingsSnapshot> {
    this.#active();
    const operation = this.#tail.then(() => this.#mutate(request));
    this.#tail = operation.catch(() => {});
    return operation;
  }
  async #mutate(request: OmpSettingsMutation): Promise<OmpSettingsSnapshot> {
    this.#active();
    const key = requireSetting(request.path);
    if (!describeSetting(key).scopes.includes(request.scope)) throw new OmpSettingsError("unsupported", "This native setting is not supported at the requested scope");
    if (!["set", "reset"].includes(request.operation)) throw new OmpSettingsError("invalid-value", "Unknown settings mutation");
    const value = request.operation === "reset" ? structuredClone(getDefault(key)) : validateSettingValue(key, request.value);
    const before = await this.read();
    if (before.revision !== request.expectedRevision) throw new OmpSettingsError("conflict", "OMP settings changed; reload before applying this edit");
    try {
      if (request.scope === "global") {
        const writer = await Settings.loadIsolated({ agentDir: this.agentDir, cwd: this.cwd });
        try {
          if ((await this.read()).revision !== request.expectedRevision) throw new OmpSettingsError("conflict", "OMP configuration changed during writer initialization");
          writer.set(key, value as SettingValue<typeof key>);
          await writer.flush();
        } finally {
          writer.cancelPendingSaves();
          // Native AgentStorage is a process cache with only a static close-all
          // method. Its owner process, not one settings edit, owns that lifetime.
        }
      } else {
        await this.#writeProject(before.sources.projectWritePath, request.expectedRevision, key, value);
      }
      const after = await this.#readNative();
      const persisted = request.scope === "global" ? after.settings.getGlobalSettings() : await this.#projectFile(before.sources.projectWritePath);
      if (!Bun.deepEquals(readPath(persisted, key), value)) throw new OmpSettingsError("conflict", "The native writer did not retain this value; configuration changed during the write");
      return after.snapshot;
    } catch (error) {
      if (error instanceof OmpSettingsError) throw error;
      throw new OmpSettingsError("write-failed", "Native OMP settings write failed; reload to inspect the owning host's configuration");
    }
  }
  async #projectFile(file: string): Promise<Record<string, unknown>> {
    const text = await textIfPresent(file);
    if (text === undefined || text.trim() === "") return {};
    const parsed = Bun.YAML.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OmpSettingsError("read-failed", "Native project configuration must be a YAML mapping");
    return parsed as Record<string, unknown>;
  }
  async #writeProject(file: string, expectedRevision: string, key: SettingPath, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    let target: string;
    try { target = await realpath(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const metadata = await lstat(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (metadata?.isSymbolicLink()) throw new OmpSettingsError("unsupported", "Dangling project configuration symlink requires repair before editing");
      target = path.join(await realpath(path.dirname(file)), path.basename(file));
    }
    await withFileLock(target, async () => {
      if ((await this.read()).revision !== expectedRevision) throw new OmpSettingsError("conflict", "OMP configuration changed before its project write lock was acquired");
      const current = await this.#projectFile(target);
      setPath(current, key, value);
      const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(stringifyYamlConfig(current), "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await replaceFileAtomically(temp, target);
      } finally { await rm(temp, { force: true }); }
      invalidate(file); invalidate(target);
    });
  }
  async dispose(): Promise<void> { this.#disposed = true; await this.#tail; await this.#models.dispose(); }
}
