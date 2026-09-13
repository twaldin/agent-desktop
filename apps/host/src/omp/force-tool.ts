import { randomUUID } from "node:crypto";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { ToolChoiceQueueEvent } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { toReasoningEffort } from "@oh-my-pi/pi-coding-agent/thinking";
import { supportsExternalThinking } from "@oh-my-pi/pi-coding-agent/tools";
import type {
  ForceToolCancelResult, ForceToolGuard, ForceToolReceipt, ForceToolRecovery,
  ForceToolState, ForceToolTicket,
} from "../../../../packages/shared/src/force-tool";
import { getNativeForceToolAvailability } from "./force-tool-capability";

export interface NativeForceToolAdmissionPort {
  getState(): ForceToolState;
  captureArm<T>(input: { commandId: string; toolName: string; promptRequested: boolean; guard?: ForceToolGuard }, invokeOriginalNativeHandler: () => T): { result: T; receipt?: ForceToolReceipt };
  cancel(input: { ticket: ForceToolTicket; directiveId: string }): ForceToolCancelResult;
  /** Must be called immediately before ordinary prompt entry under its existing idle admission fence. */
  assertRecovery(input: ForceToolRecovery): void;
}

export interface NativeForceToolControllerOptions {
  /** Actual native construction dialect plus current native env fallback, not a saved preference guess. */
  getDialect(): Dialect | undefined;
  /** Original builtin must still own dispatch. Return a reason if replaced/unavailable. */
  getOwnershipReason(): string | undefined;
  /** Stable actual registry/session-owner revision; never admission depth or presentation reason. */
  getOwnershipRevision(): string | number;
  /** Existing worker maintenance/startup/queue gate, excluding this admission's own lease. */
  getBusyReason(): string | undefined;
}

export class NativeForceToolError extends Error {
  readonly code: "conflict" | "unavailable" | "busy";
  forceToolReceipt?: ForceToolReceipt;
  constructor(code: NativeForceToolError["code"], message: string, options?: ErrorOptions) {
    super(message, options); this.name = "NativeForceToolError"; this.code = code;
  }
}

/** Only projects live native state. The correlation map cannot execute or reconstruct queue work. */
export class NativeForceToolController implements NativeForceToolAdmissionPort {
  readonly epoch = randomUUID();
  #revision = 0;
  #policyFingerprint: string | undefined;
  #commandIds = new Map<string, string>();
  #toolIdentities = new WeakMap<object, number>();
  #nextToolIdentity = 0;
  #captureDepth = 0;
  #captureGeneration = 0;
  #disposed = false;
  #unsubscribe: () => void;

  constructor(readonly session: AgentSession, readonly options: NativeForceToolControllerOptions) {
    this.#unsubscribe = session.toolChoiceQueue.subscribe(() => { this.#revision++; });
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe();
    this.#commandIds.clear();
  }

  #toolIdentity(value: object): number {
    let id = this.#toolIdentities.get(value);
    if (id === undefined) { id = ++this.#nextToolIdentity; this.#toolIdentities.set(value, id); }
    return id;
  }

  getState(): ForceToolState {
    const session = this.session, model = session.model;
    const dialect = this.options.getDialect();
    const ownershipReason = this.#disposed || session.isDisposed ? "Native worker owner is unavailable." : this.options.getOwnershipReason();
    const busyReason = this.options.getBusyReason()
      ?? (session.isAborting ? "Native abort is settling." : session.isCompacting ? "Native compaction is running."
        : session.isRetrying ? "Native retry is pending." : session.isStreaming ? "Native turn is running."
          : session.toolChoiceQueue.hasInFlight ? "A native tool-choice request is in flight." : undefined);
    const activeNames = session.getActiveToolNames();
    const externalThinking = !!model && session.settings.get("externalThinking")
      && session.agent.state.tools.some(tool => tool.name === "think") && supportsExternalThinking(model);
    const policy = { model, dialect, reasoningActive: toReasoningEffort(session.thinkingLevel) !== undefined && !externalThinking };
    const availability = ownershipReason ? { state: "unsupported" as const, reason: ownershipReason } : getNativeForceToolAvailability(policy);
    // Reads do not touch native queue state. Changes of the live admission authority
    // (including same-ID compat/schema changes) invalidate tickets independently of queue mutations.
    // Busy presentation is intentionally excluded: an external read of this
    // command's own idle reservation must not invalidate its pre-admission ticket.
    const fingerprint = JSON.stringify([session.sessionId, model && {
      provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
      transport: model.transport, compat: model.compat, thinking: model.thinking,
      reasoning: model.reasoning, supportsTools: model.supportsTools,
      supportsComputerUse: model.supportsComputerUse, applyPatchToolType: model.applyPatchToolType,
    }, dialect, session.thinkingLevel, externalThinking,
      activeNames, session.agent.state.tools.map(tool => ({
        identity: this.#toolIdentity(tool), name: tool.name,
        // ArkType/Zod schemas may be callable or cyclic. Never run their toJSON,
        // validators or transforms merely to read native force state.
        parameters: this.#toolIdentity(tool.parameters),
        customFormat: tool.customFormat, customWireName: tool.customWireName, native: tool.native,
      })), this.options.getOwnershipRevision(), this.#disposed, session.isDisposed]);
    if (this.#policyFingerprint !== undefined && this.#policyFingerprint !== fingerprint) this.#revision++;
    this.#policyFingerprint = fingerprint;
    const snapshot = session.toolChoiceQueue.snapshot();
    const directives: ForceToolState["directives"] = [];
    const liveIds = new Set(snapshot.directives.map(directive => directive.id));
    for (const id of this.#commandIds.keys()) if (!liveIds.has(id)) this.#commandIds.delete(id);
    for (const directive of snapshot.directives) {
      const first = directive.sequence?.[0];
      if (directive.label !== "user-force" || directive.sequence?.length !== 2 || directive.sequence[1] !== "none" || !first || typeof first === "string") continue;
      const toolName = first.type === "computer" ? "computer" : "function" in first ? first.function.name : first.name;
      const index = directive.inFlightIndex ?? directive.nextIndex;
      directives.push({ id: directive.id, toolName,
        ...(this.#commandIds.has(directive.id) ? { commandId: this.#commandIds.get(directive.id)! } : {}),
        phase: index === 0 ? (directive.inFlightIndex === undefined ? "pending-tool" : "tool-in-flight")
          : (directive.inFlightIndex === undefined ? "pending-final-response" : "final-response-in-flight"),
        requeued: directive.requeued });
    }
    const canArm = !busyReason && availability.state !== "unsupported" && activeNames.length > 0;
    return { epoch: this.epoch, revision: this.#revision, nativeSessionId: session.sessionId,
      model: model ? { provider: model.provider, id: model.id, api: model.api } : null, availability,
      tools: activeNames.map(name => ({ name, available: availability.state !== "unsupported",
        ...(availability.state !== "supported" ? { reason: availability.reason }
          : !session.agent.state.tools.some(tool => tool.name === name) ? { reason: "Active native registry name is absent from the current offered tools; native dispatch may drop it." } : {}) })),
      directives, canArm, canCancel: !busyReason && !ownershipReason
        && directives.some(directive => directive.phase === "pending-tool" || directive.phase === "pending-final-response"),
      ...(busyReason ? { busyReason } : {}) };
  }

  #assertTicket(state: ForceToolState, ticket: ForceToolTicket): void {
    if (ticket.epoch !== state.epoch || ticket.revision !== state.revision)
      throw new NativeForceToolError("conflict", "Native force ticket is stale; refresh the current worker state.");
  }

  #assertArm(state: ForceToolState, toolName: string): void {
    if (state.busyReason) throw new NativeForceToolError("busy", state.busyReason);
    if (state.availability.state === "unsupported") throw new NativeForceToolError("unavailable", state.availability.reason);
    if (!state.tools.some(tool => tool.name === toolName))
      throw new NativeForceToolError("unavailable", `Tool "${toolName}" is not currently active.`);
  }

  captureArm<T>(input: { commandId: string; toolName: string; promptRequested: boolean; guard?: ForceToolGuard }, invokeOriginalNativeHandler: () => T): { result: T; receipt?: ForceToolReceipt } {
    const state = this.getState();
    const notArmed: ForceToolReceipt = { commandId: input.commandId, epoch: this.epoch, toolName: input.toolName,
      arm: "not-armed", prompt: input.promptRequested ? "not-recorded" : "not-requested" };
    try {
      if (input.guard) {
        this.#assertTicket(state, { epoch: input.guard.epoch, revision: input.guard.expectedRevision });
        if (input.guard.toolName !== input.toolName) throw new NativeForceToolError("conflict", "Native parsed tool differs from the selected tool.");
      }
      // Empty arguments belong to the original usage handler; never clone its parser.
      if (input.toolName) this.#assertArm(state, input.toolName);
    } catch (error) {
      if (error instanceof NativeForceToolError) error.forceToolReceipt = notArmed;
      throw error;
    }
    const nested = this.#captureDepth++ > 0;
    const generation = ++this.#captureGeneration;
    const events: ToolChoiceQueueEvent[] = [];
    const admissions: Array<{ id: string; toolName: string }> = [];
    const stopQueue = this.session.toolChoiceQueue.subscribe(event => { events.push(event); });
    const stopSetter = this.session.subscribeForcedToolChoice((id, toolName) => { admissions.push({ id, toolName }); });
    let result!: T, thrown: unknown, didThrow = false;
    try { result = invokeOriginalNativeHandler(); }
    catch (error) { thrown = error; didThrow = true; }
    finally { stopSetter(); stopQueue(); this.#captureDepth--; }
    let receipt: ForceToolReceipt = notArmed;
    // The original no-argument usage branch never invokes the setter. Its
    // output callback's unrelated work cannot be assigned an invented tool name.
    if (input.toolName && (events.length || admissions.length)) {
      const admission = admissions[0], event = events[0];
      const unambiguous = !nested && generation === this.#captureGeneration && events.length === 1 && admissions.length === 1
        && event?.type === "push" && event.id === admission?.id && admission.toolName === input.toolName;
      receipt = { commandId: input.commandId, epoch: this.epoch, toolName: input.toolName,
        arm: unambiguous ? "armed" : "unknown", prompt: input.promptRequested ? "not-recorded" : "not-requested",
        ...(unambiguous ? { directiveId: admission!.id } : { message: "Native activity during the handler was ambiguous; do not replay or undo queued work." }) };
      if (unambiguous) this.#commandIds.set(admission!.id, input.commandId);
    }
    if (didThrow) {
      // Preserve the original error as cause even for frozen errors or primitive throws.
      const error = new NativeForceToolError("unavailable", thrown instanceof Error ? thrown.message : String(thrown), { cause: thrown });
      error.forceToolReceipt = receipt;
      throw error;
    }
    // Never await/wrap the promise. Output rejection does not erase synchronous arming evidence.
    return { result, receipt };
  }

  cancel(input: { ticket: ForceToolTicket; directiveId: string }): ForceToolCancelResult {
    const state = this.getState();
    this.#assertTicket(state, input.ticket);
    if (state.busyReason) throw new NativeForceToolError("busy", state.busyReason);
    if (this.#disposed || this.session.isDisposed || this.options.getOwnershipReason()) throw new NativeForceToolError("unavailable", "Native force owner is unavailable.");
    if (!state.directives.some(directive => directive.id === input.directiveId
      && (directive.phase === "pending-tool" || directive.phase === "pending-final-response"))
      || !this.session.toolChoiceQueue.removeSequence(input.directiveId))
      throw new NativeForceToolError("conflict", "The exact idle native directive is no longer pending.");
    return { state: this.getState(), cancelledDirectiveId: input.directiveId };
  }

  assertRecovery(input: ForceToolRecovery): void {
    const state = this.getState();
    this.#assertTicket(state, { epoch: input.epoch, revision: input.expectedRevision });
    const directive = state.directives.find(candidate => candidate.id === input.directiveId);
    if (!directive || (directive.phase !== "pending-tool" && directive.phase !== "pending-final-response"))
      throw new NativeForceToolError("conflict", "The original native directive is no longer idle and pending; recovery cannot recreate it.");
    this.#assertArm(state, directive.toolName);
  }
}
