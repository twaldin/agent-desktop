import type { OmpSettingDescriptor, OmpSettingsCatalog, SettingValueSchema, SettingJson } from "@agent-desktop/shared";
import { SETTINGS_SCHEMA, getUi, isCredential, SETTING_TABS, TAB_METADATA, TAB_GROUPS, type SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { validateProviderMaxInFlightRequests } from "@oh-my-pi/pi-coding-agent/config/settings";

export const OMP_RELEASE_COMMIT = "f241301c83726afe75a847e919b89977a54dafbe";
export const settingPaths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];
if (settingPaths.length !== 484) throw new Error("OMP settings schema differs from pinned 18.1.10 (expected 484)");
const str: SettingValueSchema = { kind: "string" };
const num: SettingValueSchema = { kind: "number" };
const json: SettingValueSchema = { kind: "json" };
const strings: SettingValueSchema = { kind: "array", item: str };
const stringOrStrings: SettingValueSchema = { kind: "union", alternatives: [str, strings] };
const policy: SettingValueSchema = { kind: "enum", values: ["allow", "deny", "prompt"] };
const compound: Record<string, SettingValueSchema> = {
  "providers.maxInFlightRequests": { kind: "map", value: num },
  modelRoles: { kind: "map", value: stringOrStrings },
  modelTags: { kind: "map", value: { kind: "object", fields: { name: { schema: str }, color: { schema: str, optional: true }, hidden: { schema: { kind: "boolean" }, optional: true } } } },
  "statusLine.segmentOptions": { kind: "map", value: json },
  "images.urls.options": { kind: "map", value: { kind: "map", value: json } },
  "images.urls.credentials": { kind: "map", value: { kind: "map", value: str } },
  "retry.fallbackChains": { kind: "map", value: strings },
  "tools.approval": { kind: "map", value: policy },
  "task.agentModelOverrides": { kind: "map", value: stringOrStrings },
  "task.agentPrewalk": { kind: "map", value: str },
  "task.agentAdvisor": { kind: "map", value: str },
  "bash.patterns": { kind: "array", item: { kind: "object", fields: { match: { schema: str }, approval: { schema: policy } } } },
  "bashInterceptor.patterns": { kind: "array", item: { kind: "object", fields: {
    pattern: { schema: str }, flags: { schema: str, optional: true }, tool: { schema: str }, message: { schema: str }, allowSubcommands: { schema: strings, optional: true },
  } } },
};
// Native resolvePathScopedStringArray accepts either ordinary strings or these
// path-filtered entries. Preserve that source-supported syntax in the UI schema.
for (const path of ["enabledModels", "enabledProviders", "disabledProviders"]) {
  compound[path] = { kind: "array", item: { kind: "union", alternatives: [str, { kind: "object", fields: Object.fromEntries(
    ["path", "paths", "pathPrefix", "pathPrefixes", "values", "items", "models", "providers"].map(key => [key, { schema: stringOrStrings, optional: true }]),
  ) }] } };
}

export class OmpSettingsError extends Error {
  constructor(readonly code: import("@agent-desktop/shared").OmpSettingsErrorCode, message: string) {
    super(message); this.name = "OmpSettingsError";
  }
}
export function requireSetting(path: string): SettingPath {
  if (!Object.hasOwn(SETTINGS_SCHEMA, path)) throw new OmpSettingsError("invalid-setting", "Unknown pinned OMP setting");
  return path as SettingPath;
}
export function valueSchema(path: SettingPath): SettingValueSchema {
  const definition = SETTINGS_SCHEMA[path];
  if (compound[path]) return compound[path];
  switch (definition.type) {
    case "enum": return { kind: "enum", values: [...definition.values] };
    case "array": return strings;
    case "record": throw new OmpSettingsError("unsupported", `Missing compound schema for ${path}`);
    default: return { kind: definition.type };
  }
}
function check(value: unknown, schema: SettingValueSchema): boolean {
  switch (schema.kind) {
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "enum": return typeof value === "string" && schema.values.includes(value);
    case "array": return Array.isArray(value) && value.every(item => check(item, schema.item));
    case "map": return record(value) && Object.entries(value).every(([key, item]) => safeKey(key) && check(item, schema.value));
    case "object": return record(value) && Object.keys(value).every(key => safeKey(key) && Object.hasOwn(schema.fields, key))
      && Object.entries(schema.fields).every(([key, field]) => value[key] === undefined ? !!field.optional : check(value[key], field.schema));
    case "union": return schema.alternatives.some(option => check(value, option));
    case "json": return value === null || ["string", "boolean"].includes(typeof value)
      || (typeof value === "number" && Number.isFinite(value))
      || (Array.isArray(value) && value.every(item => check(item, json)))
      || (record(value) && Object.entries(value).every(([key, item]) => safeKey(key) && check(item, json)));
  }
}
function safeKey(key: string): boolean { return !["__proto__", "constructor", "prototype"].includes(key); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function validateSettingValue(path: SettingPath, value: unknown): SettingJson {
  if (!check(value, valueSchema(path))) throw new OmpSettingsError("invalid-value", `Value does not match the native type for ${path}`);
  if (path === "providers.maxInFlightRequests") {
    try { return validateProviderMaxInFlightRequests(value); }
    catch { throw new OmpSettingsError("invalid-value", "Native provider request limits must be positive numbers"); }
  }
  return structuredClone(value) as SettingJson;
}

function label(path: string): string {
  return path.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(".", " / ").replace(/^./, char => char.toUpperCase());
}
export function describeSetting(path: SettingPath): OmpSettingDescriptor {
  const definition = SETTINGS_SCHEMA[path];
  const ui = getUi(path);
  const credential = isCredential(path);
  const terminal = /^(theme\.|tui\.|statusLine\.|composer\.|terminal|editor\.|symbolPreset|colorBlindMode)/.test(path);
  const applicability = terminal ? "native-terminal" : path === "setupVersion" ? "native-internal"
    : /^(auth\.|shellPath$|extensions$|disabledExtensions$|skills\.)/.test(path) ? "host-configuration" : "native-runtime";
  return {
    path, type: definition.type, label: ui?.label ?? label(path), description: ui?.description,
    metadataSource: ui ? "native-ui" : "schema-path", tab: ui?.tab ?? "advanced", group: ui?.group ?? path.split(".")[0],
    advanced: !ui || !ui.options && ["number", "array", "record"].includes(definition.type),
    warning: ui?.warning, condition: ui?.condition, credential,
    ...(!credential && definition.default !== undefined ? { defaultValue: structuredClone(definition.default) as SettingJson } : {}),
    schema: valueSchema(path),
    control: credential ? "secret" : definition.type === "boolean" ? "toggle" : definition.type === "enum" || ui?.options === "runtime" ? "select"
      : definition.type === "number" ? "number" : definition.type === "array" ? ui?.ordered ? "ordered-list" : "list" : definition.type === "record" ? "record" : "text",
    ...(Array.isArray(ui?.options) ? { options: ui.options.map(option => ({ ...option })) } : {}),
    ...(ui?.options === "runtime" ? { dynamicOptions: "runtime" as const } : {}),
    scopes: path.startsWith("auth.") || path === "setupVersion" ? ["global"] : ["global", "project"], applicability, application: terminal ? "terminal-only" : "next-session",
    source: { version: "18.1.10", commit: OMP_RELEASE_COMMIT, file: "packages/coding-agent/src/config/settings-schema.ts" },
  };
}
export function settingsCatalog(): OmpSettingsCatalog {
  return { version: "18.1.10", sourceCommit: OMP_RELEASE_COMMIT, settings: settingPaths.map(describeSetting),
    groups: Object.fromEntries(Object.entries(TAB_GROUPS).map(([tab, groups]) => [tab, [...groups]])), tabs: SETTING_TABS.map(id => ({ id, ...TAB_METADATA[id] })), extensionSettings: "not-in-core-schema" };
}
