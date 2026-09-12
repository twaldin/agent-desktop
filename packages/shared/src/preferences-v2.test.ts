import { expect, test } from "bun:test";
import { parsePreferencesSnapshot, type PreferenceRecord } from "./preferences";
import { parseCommandKeymap, updateCommandBinding } from "./command-keybindings";
import { COMMAND_KEYMAP_PREFERENCE as key, parseCommandKeymapMutation, parseCommandKeymapPreference, parsePreferencesSnapshotV2, projectLegacyPreferences, readPreferencesSnapshotVersion } from "./preferences-v2";

const revision = () => ({ counter: 1, actor: crypto.randomUUID(), opId: crypto.randomUUID() });
const value = () => ({ version: 1, platform: "mac", overrides: [{ command: "search", keys: ["CmdOrCtrl+K"] }] });
const record = () => ({ key, deleted: false, value: value(), revision: revision() });
const legacy = (): PreferenceRecord => ({ key: "theme.mode", value: "dark", deleted: false, revision: revision() });

test("number target has a strict versioned shape without rewriting legacy values", () => {
  const old = { ...value(), version: 1 as const, platform: "mac" as const }, before = JSON.stringify(old);
  expect(parseCommandKeymapPreference(old)).toEqual(old);
  expect(JSON.stringify(old)).toBe(before);
  const next = { ...old, version: 2 as const, primaryNumberShortcutTarget: "sidebar" as const };
  expect(parseCommandKeymapPreference(next)).toEqual(next);
  for (const bad of [{ ...old, primaryNumberShortcutTarget: "sidebar" }, { ...next, primaryNumberShortcutTarget: "other" }, { ...next, version: 3 }]) expect(() => parseCommandKeymapPreference(bad)).toThrow();
  const mutation = { expectedRevision: null, edit: { type: "number-target" as const, target: "sidebar" as const } };
  expect(parseCommandKeymapMutation(mutation)).toEqual(mutation);
  for (const edit of [{ type: "number-target" }, { type: "number-target", target: "other" }, { ...mutation.edit, commandId: "search" }, { type: "command", commandId: "search", update: { type: "clear" }, target: "tabs" }]) expect(() => parseCommandKeymapMutation({ expectedRevision: null, edit })).toThrow();
});

test("legacy projection preserves legacy records and never exposes a new live value or tombstone", () => {
  const old = legacy();
  for (const next of [record(), { key, deleted: true, revision: revision() }]) {
    const full = parsePreferencesSnapshotV2({ version: 2, records: [old, next] });
    expect(projectLegacyPreferences(full)).toEqual({ version: 1, records: [old] });
    expect(full.records).toHaveLength(2);
    expect(() => parsePreferencesSnapshot({ version: 1, records: [next] })).toThrow();
  }
});

test("legacy upgrade is an in-memory view that preserves bytes and revisions", () => {
  const old = { version: 1, records: [legacy()] }, before = JSON.stringify(old);
  expect(readPreferencesSnapshotVersion(old)).toEqual({ version: 2, records: old.records });
  expect(JSON.stringify(old)).toBe(before);
  expect(() => readPreferencesSnapshotVersion({ version: 3, records: [] })).toThrow();
});

test("replication preserves future command identities while edits reject an unknown installed command", () => {
  const newer = parseCommandKeymapPreference({ ...value(), overrides: [{ command: "future-command", keys: ["CmdOrCtrl+U"] }] });
  const parsed = parsePreferencesSnapshotV2({ version: 2, records: [{ ...record(), value: newer }] });
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  expect(newer.overrides[0]!.command).toBe("future-command");
  const definitions = [{ id: "search", defaults: ["CmdOrCtrl+K"] }];
  expect(() => parseCommandKeymap({ overrides: newer.overrides }, definitions, "mac")).toThrow("unsupported command");
  expect(() => updateCommandBinding("search", { type: "clear" }, definitions, { overrides: newer.overrides }, "mac")).toThrow();
});

test("new snapshots reject duplicate keys and shared operation IDs across versions", () => {
  const next = record(), old = legacy();
  for (const records of [[next, { ...next, revision: revision() }], [old, { ...next, revision: old.revision }]]) {
    expect(() => parsePreferencesSnapshotV2({ version: 2, records })).toThrow("duplicate");
  }
});

test("new snapshots remain strict about versions, values, deletion flags and unknown preference keys", () => {
  for (const next of [{ ...record(), deleted: undefined }, { ...record(), deleted: true }, { ...record(), key: "future.preference" },
    { ...record(), extra: true }, { ...record(), value: { ...value(), platform: "linux" } },
    { ...record(), value: { ...value(), version: 2 } }]) {
    expect(() => parsePreferencesSnapshotV2({ version: 2, records: [next] })).toThrow();
  }
  expect(() => parsePreferencesSnapshotV2({ version: 1, records: [] })).toThrow();
  expect(() => parsePreferencesSnapshotV2({ version: 2, records: [], extra: true })).toThrow();
});

test("keymap values validate structure and size without interpreting desktop commands as host commands", () => {
  for (const overrides of [[{ command: "search", keys: [] }, { command: "search", keys: [] }], [{ command: "", keys: [] }],
    [{ command: "search", keys: [4] }], [{ command: "search", keys: ["Ctrl++"] }], [{ command: "search", keys: [], extra: true }]]) {
    expect(() => parseCommandKeymapPreference({ ...value(), overrides })).toThrow();
  }
  expect(() => parseCommandKeymapPreference({ ...value(), overrides: Array.from({ length: 1025 }, (_, i) => ({ command: `command-${i}`, keys: [] })) })).toThrow();
  expect(() => parseCommandKeymapPreference({ ...value(), overrides: Array.from({ length: 300 }, (_, i) => ({ command: `command-${i}`, keys: Array.from({ length: 5 }, () => "A".repeat(64)) })) })).toThrow("too large");
  expect(parseCommandKeymapPreference({ ...value(), overrides: [{ command: "search", keys: [] }] }).overrides).toEqual([{ command: "search", keys: [] }]);
});

test("mutation envelopes require an explicit revision and exact action fields", () => {
  for (const input of [null, {}, { edit: { type: "reset-all" } }, { expectedRevision: null, edit: { type: "reset-all", commandId: "search" } },
    { expectedRevision: null, edit: { type: "command", commandId: "search", update: { type: "set" } } },
    { expectedRevision: null, edit: { type: "command", commandId: "search", update: { type: "clear", extra: true } } },
    { expectedRevision: null, edit: { type: "reset-all" }, extra: true }]) expect(() => parseCommandKeymapMutation(input)).toThrow();
  const expected = revision();
  expect(parseCommandKeymapMutation({ expectedRevision: expected, edit: { type: "command", commandId: "search", update: { type: "set", accelerator: "cmd+j" } } })).toEqual({ expectedRevision: expected, edit: { type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } } });
  expect(parseCommandKeymapMutation({ expectedRevision: null, edit: { type: "reset-all" } })).toEqual({ expectedRevision: null, edit: { type: "reset-all" } });
});
