import {
  PREFERENCES_VERSION, PreferenceError, comparePreferenceRevisions, isPreferenceId,
  parsePreferenceChange, parsePreferenceKey, parsePreferencesSnapshot,
  type PreferenceChange, type PreferenceKey, type PreferenceMergeResult, type PreferenceRecord, type PreferencesSnapshot,
} from "../../../../packages/shared/src/preferences";
import { parseCommandKeymap, updateCommandBinding, type CommandBindingDefinition } from "../../../../packages/shared/src/command-keybindings";
import {
  COMMAND_KEYMAP_PREFERENCE, commandKeymapNumberTarget, parseCommandKeymapMutation, parseCommandKeymapPreference, parsePreferencesSnapshotV2, projectLegacyPreferences, readPreferencesSnapshotVersion,
  type CommandKeymapMutation, type CommandKeymapPreferenceRecord, type PreferenceKeyV2, type PreferenceMergeResultV2, type PreferencesSnapshotV2,
} from "../../../../packages/shared/src/preferences-v2";
import type { PrimaryNumberTarget } from "../../../../packages/shared/src/preferences-v2";
import type { HostStore } from "../store";

export type StoredPreferencesState = (PreferencesSnapshot | PreferencesSnapshotV2) & { counter: number };
/** The installed registry is selected inside the same transaction as its saved layout. */
export type CommandKeymapRegistry = readonly CommandBindingDefinition[] | ((target: PrimaryNumberTarget) => readonly CommandBindingDefinition[]);

function readState(value: StoredPreferencesState | undefined): StoredPreferencesState {
  if (!value) return { version: PREFERENCES_VERSION, counter: 0, records: [] };
  const snapshot = readPreferencesSnapshotVersion({ version: value.version, records: value.records });
  if (!Number.isSafeInteger(value.counter) || value.counter < 0 || snapshot.records.some(record => record.revision.counter > value.counter)) {
    throw new PreferenceError("INVALID_PREFERENCES_STATE", "The persisted preference clock is invalid. Preserve the database before repairing it.");
  }
  return storedState(snapshot, value.counter, value.version);
}

function storedState(snapshot: PreferencesSnapshotV2, counter: number, version: 1 | 2): StoredPreferencesState {
  const parsed = parsePreferencesSnapshotV2(snapshot);
  if (version === 1 && parsed.records.some(record => record.key === COMMAND_KEYMAP_PREFERENCE)) throw new PreferenceError("INVALID_PREFERENCES_STATE", "Newer preferences cannot be written in the legacy storage format.");
  return { ...(version === 1 ? projectLegacyPreferences(parsed) : parsed), counter };
}

function fingerprint(value: unknown): string {
  // Schema objects are shallow and bounded; sort keys so input field order cannot cause equivocation.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${fingerprint((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** A small replicated app-preference map, in the owning HostStore's existing metadata table. */
export class PreferencesStore {
  constructor(private readonly store: HostStore) {
    if (!isPreferenceId(store.host.id)) throw new PreferenceError("INVALID_PREFERENCE_ACTOR", "Preference actors must be stable host UUIDs.");
    // Validate before the service starts; reads never migrate stored preference bytes.
    readState(store.readPreferencesState());
  }

  snapshot(): PreferencesSnapshot {
    return projectLegacyPreferences(this.snapshotV2());
  }

  snapshotV2(): PreferencesSnapshotV2 {
    const { records } = readState(this.store.readPreferencesState());
    return parsePreferencesSnapshotV2({ version: 2, records });
  }

  get(key: PreferenceKey): PreferenceRecord | undefined {
    const parsed = parsePreferenceKey(key);
    return this.snapshot().records.find(record => record.key === parsed);
  }

  put(input: PreferenceChange): PreferenceRecord {
    return this.putMany([input])[0]!;
  }

  putMany(inputs: PreferenceChange[]): PreferenceRecord[] {
    if (!inputs.length || inputs.length > 16) throw new PreferenceError("INVALID_PREFERENCE", "A preference transaction requires 1 to 16 changes.");
    const changes = inputs.map(parsePreferenceChange);
    if (new Set(changes.map(change => change.key)).size !== changes.length) throw new PreferenceError("INVALID_PREFERENCE", "A preference transaction cannot repeat a key.");
    return this.store.updatePreferencesState(saved => {
      const state = readState(saved);
      if (!Number.isSafeInteger(state.counter + changes.length)) throw new PreferenceError("PREFERENCE_CLOCK_EXHAUSTED", "The preference revision counter cannot advance safely.");
      const records = changes.map((change, index) => ({ ...change, deleted: change.deleted ?? false,
        revision: { counter: state.counter + index + 1, actor: this.store.host.id, opId: crypto.randomUUID() } }) as PreferenceRecord);
      const keys = new Set<string>(changes.map(change => change.key));
      const snapshot = parsePreferencesSnapshotV2({ version: 2, records: [...state.records.filter(item => !keys.has(item.key)), ...records] });
      return { state: storedState(snapshot, state.counter + changes.length, state.version), result: records };
    });
  }

  merge(input: unknown): PreferenceMergeResult {
    const incoming = parsePreferencesSnapshot(input);
    const result = this.mergeFull({ version: 2, records: incoming.records });
    return { changedKeys: result.changedKeys as PreferenceKey[], snapshot: projectLegacyPreferences(result.snapshot) };
  }

  mergeV2(input: unknown): PreferenceMergeResultV2 {
    return this.mergeFull(parsePreferencesSnapshotV2(input));
  }

  /** Called within the existing serialized command admission; the whole map shares one revision. */
  mutateCommandKeymap(input: CommandKeymapMutation, registry: CommandKeymapRegistry): CommandKeymapPreferenceRecord {
    input = parseCommandKeymapMutation(input);
    const expected = input.expectedRevision;
    return this.store.updatePreferencesState(saved => {
      const state = readState(saved);
      const current = state.records.find(record => record.key === COMMAND_KEYMAP_PREFERENCE) as CommandKeymapPreferenceRecord | undefined;
      if (current ? !expected || comparePreferenceRevisions(current.revision, expected) !== 0 : expected !== null) throw new PreferenceError("STALE_KEYBINDINGS", "Shortcuts changed on another client. Refresh before editing them.");
      if (!Number.isSafeInteger(state.counter + 1)) throw new PreferenceError("PREFERENCE_CLOCK_EXHAUSTED", "The preference revision counter cannot advance safely.");
      // Linux services evaluate macOS desktop shortcuts, not their own operating system's shortcuts.
      const target = commandKeymapNumberTarget(current);
      const definitions = typeof registry === "function" ? registry(target) : registry;
      const previous = input.edit.type === "number-target" ? undefined
        : parseCommandKeymap({ overrides: current && !current.deleted ? current.value.overrides : [] }, definitions, "mac");
      const revision = { counter: state.counter + 1, actor: this.store.host.id, opId: crypto.randomUUID() };
      let record: CommandKeymapPreferenceRecord;
      if (input.edit.type === "number-target") {
        record = { key: COMMAND_KEYMAP_PREFERENCE, deleted: false, revision, value: parseCommandKeymapPreference({
          version: 2, platform: "mac", primaryNumberShortcutTarget: input.edit.target,
          // Changing conditional defaults never materializes, clears or reassigns an explicit override.
          overrides: current && !current.deleted ? current.value.overrides : [],
        }) };
      } else if (input.edit.type === "reset-all") {
        record = current && !current.deleted && current.value.version === 2
          ? { key: COMMAND_KEYMAP_PREFERENCE, deleted: false, revision, value: { ...current.value, overrides: [] } }
          : { key: COMMAND_KEYMAP_PREFERENCE, deleted: true, revision };
      }
      else if (input.edit.type === "command") {
        const next = updateCommandBinding(input.edit.commandId, input.edit.update, definitions, previous!, "mac");
        record = { key: COMMAND_KEYMAP_PREFERENCE, deleted: false, value: parseCommandKeymapPreference({
          ...(current && !current.deleted ? current.value : { version: 1, platform: "mac" }), overrides: next.overrides,
        }), revision };
      } else throw new PreferenceError("INVALID_PREFERENCE", "Unknown shortcut operation.");
      const snapshot = parsePreferencesSnapshotV2({ version: 2, records: [...state.records.filter(record => record.key !== COMMAND_KEYMAP_PREFERENCE), record] });
      return { state: storedState(snapshot, revision.counter, 2), result: record };
    });
  }

  private mergeFull(incoming: PreferencesSnapshotV2): PreferenceMergeResultV2 {
    return this.store.updatePreferencesState(saved => {
      const state = readState(saved);
      const entries = new Map(state.records.map(record => [record.key, record]));
      const operations = new Map(state.records.map(record => [record.revision.opId, fingerprint(record)]));
      const changedKeys: PreferenceKeyV2[] = [];
      let counter = state.counter;
      for (const record of incoming.records) {
        counter = Math.max(counter, record.revision.counter);
        const existingOperation = operations.get(record.revision.opId);
        if (existingOperation !== undefined && existingOperation !== fingerprint(record)) throw new PreferenceError("PREFERENCE_OPERATION_REUSED", "A preference operation identity was reused with different contents.");
        const current = entries.get(record.key);
        const compared = current ? comparePreferenceRevisions(record.revision, current.revision) : 1;
        if (compared > 0) { entries.set(record.key, record); changedKeys.push(record.key); }
        else if (compared === 0 && fingerprint(current) !== fingerprint(record)) throw new PreferenceError("PREFERENCE_REVISION_REUSED", "A preference revision was reused with different contents.");
      }
      const snapshot = parsePreferencesSnapshotV2({ version: 2, records: [...entries.values()] });
      const version = state.version === 2 || snapshot.records.some(record => record.key === COMMAND_KEYMAP_PREFERENCE) ? 2 : 1;
      return { state: storedState(snapshot, counter, version), result: { changedKeys, snapshot } };
    });
  }
}
