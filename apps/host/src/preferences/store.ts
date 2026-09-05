import {
  PREFERENCES_VERSION, PreferenceError, comparePreferenceRevisions, isPreferenceId,
  parsePreferenceChange, parsePreferenceKey, parsePreferencesSnapshot,
  type PreferenceChange, type PreferenceKey, type PreferenceMergeResult, type PreferenceRecord, type PreferencesSnapshot,
} from "../../../../packages/shared/src/preferences";
import type { HostStore } from "../store";

export interface StoredPreferencesState { version: 1; counter: number; records: PreferenceRecord[] }

function readState(value: StoredPreferencesState | undefined): StoredPreferencesState {
  if (!value) return { version: PREFERENCES_VERSION, counter: 0, records: [] };
  const snapshot = parsePreferencesSnapshot({ version: value.version, records: value.records });
  if (!Number.isSafeInteger(value.counter) || value.counter < 0 || snapshot.records.some(record => record.revision.counter > value.counter)) {
    throw new PreferenceError("INVALID_PREFERENCES_STATE", "The persisted preference clock is invalid. Preserve the database before repairing it.");
  }
  return { ...snapshot, counter: value.counter };
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
  }

  snapshot(): PreferencesSnapshot {
    const { version, records } = readState(this.store.readPreferencesState());
    return { version, records };
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
      const keys = new Set(changes.map(change => change.key));
      const snapshot = parsePreferencesSnapshot({ version: PREFERENCES_VERSION, records: [...state.records.filter(item => !keys.has(item.key)), ...records] });
      return { state: { ...snapshot, counter: state.counter + changes.length }, result: records };
    });
  }

  merge(input: unknown): PreferenceMergeResult {
    const incoming = parsePreferencesSnapshot(input);
    return this.store.updatePreferencesState(saved => {
      const state = readState(saved);
      const entries = new Map(state.records.map(record => [record.key, record]));
      const operations = new Map(state.records.map(record => [record.revision.opId, fingerprint(record)]));
      const changedKeys: PreferenceKey[] = [];
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
      const snapshot = parsePreferencesSnapshot({ version: PREFERENCES_VERSION, records: [...entries.values()] });
      return { state: { ...snapshot, counter }, result: { changedKeys, snapshot } };
    });
  }
}
