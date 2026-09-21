import { readNativeImage, type PreparedPromptImage } from "./images";
import { createHash, randomUUID } from "node:crypto";
import type { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSessionTree, parseTreeCommandId, parseTreeDraft, parseTreeMutationRequest, parseTreeTicket,
  type SessionTree, type TreeTicket, type TreeDraft, type TreeEntry, type TreeMutationRequest, type TreeMutationResult } from "../../../../packages/shared/src/session-tree";
import type { OmpInteractionBridge } from "./interactions";

export const TREE_NAVIGATION_ENTRY = "agent-desktop.tree-navigation";
export class NativeTreeError extends Error {
  constructor(readonly code: "TREE_REJECTED" | "OUTCOME_UNKNOWN", message: string, options?: ErrorOptions) { super(message, options); this.name = "NativeTreeError"; }
}
const rejected = (message: string) => new NativeTreeError("TREE_REJECTED", message);
export interface NativeSessionTreePorts {
  assertOwner(): void;
  getBusyReason(): string | undefined;
  prepare(): Promise<void>;
  ui?: OmpInteractionBridge;
  /** Synchronously replace the old display mirror and publish a history-change event before native continuation. */
  onChanged(): void;
}
export function nativeTreeCommandAvailable(session: AgentSession): boolean {
  return lookupBuiltinSlashCommand("tree")?.name === "tree" && !session.extensionRunner?.getCommand("tree")
    && !session.customCommands.some(item => item.command.name === "tree");
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (part.type === "toolCall" && typeof part.name === "string") return `[${part.name}]`;
    if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
    return "";
  }).filter(Boolean).join("\n");
}
/** One live native owner. Native history is the only branch store; command
 * receipts remain in the host journal. Metadata markers make leaf-only moves
 * durable and retain native re-edit content across a lost command response. */
export class NativeSessionTree {
  readonly #identity: { id: string; file: string };
  readonly #epoch = randomUUID();
  #active?: Promise<TreeMutationResult>;
  #abort?: AbortController;
  #unknown = false;
  #interruptGeneration = 0;
  constructor(private readonly session: AgentSession, private readonly manager: SessionManager, private readonly ports: NativeSessionTreePorts) {
    if (!session.sessionFile || session.sessionManager !== manager) throw rejected("A persisted native history owner is required.");
    this.#identity = { id: manager.getSessionId(), file: session.sessionFile }; this.#assert();
  }
  assertTicket(raw: TreeTicket): void {
    this.#assert(); const ticket = parseTreeTicket(raw);
    if (ticket.nativeSessionId !== this.#identity.id || ticket.epoch !== this.#epoch || ticket.revision !== this.#revision())
      throw rejected("The original history branch changed. The edited message was not submitted.");
    if (this.#unknown) throw new NativeTreeError("OUTCOME_UNKNOWN", "The original history needs reconciliation.");
  }
  editImages(ticket: TreeTicket): PreparedPromptImage[] {
    this.assertTicket(ticket);
    const recovered = this.read().recoveredDraft;
    if (!recovered) throw rejected("This history ticket has no native edit payload.");
    return recovered.draft.images.map((image, index) => {
      const value = readNativeImage(image);
      return { data: value.data, attachment: { id: `${recovered.commandId}:${index}`, hostId: this.#identity.id, kind: "image", sha256: value.sha256,
        bytes: value.bytes, mimeType: value.mimeType as PreparedPromptImage["attachment"]["mimeType"], name: `Native history image ${index + 1}` } };
    });
  }
  consumeEdit(ticket: TreeTicket): () => void {
    this.assertTicket(ticket);
    if (!this.read().recoveredDraft) throw rejected("The original native edit payload is unavailable.");
    this.#interruptGeneration++;
    const consumed = { ...ticket, revision: this.#revision() };
    return () => this.assertTicket(consumed);
  }
  get busy(): boolean { return !!this.#active || this.#unknown; }
  get reconciliationRequired(): boolean { return this.#unknown; }
  abort(): void { this.#interruptGeneration++; this.#abort?.abort(); this.session.abortBranchSummary(); }
  async settle(): Promise<void> { await this.#active?.catch(() => {}); }
  #assert(): void {
    this.ports.assertOwner();
    if (this.session.isDisposed || this.session.sessionFile !== this.#identity.file
      || this.manager.getSessionId() !== this.#identity.id || this.manager.getSessionFile() !== this.#identity.file)
      throw rejected("The original native history owner has retired.");
  }
  #historyRevision(): string {
    return createHash("sha256").update(JSON.stringify([this.manager.getLeafId(), this.manager.getEntries()])).digest("hex");
  }
  #revision(): string { return createHash("sha256").update(this.#historyRevision()).update(JSON.stringify([this.session.sessionId, this.#interruptGeneration])).digest("hex"); }
  read(includeOwnBusy = true): SessionTree {
    this.#assert();
    const active = new Set(this.manager.getBranch().map(entry => entry.id));
    const labels = new Map<string, string>();
    const pending = [...this.manager.getTree()];
    while (pending.length) { const node = pending.pop()!; if (node.label !== undefined) labels.set(node.entry.id, node.label); pending.push(...node.children); }
    const entries: TreeEntry[] = this.manager.getEntries().map(entry => {
      let kind: string = entry.type, text = "", editable = false, imageCount = 0;
      if (entry.type === "message") {
        kind = entry.message.role;
        const content = "content" in entry.message ? entry.message.content : "output" in entry.message ? entry.message.output : "";
        text = contentText(content);
        editable = entry.message.role === "user";
        imageCount = Array.isArray(content) ? content.filter(part => part.type === "image").length : 0;
        if (entry.message.role === "toolResult") kind = `tool: ${entry.message.toolName}`;
      } else if (entry.type === "custom_message") {
        kind = `message: ${entry.customType}`; text = contentText(entry.content); editable = entry.customType !== SKILL_PROMPT_MESSAGE_TYPE;
      } else if (entry.type === "branch_summary" || entry.type === "compaction") text = entry.summary;
      else if (entry.type === "custom") { kind = `metadata: ${entry.customType}`; text = entry.customType === TREE_NAVIGATION_ENTRY ? "History navigation" : ""; }
      const label = labels.get(entry.id);
      return { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, kind, text,
        ...(label === undefined ? {} : { label }), active: active.has(entry.id), editable, imageCount };
    });
    let recoveredDraft: SessionTree["recoveredDraft"];
    for (const entry of this.manager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "user") recoveredDraft = undefined;
      if (entry.type === "custom" && entry.customType === TREE_NAVIGATION_ENTRY) {
        const data = entry.data as { commandId?: unknown; targetId?: unknown; draft?: unknown } | undefined;
        recoveredDraft = undefined;
        if (data?.draft !== undefined) recoveredDraft = { commandId: parseTreeCommandId(data.commandId), targetId: String(data.targetId), draft: parseTreeDraft(data.draft) };
      }
    }
    const busyReason = this.ports.getBusyReason() ?? (includeOwnBusy && this.busy ? "A history change is still settling." : undefined);
    return parseSessionTree({ ticket: { nativeSessionId: this.#identity.id, epoch: this.#epoch, revision: this.#revision() },
      leafId: this.manager.getLeafId(), entries, summariesEnabled: this.session.settings.get("branchSummary.enabled"),
      nativeCommandAvailable: nativeTreeCommandAvailable(this.session), reconciliationRequired: this.#unknown,
      ...(busyReason ? { busyReason } : {}), ...(recoveredDraft ? { recoveredDraft } : {}) });
  }
  mutate(commandId: string, raw: TreeMutationRequest): Promise<TreeMutationResult> {
    try {
      parseTreeCommandId(commandId); const request = parseTreeMutationRequest(raw); this.#assert();
      if (this.#unknown) throw new NativeTreeError("OUTCOME_UNKNOWN", "The original history change needs reconciliation; it was not replayed.");
      const current = this.read();
      if (current.busyReason) throw rejected(current.busyReason);
      if (JSON.stringify(request.ticket) !== JSON.stringify(current.ticket)) throw rejected("The native history changed. Refresh before navigating.");
      if (!this.manager.getEntry(request.mutation.targetId)) throw rejected("The selected history entry no longer exists.");
      const abort = this.#abort = new AbortController();
      const historyRevision = this.#historyRevision();
      const operation = Promise.resolve().then(() => this.#run(commandId, request, current, abort, historyRevision));
      this.#active = operation;
      void operation.finally(() => { if (this.#active === operation) { this.#active = undefined; this.#abort = undefined; } }).catch(() => {});
      return operation;
    } catch (error) { return Promise.reject(error instanceof NativeTreeError ? error : rejected(error instanceof Error ? error.message : String(error))); }
  }
  async #run(commandId: string, request: TreeMutationRequest, before: SessionTree, abort: AbortController, historyRevision: string): Promise<TreeMutationResult> {
    const assertCurrent = () => {
      this.#assert();
      if (abort.signal.aborted) throw rejected("The history change was stopped before navigation.");
      if (this.#revision() !== before.ticket.revision) throw rejected("Native history changed during navigation preparation.");
    };
    const unchanged = () => this.#historyRevision() === historyRevision;
    try {
      await this.ports.prepare(); assertCurrent();
      const mutation = request.mutation;
      if (mutation.action === "label") {
        this.manager.appendLabelChange(mutation.targetId, mutation.label ?? undefined);
        await this.manager.flush(); this.#assert();
        this.ports.onChanged();
        return { commandId, state: this.read(false), cancelled: false };
      }
      // Validate returnable user images before any native navigation so the UI
      // never commits a history change whose draft cannot cross the transport.
      const entry = this.manager.getEntry(mutation.targetId)!;
      if (entry.type === "message" && entry.message.role === "user") {
        parseTreeDraft({ text: contentText(entry.message.content), images: Array.isArray(entry.message.content) ? entry.message.content.filter(part => part.type === "image") : [] });
      }
      const options = { summarize: mutation.summarize, customInstructions: mutation.customInstructions, allowAskReopen: true, assertCurrent };
      let result = await this.session.navigateTree(mutation.targetId, options);
      if (result.reopenAsk) {
        assertCurrent();
        const ui = this.ports.ui;
        if (!ui) throw rejected("The native question UI is unavailable. History was retained.");
        const ask = new AskTool({ cwd: this.manager.getCwd(), hasUI: true, settings: this.session.settings,
          getSessionFile: () => this.session.sessionFile ?? null, getSessionSpawns: () => null,
          getPlanModeState: () => this.session.getPlanModeState() });
        let answer;
        try { answer = await ui.runWithSignal(abort.signal, () => ask.execute("tree-reanswer", { questions: result.reopenAsk!.questions }, abort.signal, undefined, this.session.buildAskReanswerContext(ui))); }
        catch (error) { if (!(error instanceof ToolAbortError) && !abort.signal.aborted) throw error; }
        if (!answer || answer.details?.chatRedirect) {
          if (answer?.details?.chatRedirect) throw rejected("Chat about this is unavailable when re-answering history. Pick an option or enter a custom answer.");
          if (!unchanged()) throw new Error("History changed while the native question was cancelled.");
          this.#assert(); return { commandId, state: this.read(false), cancelled: true };
        }
        assertCurrent();
        result = await this.session.navigateTree(mutation.targetId, { ...options, reanswerAskResult: answer });
      }
      this.#assert();
      if (result.cancelled) {
        if (!unchanged()) throw new Error("A cancelled native hook changed history.");
        return { commandId, state: this.read(false), cancelled: true };
      }
      let draft: TreeDraft | undefined;
      if (result.editorText !== undefined || result.editorImages?.length) draft = parseTreeDraft({ text: result.editorText ?? "", images: result.editorImages ?? [] });
      // A plain native move changes only memory. This metadata child preserves
      // the selected path on reopen without deleting or replacing any entry.
      if (!unchanged() || draft || result.askReanswerCommitted) {
        this.manager.appendCustomEntry(TREE_NAVIGATION_ENTRY, { commandId, targetId: mutation.targetId, ...(draft ? { draft } : {}) });
        await this.manager.flush(); this.#assert();
      }
      const state = this.read(false);
      this.ports.onChanged();
      if (result.askReanswerCommitted && !abort.signal.aborted) this.session.resumeAfterAskReanswer();
      return { commandId, state, cancelled: false, ...(draft ? { draft } : {}), ...(result.askReanswerCommitted ? { askReanswerCommitted: true } : {}) };
    } catch (cause) {
      if (!unchanged()) {
        this.#unknown = true; this.ports.onChanged();
        throw new NativeTreeError("OUTCOME_UNKNOWN", "Native history may have changed, but its outcome could not be confirmed. Inspect the original history; do not replay this command.", { cause });
      }
      throw cause instanceof NativeTreeError ? cause : new NativeTreeError("TREE_REJECTED", cause instanceof Error ? cause.message : String(cause), { cause });
    }
  }
}
