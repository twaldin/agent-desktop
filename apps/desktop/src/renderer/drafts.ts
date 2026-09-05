import type { CommandEnvelope, CommandResult, Draft, ModelChoice } from "../../../../packages/shared/src/protocol";

export type DraftStatus = "saved" | "unsaved" | "saving" | "offline" | "conflict" | "error";
export interface DraftView {
  draft: Draft;
  status: DraftStatus;
  conflict?: Draft;
  error?: string;
}
interface Entry {
  view: DraftView;
  base: Draft;
  dirty: boolean;
  version: number;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<Draft>;
  sending?: Draft;
  consuming?: Draft;
  pendingDraft?: Draft;
}
export interface DraftCache {
  read(key: string): string | null;
  write(key: string, value: string): void;
}
const equalModel = (a: ModelChoice | null, b: ModelChoice | null) => a?.id === b?.id && a?.provider === b?.provider;
export const sameDraftContent = (a: Draft, b: Draft) => a.text === b.text && a.projectId === b.projectId && equalModel(a.model, b.model) && a.thinkingLevel === b.thinkingLevel && a.approvalMode === b.approvalMode;

/** Owner revisions are authoritative; local changes remain recoverable until acknowledged. */
export class DraftController {
  private entries = new Map<string, Entry>();
  private connected = false;
  private listeners = new Set<() => void>();
  private cacheError: string | undefined;
  readonly cacheKey: string;
  constructor(private send: (envelope: CommandEnvelope) => Promise<CommandResult>, hostId: string, private cache?: DraftCache) {
    this.cacheKey = `agent-desktop:drafts:v1:${hostId}`;
    try {
      const parsed = JSON.parse(cache?.read(this.cacheKey) ?? "[]") as unknown;
      if (Array.isArray(parsed)) for (const item of parsed) {
        if (!item || typeof item !== "object" || !item.draft || !item.base || typeof item.draft.id !== "string" || typeof item.draft.text !== "string" || !Number.isInteger(item.base.revision)) continue;
        this.entries.set(item.draft.id, { base: item.base, dirty: Boolean(item.dirty), version: 0, view: { draft: item.draft, status: item.dirty ? "offline" : "saved" } });
      }
    } catch { this.cacheError = "The local draft cache could not be read. Saved host drafts remain available."; }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get cacheWarning() { return this.cacheError; }
  get(id: string, initial?: Partial<Draft>): DraftView {
    let entry = this.entries.get(id);
    if (!entry) {
      const draft: Draft = { id, revision: 0, updatedAt: 0, text: "", projectId: null, model: null, ...initial };
      entry = { base: draft, dirty: false, version: 0, view: { draft, status: "saved" } };
      this.entries.set(id, entry);
    }
    return entry.view;
  }
  private publish() {
    try { this.cache?.write(this.cacheKey, JSON.stringify([...this.entries.values()].map(e => ({ draft: e.view.draft, base: e.base, dirty: e.dirty })))); }
    catch { this.cacheError = "Local draft storage is unavailable. Keep this window open until changes are saved to the host."; }
    for (const listener of this.listeners) listener();
  }
  setConnected(value: boolean) {
    this.connected = value;
    for (const [id, entry] of this.entries) if (entry.dirty && entry.view.status !== "conflict") {
      entry.view = { ...entry.view, status: value ? "unsaved" : "offline" };
      if (value) this.schedule(id);
    }
    this.publish();
  }
  ingest(remote: Draft) {
    this.get(remote.id);
    const entry = this.entries.get(remote.id)!;
    if (remote.revision < entry.base.revision) return;
    // A submitted revision may be consumed while its response is still in flight.
    const submitted = entry.sending ?? entry.consuming;
    if (submitted && remote.revision > submitted.revision && remote.text === "") {
      entry.base = remote;
      if (!entry.dirty || sameDraftContent(entry.view.draft, submitted)) {
        entry.view = { draft: remote, status: "saved" }; entry.dirty = false;
      }
      entry.consuming = undefined;
      this.publish(); if (entry.dirty && !entry.sending) this.schedule(remote.id); return;
    }
    if (entry.pendingDraft && sameDraftContent(remote, entry.pendingDraft)) {
      entry.base = remote; this.publish(); return;
    }
    if (entry.dirty && remote.revision > entry.base.revision && !sameDraftContent(remote, entry.view.draft)) {
      entry.view = { ...entry.view, status: "conflict", conflict: remote, error: undefined };
      this.publish(); return;
    }
    if (!entry.dirty || sameDraftContent(remote, entry.view.draft)) {
      entry.base = remote;
      entry.dirty = false;
      entry.view = { draft: remote, status: "saved" };
      this.publish();
    }
  }
  update(id: string, patch: Partial<Pick<Draft, "text" | "projectId" | "model" | "thinkingLevel" | "approvalMode">>) {
    this.get(id); const entry = this.entries.get(id)!;
    entry.version += 1; entry.dirty = true;
    entry.view = { ...entry.view, draft: { ...entry.view.draft, ...patch }, error: undefined, status: entry.view.conflict ? "conflict" : this.connected ? "unsaved" : "offline" };
    this.publish(); this.schedule(id);
  }
  private schedule(id: string) {
    const entry = this.entries.get(id)!;
    if (entry.timer) clearTimeout(entry.timer);
    if (!this.connected || entry.view.conflict || entry.sending || entry.consuming) return;
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.flush(id).catch(() => {}); }, 300);
  }
  async flush(id: string, captured?: { draft: Draft; version: number }): Promise<Draft> {
    this.get(id); const entry = this.entries.get(id)!;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    if (entry.pending) { await entry.pending; return this.flush(id, captured); }
    if (entry.view.conflict) throw new Error("Resolve the draft conflict before sending.");
    if (captured ? sameDraftContent(entry.base, captured.draft) : !entry.dirty) return entry.base;
    if (!this.connected) throw new Error("Reconnect to save and send this draft.");
    const snapshot = { ...(captured?.draft ?? entry.view.draft) }; const version = captured?.version ?? entry.version;
    entry.pendingDraft = snapshot;
    entry.view = { ...entry.view, status: "saving", error: undefined }; this.publish();
    const task = (async () => {
      try {
        const { revision: _revision, updatedAt: _updatedAt, ...draft } = snapshot;
        const result = await this.send({ id: crypto.randomUUID(), command: { type: "draft.put", draft, expectedRevision: entry.base.revision } });
        if (!result.ok) {
          if (result.currentDraft) entry.view = { ...entry.view, status: "conflict", conflict: result.currentDraft, error: result.error.message };
          else entry.view = { ...entry.view, status: this.connected ? "error" : "offline", error: result.error.message };
          throw new Error(result.error.message);
        }
        if (!result.value || !("revision" in result.value)) throw new Error("The host did not acknowledge the saved draft.");
        if (entry.view.conflict && entry.view.conflict.revision > result.value.revision) throw new Error("The draft changed on another device while saving. Resolve the conflict before sending.");
        entry.base = result.value;
        entry.dirty = entry.version !== version;
        entry.view = { draft: entry.dirty ? { ...entry.view.draft, revision: result.value.revision, updatedAt: result.value.updatedAt } : result.value, status: entry.dirty ? "unsaved" : "saved" };
        return result.value;
      } catch (error) {
        if (entry.view.status !== "conflict") entry.view = { ...entry.view, status: this.connected ? "error" : "offline", error: error instanceof Error ? error.message : "Draft save failed." };
        throw error;
      } finally { entry.pending = undefined; entry.pendingDraft = undefined; this.publish(); }
    })();
    entry.pending = task;
    const saved = await task;
    if (entry.dirty) this.schedule(id);
    return saved;
  }
  async prepareSubmission(id: string): Promise<Draft> {
    this.get(id); const entry = this.entries.get(id)!;
    // Capture the click/keypress, not later typing that arrives while disk/network saves finish.
    const captured = { draft: { ...entry.view.draft }, version: entry.version };
    entry.sending = captured.draft;
    try {
      const saved = await this.flush(id, captured);
      entry.sending = saved;
      return saved;
    } catch (error) { entry.sending = undefined; throw error; }
  }
  beginPendingSubmission(submitted: Draft) {
    this.get(submitted.id); this.entries.get(submitted.id)!.sending = submitted;
  }
  finishSubmission(id: string, submitted: Draft, accepted: boolean, uncertain = false) {
    const entry = this.entries.get(id)!;
    entry.sending = undefined;
    if ((accepted || uncertain) && entry.base.revision <= submitted.revision) entry.consuming = submitted;
    else if (!accepted) entry.consuming = undefined;
    if (accepted && sameDraftContent(entry.view.draft, submitted)) {
      // The host owns revision increments and consumes the supplied revision.
      // Clear locally now, then reconcile the authoritative state event.
      entry.view = { draft: { ...entry.view.draft, text: "" }, status: "saved" }; entry.dirty = false;
    }
    this.publish();
    if (entry.dirty) this.schedule(id);
  }
  resolve(id: string, choice: "remote" | "local") {
    const entry = this.entries.get(id)!; const remote = entry.view.conflict;
    if (!remote) return;
    entry.base = remote;
    if (choice === "remote") { entry.view = { draft: remote, status: "saved" }; entry.dirty = false; }
    else { entry.view = { draft: { ...entry.view.draft, revision: remote.revision }, status: this.connected ? "unsaved" : "offline" }; entry.dirty = true; entry.version += 1; }
    this.publish(); if (choice === "local") this.schedule(id);
  }
  dispose() { for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer); this.listeners.clear(); }
}
