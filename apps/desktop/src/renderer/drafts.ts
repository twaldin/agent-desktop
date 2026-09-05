import { parseImageAttachments, sameImageAttachments, type CommandEnvelope, type CommandResult, type Draft, type DraftInput, type ModelChoice } from "../../../../packages/shared/src/protocol";

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
  sending?: SubmissionCorrelation;
  consuming?: SubmissionCorrelation;
  pendingDraft?: Draft;
}
interface SubmissionCorrelation { draft: Draft; commandId?: string }
export interface DraftCache {
  read(key: string): string | null;
  write(key: string, value: string): void;
}
const equalModel = (a: ModelChoice | null, b: ModelChoice | null) => a?.id === b?.id && a?.provider === b?.provider;
export const sameDraftContent = (a: Draft, b: Draft) => a.text === b.text && a.projectId === b.projectId && equalModel(a.model, b.model) && a.thinkingLevel === b.thinkingLevel && a.approvalMode === b.approvalMode && sameImageAttachments(a.attachments, b.attachments);
export const hasDraftContent = (draft: Pick<Draft, "text" | "attachments">) => Boolean(draft.text.trim() || draft.attachments?.length);
/** Copy nested mutable input and preserve the distinction between legacy and image-aware empty drafts. */
export function captureDraft(draft: Draft, hostId?: string): Draft {
  return { ...draft, model: draft.model ? { ...draft.model } : null,
    ...(draft.attachments !== undefined ? { attachments: parseImageAttachments(draft.attachments, hostId) } : {}),
    ...(draft.lastConsumption ? { lastConsumption: { commandId: draft.lastConsumption.commandId, submittedRevision: draft.lastConsumption.submittedRevision } } : {}) };
}
function editableDraft(draft: Draft): DraftInput {
  return { id: draft.id, text: draft.text, projectId: draft.projectId, model: draft.model ? { ...draft.model } : null,
    thinkingLevel: draft.thinkingLevel, approvalMode: draft.approvalMode,
    ...(draft.attachments !== undefined ? { attachments: parseImageAttachments(draft.attachments) } : {}) };
}
function directConsumption(remote: Draft, submitted: SubmissionCorrelation) {
  if (submitted.draft.attachments === undefined) return remote.revision > submitted.draft.revision && remote.text === "" && remote.attachments === undefined;
  // This marker is retained by later saves. Those later revisions require ordinary conflict handling.
  return Boolean(submitted.commandId && remote.lastConsumption?.commandId === submitted.commandId
    && remote.lastConsumption.submittedRevision === submitted.draft.revision && remote.revision === submitted.draft.revision + 1
    && remote.text === "" && remote.attachments?.length === 0);
}

/** Owner revisions are authoritative; local changes remain recoverable until acknowledged. */
export class DraftController {
  private entries = new Map<string, Entry>();
  private connected = false;
  private listeners = new Set<() => void>();
  private cacheError: string | undefined;
  readonly cacheKey: string;
  constructor(private send: (envelope: CommandEnvelope) => Promise<CommandResult>, private hostId: string, private cache?: DraftCache) {
    this.cacheKey = `agent-desktop:drafts:v1:${hostId}`;
    try {
      const parsed = JSON.parse(cache?.read(this.cacheKey) ?? "[]") as unknown;
      if (Array.isArray(parsed)) for (const item of parsed) {
        if (!item || typeof item !== "object" || !item.draft || !item.base || typeof item.draft.id !== "string" || typeof item.draft.text !== "string" || !Number.isInteger(item.base.revision)) continue;
        try {
          const draft = captureDraft(item.draft, hostId), base = captureDraft(item.base, hostId);
          if (draft.id !== base.id) throw new Error("Draft cache identities differ.");
          // An unbound keypress cannot have been delivered. Exact cached send envelopes
          // are restored by the submission controller before the first host ingest.
          const savedCorrelation = (item.sending ?? item.consuming)?.commandId ? item.sending ?? item.consuming : undefined;
          const consuming = savedCorrelation ? { draft: captureDraft(savedCorrelation.draft, hostId), commandId: savedCorrelation.commandId } : undefined;
          if (consuming && (consuming.draft.id !== draft.id || (consuming.commandId !== undefined && (typeof consuming.commandId !== "string" || !consuming.commandId)))) throw new Error("Invalid pending draft identity.");
          const conflict = item.conflict ? captureDraft(item.conflict, hostId) : undefined;
          this.entries.set(draft.id, { base, consuming, dirty: Boolean(item.dirty), version: 0, view: { draft, conflict, status: conflict ? "conflict" : item.dirty ? "offline" : "saved" } });
        } catch { this.cacheError = "Some local draft metadata could not be read. Check saved host drafts and pending submissions before resending."; }
      }
    } catch { this.cacheError = "The local draft cache could not be read. Saved host drafts remain available."; }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get cacheWarning() { return this.cacheError; }
  get(id: string, initial?: Partial<Draft>): DraftView {
    let entry = this.entries.get(id);
    if (!entry) {
      const draft = captureDraft({ id, revision: 0, updatedAt: 0, text: "", projectId: null, model: null, ...initial }, this.hostId);
      entry = { base: draft, dirty: false, version: 0, view: { draft, status: "saved" } };
      this.entries.set(id, entry);
    }
    return entry.view;
  }
  private publish() {
    try { this.cache?.write(this.cacheKey, JSON.stringify([...this.entries.values()].map(e => ({ draft: e.view.draft, base: e.base, dirty: e.dirty, conflict: e.view.conflict, consuming: e.sending ?? e.consuming })))); }
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
    remote = captureDraft(remote, this.hostId);
    this.get(remote.id);
    const entry = this.entries.get(remote.id)!;
    if (remote.revision < Math.max(entry.base.revision, entry.view.conflict?.revision ?? 0)) return;
    // A submitted revision may be consumed while its response is still in flight.
    const submitted = entry.sending ?? entry.consuming;
    if (submitted && directConsumption(remote, submitted)) {
      entry.base = remote;
      if (!entry.dirty || sameDraftContent(entry.view.draft, submitted.draft)) {
        entry.view = { draft: remote, status: "saved" }; entry.dirty = false;
      }
      entry.consuming = undefined;
      this.publish(); if (entry.dirty && !entry.sending) this.schedule(remote.id); return;
    }
    if (entry.base.attachments !== undefined && remote.attachments === undefined) {
      entry.view = { ...entry.view, status: "conflict", conflict: remote, error: "The host draft is missing its attachment format. Local images were preserved." };
      this.publish(); return;
    }
    if (entry.pendingDraft && sameDraftContent(remote, entry.pendingDraft)) {
      entry.base = remote;
      if (entry.consuming && remote.revision > entry.consuming.draft.revision) entry.consuming = undefined;
      this.publish(); return;
    }
    if ((entry.dirty || submitted?.draft.attachments !== undefined) && remote.revision > entry.base.revision && !sameDraftContent(remote, entry.view.draft)) {
      entry.view = { ...entry.view, status: "conflict", conflict: remote, error: undefined };
      this.publish(); return;
    }
    if (!entry.dirty || sameDraftContent(remote, entry.view.draft)) {
      entry.base = remote;
      if (entry.consuming && remote.revision > entry.consuming.draft.revision) entry.consuming = undefined;
      entry.dirty = false;
      entry.view = { draft: remote, status: "saved" };
      this.publish();
    }
  }
  update(id: string, patch: Partial<Pick<Draft, "text" | "projectId" | "model" | "thinkingLevel" | "approvalMode" | "attachments">>) {
    this.get(id); const entry = this.entries.get(id)!;
    if (entry.view.draft.attachments !== undefined && "attachments" in patch && patch.attachments === undefined) throw new Error("An image-aware draft must retain its attachment format. Remove images with an empty array.");
    const next = captureDraft({ ...entry.view.draft, ...patch }, this.hostId);
    entry.version += 1; entry.dirty = true;
    entry.view = { ...entry.view, draft: next, error: undefined, status: entry.view.conflict ? "conflict" : this.connected ? "unsaved" : "offline" };
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
    if (captured ? sameDraftContent(entry.base, captured.draft) : !entry.dirty) return captureDraft(entry.base, this.hostId);
    if (!this.connected) throw new Error("Reconnect to save and send this draft.");
    const snapshot = captureDraft(captured?.draft ?? entry.view.draft, this.hostId); const version = captured?.version ?? entry.version;
    entry.pendingDraft = snapshot;
    entry.view = { ...entry.view, status: "saving", error: undefined }; this.publish();
    const task = (async () => {
      try {
        const draft = editableDraft(snapshot);
        const result = await this.send({ id: crypto.randomUUID(), command: { type: "draft.put", draft, expectedRevision: entry.base.revision } });
        if (!result.ok) {
          if (result.currentDraft) entry.view = { ...entry.view, status: "conflict", conflict: captureDraft(result.currentDraft, this.hostId), error: result.error.message };
          else entry.view = { ...entry.view, status: this.connected ? "error" : "offline", error: result.error.message };
          throw new Error(result.error.message);
        }
        if (!result.value || !("revision" in result.value)) throw new Error("The host did not acknowledge the saved draft.");
        const saved = captureDraft(result.value, this.hostId);
        if (saved.id !== snapshot.id || !sameDraftContent(saved, snapshot)) throw new Error("The host did not preserve the saved draft content.");
        if (entry.view.conflict && entry.view.conflict.revision > result.value.revision) throw new Error("The draft changed on another device while saving. Resolve the conflict before sending.");
        entry.base = saved;
        if (entry.consuming && saved.revision > entry.consuming.draft.revision) entry.consuming = undefined;
        entry.dirty = entry.version !== version;
        entry.view = { draft: entry.dirty ? { ...entry.view.draft, revision: saved.revision, updatedAt: saved.updatedAt } : saved, status: entry.dirty ? "unsaved" : "saved" };
        return captureDraft(saved, this.hostId);
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
    if (entry.consuming?.draft.attachments !== undefined) throw new Error("Waiting for the host to confirm consumption of the pending image-aware draft.");
    // Capture the click/keypress, not later typing that arrives while disk/network saves finish.
    const captured = { draft: captureDraft(entry.view.draft, this.hostId), version: entry.version };
    entry.sending = { draft: captured.draft };
    try {
      const saved = await this.flush(id, captured);
      entry.sending = { draft: captureDraft(saved, this.hostId) };
      return captureDraft(saved, this.hostId);
    } catch (error) { entry.sending = undefined; throw error; }
  }
  beginPendingSubmission(submitted: Draft, commandId?: string) {
    this.get(submitted.id, submitted); this.entries.get(submitted.id)!.sending = { draft: captureDraft(submitted, this.hostId), commandId };
    this.publish();
  }
  finishSubmission(id: string, submitted: Draft, accepted: boolean, uncertain = false, commandId?: string) {
    const entry = this.entries.get(id)!;
    const correlation = { draft: captureDraft(submitted, this.hostId), commandId: commandId ?? entry.sending?.commandId ?? entry.consuming?.commandId };
    entry.sending = undefined;
    entry.consuming = (accepted || uncertain) && entry.base.revision <= submitted.revision ? correlation : undefined;
    if (accepted && submitted.attachments === undefined && sameDraftContent(entry.view.draft, submitted)) {
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
    entry.consuming = undefined;
    if (choice === "remote") {
      const retainFormat = entry.view.draft.attachments !== undefined && remote.attachments === undefined;
      entry.view = { draft: retainFormat ? { ...remote, attachments: [] } : remote, status: retainFormat ? this.connected ? "unsaved" : "offline" : "saved" }; entry.dirty = retainFormat;
    }
    else { entry.view = { draft: { ...entry.view.draft, revision: remote.revision }, status: this.connected ? "unsaved" : "offline" }; entry.dirty = true; entry.version += 1; }
    this.publish(); if (entry.dirty) this.schedule(id);
  }
  dispose() { for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer); this.listeners.clear(); }
}
