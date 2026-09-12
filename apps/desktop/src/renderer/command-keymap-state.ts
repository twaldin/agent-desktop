import type { CommandEnvelope, CommandResult, DesktopBridge } from "../../../../packages/shared/src/protocol";
import { COMMAND_KEYMAP_PREFERENCE, commandKeymapNumberTarget, parseCommandKeymapMutation, parsePreferencesSnapshotV2, type CommandKeymapMutation, type CommandKeymapPreferenceRecord, type PreferencesSnapshotV2 } from "../../../../packages/shared/src/preferences-v2";
import { comparePreferenceRevisions } from "../../../../packages/shared/src/preferences";
import type { DraftCache } from "./drafts";
import type { OfflineCache } from "./offline-cache";

export interface CommandKeymapCapability { commandVersion: 11; snapshotVersion: 2; numberTargetVersion?: 1 }
export type CommandKeymapEdit = CommandKeymapMutation["edit"];
export interface CommandKeymapEnvelope {
  id: string;
  commandVersion: 11;
  command: { type: "preferences.keymap.mutate"; mutation: CommandKeymapMutation };
}
type Bridge = Pick<DesktopBridge, "command"> & { getPreferencesV2?(): Promise<PreferencesSnapshotV2> };
type SavedPending = { hostId: string; envelope: CommandKeymapEnvelope; edit: CommandKeymapEdit; stale?: true };

const CACHE_PREFIX = "agent-desktop:command-keymap:v2:";
const RECEIPT_PREFIX = "agent-desktop:command-keymap:pending:v1:";
const supported = (value: CommandKeymapCapability | undefined) => value?.commandVersion === 11 && value.snapshotVersion === 2;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function fingerprint(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${fingerprint((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function copyEdit(value: CommandKeymapEdit): CommandKeymapEdit {
  return structuredClone(value);
}
function parseEnvelope(value: unknown): CommandKeymapEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved keybinding command.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => key !== "id" && key !== "commandVersion" && key !== "command") || typeof item.id !== "string" || !item.id || item.commandVersion !== 11 || !item.command || typeof item.command !== "object" || Array.isArray(item.command)) throw new Error("Invalid saved keybinding command.");
  const command = item.command as Record<string, unknown>;
  if (Object.keys(command).some(key => key !== "type" && key !== "mutation") || command.type !== "preferences.keymap.mutate") throw new Error("Invalid saved keybinding command.");
  return { id: item.id, commandVersion: 11, command: { type: "preferences.keymap.mutate", mutation: parseCommandKeymapMutation(command.mutation) } };
}
function parseSaved(value: unknown): SavedPending {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved keybinding receipt.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => key !== "hostId" && key !== "envelope" && key !== "edit" && key !== "stale") || typeof item.hostId !== "string" || !item.hostId || (item.stale !== undefined && item.stale !== true)) throw new Error("Invalid saved keybinding receipt.");
  const envelope = parseEnvelope(item.envelope);
  const mutation = parseCommandKeymapMutation({ expectedRevision: envelope.command.mutation.expectedRevision, edit: item.edit });
  if (fingerprint(mutation.edit) !== fingerprint(envelope.command.mutation.edit)) throw new Error("Saved keybinding edit disagrees with its command.");
  return { hostId: item.hostId, envelope, edit: mutation.edit, ...(item.stale ? { stale: true } : {}) };
}
function receipt(result: unknown, id: string): CommandKeymapPreferenceRecord | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const item = result as Record<string, unknown>;
  if (item.ok !== true || item.commandId !== id || !item.value || typeof item.value !== "object" || Array.isArray(item.value)) return;
  const value = item.value as Record<string, unknown>;
  if (value.type !== "preferences.keymap.mutate") return;
  const record = value.preference;
  return parsePreferencesSnapshotV2({ version: 2, records: [record] }).records.find(entry => entry.key === COMMAND_KEYMAP_PREFERENCE) as CommandKeymapPreferenceRecord | undefined;
}

/** Durable receipt controller for the v2 keymap only. It never installs bindings itself. */
export class CommandKeymapState {
  record?: CommandKeymapPreferenceRecord;
  pending?: CommandKeymapEnvelope;
  staleEdit?: CommandKeymapEdit;
  loading = false;
  busy = false;
  connected = false;
  hostId?: string;
  private pendingHostId?: string;
  capability?: CommandKeymapCapability;
  error?: string;
  cacheWarning?: string;
  receiptRecoveryError?: string;
  private ready = false;
  private listeners = new Set<() => void>();
  private inFlight?: { hostId: string | undefined; generation: number; promise: Promise<boolean> };
  private cacheWrite: Promise<void> = Promise.resolve();
  private refreshes = 0;
  private admitting = false;
  private generation = 0;
  readonly pendingKey: string;

  /** ownerKey must be stable for the persisted desktop window that owns this controller. */
  constructor(private readonly ownerKey: string, private readonly bridge: Bridge, private readonly cache: OfflineCache, private readonly receipts: DraftCache) {
    if (!ownerKey) throw new Error("A stable window owner key is required for keyboard shortcut state.");
    this.pendingKey = `${RECEIPT_PREFIX}${encodeURIComponent(ownerKey)}`;
    try {
      const raw = receipts.read(this.pendingKey);
      if (raw) {
        const saved = parseSaved(JSON.parse(raw));
        if (!saved.stale) this.pending = saved.envelope;
        this.pendingHostId = saved.hostId;
        this.staleEdit = copyEdit(saved.edit);
        this.hostId = saved.hostId;
      }
    } catch (cause) {
      this.receiptRecoveryError = `Pending shortcut changes could not be recovered: ${message(cause)} Saved command receipts have been retained.`;
      this.cacheWarning = this.receiptRecoveryError;
    }
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private cacheKey() { return this.hostId ? `${CACHE_PREFIX}${encodeURIComponent(this.ownerKey)}:${encodeURIComponent(this.hostId)}` : undefined; }
  get available() { return Boolean(this.connected && this.hostId && supported(this.capability) && this.bridge.getPreferencesV2); }
  get loaded() { return this.ready; }
  get primaryNumberShortcutTarget() { return commandKeymapNumberTarget(this.record); }
  get numberTargetAvailable() { return this.available && this.capability?.numberTargetVersion === 1; }

  prepareWindowClose(signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    if (this.admitting || this.busy) return false;
    // Ambiguous receipts are already durable and are never replayed by closing.
    return true;
  }

  setConnection(hostId: string | undefined, connected: boolean, capability?: CommandKeymapCapability) {
    const changedOwner = this.hostId !== hostId;
    if (changedOwner) { this.generation++; this.ready = false; this.record = undefined; }
    this.hostId = hostId; this.connected = connected; this.capability = capability;
    if (this.pending && this.pendingHostId !== hostId) this.error = "A shortcut change is awaiting its original host. Reconnect to that host to inspect its receipt.";
    this.changed();
  }

  private ingest(snapshot: PreferencesSnapshotV2) {
    const parsed = parsePreferencesSnapshotV2(snapshot);
    const next = parsed.records.find(record => record.key === COMMAND_KEYMAP_PREFERENCE) as CommandKeymapPreferenceRecord | undefined;
    // An omitted key is not a deletion. Preserve an observed tombstone too.
    if (!next) return;
    if (!this.record) { this.record = next; return; }
    const compared = comparePreferenceRevisions(next.revision, this.record.revision);
    if (compared < 0) return;
    if (compared === 0 && fingerprint(next) !== fingerprint(this.record)) throw new Error("A keybinding revision was reused with different contents.");
    this.record = next;
  }

  async restore() {
    const key = this.cacheKey(), hostId = this.hostId, generation = this.generation;
    if (!key || this.ready) return;
    try {
      const saved = await this.cache.read(key);
      if (this.hostId !== hostId || this.generation !== generation) return;
      if (saved) this.ingest(JSON.parse(saved));
      this.ready = true;
    } catch (cause) {
      if (this.hostId === hostId && this.generation === generation) this.cacheWarning = `Shortcut cache could not be read: ${message(cause)}`;
    }
    this.changed();
  }

  private persist(required = false): Promise<void> {
    const key = this.cacheKey();
    if (!key || (!this.ready && !required)) return Promise.resolve();
    // Capture before queuing: no later mutation can alter this write's payload.
    const serialized = JSON.stringify({ version: 2, records: this.record ? [this.record] : [] });
    const write = this.cacheWrite.catch(() => undefined).then(() => this.cache.write(key, serialized));
    this.cacheWrite = write.catch(() => undefined);
    return write;
  }

  async refresh(): Promise<boolean> {
    const hostId = this.hostId, generation = this.generation;
    const inFlight = this.inFlight;
    if (inFlight && inFlight.hostId === hostId && inFlight.generation === generation) return inFlight.promise;
    const promise = (async () => {
      this.refreshes++; this.loading = true; this.changed();
      try {
        await this.restore();
        if (this.hostId !== hostId || this.generation !== generation) return false;
        if (!this.available) throw new Error("Update the owning host before editing keyboard shortcuts.");
        const snapshot = await this.bridge.getPreferencesV2!();
        if (this.hostId !== hostId || this.generation !== generation) return false;
        this.ingest(snapshot);
        // An authoritative read can recover an unavailable local cache. Never
        // install guessed defaults while restoration is still unresolved.
        this.ready = true;
        await this.persist();
        if (this.hostId !== hostId || this.generation !== generation) return false;
        this.error = undefined; return true;
      } catch (cause) { if (this.hostId === hostId && this.generation === generation) this.error = message(cause); return false; }
      finally { this.refreshes--; this.loading = this.refreshes > 0; this.changed(); }
    })();
    this.inFlight = { hostId, generation, promise };
    void promise.finally(() => { if (this.inFlight?.promise === promise) this.inFlight = undefined; });
    return promise;
  }

  private savePending(hostId: string, envelope: CommandKeymapEnvelope, edit: CommandKeymapEdit) {
    this.receipts.write(this.pendingKey, JSON.stringify({ hostId, envelope, edit } satisfies SavedPending));
    this.pending = envelope; this.pendingHostId = hostId; this.staleEdit = copyEdit(edit);
  }
  private clearPending() {
    this.receipts.write(this.pendingKey, "");
    this.pending = undefined; this.pendingHostId = undefined;
  }
  private saveStale(hostId: string, envelope: CommandKeymapEnvelope, edit: CommandKeymapEdit) {
    // The stale edit survives restart before the original pending receipt is cleared.
    this.receipts.write(this.pendingKey, JSON.stringify({ hostId, envelope, edit, stale: true } satisfies SavedPending));
    this.pending = undefined; this.pendingHostId = hostId; this.staleEdit = copyEdit(edit);
  }

  async submit(edit: CommandKeymapEdit) {
    if (this.pending || this.busy || this.admitting) return;
    if (this.staleEdit) {
      this.error = "Rebase or dismiss the retained stale shortcut change before saving another one.";
      this.changed();
      return;
    }
    this.admitting = true;
    try {
      if (this.receiptRecoveryError) throw new Error(this.receiptRecoveryError);
      if (!this.available || !this.hostId) throw new Error("Update the owning host before editing keyboard shortcuts.");
      if (edit.type === "number-target" && !this.numberTargetAvailable) throw new Error("Update the owning host before changing number shortcuts.");
      const hostId = this.hostId, generation = this.generation;
      // Load only the scoped offline snapshot. Do not refresh remotely: the edit
      // keeps the revision the user saw, while avoiding an empty-cache overwrite.
      await this.restore();
      if (this.hostId !== hostId || this.generation !== generation) throw new Error("The active host changed before the shortcut cache was restored.");
      if (!this.ready) throw new Error(this.cacheWarning ?? "The shortcut cache could not be restored before saving this change.");
      const mutation = parseCommandKeymapMutation({ expectedRevision: this.record?.revision ?? null, edit });
      const envelope: CommandKeymapEnvelope = { id: crypto.randomUUID(), commandVersion: 11, command: { type: "preferences.keymap.mutate", mutation } };
      // Cache and receipt durability precede dispatch. Neither failure starts a mutation.
      await this.persist(true);
      if (this.hostId !== hostId || this.generation !== generation) throw new Error("The active host changed before the shortcut command was saved.");
      this.savePending(hostId, envelope, mutation.edit);
      await this.dispatch();
    } catch (cause) { this.error = message(cause); this.changed(); }
    finally { this.admitting = false; this.changed(); }
  }

  /** Explicit user action only; reconnect and refresh never replay a mutation. */
  async retry() { if (this.pending && !this.busy) await this.dispatch(); }

  /** Explicitly discards a durable stale edit; ordinary submit must never replace it. */
  dismissStale() {
    if (!this.staleEdit || this.pending || this.busy || this.admitting) return;
    try {
      this.receipts.write(this.pendingKey, "");
      this.staleEdit = undefined;
      this.pendingHostId = undefined;
      this.error = undefined;
    } catch (cause) { this.error = message(cause); }
    this.changed();
  }

  /** Explicitly creates a new command after a stale rejection using the refreshed revision. */
  async rebase() {
    if (!this.staleEdit || this.pending || this.busy || this.admitting) return;
    if (!this.hostId || this.pendingHostId !== this.hostId) {
      this.error = "Reconnect to the original host before rebasing this shortcut change.";
      this.changed();
      return;
    }
    this.admitting = true;
    try {
      if (!await this.refresh()) return;
      if (!this.staleEdit || this.pendingHostId !== this.hostId) return;
      const hostId = this.hostId;
      const generation = this.generation;
      const edit = copyEdit(this.staleEdit);
      // savePending overwrites the durable stale receipt before dispatch. Keep the edit until then.
      const mutation = parseCommandKeymapMutation({ expectedRevision: this.record?.revision ?? null, edit });
      const envelope: CommandKeymapEnvelope = { id: crypto.randomUUID(), commandVersion: 11, command: { type: "preferences.keymap.mutate", mutation } };
      await this.persist(true);
      if (this.hostId !== hostId || this.generation !== generation || this.pendingHostId !== hostId) {
        this.error = "The active host changed before the rebased shortcut command was saved.";
        return;
      }
      this.savePending(hostId, envelope, mutation.edit);
      await this.dispatch();
    } catch (cause) { this.error = message(cause); }
    finally { this.admitting = false; this.changed(); }
  }

  private async dispatch() {
    const envelope = this.pending, hostId = this.pendingHostId, generation = this.generation;
    if (!envelope || !hostId || this.busy) return;
    if (envelope.command.mutation.edit.type === "number-target" && !this.numberTargetAvailable) { this.error = "Reconnect to an updated original host before retrying number shortcuts."; this.changed(); return; }
    if (!this.connected || !this.available || this.hostId !== hostId) { this.error = "Reconnect to the original host to inspect this shortcut change."; this.changed(); return; }
    this.busy = true; this.error = undefined; this.changed();
    try {
      // A recovered receipt may be retried before the normal snapshot observer runs.
      // Restore first so confirmation cannot erase a newer cached revision or skip durability.
      await this.restore();
      if (this.hostId !== hostId || this.generation !== generation) throw new Error("The active host changed before this shortcut retry was ready.");
      if (!this.ready) throw new Error(this.cacheWarning ?? "Shortcut cache restoration is incomplete.");
      const result = await this.bridge.command(envelope, hostId) as CommandResult;
      if (this.hostId !== hostId || this.generation !== generation) throw new Error("The active host changed before this shortcut receipt could be inspected.");
      if ((result as { commandId?: unknown }).commandId !== envelope.id) throw new Error("The host returned a different shortcut command receipt.");
      const confirmed = receipt(result, envelope.id);
      if (confirmed) {
        // A delayed retry may confirm after a newer replicated snapshot arrived.
        this.ingest({ version: 2, records: [confirmed] });
        await this.persist();
        this.clearPending(); this.staleEdit = undefined;
      } else if ((result as { ok?: unknown }).ok === false) {
        const failure = result as { error: { code: string; message: string } };
        if (failure.error.code === "STALE_KEYBINDINGS") {
          this.saveStale(hostId, envelope, this.staleEdit ?? envelope.command.mutation.edit);
          // Only rebase() may create a new expected revision.
          this.error = failure.error.message;
        } else if (failure.error.code === "OUTCOME_UNKNOWN") {
          throw new Error(failure.error.message);
        } else {
          this.clearPending(); this.staleEdit = undefined; this.error = `${failure.error.message} This shortcut change was rejected and will not be retried.`;
        }
      } else throw new Error("The shortcut change has no confirmed receipt. Retry checks its original command.");
    } catch (cause) { this.error = `${message(cause)}${this.pending ? " The original command was retained; retry is explicit." : ""}`; }
    finally { this.busy = false; this.changed(); }
  }
}
