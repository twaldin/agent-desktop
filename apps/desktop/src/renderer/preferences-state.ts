import type { CommandEnvelope, DesktopBridge } from "../../../../packages/shared/src/protocol";
import { DEFAULT_SIDEBAR_ORGANIZATION, LEGACY_SIDEBAR_ORGANIZATION, comparePreferenceRevisions, parsePreferenceChange, parsePreferencesSnapshot, type PreferenceChange, type PreferenceKey, type PreferenceRecord, type PreferencesSnapshot, type PreferenceValues, type SidebarEntityPreference, type SidebarSectionPreference } from "../../../../packages/shared/src/preferences";
import type { DraftCache } from "./drafts";
import type { OfflineCache } from "./offline-cache";

type PreferencesBridge = Pick<DesktopBridge, "getPreferences" | "command" | "subscribe">;
export class PreferencesState {
  records = new Map<PreferenceKey, PreferenceRecord>();
  pending: CommandEnvelope[] = [];
  loading = false;
  busy = false;
  connected = false;
  localHostId?: string;
  error?: string;
  cacheWarning?: string;
  ready = false;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private inFlight?: Promise<void>;
  private again = false;
  private restoration?: Promise<void>;
  private receiptRecoveryError?: string;
  private writes: Promise<void> = Promise.resolve();
  readonly cacheKey = "agent-desktop:preferences:v1";
  readonly pendingKey = "agent-desktop:preference-commands:v1";
  constructor(private bridge: PreferencesBridge, private cache: OfflineCache, private receipts: DraftCache) {
    try {
      const saved = JSON.parse(receipts.read(this.pendingKey) ?? "[]");
      if (!Array.isArray(saved)) throw new Error("Invalid pending preference commands.");
      this.pending = saved.map(item => { if (typeof item?.id !== "string" || item?.command?.type !== "preferences.put") throw new Error("Invalid pending preference command."); return { id: item.id, command: { type: "preferences.put", change: parsePreferenceChange(item.command.change) } }; });
    } catch (cause) { this.receiptRecoveryError = `Pending preference changes could not be recovered: ${message(cause)} Saved command receipts have been retained. Restart after repairing this device’s storage to change shared preferences.`; this.cacheWarning = this.receiptRecoveryError; }
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  start() { this.unsubscribe ??= this.bridge.subscribe(event => { if (event.type === "preferences" && (event.hostId ?? this.localHostId) === this.localHostId) void this.refresh(); }); }
  stop() { this.unsubscribe?.(); this.unsubscribe = undefined; }
  setConnection(hostId: string | undefined, connected: boolean) { this.localHostId = hostId; this.connected = connected; this.changed(); }
  get<K extends PreferenceKey>(key: K): PreferenceValues[K] | undefined { const record = this.records.get(key); return record && !record.deleted ? record.value as PreferenceValues[K] : undefined; }
  sidebarOrganization() {
    return this.get("sidebar.organization") ?? ([...this.records.values()].some(record => !record.deleted && /^sidebar\.(section|project|session)\./.test(record.key)) ? LEGACY_SIDEBAR_ORGANIZATION : DEFAULT_SIDEBAR_ORGANIZATION);
  }
  sections() { return [...this.records.values()].flatMap(record => record.key.startsWith("sidebar.section.") && !record.deleted ? [{ id: record.key.slice("sidebar.section.".length), ...record.value as SidebarSectionPreference }] : []).sort(positionOrder); }
  entity(kind: "project" | "session", id: string, hostId: string): SidebarEntityPreference | undefined { const value = this.get(`sidebar.${kind}.${id}`); return value?.hostId === hostId ? value : undefined; }
  sectionFor(kind: "project" | "session", id: string, hostId: string): string | null {
    const section = this.entity(kind, id, hostId)?.sectionId;
    return section === "pinned" || section && this.get(`sidebar.section.${section}`) ? section : null;
  }
  ingest(snapshot: PreferencesSnapshot) {
    for (const record of parsePreferencesSnapshot(snapshot).records) {
      const current = this.records.get(record.key);
      if (!current || comparePreferenceRevisions(record.revision, current.revision) > 0) this.records.set(record.key, record);
    }
    this.changed();
  }
  restore(): Promise<void> {
    return this.restoration ??= (async () => {
      try { const saved = await this.cache.read(this.cacheKey); if (saved) this.ingest(JSON.parse(saved)); this.ready = true; }
      catch (cause) { this.cacheWarning = `Shared preferences cache could not be read. ${message(cause)}`; this.restoration = undefined; }
      this.changed();
    })();
  }
  private persist() {
    if (!this.ready) return;
    const value = JSON.stringify({ version: 1, records: [...this.records.values()] });
    this.writes = this.writes.catch(() => {}).then(() => this.cache.write(this.cacheKey, value)).catch(cause => { this.cacheWarning = `Shared preferences could not be cached: ${message(cause)}`; this.changed(); });
  }
  refresh(): Promise<void> {
    if (this.inFlight) { this.again = true; return this.inFlight; }
    this.inFlight = (async () => {
      this.loading = true; this.changed();
      try { await this.restore(); this.ingest(await this.bridge.getPreferences()); this.error = undefined; this.persist(); }
      catch (cause) { this.error = message(cause); }
      finally { this.loading = false; this.changed(); }
    })().finally(() => { this.inFlight = undefined; if (this.again) { this.again = false; void this.refresh(); } });
    return this.inFlight;
  }
  async put(change: PreferenceChange) { await this.putMany([change]); }
  async putMany(changes: PreferenceChange[]) {
    if (this.pending.length || this.busy) return;
    try {
      if (this.receiptRecoveryError) throw new Error(this.receiptRecoveryError);
      if (!this.connected || !this.localHostId) throw new Error("Reconnect to this device’s host before changing shared organization.");
      const writes = !this.get("sidebar.organization") && !changes.some(change => change.key === "sidebar.organization") && changes.some(change => /^sidebar\.(section|project|session)\./.test(change.key))
        ? [{ key: "sidebar.organization", value: this.sidebarOrganization() } as PreferenceChange, ...changes] : changes;
      this.pending = writes.map(change => ({ id: crypto.randomUUID(), command: { type: "preferences.put", change: parsePreferenceChange(change) } }));
      await this.retry();
    } catch (cause) { this.error = message(cause); this.changed(); }
  }
  async retry() {
    if (this.busy || !this.connected || !this.localHostId) return;
    this.busy = true; this.error = undefined; this.changed();
    try {
      while (this.pending.length) {
        this.receipts.write(this.pendingKey, JSON.stringify(this.pending));
        const envelope = this.pending[0]!;
        const result = await this.bridge.command(envelope, this.localHostId);
        if (result.commandId !== envelope.id) throw new Error("The host returned a different preference command receipt.");
        if (!result.ok) {
          if (result.error.code === "OUTCOME_UNKNOWN") throw new Error(result.error.message);
          this.pending.shift(); this.receipts.write(this.pendingKey, JSON.stringify(this.pending)); throw new Error(result.error.message);
        }
        if (!result.value || !("type" in result.value) || result.value.type !== "preferences.put") throw new Error("The preference change has no confirmed receipt. Retry checks its original command.");
        this.ingest({ version: 1, records: [result.value.preference] });
        this.pending.shift(); this.receipts.write(this.pendingKey, JSON.stringify(this.pending)); this.persist();
      }
    } catch (cause) { this.error = `${message(cause)}${this.pending.length ? " Remaining changes are preserved. Retry uses their original command IDs." : ""}`; }
    finally { this.busy = false; this.changed(); }
  }
}
export function positionOrder(a: { id: string; position: number }, b: { id: string; position: number }) { return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
