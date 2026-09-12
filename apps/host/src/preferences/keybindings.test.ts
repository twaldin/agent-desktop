import { expect, test } from "bun:test";
import type { HostStore } from "../store";
import { PreferencesStore, type StoredPreferencesState } from "./store";
import { COMMAND_KEYMAP_PREFERENCE, type CommandKeymapPreferenceRecord } from "../../../../packages/shared/src/preferences-v2";
import { parsePreferencesSnapshot, type PreferenceRevision } from "../../../../packages/shared/src/preferences";
import { applicationKeybindingAdmissionDefinitions, resolveEffectiveApplicationBindings } from "../../../../packages/shared/src/application-commands";

const definitions = [{ id: "search", defaults: ["CmdOrCtrl+K"] }, { id: "browser", defaults: ["CmdOrCtrl+T"] }];
/** Pure transaction adapter. These tests do not establish SQLite, restart, HTTP or peer transport behavior. */
function memory(saved?: StoredPreferencesState) {
  let state = structuredClone(saved), writes = 0;
  const adapter = {
    host: { id: crypto.randomUUID() },
    readPreferencesState: () => structuredClone(state),
    updatePreferencesState<T>(update: (current: StoredPreferencesState | undefined) => { state: StoredPreferencesState; result: T }): T {
      const result = update(structuredClone(state));
      state = structuredClone(result.state); writes++; return result.result;
    },
  };
  return { store: new PreferencesStore(adapter as unknown as HostStore), saved: () => structuredClone(state), writes: () => writes };
}
function set(store: PreferencesStore, expectedRevision: PreferenceRevision | null, accelerator = "Command+K") {
  return store.mutateCommandKeymap({ expectedRevision, edit: { type: "command", commandId: "browser", update: { type: "set", accelerator } } }, definitions);
}

test("number target shares the binding revision, preserves explicit overrides and survives reset and merge", () => {
  const a = memory(), b = memory();
  const registry = (target: "tabs" | "sidebar") => applicationKeybindingAdmissionDefinitions({ primaryNumberShortcutTarget: target });
  const first = a.store.mutateCommandKeymap({ expectedRevision: null, edit: { type: "command", commandId: "thread1", update: { type: "set", accelerator: "Command+9" } } }, registry);
  const before = a.saved();
  a.store.snapshotV2(); expect(a.saved()).toEqual(before);
  const changed = a.store.mutateCommandKeymap({ expectedRevision: first.revision, edit: { type: "number-target", target: "sidebar" } }, registry);
  expect(changed).toMatchObject({ deleted: false, value: { version: 2, primaryNumberShortcutTarget: "sidebar", overrides: first.deleted ? [] : first.value.overrides } });
  expect(changed.revision.counter).toBe(first.revision.counter + 1);
  expect(() => a.store.mutateCommandKeymap({ expectedRevision: first.revision, edit: { type: "command", commandId: "thread2", update: { type: "clear" } } }, registry)).toThrow("changed");
  expect(() => a.store.mutateCommandKeymap({ expectedRevision: first.revision, edit: { type: "number-target", target: "tabs" } }, registry)).toThrow("changed");
  expect(a.writes()).toBe(2);
  const edited = a.store.mutateCommandKeymap({ expectedRevision: changed.revision, edit: { type: "command", commandId: "thread2", update: { type: "set", accelerator: "Command+3" } } }, registry);
  expect(edited).toMatchObject({ value: { primaryNumberShortcutTarget: "sidebar", overrides: expect.arrayContaining([{ command: "thread3", keys: [] }]) } });
  const reset = a.store.mutateCommandKeymap({ expectedRevision: edited.revision, edit: { type: "reset-all" } }, registry);
  expect(reset).toMatchObject({ deleted: false, value: { version: 2, primaryNumberShortcutTarget: "sidebar", overrides: [] } });
  b.store.mergeV2(a.store.snapshotV2());
  expect(b.store.snapshotV2()).toEqual(a.store.snapshotV2());
  b.store.mergeV2({ version: 2, records: [changed] });
  expect(b.store.snapshotV2().records).toEqual([reset]);
  if (reset.deleted) throw new Error("reset lost target");
  expect(resolveEffectiveApplicationBindings(reset.value, { primaryNumberShortcutTarget: "sidebar" }).bindings.find(binding => binding.command === "thread2")?.keys).toEqual(["Command+2"]);
});

test("target changes preserve future overrides verbatim but command edits still fail closed", () => {
  const host = memory();
  const future: CommandKeymapPreferenceRecord = { key: COMMAND_KEYMAP_PREFERENCE, deleted: false, value: { version: 1, platform: "mac", overrides: [{ command: "future", keys: ["Command+U"] }] }, revision: { counter: 2, actor: crypto.randomUUID(), opId: crypto.randomUUID() } };
  host.store.mergeV2({ version: 2, records: [future] });
  const next = host.store.mutateCommandKeymap({ expectedRevision: future.revision, edit: { type: "number-target", target: "sidebar" } }, definitions);
  expect(next).toMatchObject({ value: { version: 2, overrides: future.value.overrides, primaryNumberShortcutTarget: "sidebar" } });
  expect(() => set(host.store, next.revision)).toThrow("unsupported command");
});

test("one map edit commits both assignment and suppression with one shared revision", () => {
  const host = memory();
  const record = set(host.store, null);
  expect(host.writes()).toBe(1);
  expect(record.revision.counter).toBe(1);
  expect(record).toMatchObject({ deleted: false, value: { platform: "mac", overrides: [{ command: "browser", keys: ["Command+K"] }, { command: "search", keys: [] }] } });
  expect(host.saved()?.version).toBe(2);
  expect(host.store.snapshot()).toEqual({ version: 1, records: [] });
  expect(host.store.snapshotV2().records).toEqual([record]);
});

test("stale edit and stale reset fail without advancing state or writes", () => {
  const host = memory();
  const first = set(host.store, null), second = set(host.store, first.revision, "Command+U"), before = host.saved();
  for (const expectedRevision of [null, first.revision, { ...second.revision, opId: crypto.randomUUID() }]) {
    expect(() => set(host.store, expectedRevision)).toThrow("changed");
    expect(() => host.store.mutateCommandKeymap({ expectedRevision, edit: { type: "reset-all" } }, definitions)).toThrow("changed");
    expect(host.saved()).toEqual(before);
  }
  expect(host.writes()).toBe(2);
});

test("legacy read and write preserve v2 values and use the same counter", () => {
  const host = memory(), keymap = set(host.store, null);
  const mode = host.store.put({ key: "theme.mode", value: "dark" });
  expect(mode.revision.counter).toBe(2);
  expect(host.store.snapshot().records).toEqual([mode]);
  expect(host.store.snapshotV2().records).toContainEqual(keymap);
  expect(host.saved()?.version).toBe(2);
  expect(parsePreferencesSnapshot(host.store.snapshot())).toEqual(host.store.snapshot());
});

test("legacy exchange cannot erase a new map or reset tombstone; later full exchange cannot revive an old map", () => {
  const a = memory(), b = memory();
  const map = set(a.store, null), old = a.store.snapshotV2();
  b.store.mergeV2(old);
  const reset = a.store.mutateCommandKeymap({ expectedRevision: map.revision, edit: { type: "reset-all" } }, definitions);
  expect(reset.deleted).toBe(true);
  a.store.merge({ version: 1, records: [] });
  expect(a.store.snapshotV2().records).toEqual([reset]);
  expect(a.store.snapshot().records).toEqual([]);
  b.store.mergeV2(a.store.snapshotV2());
  b.store.mergeV2(old);
  expect(b.store.snapshotV2().records).toEqual([reset]);
  expect(() => set(b.store, null)).toThrow("changed");
  expect(set(b.store, reset.revision).revision.counter).toBe(3);
});

test("legacy higher clocks and cross-version operation reuse retain full validation", () => {
  const host = memory(), map = set(host.store, null);
  const changed = { key: "theme.mode", deleted: false, value: "dark", revision: { counter: 40, actor: crypto.randomUUID(), opId: crypto.randomUUID() } };
  host.store.merge({ version: 1, records: [changed] });
  expect(set(host.store, map.revision).revision.counter).toBe(41);
  const before = host.saved();
  expect(() => host.store.merge({ version: 1, records: [{ ...changed, revision: host.store.snapshotV2().records.find(record => record.key === COMMAND_KEYMAP_PREFERENCE)!.revision }] })).toThrow("reused");
  expect(host.saved()).toEqual(before);
});

test("valid newer command entries replicate but prevent destructive edits by an older registry", () => {
  const host = memory();
  const future: CommandKeymapPreferenceRecord = { key: COMMAND_KEYMAP_PREFERENCE, deleted: false, value: { version: 1, platform: "mac", overrides: [{ command: "future-command", keys: ["Command+U"] }] }, revision: { counter: 5, actor: crypto.randomUUID(), opId: crypto.randomUUID() } };
  host.store.mergeV2({ version: 2, records: [future] });
  const before = host.saved();
  expect(() => set(host.store, future.revision)).toThrow("unsupported command");
  expect(() => host.store.mutateCommandKeymap({ expectedRevision: future.revision, edit: { type: "reset-all" } }, definitions)).toThrow("unsupported command");
  expect(host.saved()).toEqual(before);
});

test("reading legacy stored bytes does not migrate; only new writes require the v2 store discriminant", () => {
  const first = memory();
  first.store.put({ key: "theme.mode", value: "dark" });
  expect(first.saved()?.version).toBe(1);
  const before = first.saved(), second = memory(before);
  second.store.snapshotV2(); second.store.snapshot();
  expect(second.saved()).toEqual(before); expect(second.writes()).toBe(0);
  second.store.put({ key: "general.reduceMotion", value: true });
  expect(second.saved()?.version).toBe(1);
  set(second.store, null);
  expect(second.saved()?.version).toBe(2);
  expect(second.store.snapshot().records).toHaveLength(2);
});

test("unknown stored versions and invalid clocks fail before any transaction", () => {
  for (const state of [{ version: 3, counter: 0, records: [] }, { version: 2, counter: -1, records: [] }]) {
    expect(() => memory(state as StoredPreferencesState)).toThrow();
  }
});
