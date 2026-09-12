import { isSessionReadKey, parseSessionReadMark, type SessionReadMark } from "./session-read";
import { TREE_ICON_THEME_TOKENS } from "./tree-icon-theme";
export const PREFERENCES_VERSION = 1 as const;
export const PREFERENCE_LIMITS = { records: 10_000, snapshotBytes: 8 * 1024 * 1024, valueBytes: 64 * 1024 } as const;

export type ThemeTokenDefinition =
  | { kind: "color" }
  | { kind: "font-family" }
  | { kind: "length" | "number"; minimum: number; maximum: number };

/** Shared allowlist for sync, the theme file and future settings controls. Length limits are CSS pixels (rem/em = 16px for validation). */
export const THEME_TOKEN_DEFINITIONS = {
  ...TREE_ICON_THEME_TOKENS,
  "--app-surface": { kind: "color" }, "--sidebar-surface": { kind: "color" },
  "--composer-surface": { kind: "color" }, "--elevated-surface": { kind: "color" },
  "--dialog-input-surface": { kind: "color" },
  "--dialog-surface": { kind: "color" },
  "--dialog-backdrop-color": { kind: "color" },
  "--dialog-opacity": { kind: "number", minimum: 0, maximum: 1 },
  "--dialog-blur": { kind: "length", minimum: 0, maximum: 100 },
  "--welcome-mark-color": { kind: "color" },
  "--markdown-code-background": { kind: "color" },
  "--markdown-code-radius": { kind: "length", minimum: 0, maximum: 100 },
  "--markdown-code-label-size": { kind: "length", minimum: 8, maximum: 40 },
  "--transcript-code-radius": { kind: "length", minimum: 0, maximum: 100 },
  "--transcript-code-line-height": { kind: "number", minimum: 1, maximum: 3 },
  "--markdown-table-border": { kind: "color" },
  "--welcome-mark-opacity": { kind: "number", minimum: 0, maximum: 1 },
  "--welcome-mark-hover-opacity": { kind: "number", minimum: 0, maximum: 1 },
  "--user-message-surface": { kind: "color" }, "--user-message-text": { kind: "color" },
  "--header-divider-color": { kind: "color" }, "--sidebar-divider-color": { kind: "color" },
  "--header-inactive-icon-color": { kind: "color" },
  "--header-inset-right": { kind: "length", minimum: 0, maximum: 100 },
  "--header-action-gap": { kind: "length", minimum: 0, maximum: 100 },
  "--settings-card-surface": { kind: "color" },
  "--panel-surface": { kind: "color" }, "--menu-surface": { kind: "color" },
  "--editor-surface": { kind: "color" }, "--terminal-surface": { kind: "color" },
  "--text": { kind: "color" }, "--secondary": { kind: "color" }, "--tertiary": { kind: "color" },
  "--border": { kind: "color" }, "--hover": { kind: "color" }, "--selected": { kind: "color" },
  "--switch-on": { kind: "color" }, "--switch-off": { kind: "color" }, "--switch-thumb": { kind: "color" },
  "--accent": { kind: "color" }, "--accent-text": { kind: "color" }, "--focus-ring": { kind: "color" },
  "--danger": { kind: "color" }, "--error-surface": { kind: "color" },
  "--success": { kind: "color" }, "--warning": { kind: "color" }, "--selection-surface": { kind: "color" },
  "--code-surface": { kind: "color" }, "--code-text": { kind: "color" },
  "--diff-added-surface": { kind: "color" }, "--diff-removed-surface": { kind: "color" },
  "--diff-added-text": { kind: "color" }, "--diff-removed-text": { kind: "color" },
  "--syntax-keyword": { kind: "color" }, "--syntax-string": { kind: "color" },
  "--syntax-comment": { kind: "color" }, "--syntax-number": { kind: "color" },
  "--syntax-function": { kind: "color" }, "--syntax-type": { kind: "color" },
  "--syntax-attribute": { kind: "color" }, "--syntax-name": { kind: "color" }, "--syntax-error": { kind: "color" },
  "--ui-font": { kind: "font-family" }, "--code-font": { kind: "font-family" },
  "--terminal-font": { kind: "font-family" }, "--heading-font": { kind: "font-family" },
  "--font-size": { kind: "length", minimum: 8, maximum: 40 },
  "--code-font-size": { kind: "length", minimum: 8, maximum: 40 },
  "--terminal-font-size": { kind: "length", minimum: 8, maximum: 40 },
  "--heading-font-size": { kind: "length", minimum: 10, maximum: 80 },
  "--small-font-size": { kind: "length", minimum: 8, maximum: 32 },
  "--font-weight": { kind: "number", minimum: 100, maximum: 1000 },
  "--heading-font-weight": { kind: "number", minimum: 100, maximum: 1000 },
  "--code-font-weight": { kind: "number", minimum: 100, maximum: 1000 },
  "--line-height": { kind: "number", minimum: 1, maximum: 3 },
  "--transcript-line-height": { kind: "number", minimum: 1, maximum: 3 },
  "--code-line-height": { kind: "number", minimum: 1, maximum: 3 },
  "--letter-spacing": { kind: "length", minimum: -2, maximum: 8 },
  "--radius": { kind: "length", minimum: 0, maximum: 64 },
  "--radius-small": { kind: "length", minimum: 0, maximum: 64 },
  "--radius-large": { kind: "length", minimum: 0, maximum: 96 },
  "--composer-radius": { kind: "length", minimum: 0, maximum: 96 },
  "--user-message-radius": { kind: "length", minimum: 0, maximum: 96 },
  "--corner-radius-scale": { kind: "number", minimum: 0, maximum: 3 },
  "--corner-exponent": { kind: "number", minimum: 0, maximum: 4 },
  "--conversation-width": { kind: "length", minimum: 240, maximum: 2000 },
  "--attachment-thumbnail-size": { kind: "length", minimum: 32, maximum: 240 },
  "--menu-radius": { kind: "length", minimum: 0, maximum: 64 },
  "--panel-radius": { kind: "length", minimum: 0, maximum: 64 },
  "--button-radius": { kind: "length", minimum: 0, maximum: 64 },
  "--segmented-radius": { kind: "length", minimum: 0, maximum: 9999 },
  "--border-width": { kind: "length", minimum: 0, maximum: 8 },
  "--divider-width": { kind: "length", minimum: 0, maximum: 8 },
  "--composer-border-width": { kind: "length", minimum: 0, maximum: 8 },
  "--spacing-scale": { kind: "number", minimum: 0.5, maximum: 3 },
  "--spacing-xs": { kind: "length", minimum: 0, maximum: 32 },
  "--spacing-sm": { kind: "length", minimum: 0, maximum: 64 },
  "--spacing-md": { kind: "length", minimum: 0, maximum: 96 },
  "--spacing-lg": { kind: "length", minimum: 0, maximum: 128 },
  "--spacing-xl": { kind: "length", minimum: 0, maximum: 192 },
  "--row-padding-x": { kind: "length", minimum: 0, maximum: 64 },
  "--row-padding-y": { kind: "length", minimum: 0, maximum: 48 },
  "--composer-padding": { kind: "length", minimum: 0, maximum: 96 },
  "--panel-padding": { kind: "length", minimum: 0, maximum: 96 },
  "--icon-size": { kind: "length", minimum: 8, maximum: 64 },
  "--surface-opacity": { kind: "number", minimum: 0, maximum: 1 },
  "--sidebar-opacity": { kind: "number", minimum: 0, maximum: 1 },
  "--composer-opacity": { kind: "number", minimum: 0, maximum: 1 },
  "--panel-opacity": { kind: "number", minimum: 0, maximum: 1 },
  "--background-blur": { kind: "length", minimum: 0, maximum: 100 },
  "--sidebar-blur": { kind: "length", minimum: 0, maximum: 100 },
  "--panel-blur": { kind: "length", minimum: 0, maximum: 100 },
} as const satisfies Record<string, ThemeTokenDefinition>;

export type ThemeTokenName = keyof typeof THEME_TOKEN_DEFINITIONS;
export type ThemeTokens = Partial<Record<ThemeTokenName, string>>;
export type ThemeBackground =
  | { kind: "none" }
  | { kind: "color"; color: string }
  | { kind: "gradient"; angle: number; stops: { color: string; position: number }[] }
  | { kind: "asset"; sha256: string; fit: "cover" | "contain" | "tile"; opacity: number; blur: number };
export type SidebarGrouping = "project" | "connection" | "list";
export type SidebarSort = "priority" | "updated_at" | "manual";
export interface SidebarOrganization { grouping: SidebarGrouping; projectSort: SidebarSort; chatSort: SidebarSort }
export const DEFAULT_SIDEBAR_ORGANIZATION: SidebarOrganization = { grouping: "project", projectSort: "updated_at", chatSort: "updated_at" };
// Existing explicit sidebar positions retain their previous interpretation.
export const LEGACY_SIDEBAR_ORGANIZATION: SidebarOrganization = { grouping: "connection", projectSort: "manual", chatSort: "manual" };
export interface SidebarSectionPreference { name: string; position: number }
export const PROJECT_APPEARANCE_ICONS = ["folder", "currency-dollar", "book", "graduation-cap", "edit", "writing", "function", "terminal", "music", "popcorn", "customize", "palette", "stethoscope", "health", "lotus", "suitcase", "bar-chart", "kettlebell", "dumbbell", "logs", "scale", "desk-globe", "plane", "globe", "wrench", "paw", "flask", "brain", "heart", "plant"] as const;
export type ProjectAppearanceIcon = typeof PROJECT_APPEARANCE_ICONS[number];
export const PROJECT_APPEARANCE_COLORS = ["black", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
export type ProjectAppearanceColor = typeof PROJECT_APPEARANCE_COLORS[number] | `#${string}`;
export type ProjectAppearance = { marker: { kind: "icon"; icon: ProjectAppearanceIcon } | { kind: "emoji"; emoji: string }; color: ProjectAppearanceColor };
export interface SidebarEntityPreference { hostId: string; sectionId: string | "pinned" | null; position: number; appearance?: ProjectAppearance }
export type CompletionNotificationPolicy = "never" | "unfocused" | "always";
export interface NotificationPreferences {
  turnComplete: boolean;
  approvalRequired: boolean;
  sound: boolean;
  completionPolicy?: CompletionNotificationPolicy;
  questionRequired?: boolean;
}
/** Read old records without changing their serialized, revision-owned value. */
export function notificationPreferences(value?: NotificationPreferences): Required<NotificationPreferences> {
  const completionPolicy = value?.completionPolicy ?? (value?.turnComplete === false ? "never" : "unfocused");
  return { turnComplete: completionPolicy !== "never", completionPolicy,
    approvalRequired: value?.approvalRequired ?? true, questionRequired: value?.questionRequired ?? true, sound: value?.sound ?? false };
}
export interface PreferenceValues {
  "sidebar.organization": SidebarOrganization;
  [key: `session.read.${string}.${string}`]: SessionReadMark;
  "connections.keepAwakeWhilePluggedIn": boolean;
  "git.branchPrefix": string;
  "theme.material": "none" | "sidebar" | "under-window" | "hud";
  "theme.opaqueWindows": boolean;
  "theme.mode": "system" | "light" | "dark";
  "theme.tokens": ThemeTokens;
  "theme.background": ThemeBackground;
  "general.notifications": NotificationPreferences;
  "general.reduceMotion": boolean;
  "general.sendBehavior": "enter" | "mod-enter";
  "general.followUpQueueMode": "queue" | "steer";
  "general.bottomPanel": boolean;
  "general.defaultTerminalLocation": "bottom" | "right";
  [key: `sidebar.section.${string}`]: SidebarSectionPreference;
  [key: `sidebar.project.${string}`]: SidebarEntityPreference;
  [key: `sidebar.session.${string}`]: SidebarEntityPreference;
}
export type PreferenceKey = keyof PreferenceValues;
export interface PreferenceRevision { counter: number; actor: string; opId: string }
export type PreferenceChange = { [K in PreferenceKey]: { key: K; value: PreferenceValues[K]; deleted?: false } }[PreferenceKey]
  | { key: PreferenceKey; deleted: true };
export type PreferenceRecord = { [K in PreferenceKey]: { key: K; value: PreferenceValues[K]; deleted: false; revision: PreferenceRevision } }[PreferenceKey]
  | { key: PreferenceKey; deleted: true; revision: PreferenceRevision };
export interface PreferencesSnapshot { version: typeof PREFERENCES_VERSION; records: PreferenceRecord[] }
export interface PreferenceMergeResult { changedKeys: PreferenceKey[]; snapshot: PreferencesSnapshot }

export class PreferenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PreferenceError"; }
}
const invalid = (message: string): never => { throw new PreferenceError("INVALID_PREFERENCE", message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isPreferenceId(value: unknown): value is string { return typeof value === "string" && uuid.test(value); }

function object(value: unknown, fields?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid("A plain preference object is required.");
  const record = value as Record<string, unknown>;
  if (fields && Object.keys(record).some(key => !fields.includes(key))) return invalid("Unknown preference fields are not allowed.");
  return record;
}
function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return invalid("Preference text is empty, too long or contains control characters.");
  return value;
}
function finite(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) return invalid(`Preference number must be between ${minimum} and ${maximum}.`);
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") return invalid("A preference boolean is required."); return value; }
function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) return invalid("Unknown preference choice.");
  return value as T;
}
function color(value: unknown): string {
  const text = boundedText(value, 200);
  const hex = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const keyword = /^(?:transparent|currentColor|black|white|red|green|blue|yellow|gray|grey|orange|purple|pink|cyan|magenta|lime|navy|teal|silver|maroon|olive)$/i;
  const functional = /^(?:(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([0-9.,%+\-\s/]*(?:deg|grad|rad|turn)?[0-9.,%+\-\s/]*\)|color\((?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65) [0-9.,%+\-\s/]+\))$/i;
  if (!hex.test(text) && !keyword.test(text)) {
    if (!functional.test(text)) return invalid("A literal CSS color is required; URLs and arbitrary CSS are not theme colors.");
    const body = text.slice(text.indexOf("(") + 1, -1).replace(/^[a-z][a-z0-9-]*\s+/i, "");
    const parts = body.includes(",") ? body.split(",").map(value => value.trim()) : body.split("/").flatMap(value => value.trim().split(/\s+/));
    if (parts.length < 3 || parts.length > 4 || parts.some(part => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|deg|grad|rad|turn)?$/.test(part)) || (parts.length === 4 && !body.includes(",") && !body.includes("/"))) return invalid("A CSS color requires three channels and an optional alpha channel.");
    const name = text.slice(0, text.indexOf("(")).toLowerCase();
    const unit = (part: string) => /(?:%|deg|grad|rad|turn)$/.exec(part)?.[0] ?? "";
    const units = parts.map(unit);
    const hueIndex = ["hsl", "hsla", "hwb"].includes(name) ? 0 : ["lch", "oklch"].includes(name) ? 2 : -1;
    if (units.some((value, index) => index === hueIndex ? value === "%" : !["", "%"].includes(value))
      || (["hsl", "hsla", "hwb"].includes(name) && (units[1] !== "%" || units[2] !== "%"))
      || (body.includes(",") && (!["rgb", "rgba", "hsl", "hsla"].includes(name) || body.includes("/")
        || (["rgb", "rgba"].includes(name) && new Set(units.slice(0, 3)).size !== 1)))
      || body.split("/").length > 2) return invalid("The color channels use units or separators that are not valid for this CSS color function.");
  }
  return text;
}

export function parseThemeTokens(value: unknown): ThemeTokens {
  const entries = object(value);
  const parsed: ThemeTokens = {};
  for (const [name, raw] of Object.entries(entries)) {
    if (!Object.hasOwn(THEME_TOKEN_DEFINITIONS, name)) return invalid(`Unknown theme token: ${name}.`);
    const definition: ThemeTokenDefinition = THEME_TOKEN_DEFINITIONS[name as ThemeTokenName];
    const text = boundedText(raw, definition.kind === "font-family" ? 500 : 200);
    if (definition.kind === "color") color(text);
    else if (definition.kind === "font-family") {
      if (!/^[\p{L}\p{N} _,.'"\-]+$/u.test(text) || /\burl\b/i.test(text)) return invalid("A font-family list is required, without file paths or URLs.");
      if (text.split(",").some(part => !/^(?:"[^"']+"|'[^"']+'|[\p{L}\p{N}_][\p{L}\p{N}_ \-]*)$/u.test(part.trim()))) return invalid("Font family names require balanced quotes and nonempty entries.");
    } else {
      const matched = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em)?$/.exec(text);
      if (!matched || (definition.kind === "number" && matched[2]) || (definition.kind === "length" && !matched[2] && Number(matched[1]) !== 0)) return invalid(`Invalid numeric theme token: ${name}.`);
      finite(Number(matched[1]) * (matched[2] === "rem" || matched[2] === "em" ? 16 : 1), definition.minimum, definition.maximum);
    }
    parsed[name as ThemeTokenName] = text;
  }
  return parsed;
}

function background(value: unknown): ThemeBackground {
  const item = object(value);
  if (item.kind === "none") { object(item, ["kind"]); return { kind: "none" }; }
  if (item.kind === "color") { object(item, ["kind", "color"]); return { kind: "color", color: color(item.color) }; }
  if (item.kind === "gradient") {
    object(item, ["kind", "angle", "stops"]);
    if (!Array.isArray(item.stops) || item.stops.length < 2 || item.stops.length > 16) return invalid("A gradient requires between 2 and 16 stops.");
    const stops = item.stops.map(value => { const stop = object(value, ["color", "position"]); return { color: color(stop.color), position: finite(stop.position, 0, 1) }; });
    if (stops.some((stop, index) => index > 0 && stop.position < stops[index - 1]!.position)) return invalid("Gradient stops must be ordered.");
    return { kind: "gradient", angle: finite(item.angle, -360, 360), stops };
  }
  if (item.kind === "asset") {
    object(item, ["kind", "sha256", "fit", "opacity", "blur"]);
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) return invalid("A background asset requires a SHA-256 digest, not a file path or URL.");
    return { kind: "asset", sha256: item.sha256, fit: enumeration(item.fit, ["cover", "contain", "tile"]), opacity: finite(item.opacity, 0, 1), blur: finite(item.blur, 0, 100) };
  }
  return invalid("Unknown background kind.");
}

export function parsePreferenceKey(value: unknown): PreferenceKey {
  if (typeof value !== "string") return invalid("A preference key is required.");
  if (["sidebar.organization", "connections.keepAwakeWhilePluggedIn", "git.branchPrefix", "theme.mode", "theme.material", "theme.opaqueWindows", "theme.tokens", "theme.background", "general.notifications", "general.reduceMotion", "general.sendBehavior", "general.followUpQueueMode", "general.bottomPanel", "general.defaultTerminalLocation"].includes(value)) return value as PreferenceKey;
  if (isSessionReadKey(value)) return value;
  const match = /^sidebar\.(?:section|project|session)\.(.+)$/.exec(value);
  if (!match || !isPreferenceId(match[1])) return invalid("Only allowlisted app preferences and UUID sidebar entities can be shared.");
  return value as PreferenceKey;
}

function preferenceValue(key: PreferenceKey, value: unknown): PreferenceValues[PreferenceKey] {
  if (key === "sidebar.organization") {
    const item = object(value, ["grouping", "projectSort", "chatSort"]);
    return { grouping: enumeration(item.grouping, ["project", "connection", "list"] as const),
      projectSort: enumeration(item.projectSort, ["priority", "updated_at", "manual"] as const),
      chatSort: enumeration(item.chatSort, ["priority", "updated_at", "manual"] as const) };
  }
  if (isSessionReadKey(key)) {
    try { return parseSessionReadMark(value); } catch { return invalid("Invalid session read mark."); }
  }
  if (key === "git.branchPrefix") {
    if (typeof value !== "string" || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) return invalid("A branch prefix is too long or contains control characters.");
    const text = value.trim();
    if (text && (!text.endsWith("/") || text.startsWith("/") || text.includes("//") || !/^[A-Za-z0-9._/-]+$/.test(text) || text.includes("..") || text.endsWith("/."))) return invalid("A branch prefix must be a safe Git path prefix ending in '/'.");
    return text;
  }
  if (key === "connections.keepAwakeWhilePluggedIn") return bool(value);
  if (key === "theme.mode") return enumeration(value, ["system", "light", "dark"] as const);
  if (key === "theme.material") return enumeration(value, ["none", "sidebar", "under-window", "hud"] as const);
  if (key === "theme.opaqueWindows") return bool(value);
  if (key === "theme.tokens") return parseThemeTokens(value);
  if (key === "theme.background") return background(value);
  if (key === "general.reduceMotion" || key === "general.bottomPanel") return bool(value);
  if (key === "general.defaultTerminalLocation") return enumeration(value, ["bottom", "right"] as const);
  if (key === "general.sendBehavior") return enumeration(value, ["enter", "mod-enter"] as const);
  if (key === "general.followUpQueueMode") return enumeration(value, ["queue", "steer"] as const);
  if (key === "general.notifications") {
    const item = object(value, ["turnComplete", "approvalRequired", "sound", "completionPolicy", "questionRequired"]);
    const policy = item.completionPolicy === undefined ? undefined : enumeration(item.completionPolicy, ["never", "unfocused", "always"] as const);
    const turnComplete = bool(item.turnComplete);
    if (policy !== undefined && turnComplete !== (policy !== "never")) return invalid("Completion notification settings disagree.");
    return { turnComplete, approvalRequired: bool(item.approvalRequired), sound: bool(item.sound),
      ...(policy === undefined ? {} : {completionPolicy:policy}),
      ...(item.questionRequired === undefined ? {} : {questionRequired:bool(item.questionRequired)}) };
  }
  if (key.startsWith("sidebar.section.")) {
    const item = object(value, ["name", "position"]);
    return { name: boundedText(item.name, 120), position: finite(item.position, -1e12, 1e12) };
  }
  const project = key.startsWith("sidebar.project.");
  const item = object(value, project ? ["hostId", "sectionId", "position", "appearance"] : ["hostId", "sectionId", "position"]);
  if (!isPreferenceId(item.hostId) || !(item.sectionId === null || item.sectionId === "pinned" || isPreferenceId(item.sectionId))) return invalid("Sidebar entities require host and section identities, not paths.");
  const appearance = project && item.appearance !== undefined ? projectAppearance(item.appearance) : undefined;
  return { hostId: item.hostId, sectionId: item.sectionId, position: finite(item.position, -1e12, 1e12), ...(appearance === undefined ? {} : { appearance }) };
}

function projectAppearance(value: unknown): ProjectAppearance {
  const item = object(value, ["marker", "color"]);
  const marker = object(item.marker, ["kind", "icon", "emoji"]);
  let parsedMarker: ProjectAppearance["marker"];
  if (marker.kind === "icon") {
    if (typeof marker.icon !== "string" || !PROJECT_APPEARANCE_ICONS.includes(marker.icon as ProjectAppearanceIcon) || Object.hasOwn(marker, "emoji")) return invalid("A project marker icon must be one of the supported icons.");
    parsedMarker = { kind: "icon", icon: marker.icon as ProjectAppearanceIcon };
  } else if (marker.kind === "emoji") {
    if (typeof marker.emoji !== "string" || marker.emoji.length < 1 || marker.emoji.length > 32 || /[\u0000-\u001f\u007f]/.test(marker.emoji) || Object.hasOwn(marker, "icon")) return invalid("A project emoji marker is invalid.");
    parsedMarker = { kind: "emoji", emoji: marker.emoji };
  } else return invalid("A project marker kind is required.");
  if (typeof item.color !== "string" || !([...(PROJECT_APPEARANCE_COLORS as readonly string[])].includes(item.color) || /^#(?:[0-9a-f]{3}){1,2}$/i.test(item.color))) return invalid("A project color must be a preset or hexadecimal color.");
  return { marker: parsedMarker, color: item.color as ProjectAppearanceColor };
}

/** Produces new schema-owned objects, rejecting unknown fields instead of carrying them through. */
export function parsePreferenceChange(value: unknown): PreferenceChange {
  const item = object(value, ["key", "value", "deleted"]);
  const key = parsePreferenceKey(item.key);
  if (item.deleted === true) { if (Object.hasOwn(item, "value")) return invalid("A deleted preference cannot carry a value."); return { key, deleted: true }; }
  if (item.deleted !== undefined && item.deleted !== false) return invalid("Invalid preference deletion flag.");
  const parsed = { key, value: preferenceValue(key, item.value) } as PreferenceChange;
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > PREFERENCE_LIMITS.valueBytes) return invalid("Preference value is too large.");
  return parsed;
}

export function parsePreferenceRevision(value: unknown): PreferenceRevision {
  const item = object(value, ["counter", "actor", "opId"]);
  if (!Number.isSafeInteger(item.counter) || (item.counter as number) < 1 || !isPreferenceId(item.actor) || !isPreferenceId(item.opId)) return invalid("A preference revision requires a positive safe counter and UUID actor/operation identities.");
  return { counter: item.counter as number, actor: item.actor, opId: item.opId };
}

export function parsePreferencesSnapshot(value: unknown): PreferencesSnapshot {
  const item = object(value, ["version", "records"]);
  if (item.version !== PREFERENCES_VERSION) throw new PreferenceError("PREFERENCES_VERSION_UNSUPPORTED", "This preferences schema version is not supported.");
  if (!Array.isArray(item.records) || item.records.length > PREFERENCE_LIMITS.records) return invalid("Preference snapshot contains too many records.");
  const keys = new Set<string>();
  const operations = new Set<string>();
  const records = item.records.map(raw => {
    const record = object(raw, ["key", "value", "deleted", "revision"]);
    if (typeof record.deleted !== "boolean") return invalid("A replicated preference requires an explicit deletion flag.");
    const change = parsePreferenceChange({ key: record.key, deleted: record.deleted, ...(record.deleted ? {} : { value: record.value }) });
    if (record.deleted && Object.hasOwn(record, "value")) return invalid("A tombstone cannot carry a value.");
    const revision = parsePreferenceRevision(record.revision);
    if (keys.has(change.key) || operations.has(revision.opId)) return invalid("Preference snapshots cannot contain duplicate keys or operation identities.");
    keys.add(change.key); operations.add(revision.opId);
    return { ...change, deleted: change.deleted ?? false, revision } as PreferenceRecord;
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const snapshot: PreferencesSnapshot = { version: PREFERENCES_VERSION, records };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > PREFERENCE_LIMITS.snapshotBytes) return invalid("Preference snapshot is too large.");
  return snapshot;
}

/** Locale-independent deterministic order; no wall clock participates. */
export function comparePreferenceRevisions(a: PreferenceRevision, b: PreferenceRevision): number {
  for (const field of ["counter", "actor", "opId"] as const) { if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1; }
  return 0;
}
