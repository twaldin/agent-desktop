import { normalizeAccelerator, parseCommandBindingUpdate, type CommandBindingOverride, type CommandBindingUpdate } from "./command-keybindings";
import type { NativeTerminalResult } from "./terminals";
import {
  PREFERENCE_LIMITS, PreferenceError, parsePreferenceRevision, parsePreferencesSnapshot,
  type PreferenceKey, type PreferenceRecord, type PreferenceRevision, type PreferencesSnapshot,
} from "./preferences";

export const COMMAND_KEYMAP_PREFERENCE = "general.commandKeymap" as const;
/** Pinned ordering is v2-only so legacy parsers never receive it. */
export const PINNED_SIDEBAR_SORT_PREFERENCE = "sidebar.pinnedSort" as const;
export type PrimaryNumberTarget = "tabs" | "sidebar";
export type CommandKeymapPreference = {
  /** The viewing desktops are macOS, including when the owning service runs on Linux. */
  platform: "mac";
  overrides: CommandBindingOverride[];
} & ({ version: 1 } | { version: 2; primaryNumberShortcutTarget: PrimaryNumberTarget });

export function commandKeymapNumberTarget(record: CommandKeymapPreferenceRecord | undefined): PrimaryNumberTarget {
  return record && !record.deleted && record.value.version === 2 ? record.value.primaryNumberShortcutTarget : "tabs";
}
export type CommandKeymapPreferenceRecord =
  | { key: typeof COMMAND_KEYMAP_PREFERENCE; deleted: false; value: CommandKeymapPreference; revision: PreferenceRevision }
  | { key: typeof COMMAND_KEYMAP_PREFERENCE; deleted: true; revision: PreferenceRevision };
export type PreferenceKeyV2 = PreferenceKey | typeof COMMAND_KEYMAP_PREFERENCE;
export type PreferenceRecordV2 = PreferenceRecord | CommandKeymapPreferenceRecord;
export interface PreferencesSnapshotV2 { version: 2; records: PreferenceRecordV2[] }
/** Structured across Electron IPC so a renderer can distinguish an old host from a failed v2 read. */
export type PreferencesV2ReadResult = NativeTerminalResult<PreferencesSnapshotV2>;
export interface PreferenceMergeResultV2 { changedKeys: PreferenceKeyV2[]; snapshot: PreferencesSnapshotV2 }
export interface CommandKeymapMutation {
  expectedRevision: PreferenceRevision | null;
  edit: { type: "reset-all" } | { type: "number-target"; target: PrimaryNumberTarget } | { type: "command"; commandId: string; update: CommandBindingUpdate };
}

function invalid(message: string): never { throw new PreferenceError("INVALID_PREFERENCE", message); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid("A plain preference object is required.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !fields.includes(key))) return invalid("Unknown preference fields are not allowed.");
  return record;
}

export function parseCommandKeymapMutation(value: unknown): CommandKeymapMutation {
  const item = object(value, ["expectedRevision", "edit"]);
  const expectedRevision = item.expectedRevision === null ? null : parsePreferenceRevision(item.expectedRevision);
  const edit = object(item.edit, ["type", "commandId", "update", "target"]);
  if (edit.type === "number-target") {
    if (Object.keys(edit).length !== 2 || (edit.target !== "tabs" && edit.target !== "sidebar")) return invalid("Invalid number shortcut target.");
    return { expectedRevision, edit: { type: "number-target", target: edit.target } };
  }
  if (edit.type === "reset-all") {
    if (Object.keys(edit).length !== 1) return invalid("Reset-all does not take command fields.");
    return { expectedRevision, edit: { type: "reset-all" } };
  }
  if (edit.type !== "command" || Object.keys(edit).length !== 3 || typeof edit.commandId !== "string" || !edit.commandId.trim() || edit.commandId.length > 256
    || /[\u0000-\u001f\u007f]/.test(edit.commandId)) return invalid("A shortcut edit requires a command identity.");
  return { expectedRevision, edit: { type: "command", commandId: edit.commandId, update: parseCommandBindingUpdate(edit.update) } };
}

/** Replication preserves structurally valid future command IDs. Editing still requires the installed command registry. */
export function parseCommandKeymapPreference(value: unknown): CommandKeymapPreference {
  const item = object(value, ["version", "platform", "overrides", "primaryNumberShortcutTarget"]);
  if ((item.version !== 1 && item.version !== 2) || item.platform !== "mac") return invalid("This desktop keymap version or platform is unsupported.");
  if (item.version === 1 ? Object.hasOwn(item, "primaryNumberShortcutTarget")
    : item.primaryNumberShortcutTarget !== "tabs" && item.primaryNumberShortcutTarget !== "sidebar") return invalid("Invalid versioned number shortcut target.");
  if (!Array.isArray(item.overrides) || item.overrides.length > 1024) return invalid("A keymap requires a bounded overrides array.");
  const seen = new Set<string>();
  const overrides = item.overrides.map(raw => {
    const entry = object(raw, ["command", "keys"]);
    if (typeof entry.command !== "string" || !entry.command.trim() || entry.command.length > 256
      || /[\u0000-\u001f\u007f]/.test(entry.command) || seen.has(entry.command)) return invalid("Shortcut command identities must be unique and nonempty.");
    seen.add(entry.command);
    if (!Array.isArray(entry.keys) || entry.keys.length > 256 || entry.keys.some(key => typeof key !== "string")) return invalid("Invalid shortcut alternatives.");
    // Do not interpret command eligibility or discard unknown commands at the transport boundary.
    const keys = entry.keys.map(key => normalizeAccelerator(key as string));
    return { command: entry.command, keys };
  });
  const result: CommandKeymapPreference = item.version === 1 ? { version: 1, platform: "mac", overrides }
    : { version: 2, platform: "mac", overrides, primaryNumberShortcutTarget: item.primaryNumberShortcutTarget as PrimaryNumberTarget };
  if (new TextEncoder().encode(JSON.stringify({ key: COMMAND_KEYMAP_PREFERENCE, value: result })).length > PREFERENCE_LIMITS.valueBytes) return invalid("Preference value is too large.");
  return result;
}

export function parsePreferencesSnapshotV2(value: unknown): PreferencesSnapshotV2 {
  const item = object(value, ["version", "records"]);
  if (item.version !== 2) throw new PreferenceError("PREFERENCES_VERSION_UNSUPPORTED", "This preferences schema version is not supported.");
  if (!Array.isArray(item.records) || item.records.length > PREFERENCE_LIMITS.records) return invalid("Preference snapshot contains too many records.");
  const legacy: unknown[] = [], newer: CommandKeymapPreferenceRecord[] = [];
  for (const raw of item.records) {
    const record = object(raw, ["key", "value", "deleted", "revision"]);
    if (record.key !== COMMAND_KEYMAP_PREFERENCE) { legacy.push(record); continue; }
    const revision = parsePreferenceRevision(record.revision);
    if (record.deleted === true) {
      if (Object.hasOwn(record, "value")) return invalid("A tombstone cannot carry a value.");
      newer.push({ key: COMMAND_KEYMAP_PREFERENCE, deleted: true, revision });
    } else if (record.deleted === false) {
      newer.push({ key: COMMAND_KEYMAP_PREFERENCE, deleted: false, value: parseCommandKeymapPreference(record.value), revision });
    } else return invalid("A replicated preference requires an explicit deletion flag.");
  }
  const records: PreferenceRecordV2[] = [...parsePreferencesSnapshot({ version: 1, records: legacy }).records, ...newer];
  if (new Set(records.map(record => record.key)).size !== records.length || new Set(records.map(record => record.revision.opId)).size !== records.length) return invalid("Preference snapshots cannot contain duplicate keys or operation identities.");
  records.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const snapshot: PreferencesSnapshotV2 = { version: 2, records };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > PREFERENCE_LIMITS.snapshotBytes) return invalid("Preference snapshot is too large.");
  return snapshot;
}

/** This is an outgoing projection, never a replacement for the full persisted state. */
export function projectLegacyPreferences(value: PreferencesSnapshotV2): PreferencesSnapshot {
  const snapshot = parsePreferencesSnapshotV2(value);
  return parsePreferencesSnapshot({ version: 1, records: snapshot.records.filter(record => record.key !== COMMAND_KEYMAP_PREFERENCE && record.key !== PINNED_SIDEBAR_SORT_PREFERENCE) });
}

/** Read legacy stored bytes without rewriting them; unknown versions still fail closed. */
export function readPreferencesSnapshotVersion(value: unknown): PreferencesSnapshotV2 {
  const item = object(value, ["version", "records"]);
  return item.version === 1 ? { version: 2, records: parsePreferencesSnapshot(item).records } : parsePreferencesSnapshotV2(item);
}
