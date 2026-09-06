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
  if (new TextEncoder().encode(raw).length > maximumConfigBytes) throw new Error("Environment config exceeds 1 MiB.");
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
