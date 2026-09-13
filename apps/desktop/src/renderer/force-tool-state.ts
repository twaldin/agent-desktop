export class ForceToolOperationRefused extends Error {}
/** Structural UI ports. Root adapts the shared force-tool contract and validated
 * owner transport here; this module never validates wire JSON or arms a queue. */
export interface ForceToolOwner { hostId: string; sessionId: string }
export interface ForceToolTicket { epoch: string; revision: number }
export interface ForceToolDirective {
  id: string; toolName: string; commandId?: string;
  phase: "pending-tool" | "tool-in-flight" | "pending-final-response" | "final-response-in-flight";
  requeued: boolean;
}
export interface ForceToolSnapshot extends ForceToolTicket {
  nativeSessionId: string;
  model: { provider: string; id: string; api: string } | null;
  availability: { state: "supported" | "degraded" | "unsupported"; reason: string; thinkingNote?: string };
  tools: Array<{ name: string; available: boolean; reason?: string }>;
  directives: ForceToolDirective[];
  canArm: boolean; canCancel: boolean; busyReason?: string;
}
export interface ForceToolReceipt {
  commandId: string; epoch: string; directiveId?: string; toolName: string;
  arm: "not-armed" | "armed" | "unknown";
  prompt: "not-requested" | "recorded" | "not-recorded" | "unknown";
  promptEntryId?: string; message?: string;
}
export interface ForceToolRead {
  protocolVersion: 1; hostId: string; sessionId: string; value: ForceToolSnapshot | null;
  receipt?: { commandId: string; state: "pending" | "succeeded" | "failed" | "unknown" | "absent"; forceToolReceipt?: ForceToolReceipt };
  unavailable?: string;
}
export interface ForceToolInsertion {
  text: string; expectedDraftText: string;
  guard: { epoch: string; expectedRevision: number; toolName: string };
}
export interface ForceToolRecovery { receipt: ForceToolReceipt; prompt: string }
export interface ForceToolRecoveryRequest {
  text: string; originalReceipt: ForceToolReceipt; ticket: ForceToolTicket; directiveId: string;
}
export interface ForceToolPorts {
  read(owner: ForceToolOwner, commandId?: string): Promise<ForceToolRead>;
  /** Root owns the existing deduplicated command identity, including uncertain replies. */
  cancel(owner: ForceToolOwner, request: { epoch: string; expectedRevision: number; directiveId: string }): Promise<ForceToolSnapshot>;
  /** Root compares expectedDraftText before replacing the ordinary composer draft. */
  insertDraft(owner: ForceToolOwner, insertion: ForceToolInsertion): void;
  /** Existing session.prompt with an atomic forceRecovery guard, never another arm. */
  recoverPrompt(owner: ForceToolOwner, request: ForceToolRecoveryRequest): Promise<void>;
}
export interface ForceToolView {
  connected: boolean; active: boolean; loading: boolean; fresh: boolean;
  snapshot: ForceToolSnapshot | null; unavailable?: string; error?: string; notice?: string;
  selectedTool: string; selectionTicket?: ForceToolTicket;
  prompt: string; sourceDraft: string; latestDraft: string;
  mutation?: "cancel" | "recover";
  uncertain?: "cancel" | "recover";
  recovery?: ForceToolRecovery;
  recoveryResolved?: boolean;
  receipt?: ForceToolRead["receipt"];
}
const message = (error: unknown) => error instanceof Error ? error.message : "The owning host could not complete this operation.";
const ticket = (state: ForceToolTicket): ForceToolTicket => ({ epoch: state.epoch, revision: state.revision });
export const sameForceTicket = (a: ForceToolTicket | undefined, b: ForceToolTicket | undefined) => !!a && !!b && a.epoch === b.epoch && a.revision === b.revision;
export function forceDraftParts(text: string): { toolName?: string; prompt: string } {
  // Presentation only. Native dispatch remains responsible for command parsing,
  // precedence, alias matching and validation.
  const match = /^\/force(?: +|:)([^\s]+)(?: +([\s\S]*))?$/.exec(text);
  return match ? { toolName: match[1], prompt: match[2] ?? "" } : { prompt: text };
}
export function forceToolReason(view: ForceToolView): string | undefined {
  if (!view.connected) return "Reconnect to the owning host before preparing a force request.";
  if (!view.active) return "Open this conversation to refresh its native tools.";
  if (!view.fresh || !view.snapshot) return view.unavailable ?? "Refresh the native tools before continuing.";
  if (view.mutation || view.uncertain) return "Resolve the pending operation before preparing another request.";
  if (!view.recoveryResolved && view.recovery?.receipt.arm === "armed" && view.recovery.receipt.prompt !== "recorded") return "Resolve the previously armed request before preparing another force command.";
  if (view.snapshot.availability.state === "unsupported") return view.snapshot.availability.reason;
  if (!view.snapshot.canArm) return view.snapshot.busyReason ?? "The native session cannot accept a force request yet.";
  if (!view.selectedTool) return "Choose an active tool.";
  const tool = view.snapshot.tools.find(value => value.name === view.selectedTool);
  if (!tool?.available) return tool?.reason ?? "The selected tool is no longer active.";
  if (/\s/.test(tool.name)) return "This tool name cannot be represented by the native /force command.";
  if (!sameForceTicket(view.selectionTicket, view.snapshot)) return "Native tools or model state changed. Review the refreshed selection.";
  if (view.sourceDraft !== view.latestDraft) return "The composer changed. Review its current text before replacing it.";
  return undefined;
}
export function forceRecoveryReason(view: ForceToolView): string | undefined {
  const recovery = view.recovery, state = view.snapshot;
  if (!recovery) return "No incomplete force request is available.";
  if (view.recoveryResolved) return "The previous pending force was removed. Its original prompt is still retained.";
  if (!view.connected || !view.active || !view.fresh || !state) return "Refresh the owning worker before recovering the prompt.";
  if (view.mutation || view.uncertain) return "Check the pending operation before sending again.";
  if (!view.receipt || ["unknown", "absent", "pending"].includes(view.receipt.state)) return "The original command receipt is not settled. Inspect its outcome before another send.";
  const confirmed = view.receipt.forceToolReceipt;
  if (view.receipt.commandId !== recovery.receipt.commandId || !confirmed || confirmed.arm !== "armed" || confirmed.prompt !== "not-recorded"
    || confirmed.epoch !== recovery.receipt.epoch || confirmed.directiveId !== recovery.receipt.directiveId || confirmed.toolName !== recovery.receipt.toolName)
    return "The owning journal does not confirm this remaining prompt. Check the original command outcome.";
  if (recovery.receipt.arm !== "armed" || recovery.receipt.prompt !== "not-recorded") return "The original prompt outcome does not permit another send.";
  if (recovery.receipt.epoch !== state.epoch) return "The owning worker restarted. Its previous pending force is no longer live.";
  if (!recovery.prompt.trim()) return "The original request has no remaining prompt.";
  if (state.availability.state === "unsupported" || !state.canArm) return state.busyReason ?? state.availability.reason;
  const directive = state.directives.find(item => item.id === recovery.receipt.directiveId && item.toolName === recovery.receipt.toolName);
  if (!directive || directive.phase !== "pending-tool") return "The original directive is no longer waiting for its tool request.";
  return undefined;
}
export const forcePhaseLabel: Record<ForceToolDirective["phase"], string> = {
  "pending-tool": "Waiting for next turn", "tool-in-flight": "Tool request in progress",
  "pending-final-response": "Waiting for final response", "final-response-in-flight": "Final response in progress",
};

/** One instance per owning conversation. Reads cannot replace local edits;
 * late reads/mutations cannot cross an offline, hidden or unmounted boundary. */
export class ForceToolState {
  private view: ForceToolView;
  private listeners = new Set<() => void>();
  private generation = 0;
  private reads = 0;
  private acknowledgedRecovery = new Set<string>();
  private reconciliation?: () => Promise<void>;
  constructor(readonly owner: ForceToolOwner, private ports: ForceToolPorts, draftText = "") {
    this.owner = { ...owner };
    const parsed = forceDraftParts(draftText);
    this.view = { connected: false, active: false, fresh: false, loading: false, snapshot: null,
      selectedTool: parsed.toolName ?? "", prompt: parsed.prompt, sourceDraft: draftText, latestDraft: draftText };
  }
  getSnapshot = (): ForceToolView => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setPorts(ports: ForceToolPorts) { this.ports = ports; }
  private update(next: Partial<ForceToolView>) { this.view = { ...this.view, ...next }; for (const listener of this.listeners) listener(); }
  configure(connected: boolean, active: boolean, draftText: string, recovery?: ForceToolRecovery) {
    if (this.view.connected !== connected || this.view.active !== active) {
      this.generation++; this.reads++;
      this.update({ connected, active, fresh: false, loading: false });
    }
    if (this.view.latestDraft !== draftText) this.update({ latestDraft: draftText });
    const nextRecovery = recovery ? structuredClone(recovery) : undefined;
    if (nextRecovery && this.acknowledgedRecovery.has(nextRecovery.receipt.commandId)) nextRecovery.receipt.prompt = "recorded";
    if (JSON.stringify(this.view.recovery) !== JSON.stringify(nextRecovery)) this.update({ recovery: nextRecovery,
      ...(this.view.recovery?.receipt.commandId !== nextRecovery?.receipt.commandId ? { recoveryResolved: false } : {}) });
  }
  async refresh(): Promise<void> {
    if (!this.view.connected || !this.view.active || this.view.mutation) return;
    const generation = this.generation, read = ++this.reads;
    this.update({ loading: true, error: undefined });
    try {
      const response = await this.ports.read(this.owner, this.view.recovery?.receipt.commandId);
      if (generation !== this.generation || read !== this.reads) return;
      if (response.hostId !== this.owner.hostId || response.sessionId !== this.owner.sessionId) throw new Error("The force state belongs to another conversation or host.");
      const changedEpoch = this.view.snapshot && response.value && this.view.snapshot.epoch !== response.value.epoch;
      // The first read can bind an existing draft selection. Later reads require
      // deliberate selection review after revision changes.
      const initial = !this.view.snapshot && !this.view.selectionTicket;
      this.update({ snapshot: response.value ? structuredClone(response.value) : null, fresh: !!response.value,
        receipt: response.receipt, unavailable: response.unavailable, loading: false,
        ...(initial && response.value && this.view.selectedTool ? { selectionTicket: ticket(response.value) } : {}),
        ...(changedEpoch ? { notice: "The owning worker restarted. Previous queue receipts are historical; nothing was rearmed." } : {}) });
    } catch (error) {
      if (generation === this.generation && read === this.reads) this.update({ error: message(error), loading: false, fresh: false });
    }
  }
  select(toolName: string) {
    const state = this.view.snapshot;
    if (!state || !this.view.fresh || !state.tools.some(tool => tool.name === toolName)) return;
    this.update({ selectedTool: toolName, selectionTicket: ticket(state), notice: undefined });
  }
  setPrompt(prompt: string) { this.update({ prompt }); }
  reviewSelection() {
    const state = this.view.snapshot;
    if (!state || !this.view.fresh) return;
    this.update({ selectionTicket: ticket(state), notice: undefined });
  }
  reviewDraft() {
    this.update({ sourceDraft: this.view.latestDraft, prompt: forceDraftParts(this.view.latestDraft).prompt });
  }
  prepare(): boolean {
    const reason = forceToolReason(this.view);
    if (reason) { this.update({ error: reason }); return false; }
    const state = this.view.snapshot!, toolName = this.view.selectedTool;
    const text = `/force ${toolName}${this.view.prompt ? ` ${this.view.prompt}` : ""}`;
    try {
      this.ports.insertDraft(this.owner, { text, expectedDraftText: this.view.latestDraft,
        guard: { epoch: state.epoch, expectedRevision: state.revision, toolName } });
      this.update({ sourceDraft: text, latestDraft: text, error: undefined, notice: "Added to the composer. Send it when ready." });
      return true;
    } catch (error) { this.update({ error: message(error) }); return false; }
  }
  canCancel(directive: ForceToolDirective): boolean {
    return !!(this.view.connected && this.view.active && this.view.fresh && this.view.snapshot?.canCancel && !this.view.mutation && !this.view.uncertain
      && (directive.phase === "pending-tool" || directive.phase === "pending-final-response"));
  }
  async cancel(directiveId: string): Promise<void> {
    const state = this.view.snapshot, directive = state?.directives.find(item => item.id === directiveId);
    if (!state || !directive || !this.canCancel(directive)) return;
    const request = { epoch: state.epoch, expectedRevision: state.revision, directiveId };
    const run = async () => {
      const generation = this.generation;
      this.reads++;
      this.update({ mutation: "cancel", error: undefined, loading: false });
      try {
        const result = await this.ports.cancel(this.owner, structuredClone(request));
        if (generation !== this.generation) { this.update({ uncertain: "cancel" }); return; }
        if (result.epoch !== state.epoch || result.nativeSessionId !== state.nativeSessionId) throw new Error("Cancellation returned another native worker's state.");
        if (result.directives.some(item => item.id === directiveId)) throw new Error("The cancellation receipt still contains the requested sequence.");
        this.reconciliation = undefined;
        this.update({ snapshot: structuredClone(result), fresh: true, uncertain: undefined,
          ...(this.view.recovery?.receipt.directiveId === directiveId ? { recoveryResolved: true } : {}),
          notice: "Removed the pending force sequence. Composer edits were retained." });
      } catch (error) {
        if (error instanceof ForceToolOperationRefused) { this.reconciliation = undefined; this.update({ uncertain: undefined, fresh: false, error: message(error) }); }
        else this.update({ uncertain: "cancel", fresh: false, error: `Cancellation needs reconciliation. ${message(error)}` });
      }
      finally { this.update({ mutation: undefined }); }
    };
    this.reconciliation = run;
    await run();
  }
  async recover(): Promise<void> {
    const reason = forceRecoveryReason(this.view);
    if (reason) { this.update({ error: reason }); return; }
    const recovery = structuredClone(this.view.recovery!), state = this.view.snapshot!;
    const request = { text: recovery.prompt, originalReceipt: recovery.receipt, ticket: ticket(state), directiveId: recovery.receipt.directiveId! };
    const run = async () => {
      this.reads++;
      this.update({ mutation: "recover", error: undefined, loading: false });
      try {
        await this.ports.recoverPrompt(this.owner, structuredClone(request));
        this.acknowledgedRecovery.add(recovery.receipt.commandId);
        this.reconciliation = undefined;
        this.update({ uncertain: undefined, fresh: false,
          recovery: { ...recovery, receipt: { ...recovery.receipt, prompt: "recorded" } },
          notice: "The remaining prompt was accepted. The force sequence was not armed again." });
      } catch (error) {
        if (error instanceof ForceToolOperationRefused) { this.reconciliation = undefined; this.update({ uncertain: undefined, fresh: false, error: message(error) }); }
        else this.update({ uncertain: "recover", fresh: false, error: `Prompt recovery needs reconciliation. ${message(error)}` });
      }
      finally { this.update({ mutation: undefined }); }
    };
    this.reconciliation = run;
    await run();
  }
  /** Root reuses the original command ID for this exact captured request. This
   * checks its receipt; it never constructs a new force/recovery request. */
  async checkPending(): Promise<void> {
    if (!this.view.connected || !this.view.active || this.view.mutation || !this.view.uncertain) return;
    await this.reconciliation?.();
  }
}
