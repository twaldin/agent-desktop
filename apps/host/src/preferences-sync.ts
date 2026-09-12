import { PREFERENCE_LIMITS, type PreferenceChange, type PreferenceRecord, type PreferencesSnapshot } from "../../../packages/shared/src/preferences";
import type { CommandKeymapMutation, CommandKeymapPreferenceRecord, PreferencesSnapshotV2 } from "../../../packages/shared/src/preferences-v2";
import type { CommandKeymapRegistry } from "./preferences/store";
import { PreferencesStore } from "./preferences";
import type { HostStore } from "./store";

export interface PreferencePeer { hostId: string; origin: string; token?: string; preferencesSyncVersion?: 2 | 3 }

/** Exchanges allowlisted preference records only, over already authenticated host endpoints. */
export class PreferencesSync {
  readonly store: PreferencesStore;
  #syncing?: Promise<void>;
  #again = false;
  #peers: PreferencePeer[] = [];
  #stopped = false;
  #controller = new AbortController();
  errors: Record<string, string> = {};
  constructor(hostStore: HostStore, private changed: () => void) { this.store = new PreferencesStore(hostStore); }
  snapshot(): PreferencesSnapshot { return this.store.snapshot(); }
  snapshotV2(): PreferencesSnapshotV2 { return this.store.snapshotV2(); }
  put(change: PreferenceChange): PreferenceRecord {
    return this.putMany([change])[0]!;
  }
  putMany(changes: PreferenceChange[]): PreferenceRecord[] {
    const records = this.store.putMany(changes);
    this.changed(); void this.sync(this.#peers);
    return records;
  }
  mutateCommandKeymap(input: CommandKeymapMutation, definitions: CommandKeymapRegistry): CommandKeymapPreferenceRecord {
    const record = this.store.mutateCommandKeymap(input, definitions);
    // The durable map already changed. Notification failure must not become a
    // definite rejection that invites a newly identified duplicate edit.
    try { this.changed(); }
    catch (cause) {
      throw Object.assign(new Error("Shortcuts were saved, but their change notification failed. Inspect the original command receipt before editing again.", { cause }), { code: "OUTCOME_UNKNOWN" });
    }
    void this.sync(this.#peers);
    return record;
  }
  merge(snapshot: unknown): PreferencesSnapshot {
    const result = this.store.merge(snapshot);
    if (result.changedKeys.length) { this.changed(); void this.sync(this.#peers); }
    return result.snapshot;
  }
  mergeV2(snapshot: unknown): PreferencesSnapshotV2 {
    const result = this.store.mergeV2(snapshot);
    if (result.changedKeys.length) { this.changed(); void this.sync(this.#peers); }
    return result.snapshot;
  }
  sync(peers: PreferencePeer[]): Promise<void> {
    this.#peers = peers;
    if (this.#stopped) return Promise.resolve();
    this.#again = true;
    if (this.#syncing) return this.#syncing;
    this.#syncing = (async () => {
      do {
        this.#again = false;
        const currentPeers = [...this.#peers];
        const errors: Record<string, string> = {};
        // Bound concurrent snapshots; a tailnet can have more devices than desktops.
        for (let i = 0; i < currentPeers.length && !this.#stopped; i += 4) {
          await Promise.all(currentPeers.slice(i, i + 4).map(async peer => {
            try {
              // Legacy peers receive neither new values nor their tombstones. Never infer support from a successful v1 response.
              const version = peer.preferencesSyncVersion ?? 1;
              const full = this.snapshotV2();
              if (version < 3 && full.records.some(record => record.key === "general.commandKeymap" && !record.deleted && record.value.version === 2)) throw new Error("This peer must be updated to synchronize number shortcuts.");
              const response = await fetch(`${peer.origin}/v${version}/preferences/merge`, {
                method: "POST", headers: { "Content-Type": "application/json", ...(peer.token ? { Authorization: `Bearer ${peer.token}` } : {}) },
                body: JSON.stringify(version >= 2 ? full : this.snapshot()), redirect: "error",
                signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(5000)]),
              });
              if (!response.ok) throw new Error(`Preference sync returned HTTP ${response.status}.`);
              if (!response.body) throw new Error("Preference snapshot body is missing.");
              const reader = response.body.getReader();
              const chunks: Uint8Array[] = []; let size = 0;
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  size += value.length;
                  if (size > PREFERENCE_LIMITS.snapshotBytes) throw new Error("Preference snapshot is too large.");
                  chunks.push(value);
                }
              } finally { await reader.cancel().catch(() => {}); }
              if (!this.#stopped) {
                const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (version >= 2) this.mergeV2(snapshot); else this.merge(snapshot);
              }
            } catch {
              if (!this.#stopped) errors[peer.hostId] = "Preferences are saved locally; this host has not synchronized yet.";
            }
          }));
        }
        const changedErrors = JSON.stringify(errors) !== JSON.stringify(this.errors);
        this.errors = errors;
        if (changedErrors && !this.#stopped) this.changed();
      } while (this.#again && !this.#stopped);
    })().finally(() => { this.#syncing = undefined; });
    return this.#syncing;
  }
  async dispose(): Promise<void> {
    this.#stopped = true; this.#controller.abort(); await this.#syncing;
  }
}
