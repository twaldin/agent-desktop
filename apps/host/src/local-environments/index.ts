import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, statSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type LocalEnvironmentPlatform = "darwin" | "linux" | "win32";
export type LocalEnvironmentIcon = "tool" | "run" | "debug" | "test";
export interface LocalEnvironmentScript {
  script: string;
  darwin?: { script: string };
  linux?: { script: string };
  win32?: { script: string };
}
export interface LocalEnvironmentAction {
  name: string;
  icon: LocalEnvironmentIcon | null;
  command: string;
  platform?: LocalEnvironmentPlatform;
}
export interface LocalEnvironmentConfig {
  version: number;
  name: string;
  setup: LocalEnvironmentScript;
  cleanup?: LocalEnvironmentScript;
  actions?: LocalEnvironmentAction[];
}
export interface LocalEnvironmentRecord {
  type: "environment";
  configPath: string;
  revision: string;
  environment: LocalEnvironmentConfig;
}
export interface LocalEnvironmentParseError {
  type: "error";
  configPath: string;
  revision?: string;
  error: string;
}
export type LocalEnvironmentCatalogItem = LocalEnvironmentRecord | LocalEnvironmentParseError;
export type LocalEnvironmentSaveResult =
  | { type: "saved"; configPath: string; revision: string; environment: LocalEnvironmentConfig }
  | { type: "conflict"; configPath: string; expectedRevision: string | null; current: LocalEnvironmentCatalogItem | null; attempted: { raw: string; environment: LocalEnvironmentConfig } };

const platforms: LocalEnvironmentPlatform[] = ["darwin", "linux", "win32"];
const icons = new Set<LocalEnvironmentIcon>(["tool", "run", "debug", "test"]);
const maximumConfigBytes = 1024 * 1024;
const saveTails = new Map<string, Promise<void>>();
const revision = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a table.`);
  return value as Record<string, unknown>;
};
const string = (value: unknown, label: string) => {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
};

function parseScript(value: unknown, label: string): LocalEnvironmentScript {
  const source = object(value, label), result: LocalEnvironmentScript = { script: string(source.script, `${label}.script`) };
  for (const platform of platforms) if (source[platform] !== undefined) result[platform] = { script: string(object(source[platform], `${label}.${platform}`).script, `${label}.${platform}.script`) };
  return result;
}

/** Parse the schema traced from the pinned native local-environment worker. */
export function parseLocalEnvironment(raw: string): LocalEnvironmentConfig {
  if (Buffer.byteLength(raw) > maximumConfigBytes) throw new Error("Environment config exceeds 1 MiB.");
  let parsed: unknown;
  try { parsed = parseToml(raw); }
  catch (cause) { throw new Error(`Invalid TOML: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const source = object(parsed, "Environment config");
  const version = source.version === undefined ? 1 : source.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) throw new Error("version must be an integer of at least 1.");
  const result: LocalEnvironmentConfig = { version: version as number, name: string(source.name, "name"), setup: parseScript(source.setup, "setup") };
  if (source.cleanup !== undefined) result.cleanup = parseScript(source.cleanup, "cleanup");
  if (source.actions !== undefined) {
    if (!Array.isArray(source.actions)) throw new Error("actions must be an array of tables.");
    result.actions = source.actions.map((value, index) => {
      const action = object(value, `actions[${index}]`), platform = action.platform;
      if (platform !== undefined && !platforms.includes(platform as LocalEnvironmentPlatform)) throw new Error(`actions[${index}].platform is invalid.`);
      return { name: string(action.name, `actions[${index}].name`), command: string(action.command, `actions[${index}].command`),
        icon: icons.has(action.icon as LocalEnvironmentIcon) ? action.icon as LocalEnvironmentIcon : null,
        ...(platform === undefined ? {} : { platform: platform as LocalEnvironmentPlatform }) };
    });
  }
  return result;
}

function tomlString(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  const native = !normalized.includes("\n") ? JSON.stringify(normalized)
    : !normalized.includes("'''") ? `'''\n${normalized}'''`
      : `"""\n${normalized.replace(/\\/g, "\\\\").replace(/"""/g, '\\"""')}"""`;
  try {
    if (parseToml(`value = ${native}\n`).value === normalized) return native;
  } catch {}
  return stringifyToml({ value: normalized }).trimEnd().slice("value = ".length);
}

function serializeScript(lines: string[], key: "setup" | "cleanup", value?: LocalEnvironmentScript) {
  if (!value) return;
  const overrides = platforms.filter(platform => Boolean(value[platform]?.script));
  if (key === "setup" || value.script.length || overrides.length) lines.push("", `[${key}]`, `script = ${tomlString(value.script)}`);
  for (const platform of overrides) lines.push("", `[${key}.${platform}]`, `script = ${tomlString(value[platform]!.script)}`);
}

/** Serialize the reusable format emitted by the pinned editor. */
export function serializeLocalEnvironment(environment: LocalEnvironmentConfig): string {
  const lines = ["# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY", `version = ${environment.version}`, `name = ${tomlString(environment.name.trim())}`];
  serializeScript(lines, "setup", environment.setup); serializeScript(lines, "cleanup", environment.cleanup);
  const actions = (environment.actions ?? []).flatMap(action => {
    const name = action.name.trim(), command = action.command.trim();
    return name && command ? [{ ...action, name, command }] : [];
  });
  if (actions.length) lines.push("");
  for (const action of actions) {
    lines.push("[[actions]]", `name = ${tomlString(action.name)}`);
    if (action.icon) lines.push(`icon = ${tomlString(action.icon)}`);
    lines.push(`command = ${tomlString(action.command)}`);
    if (action.platform) lines.push(`platform = ${tomlString(action.platform)}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Select a non-empty platform override, otherwise the lifecycle base script. */
export function scriptForPlatform(script: LocalEnvironmentScript | undefined, platform: LocalEnvironmentPlatform): string | null {
  if (!script) return null;
  return script[platform]?.script || script.script;
}

function safeName(name: string) {
  const value = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (value || "environment").slice(0, 100);
}

type LocalEnvironmentReadResult =
  | { type: "missing" }
  | { type: "item"; item: LocalEnvironmentCatalogItem; identity?: string; mode?: number };

const fileIdentity = (info: Stats) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;

export class LocalEnvironmentStore {
  readonly projectRoot: string;
  readonly directory: string;
  private readonly canonicalProjectRoot: string;
  private readonly canonicalDirectory: string;

  constructor(projectRoot: string) {
    if (!isAbsolute(projectRoot)) throw new Error("Project root must be absolute.");
    this.projectRoot = resolve(projectRoot);
    this.canonicalProjectRoot = realpathSync(this.projectRoot);
    if (!statSync(this.canonicalProjectRoot).isDirectory()) throw new Error("Project root must be a directory.");
    this.directory = join(this.projectRoot, ".agent-desktop", "environments");
    this.canonicalDirectory = join(this.canonicalProjectRoot, ".agent-desktop", "environments");
  }

  private async ownedRoot(create: boolean): Promise<string | null> {
    const root = await realpath(this.projectRoot);
    if (root !== this.canonicalProjectRoot || !(await stat(root)).isDirectory()) throw new Error("Project root identity changed.");
    const parent = dirname(this.directory);
    for (const path of [parent, this.directory]) {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Environment storage path is not an owned directory.");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        if (!create) return null;
        await mkdir(path, { mode: 0o700 });
      }
    }
    if (await realpath(this.directory) !== this.canonicalDirectory) throw new Error("Environment storage escaped the project.");
    return this.directory;
  }

  private ownedPath(directory: string, configPath: string): string {
    if (!isAbsolute(configPath)) throw new Error("Environment config path must be absolute.");
    const path = resolve(configPath), child = relative(directory, path);
    if (!child || child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child) || child.includes(sep) || !child.endsWith(".toml"))
      throw new Error("Environment config path is outside this project's environment directory.");
    return path;
  }

  private async readEntry(path: string): Promise<LocalEnvironmentReadResult> {
    let raw: Buffer, identity: string, mode: number;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (typeof constants.O_NOFOLLOW !== "number") throw new Error("This platform cannot safely open environment configs without following symlinks.");
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const before = await file.stat();
      if (!before.isFile()) throw new Error("Environment config must be a regular file, not a symlink.");
      if (before.size > maximumConfigBytes) throw new Error("Environment config exceeds 1 MiB.");
      const bounded = Buffer.allocUnsafe(maximumConfigBytes + 1);
      let length = 0;
      while (length < bounded.length) {
        const { bytesRead } = await file.read(bounded, length, bounded.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maximumConfigBytes) throw new Error("Environment config exceeds 1 MiB.");
      const after = await file.stat();
      if (fileIdentity(before) !== fileIdentity(after) || length !== after.size) throw new Error("Environment config changed while it was being read.");
      raw = bounded.subarray(0, length);
      identity = fileIdentity(after);
      mode = after.mode & 0o777;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { type: "missing" };
      const error = (cause as NodeJS.ErrnoException).code === "ELOOP" ? "Environment config must be a regular file, not a symlink."
        : cause instanceof Error ? cause.message : String(cause);
      return { type: "item", item: { type: "error", configPath: path, error } };
    } finally { await file?.close().catch(() => {}); }
    const currentRevision = revision(raw);
    try { return { type: "item", identity, mode, item: { type: "environment", configPath: path, revision: currentRevision, environment: parseLocalEnvironment(raw.toString("utf8")) } }; }
    catch (cause) { return { type: "item", identity, mode, item: { type: "error", configPath: path, revision: currentRevision, error: cause instanceof Error ? cause.message : String(cause) } }; }
  }

  async catalog(): Promise<LocalEnvironmentCatalogItem[]> {
    const directory = await this.ownedRoot(false); if (!directory) return [];
    const names = (await readdir(directory)).filter(name => name.endsWith(".toml")).sort((a, b) => a.localeCompare(b));
    const items: LocalEnvironmentCatalogItem[] = [];
    for (const name of names) {
      const entry = await this.readEntry(join(directory, name));
      if (entry.type === "item") items.push(entry.item);
    }
    return items;
  }

  async save(input: { configPath?: string | null; expectedRevision: string | null; raw: string }): Promise<LocalEnvironmentSaveResult> {
    const previous = saveTails.get(this.canonicalDirectory) ?? Promise.resolve();
    const operation = previous.then(() => this.saveOwned(input));
    const settled = operation.then(() => undefined, () => undefined);
    saveTails.set(this.canonicalDirectory, settled);
    void settled.finally(() => { if (saveTails.get(this.canonicalDirectory) === settled) saveTails.delete(this.canonicalDirectory); });
    return operation;
  }

  private async saveOwned(input: { configPath?: string | null; expectedRevision: string | null; raw: string }): Promise<LocalEnvironmentSaveResult> {
    if (input.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw new Error("Invalid environment revision.");
    const environment = parseLocalEnvironment(input.raw), directory = (await this.ownedRoot(true))!;
    let path: string;
    if (input.configPath) path = this.ownedPath(directory, input.configPath);
    else {
      if (input.expectedRevision !== null) throw new Error("A new environment cannot have an existing revision.");
      const stem = safeName(environment.name); path = join(directory, `${stem}.toml`);
      for (let suffix = 2; ; suffix++) {
        try { await lstat(path); path = join(directory, `${stem}-${suffix}.toml`); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") break; throw cause; }
      }
    }
    const original = await this.readEntry(path);
    const current = original.type === "item" ? original.item : null;
    const actualRevision = current?.revision ?? null;
    const conflict = (latest: LocalEnvironmentCatalogItem | null): LocalEnvironmentSaveResult => ({
      type: "conflict", configPath: path, expectedRevision: input.expectedRevision, current: latest,
      attempted: { raw: input.raw, environment },
    });
    if (actualRevision !== input.expectedRevision || (current?.type === "error" && !current.revision)) return conflict(current);
    const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", original.type === "item" ? original.mode : 0o600);
    try {
      await file.chmod(original.type === "item" ? original.mode! : 0o600);
      await file.writeFile(input.raw, "utf8"); await file.sync();
    }
    catch (cause) { await file.close(); await unlink(temporary).catch(() => {}); throw cause; }
    await file.close();
    try {
      await this.ownedRoot(false);
      const latest = await this.readEntry(path);
      const changed = original.type !== latest.type || (original.type === "item" && latest.type === "item" &&
        (original.identity !== latest.identity || original.item.revision !== latest.item.revision));
      if (changed) return conflict(latest.type === "item" ? latest.item : null);
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
    return { type: "saved", configPath: path, revision: revision(input.raw), environment };
  }
}
