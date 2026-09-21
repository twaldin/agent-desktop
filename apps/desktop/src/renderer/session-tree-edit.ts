import type { CommandEnvelope, DesktopBridge } from "@agent-desktop/shared";
import { parseSessionTreeResponse, parseTreeMutationResult, parseTreeTicket, parseTreeCommandId, type TreeDraft, type TreeMutationResult, type TreeTicket } from "../../../../packages/shared/src/session-tree";
export interface TreeEditOwner { hostId: string; sessionId: string; targetId: string }
interface SavedEdit {
  owner: TreeEditOwner; text: string; initialText: string; summarize: boolean; customInstructions?: string;
  originalTicket?: TreeTicket; navigationId?: string; prepared?: { ticket: TreeTicket; leafId: string | null };
  prompt?: CommandEnvelope; uncertain?: boolean;
}
function parseSavedEdit(raw: string, owner: TreeEditOwner): SavedEdit {
  const value = JSON.parse(raw) as SavedEdit;
  const fail = () => { throw new Error("The preserved edit is unreadable; it was not submitted or overwritten."); };
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["owner", "text", "initialText", "summarize", "customInstructions", "originalTicket", "navigationId", "prepared", "prompt", "uncertain"].includes(key))
    || JSON.stringify(value.owner) !== JSON.stringify(owner) || typeof value.text !== "string" || value.text.length > 500000 || typeof value.initialText !== "string" || typeof value.summarize !== "boolean"
    || value.customInstructions !== undefined && typeof value.customInstructions !== "string" || value.uncertain !== undefined && typeof value.uncertain !== "boolean") fail();
  if (value.originalTicket) { parseTreeTicket(value.originalTicket); if (value.originalTicket.nativeSessionId !== owner.sessionId) fail(); }
  if (value.navigationId !== undefined) parseTreeCommandId(value.navigationId);
  if (value.prepared) {
    parseTreeTicket(value.prepared.ticket);
    if (!value.navigationId || value.prepared.ticket.nativeSessionId !== owner.sessionId || value.prepared.leafId !== null && typeof value.prepared.leafId !== "string" || Object.keys(value.prepared).some(key => !["ticket", "leafId"].includes(key))) fail();
  }
  if (value.prompt) {
    parseTreeCommandId(value.prompt.id); const command = value.prompt.command;
    if (!value.prepared || value.prompt.commandVersion !== 23 || command.type !== "session.prompt" || command.sessionId !== owner.sessionId || command.text !== value.text || !command.treeTicket
      || Object.keys(value.prompt).some(key => !["id", "commandVersion", "command"].includes(key)) || Object.keys(command).some(key => !["type", "sessionId", "text", "treeTicket"].includes(key))) fail();
    if (command.type === "session.prompt") { parseTreeTicket(command.treeTicket); if (command.treeTicket?.nativeSessionId !== owner.sessionId) fail(); }
  }
  return value;
}
export interface TreeEditView { text: string; summarize: boolean; customInstructions: string; busy: boolean; uncertain: boolean; prepared: boolean; sent: boolean; error?: string; imageCount: number }
export class SessionTreeEditState {
  #saved: SavedEdit; #draft?: TreeDraft; #enabled = false; #generation = 0;
  #listeners = new Set<() => void>(); #view: TreeEditView; #unreadable = false;
  constructor(readonly owner: TreeEditOwner, initialText: string, imageCount: number,
    private bridge: Pick<DesktopBridge, "command" | "getSessionTree">,
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    prepared?: TreeMutationResult, originalTicket?: TreeTicket) {
    this.#saved = { owner, text: initialText, initialText, summarize: false, originalTicket };
    let recoveryError: string | undefined;
    try {
      const raw = storage.getItem(this.#key());
      if (raw) this.#saved = parseSavedEdit(raw, owner);
      if (prepared?.draft && (!this.#saved.navigationId || this.#saved.navigationId === prepared.commandId)) this.#adopt(prepared);
    } catch (cause) { this.#unreadable = true; recoveryError = cause instanceof Error ? cause.message : String(cause); }
    this.#view = { text: this.#saved.text, summarize: this.#saved.summarize, customInstructions: this.#saved.customInstructions ?? "", busy: false,
      uncertain: this.#unreadable || !!this.#saved.uncertain, error: recoveryError, prepared: !!this.#saved.prepared, sent: false, imageCount: this.#draft?.images.length ?? imageCount };
  }
  #key() { return `agent-desktop:history-edit:v1:${JSON.stringify(this.owner)}`; }
  #save() { this.storage.setItem(this.#key(), JSON.stringify(this.#saved)); }
  #set(patch: Partial<TreeEditView>) { this.#view = { ...this.#view, ...patch }; this.#listeners.forEach(listener => listener()); }
  getSnapshot = () => this.#view;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  configure(enabled: boolean) { if (this.#enabled !== enabled) this.#generation++; this.#enabled = enabled; }
  disconnect() { this.#enabled = false; this.#generation++; }
  update(patch: { text?: string; summarize?: boolean; customInstructions?: string }) {
    if (this.#unreadable || this.#view.busy || this.#saved.prompt || this.#saved.uncertain) return;
    const saved = { ...this.#saved, ...patch }; this.#saved = saved;
    try { this.#save(); this.#set({ ...patch, error: undefined }); }
    catch (cause) { this.#set({ ...patch, error: `The edit could not be saved locally: ${cause instanceof Error ? cause.message : String(cause)}` }); }
  }
  cancel(): void {
    if (this.#unreadable || this.#view.busy || this.#saved.navigationId || this.#saved.prompt) return;
    this.storage.removeItem(this.#key());
  }
  stop() {
    this.#generation++;
    this.#set({ error: "Stopped. Your edit is preserved; check the original command before continuing.", uncertain: !!this.#saved.uncertain });
  }
  async reviewCurrent(): Promise<void> {
    if (this.#unreadable || this.#view.busy || this.#saved.uncertain || this.#saved.prompt || this.#saved.navigationId && !this.#saved.prepared) return;
    const generation = this.#generation; this.#set({ busy: true, error: undefined });
    try {
      this.#assert(generation); const response = await this.#read(this.#saved.navigationId); this.#assert(generation);
      if (this.#saved.navigationId && (response.receipt?.state !== "succeeded" || !response.receipt.result || response.receipt.result.cancelled)) throw new Error("Inspect the original history command before starting a new edit.");
      if (!response.tree || response.tree.busyReason || response.tree.reconciliationRequired || !response.tree.entries.some(entry => entry.id === this.owner.targetId && entry.editable)) throw new Error("The original entry is unavailable for editing.");
      this.#saved.originalTicket = response.tree.ticket;
      this.#saved.navigationId = undefined; this.#saved.prepared = undefined; this.#draft = undefined; this.#save();
      this.#set({ prepared: false, uncertain: false });
    } catch (cause) { this.#set({ error: cause instanceof Error ? cause.message : String(cause) }); }
    finally { this.#set({ busy: false }); }
  }
  #assert(generation: number) { if (!this.#enabled || generation !== this.#generation) throw new Error("The original edit owner is no longer selected. Your edit was preserved."); }
  async #read(commandId?: string) {
    if (!this.bridge.getSessionTree) throw new Error("Update this desktop to inspect native history.");
    return parseSessionTreeResponse(await this.bridge.getSessionTree(this.owner.sessionId, this.owner.hostId, commandId), this.owner.hostId, this.owner.sessionId, commandId);
  }
  #adopt(result: TreeMutationResult) {
    if (!result.draft || result.state.ticket.nativeSessionId !== this.owner.sessionId) throw new Error("The selected native entry did not return an editable draft.");
    this.#draft = result.draft;
    if (this.#saved.text === this.#saved.initialText) this.#saved.text = result.draft.text;
    this.#saved.navigationId = result.commandId;
    this.#saved.prepared = { ticket: result.state.ticket, leafId: result.state.leafId };
    this.#saved.uncertain = false; this.#save();
  }
  async inspect(): Promise<void> {
    if (this.#unreadable || this.#view.busy) return;
    const generation = this.#generation; this.#set({ busy: true, error: undefined });
    try {
      this.#assert(generation);
      const id = this.#saved.prompt?.id ?? this.#saved.navigationId;
      if (!id) return;
      const response = await this.#read(id); this.#assert(generation);
      const receipt = response.receipt!;
      if (receipt.state === "succeeded") {
        if (this.#saved.prompt) {
          if (!receipt.submission) throw new Error("The receipt is not for the original edit submission.");
          this.storage.removeItem(this.#key()); this.#set({ sent: true, uncertain: false }); return;
        }
        if (!receipt.result || receipt.result.cancelled) throw new Error("The original history navigation was cancelled.");
        this.#adopt(receipt.result);
      } else if (receipt.state === "failed") {
        if (this.#saved.prompt) this.#saved.prompt = undefined;
        else { this.#saved.navigationId = undefined; this.#saved.prepared = undefined; }
        this.#saved.uncertain = false; this.#save();
        this.#set({ uncertain: false, error: receipt.error ?? "The original request was refused before submission." }); return;
      } else throw new Error(`The original command is ${receipt.state}. It was not replayed. Check its status before continuing.`);
      this.#set({ text: this.#saved.text, prepared: !!this.#saved.prepared, uncertain: false, imageCount: this.#draft?.images.length ?? this.#view.imageCount });
    } catch (cause) { this.#set({ error: cause instanceof Error ? cause.message : String(cause), uncertain: true }); }
    finally { this.#set({ busy: false }); }
  }
  async send(): Promise<void> {
    if (this.#view.busy || this.#view.uncertain || this.#saved.prompt) return;
    const generation = this.#generation; this.#set({ busy: true, error: undefined });
    try {
      this.#assert(generation); this.#save();
      let response = await this.#read(); this.#assert(generation);
      if (!response.tree || response.tree.reconciliationRequired || response.tree.busyReason) throw new Error(response.tree?.busyReason ?? response.unavailable ?? "The native history is unavailable.");
      if (!this.#saved.prepared) {
        if (this.#saved.originalTicket && JSON.stringify(response.tree.ticket) !== JSON.stringify(this.#saved.originalTicket)) throw new Error("History changed since this editor opened. Your edit was retained; review the current branch before sending.");
        const target = response.tree.entries.find(entry => entry.id === this.owner.targetId);
        if (!target?.editable) throw new Error("This original history entry is not editable.");
        const id = crypto.randomUUID(); this.#saved.navigationId = id; this.#saved.uncertain = true; this.#save();
        const result = await this.bridge.command({ id, commandVersion: 23, command: { type: "session.tree.mutate", sessionId: this.owner.sessionId, ticket: response.tree.ticket,
          mutation: { action: "navigate", targetId: this.owner.targetId, summarize: this.#saved.summarize,
            ...(this.#saved.summarize && this.#saved.customInstructions ? { customInstructions: this.#saved.customInstructions } : {}) } } }, this.owner.hostId);
        this.#assert(generation);
        if (result.commandId !== id) throw new Error("The navigation reply belongs to another command.");
        if (!result.ok) {
          if (result.error.code === "TREE_REJECTED" || result.error.code === "TREE_PROTOCOL_UNSUPPORTED") { this.#saved.navigationId = undefined; this.#saved.uncertain = false; this.#save(); }
          throw new Error(result.error.message);
        }
        if (!result.value || !("type" in result.value) || result.value.type !== "session.tree.mutate") throw new Error("The original navigation outcome is unknown.");
        const outcome = parseTreeMutationResult(result.value.result, id);
        if (outcome.cancelled) { this.#saved.navigationId = undefined; this.#saved.uncertain = false; this.#save(); throw new Error("History navigation was cancelled. Your edit was retained."); }
        this.#adopt(outcome);
      } else if (!this.#draft) {
        response = await this.#read(this.#saved.navigationId); this.#assert(generation);
        if (!response.receipt?.result) throw new Error("Inspect the original navigation before resuming this edit.");
        this.#adopt(response.receipt.result);
      }
      const current = await this.#read(); this.#assert(generation);
      const prepared = this.#saved.prepared!, tree = current.tree;
      if (!tree || tree.busyReason || tree.reconciliationRequired || tree.leafId !== prepared.leafId
        || tree.ticket.epoch === prepared.ticket.epoch && tree.ticket.revision !== prepared.ticket.revision
        || tree.ticket.epoch !== prepared.ticket.epoch && tree.recoveredDraft?.commandId !== this.#saved.navigationId)
        throw new Error("The original branch changed or was stopped. Your edited message was retained and was not sent.");
      const envelope: CommandEnvelope = { id: crypto.randomUUID(), commandVersion: 23, command: { type: "session.prompt", sessionId: this.owner.sessionId,
        text: this.#saved.text, treeTicket: tree.ticket } };
      this.#saved.prompt = envelope; this.#saved.uncertain = true; this.#save();
      const result = await this.bridge.command(envelope, this.owner.hostId); this.#assert(generation);
      if (result.commandId !== envelope.id) throw new Error("The edit submission reply belongs to another command.");
      if (!result.ok) {
        if (result.error.code !== "OUTCOME_UNKNOWN") { this.#saved.prompt = undefined; this.#saved.uncertain = false; this.#save(); }
        throw new Error(result.error.message);
      }
      if (!result.admission) throw new Error("The edited message has no native admission receipt. Inspect its original command.");
      this.storage.removeItem(this.#key()); this.#set({ sent: true, uncertain: false });
    } catch (cause) { this.#set({ error: cause instanceof Error ? cause.message : String(cause), uncertain: !!this.#saved.uncertain }); }
    finally { this.#set({ busy: false, prepared: !!this.#saved.prepared, text: this.#saved.text, imageCount: this.#draft?.images.length ?? this.#view.imageCount }); }
  }
}
