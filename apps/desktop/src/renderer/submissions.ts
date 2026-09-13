import { ForceToolSubmissions, remainingForcePrompt, type NativeForceSubmission } from "./force-tool-submissions";
import { parseForceToolGuard, parseForceToolReceipt, parseForceToolJournalReceipt, type ForceToolJournalReceipt, type ForceToolReceipt } from "../../../../packages/shared/src/protocol";
import type { ForceToolRecoveryRequest } from "./force-tool-state";
import { hasRemoteExecution, sameNewChatExecution } from "../../../../packages/shared/src/new-chat";
import { sameEnvironmentSelection } from "../../../../packages/shared/src/environment-selection";
import { parseDraftBrowserContinuation, type CommandEnvelope, type CommandResult, type Draft, type DraftBrowserContinuation, type FollowUpDelivery, type QueuedSubmissionReceipt } from "../../../../packages/shared/src/protocol";
import { parseQueuedSubmissionReceipt } from "../../../../packages/shared/src/queued-submissions";
import { sameImageAttachments } from "../../../../packages/shared/src/attachments";
import type { LocalEnvironmentPreparationPublic } from "../../../../packages/shared/src/environment-preparations";
import { detachedAnswerDraft, parseDetachedQuestionAnswers, type DetachedQuestionAnswer } from "../../../../packages/shared/src/detached-questions";
import { hasRepeatedWholeFileSources } from "../../../../packages/shared/src/whole-file";
import { captureDraft, sameDraftContent, type DraftCache } from "./drafts";

export interface PendingSubmission {
  draft: Draft;
  sessionId?: string;
  mode: "prompt" | "steer" | "question";
  question?: { questionId: string; questionEntryId: string; answers: DetachedQuestionAnswer[] };
  create?: CommandEnvelope;
  preparation?: LocalEnvironmentPreparationPublic;
  resume?: CommandEnvelope;
  send?: CommandEnvelope;
  uncertain: boolean;
  force?: NativeForceSubmission;
  forceToolReceipt?: ForceToolReceipt;
}
export interface PendingQueuedSubmission {
  draft: Draft;
  sessionId: string;
  delivery: FollowUpDelivery;
  send: CommandEnvelope & { command: Extract<CommandEnvelope["command"], { type: "session.follow-up" }> };
  receipt?: QueuedSubmissionReceipt;
  uncertain: boolean;
}
export class EnvironmentPreparationPause extends Error {
  readonly code = "ENVIRONMENT_PREPARATION_PAUSED" as const;
  constructor(readonly preparation: LocalEnvironmentPreparationPublic) {
    super("Environment preparation needs an explicit action before this captured prompt can continue.");
    this.name = "EnvironmentPreparationPause";
  }
}
const commandVersion = (draft: Draft): 4 | 5 | 6 | 7 | 8 | 9 | 12 | undefined => hasRemoteExecution(draft.execution) ? 12 : hasRepeatedWholeFileSources(draft.wholeFileAttachments ?? []) ? 9 : draft.wholeFileAttachments?.some(file=>file.textOffset!==undefined) ? 8 : draft.wholeFileAttachments !== undefined ? 7 : draft.selectedTextAttachments !== undefined ? 6 : draft.environment !== undefined ? 5 : draft.execution !== undefined ? 4 : undefined;
const sameDraftReference = (value: { id: string; revision: number } | undefined, draft: Draft, required: boolean) => required
  ? value?.id === draft.id && value.revision === draft.revision
  : value === undefined;
/** Persist envelopes before delivery so an explicit retry uses the original command identity. */
export class SubmissionController {
  private pending: Record<string, PendingSubmission> = {};
  private queued: Record<string, PendingQueuedSubmission> = {};
  private flights = new Map<string, Promise<unknown>>();
  private listeners = new Set<() => void>();
  readonly cacheKey: string;
  readonly queuedCacheKey: string;
  cacheWarning: string | undefined;
  readonly forceTools: ForceToolSubmissions;
  constructor(private command: (envelope: CommandEnvelope) => Promise<CommandResult>, private hostId: string, private cache?: DraftCache, private resolveNativeForce?: (sessionId: string, text: string) => Promise<boolean>) {
    this.forceTools = new ForceToolSubmissions(command, hostId, cache);
    this.cacheKey = `agent-desktop:submissions:v1:${hostId}`;
    this.queuedCacheKey = `agent-desktop:queued-submissions:v1:${hostId}`;
    try {
      const cached = JSON.parse(cache?.read(this.cacheKey) ?? "{}");
      for (const [id, value] of Object.entries(cached)) {
        const item = value as PendingSubmission;
        if (item?.draft?.id === id && typeof item.draft.text === "string" && ["prompt", "steer", "question"].includes(item.mode) && (!item.create || item.create.command.type === "session.create") && (!item.resume || item.resume.command.type === "session.environment.resume") && (!item.send || ["session.prompt", "session.steer", "session.question.answer"].includes(item.send.command.type))) {
          const captured = captureDraft(item.draft, hostId);
          if (item.create?.command.type === 'session.create' && (item.create.command.projectId !== captured.projectId || item.create.command.cwd !== undefined)) throw new Error("Pending creation belongs to a different project.");
          if (item.create?.command.type === 'session.create' && (item.create.command.model?.id !== captured.model?.id
            || item.create.command.model?.provider !== captured.model?.provider || item.create.command.approvalMode !== captured.approvalMode)) throw new Error('Pending creation differs from its captured model or permissions.');
          if (item.send && 'sessionId' in item.send.command && item.send.command.sessionId !== item.sessionId) throw new Error("Pending input belongs to a different session.");
          if (item.force) {
            if (item.force.nativeForce !== true || item.mode !== "prompt") throw new Error("Invalid native force submission.");
            item.force = { nativeForce: true, ...(item.force.guard ? { guard: parseForceToolGuard(item.force.guard) } : {}) };
          }
          if (item.forceToolReceipt) {
            if (!item.force || !item.send) throw new Error("Force receipt has no original command.");
            item.forceToolReceipt = parseForceToolReceipt(item.forceToolReceipt, item.send.id);
          }
          const expectedVersion = item.force ? 18 : commandVersion(captured);
          if (item.mode !== "question" && item.send && item.send.commandVersion !== expectedVersion) throw new Error("Pending input requires its exact original command protocol.");
          if (item.create?.command.type === "session.create") {
            const continuation=item.create.command.browserContinuation===undefined?undefined:parseDraftBrowserContinuation(item.create.command.browserContinuation);
            const createVersion=continuation?15:commandVersion(captured);
            if(item.create.commandVersion!==createVersion||continuation&&item.create.command.draft?.id!==captured.id) throw new Error("Pending browser continuation requires its exact original command protocol.");
          }
          if (item.create?.command.type === 'session.create' && !sameNewChatExecution(
            item.create.command.worktree ? { type: 'worktree', startingState: item.create.command.worktree } : captured.execution === undefined ? undefined : { type: 'local' }, captured.execution)) throw new Error("Pending worktree creation differs from its captured draft.");
          if (item.create?.command.type === "session.create") {
            const worktree = captured.execution?.type === "worktree";
            if (!sameEnvironmentSelection(item.create.command.environment, worktree ? captured.environment : undefined)
              || !sameDraftReference(item.create.command.draft, captured,
                (worktree && captured.environment !== undefined) || item.create.command.browserContinuation !== undefined)) {
              throw new Error("Pending environment creation differs from its captured draft.");
            }
          }
          if (item.preparation) {
            if (item.mode !== "prompt" || !item.create || item.create.command.type !== "session.create") throw new Error("An environment preparation requires its original creation command.");
            item.preparation = this.validatePreparation(item, item.preparation);
          }
          if (item.resume) {
            if (!item.preparation || !this.validResumeEnvelope(item.resume, item.preparation, captured)) throw new Error("Pending environment resume differs from its captured preparation.");
          }
          if (item.send && (item.send.command.type === "session.prompt" || item.send.command.type === "session.steer")) {
            const command = item.send.command;
            if (command.type === "session.prompt" && (command.forceRecovery !== undefined
              || JSON.stringify(command.forceTool) !== JSON.stringify(item.force?.guard))) throw new Error("Pending force guard differs from its captured draft.");
            if (!sameDraftContent(captured, captureDraft({ ...captured, attachments: command.attachments, selectedTextAttachments: command.selectedTextAttachments, wholeFileAttachments: command.wholeFileAttachments }, hostId))
              || command.text !== captured.text || command.draft?.id !== captured.id || command.draft.revision !== captured.revision) throw new Error("Pending attachment metadata differs from its exact command.");
          }
          if (item.mode === "question") {
            if (!item.sessionId || item.create || !item.question) throw new Error("Invalid pending detached question submission.");
            const answers = parseDetachedQuestionAnswers(item.question.answers);
            if (captured.text !== detachedAnswerDraft(answers) || captured.attachments?.length || captured.selectedTextAttachments?.length || captured.wholeFileAttachments?.length) throw new Error("Pending detached answers differ from their saved draft.");
            if (item.send) {
              if (commandVersion(captured) !== item.send.commandVersion) throw new Error("Pending selected-text draft requires its original protocol.");
              if (item.send.command.type !== "session.question.answer") throw new Error("Invalid pending detached question command.");
              const command = item.send.command;
              if (command.sessionId !== item.sessionId || command.questionId !== item.question.questionId || command.questionEntryId !== item.question.questionEntryId
                || command.draft.id !== captured.id || command.draft.revision !== captured.revision || detachedAnswerDraft(command.answers) !== captured.text) throw new Error("Pending detached answers differ from their exact command.");
            }
            item.question = { ...item.question, answers };
          }
          this.pending[id] = { ...structuredClone(item), draft: captured,
            uncertain: item.forceToolReceipt?.arm === "not-armed" ? false : Boolean(item.resume || item.send || item.create && !item.preparation) };
        }
      }
    } catch { this.cacheWarning = "Pending submission storage could not be read. Check conversation history before resending an earlier prompt."; }
    try {
      const cached = JSON.parse(cache?.read(this.queuedCacheKey) ?? "{}");
      for (const [id, value] of Object.entries(cached)) {
        const item = value as PendingQueuedSubmission;
        if (!item || item.send?.id !== id || ![13, 17].includes(item.send.commandVersion ?? 0) || item.send.command.type !== "session.follow-up"
          || item.send.command.sessionId !== item.sessionId || item.send.command.delivery !== item.delivery
          || item.send.command.draft.id !== item.draft?.id || item.send.command.draft.revision !== item.draft.revision
          || item.send.command.text !== item.draft.text
          || !sameImageAttachments(item.send.command.attachments ?? [], item.draft.attachments ?? [])
          || item.send.command.attachments !== undefined && item.send.commandVersion !== 17) throw new Error("Invalid queued submission cache");
        const receipt = item.receipt === undefined ? undefined : parseQueuedSubmissionReceipt(item.receipt);
        if (receipt && (receipt.commandId !== id || receipt.hostId !== hostId || receipt.sessionId !== item.sessionId || receipt.delivery !== item.delivery))
          throw new Error("Queued submission receipt owner changed");
        this.queued[id] = { ...structuredClone(item), draft: captureDraft(item.draft, hostId), receipt, uncertain: Boolean(item.uncertain) };
      }
    } catch { this.cacheWarning = "Queued submission storage could not be read. Inspect the conversation before resending an active-turn message."; }
  }
  get(id: string) { return this.pending[id] ? structuredClone(this.pending[id]) : undefined; }
  entries() { return Object.values(this.pending).map(item => structuredClone(item)); }
  forceRecovery(sessionId: string) {
    const item = Object.values(this.pending).find(value => value.sessionId === sessionId && value.forceToolReceipt
      && value.forceToolReceipt.arm !== "not-armed" && value.forceToolReceipt.prompt !== "recorded" && value.forceToolReceipt.prompt !== "not-requested");
    if (!item?.forceToolReceipt) return undefined;
    try { return { receipt: structuredClone(item.forceToolReceipt), prompt: remainingForcePrompt(item.draft.text, item.forceToolReceipt) }; }
    catch { return { receipt: structuredClone(item.forceToolReceipt), prompt: "" }; }
  }
  async checkForceOperation(sessionId: string, id: string) {
    try {
      const receipt = await this.forceTools.check(sessionId, id);
      const item = Object.values(this.pending).find(value => value.sessionId === sessionId && value.forceToolReceipt?.epoch === receipt.epoch
        && value.forceToolReceipt.directiveId === receipt.directiveId);
      if (item) {
        const settled = { draft: structuredClone(item.draft), originalCommandId: item.forceToolReceipt!.commandId };
        delete this.pending[item.draft.id]; this.save(); return settled;
      }
    } finally { for (const listener of this.listeners) listener(); }
  }
  observeForceReceipt(sessionId: string, value: ForceToolJournalReceipt | undefined) {
    if (!value) return;
    const journal = parseForceToolJournalReceipt(value, value.commandId);
    const item = Object.values(this.pending).find(entry => entry.sessionId === sessionId && entry.send?.id === journal.commandId && entry.force);
    if (!item) return;
    const receipt = journal.forceToolReceipt;
    if (journal.state === "succeeded" && receipt && ["recorded", "not-requested"].includes(receipt.prompt)
      || journal.state === "failed" && receipt?.arm === "not-armed") {
      delete this.pending[item.draft.id]; this.save();
      return { draft: structuredClone(item.draft), commandId: journal.commandId, accepted: journal.state === "succeeded" };
    }
    const uncertain = ["unknown", "absent", "pending"].includes(journal.state) || !receipt || receipt.arm === "unknown" || receipt.prompt === "unknown";
    if (JSON.stringify(receipt) !== JSON.stringify(item.forceToolReceipt) || uncertain !== item.uncertain) {
      if (receipt) item.forceToolReceipt = receipt;
      item.uncertain = uncertain; this.save();
    }
  }
  async recoverForcePrompt(sessionId: string, request: ForceToolRecoveryRequest) {
    const item = Object.values(this.pending).find(value => value.sessionId === sessionId && value.send?.id === request.originalReceipt.commandId);
    if (!item?.forceToolReceipt || JSON.stringify(item.forceToolReceipt) !== JSON.stringify(request.originalReceipt)) throw new Error("The original pending force receipt changed.");
    await this.forceTools.recover(sessionId, request, item.draft);
    // Recovery has its own receipt and intentionally does not consume/replace
    // the current composer revision, which may contain newer work.
    delete this.pending[item.draft.id]; this.save();
    return structuredClone(item.draft);
  }
  async cancelForce(sessionId: string, request: { epoch: string; expectedRevision: number; directiveId: string }) {
    const state = await this.forceTools.cancel(sessionId, request);
    const item = Object.values(this.pending).find(value => value.sessionId === sessionId && value.forceToolReceipt?.epoch === request.epoch
      && value.forceToolReceipt.directiveId === request.directiveId);
    if (item) { delete this.pending[item.draft.id]; this.save(); }
    return { state, draft: item ? structuredClone(item.draft) : undefined };
  }
  queuedEntries() { return Object.values(this.queued).map(item => structuredClone(item)); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private save() {
    this.cache?.write(this.cacheKey, JSON.stringify(this.pending));
    for (const listener of this.listeners) listener();
  }
  private saveQueued() {
    this.cache?.write(this.queuedCacheKey, JSON.stringify(this.queued));
    for (const listener of this.listeners) listener();
  }

  submitActive(snapshot: Draft, sessionId: string, delivery: FollowUpDelivery,
    onSendCommand?: (submitted: Draft, commandId: string) => void) {
    return this.exclusive(snapshot.id, () => this.submitActiveExclusive(snapshot, sessionId, delivery, onSendCommand));
  }

  private async submitActiveExclusive(snapshot: Draft, sessionId: string, delivery: FollowUpDelivery,
    onSendCommand?: (submitted: Draft, commandId: string) => void) {
    const captured = captureDraft(snapshot, this.hostId);
    if (Object.values(this.pending).some(item => item.sessionId === sessionId && item.force && item.send))
      throw new Error("Resolve the original force request before queuing another message.");
    if (captured.selectedTextAttachments?.length || captured.wholeFileAttachments?.length)
      throw new Error("File content cannot be sent during an active turn yet. The draft was retained.");
    const retained = Object.values(this.queued).find(item => item.sessionId === sessionId
      && item.draft.id === captured.id && item.draft.revision === captured.revision && item.draft.text === captured.text
      && item.draft.approvalMode === captured.approvalMode && sameImageAttachments(item.draft.attachments ?? [], captured.attachments ?? []));
    if (retained) {
      const receipt = await this.exclusive(retained.send.id, () => this.inspectQueued(retained));
      if (receipt.phase === "queued" || receipt.outcome === "succeeded")
        return { sessionId, submitted: captureDraft(retained.draft, this.hostId), commandId: retained.send.id, receipt };
      throw new Error(receipt.message ?? "The original active-turn message was not queued. Its draft was retained.");
    }
    const id = crypto.randomUUID();
    const send = { id, commandVersion: captured.attachments?.length ? 17 as const : 13 as const, command: { type: "session.follow-up" as const, sessionId,
      text: captured.text, delivery, approvalMode: captured.approvalMode,
      ...(captured.attachments?.length ? { attachments: structuredClone(captured.attachments) } : {}),
      draft: { id: captured.id, revision: captured.revision } } };
    const item: PendingQueuedSubmission = { draft: captured, sessionId, delivery, send, uncertain: false };
    this.queued[id] = item;
    this.saveQueued();
    onSendCommand?.(captureDraft(captured, this.hostId), id);
    const receipt = await this.exclusive(item.send.id, () => this.inspectQueued(item));
    if (receipt.phase === "queued" || receipt.outcome === "succeeded")
      return { sessionId, submitted: captureDraft(captured, this.hostId), commandId: id, receipt };
    throw new Error(receipt.message ?? "The active-turn message was not queued. Its draft was retained.");
  }

  async reconcileQueuedSubmissions(): Promise<void> {
    await Promise.all(Object.values(this.queued).map(item => this.exclusive(item.send.id, async () => { await this.inspectQueued(item); })));
  }

  reconcileQueuedSubmission(id: string): Promise<QueuedSubmissionReceipt> {
    const item = this.queued[id];
    if (!item) return Promise.reject(new Error("The queued submission is no longer pending review."));
    return this.exclusive(item.send.id, () => this.inspectQueued(item));
  }

  restoreQueuedSubmission(id: string, restore: (draft: Draft) => void): void {
    const item = this.queued[id];
    if (!item || item.receipt?.outcome !== "not-recorded") throw new Error("Only a confirmed unrecorded message can be restored safely.");
    const draft = captureDraft(item.draft, this.hostId);
    restore(draft);
    delete this.queued[id]; this.saveQueued();
  }

  private async inspectQueued(item: PendingQueuedSubmission): Promise<QueuedSubmissionReceipt> {
    let result: CommandResult;
    try { result = await this.command(structuredClone(item.send)); }
    catch (cause) {
      item.uncertain = true; this.saveQueued();
      throw new Error(`Queued delivery is uncertain. Retry checks command ${item.send.id} without sending another copy. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (result.commandId !== item.send.id) {
      item.uncertain = true; this.saveQueued();
      throw new Error("The host returned a different queued-submission command identity.");
    }
    if (!result.ok) {
      if (["OUTCOME_UNKNOWN", "HOST_STOPPING", "COMMAND_ID_REUSED"].includes(result.error.code)) item.uncertain = true;
      else delete this.queued[item.send.id];
      this.saveQueued();
      throw new Error(result.error.message);
    }
    if (!result.value || !("type" in result.value) || result.value.type !== "session.follow-up") {
      item.uncertain = true; this.saveQueued();
      throw new Error("The host returned a different queued-submission receipt.");
    }
    let receipt: QueuedSubmissionReceipt;
    try { receipt = parseQueuedSubmissionReceipt(result.value.receipt); }
    catch (cause) { item.uncertain = true; this.saveQueued(); throw cause; }
    if (receipt.commandId !== item.send.id || receipt.hostId !== this.hostId || receipt.sessionId !== item.sessionId || receipt.delivery !== item.delivery) {
      item.uncertain = true; this.saveQueued();
      throw new Error("The queued-submission receipt belongs to a different command or owner.");
    }
    item.receipt = receipt;
    item.uncertain = receipt.outcome === "unknown";
    if (receipt.outcome === "succeeded") delete this.queued[item.send.id];
    this.saveQueued();
    return receipt;
  }
  private async deliver(item: PendingSubmission, phase: "create" | "resume" | "send") {
    const envelope = item[phase];
    if (!envelope) throw new Error(`Pending ${phase} command is missing.`);
    let result: CommandResult;
    try {
      result = await this.command(structuredClone(envelope));
      if (result.commandId !== envelope.id) throw new Error("The host replied with a different command identity.");
      if (phase === "send" && item.force) {
        if (result.forceToolReceipt) item.forceToolReceipt = parseForceToolReceipt(result.forceToolReceipt, envelope.id);
        if (result.ok && !item.forceToolReceipt) throw new Error("The host did not return the native force receipt.");
      }
      if (result.ok && phase === "send" && envelope.command.type === "session.prompt" && (envelope.command.selectedTextAttachments?.length || envelope.command.wholeFileAttachments?.length)
        && (result.admission?.kind !== "user-message" || typeof result.admission.entryId !== "string" || !result.admission.entryId))
        throw new Error("The host did not return the native user receipt for this file-context submission.");
    }
    catch (cause) {
      item.uncertain = true; this.save();
      throw new Error(`Delivery is uncertain. Retry the pending submission to check the same command; it will not send a new copy. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    // These replies do not establish the outcome of this exact command. In
    // particular, HOST_STOPPING is returned before consulting the ledger, and
    // an ID conflict cannot certify that a previous attempt did not execute.
    // Keep the persisted envelope and snapshot until a definitive result or
    // explicit user reconciliation; an edited retry must never replace them.
    if (!result.ok && ["OUTCOME_UNKNOWN", "HOST_STOPPING", "COMMAND_ID_REUSED"].includes(result.error.code)) {
      item.uncertain = true; this.save();
      throw new Error(`Delivery is uncertain. Retry the pending submission to check the same command; it will not send a new copy. ${result.error.message}`);
    }
    item.uncertain = false;
    if (phase === "send" && item.force && !(!result.ok && result.error.code === "FORCE_TOOL_PROTOCOL_UNSUPPORTED") && (!result.ok || item.forceToolReceipt?.arm === "unknown"
      || item.forceToolReceipt?.arm === "armed" && ["not-recorded", "unknown"].includes(item.forceToolReceipt.prompt))) {
      if (item.forceToolReceipt?.arm !== "not-armed") {
        item.uncertain = !item.forceToolReceipt || item.forceToolReceipt.arm === "unknown" || item.forceToolReceipt.prompt === "unknown";
        this.save();
        throw new Error(!result.ok ? result.error.message : "The native force armed, but its remaining prompt was not confirmed. Resolve it in Force tool before another send.");
      }
    }
    if (!result.ok) {
      // Polling may have established a preparation before the create handler
      // returned its recorded failure. Keep that original ownership envelope.
      // A definite native refusal remains a settled envelope/receipt pair.
      // Restore validates the receipt against this original command identity;
      // dropping only the envelope would turn a normal refusal into bad cache.
      const settledForceRefusal = phase === "send" && item.forceToolReceipt?.arm === "not-armed";
      if (!settledForceRefusal && (phase !== "create" || !item.preparation)) item[phase] = undefined;
      this.save(); throw new Error(result.error.message);
    }
    return result.value;
  }

  private exclusive<T>(draftId: string, operation: () => Promise<T>): Promise<T> {
    const active = this.flights.get(draftId);
    if (active) return active as Promise<T>;
    const pending = operation().finally(() => {
      if (this.flights.get(draftId) === pending) this.flights.delete(draftId);
    });
    this.flights.set(draftId, pending);
    return pending;
  }

  submit(snapshot: Draft, sessionId: string | undefined, mode: "prompt" | "steer", onSendCommand?: (submitted: Draft, commandId: string) => void,
    browserContinuation?: DraftBrowserContinuation, force?: NativeForceSubmission) {
    return this.exclusive(snapshot.id, () => this.submitExclusive(snapshot, sessionId, mode, onSendCommand, browserContinuation, force));
  }

  private async submitExclusive(snapshot: Draft, sessionId: string | undefined, mode: "prompt" | "steer", onSendCommand?: (submitted: Draft, commandId: string) => void,
    browserContinuation?: DraftBrowserContinuation, force?: NativeForceSubmission) {
    snapshot = captureDraft(snapshot, this.hostId);
    if (force && this.cacheWarning) throw new Error(this.cacheWarning);
    let item = this.pending[snapshot.id];
    if (sessionId && Object.values(this.pending).some(value => value.draft.id !== snapshot.id && value.sessionId === sessionId && value.force && value.send))
      throw new Error("Resolve this conversation's original force request before sending another prompt.");
    if (item?.forceToolReceipt && item.forceToolReceipt.arm !== "not-armed" && !item.uncertain)
      throw new Error("Resolve the original armed force request in Force tool before sending another prompt.");
    if (force && (mode !== "prompt" || snapshot.attachments?.length || snapshot.selectedTextAttachments?.length || snapshot.wholeFileAttachments?.length))
      throw new Error("Native /force needs an idle plain-text draft. Its attachments were retained.");
    if (item?.preparation && !item.sessionId) throw new EnvironmentPreparationPause(item.preparation);
    if (item?.uncertain ? item.mode === "steer" && item.draft.wholeFileAttachments?.length : mode === "steer" && snapshot.wholeFileAttachments?.length) throw new Error("Whole files can be sent after the current response finishes. Your draft is preserved.");
    if (item?.uncertain ? item.mode === "steer" && item.draft.selectedTextAttachments?.length : mode === "steer" && snapshot.selectedTextAttachments?.length) throw new Error("Selected text cannot be sent while the agent is running yet. Wait for the response to finish.");
    if ((item?.uncertain ? item.mode === "steer" && item.draft.attachments?.length : mode === "steer" && snapshot.attachments?.length)) throw new Error("Image attachments cannot be sent while the agent is running. Wait for the response to finish.");
    if (!item?.uncertain && !item?.preparation) {
      item = { draft: snapshot, sessionId: sessionId ?? item?.sessionId, mode, uncertain: false, ...(force ? { force: structuredClone(force) } : {}) };
      this.pending[snapshot.id] = item;
    }
    if (!item.sessionId) {
      const continuation=browserContinuation===undefined?undefined:parseDraftBrowserContinuation(browserContinuation);
      const version = continuation ? 15 : commandVersion(item.draft);
      const worktree = item.draft.execution?.type === "worktree" ? item.draft.execution : undefined;
      item.create ??= { id: crypto.randomUUID(), ...(version ? { commandVersion: version } : {}), command: { type: "session.create", projectId: item.draft.projectId, model: item.draft.model ?? undefined, approvalMode: item.draft.approvalMode,
        ...(worktree ? { worktree: structuredClone(worktree.startingState),
          ...(item.draft.environment !== undefined ? { environment: structuredClone(item.draft.environment) } : {}) } : {}),
        ...(continuation ? { browserContinuation:structuredClone(continuation),draft:{id:item.draft.id,revision:item.draft.revision} }
          : worktree&&item.draft.environment!==undefined ? {draft:{id:item.draft.id,revision:item.draft.revision}} : {}) } };
      this.save();
      const value = await this.deliver(item, "create");
      if (value && typeof value === "object" && "type" in value && value.type === "environment.preparation") {
        item.preparation = this.mergePreparation(item, value.preparation);
        item.uncertain = false;
        this.save();
        throw new EnvironmentPreparationPause(item.preparation);
      }
      if (!value || !("sessionFile" in value)) { item.uncertain = true; this.save(); throw new Error("The host did not return the created session. Retry the pending submission to check the original command."); }
      this.validateCreatedSession(item, value);
      item.sessionId = value.id;
      if (!item.preparation) item.create = undefined;
      this.save();
    }
    return this.sendCaptured(item, onSendCommand);
  }

  private async sendCaptured(item: PendingSubmission, onSendCommand?: (submitted: Draft, commandId: string) => void) {
    const saved = item.draft;
    const sessionId = item.sessionId;
    if (!sessionId || item.mode === "question") throw new Error("The captured prompt is not bound to a session.");
    const attachments = { ...(saved.attachments !== undefined ? { attachments: structuredClone(saved.attachments) } : {}),
      ...(saved.wholeFileAttachments !== undefined ? { wholeFileAttachments: structuredClone(saved.wholeFileAttachments) } : {}),
      ...(saved.selectedTextAttachments !== undefined ? { selectedTextAttachments: structuredClone(saved.selectedTextAttachments) } : {}) };
    if (!item.send && item.force && this.resolveNativeForce && !await this.resolveNativeForce(sessionId, saved.text)) {
      if (item.force.guard) throw new Error("A custom command now owns the prepared force spelling. Rebuild the draft before sending.");
      item.force = undefined; this.save();
    }
    const version = item.force ? 18 : commandVersion(saved);
    item.send ??= { id: crypto.randomUUID(), ...(version ? { commandVersion: version } : {}), command: item.mode === "steer"
      ? { type: "session.steer", sessionId, text: saved.text, approvalMode: saved.approvalMode, ...attachments, draft: { id: saved.id, revision: saved.revision } }
      : { type: "session.prompt", sessionId, text: saved.text, ...(item.force?.guard ? { forceTool: structuredClone(item.force.guard) } : {}), model: saved.model ?? undefined, thinkingLevel: saved.thinkingLevel || undefined, approvalMode: saved.approvalMode, ...attachments, draft: { id: saved.id, revision: saved.revision } } };
    const send = item.send;
    this.save();
    onSendCommand?.(captureDraft(item.draft, this.hostId), send.id);
    await this.deliver(item, "send");
    const result = { sessionId, submitted: captureDraft(item.draft, this.hostId), commandId: send.id };
    delete this.pending[saved.id];
    try { this.save(); } catch { this.cacheWarning = "The message was accepted, but its local delivery receipt could not be cleared. A pending retry after restart checks the original command."; }
    return result;
  }

  observePreparation(draftId: string, preparation: LocalEnvironmentPreparationPublic): void {
    const item = this.pending[draftId];
    if (!item) throw new Error("No captured submission owns this environment preparation.");
    const validated = this.mergePreparation(item, preparation);
    if (validated === item.preparation) return;
    item.preparation = validated;
    item.uncertain = Boolean(item.resume || item.send);
    this.save();
  }

  resumeEnvironment(draftId: string, onSendCommand?: (submitted: Draft, commandId: string) => void) {
    return this.exclusive(draftId, () => this.resumeEnvironmentExclusive(draftId, onSendCommand));
  }

  private async resumeEnvironmentExclusive(draftId: string, onSendCommand?: (submitted: Draft, commandId: string) => void) {
    const item = this.pending[draftId];
    if (!item?.preparation) throw new Error("No environment preparation is available to resume.");
    if (item.sessionId) return this.sendCaptured(item, onSendCommand);
    if (item.preparation.phase === "session-created") {
      const receiptPhase = item.resume ? "resume" : "create";
      if (!item.preparation.sessionId || !item[receiptPhase]) throw new EnvironmentPreparationPause(item.preparation);
      const value = await this.deliver(item, receiptPhase);
      if (value && typeof value === "object" && "type" in value && value.type === "environment.preparation") {
        item.preparation = this.mergePreparation(item, value.preparation);
        if (item.preparation.phase !== "session-created" || !item.preparation.sessionId) {
          item.uncertain = false;
          this.save();
          throw new EnvironmentPreparationPause(item.preparation);
        }
        item.sessionId = item.preparation.sessionId;
      } else if (value && "sessionFile" in value) {
        this.validateCreatedSession(item, value);
        item.sessionId = value.id;
      } else {
        item.uncertain = true;
        this.save();
        throw new Error("The host did not return the created session. Retry checks the original creation command.");
      }
      if (receiptPhase === "resume") item.resume = undefined;
      item.uncertain = false;
      this.save();
      return this.sendCaptured(item, onSendCommand);
    }
    if (!["validated", "worktree-created", "setup-failed", "setup-succeeded"].includes(item.preparation.phase)) {
      throw new EnvironmentPreparationPause(item.preparation);
    }
    if (!item.resume) {
      item.resume = { id: crypto.randomUUID(), commandVersion: hasRemoteExecution(item.draft.execution) ? 12 : 5, command: {
        type: "session.environment.resume",
        preparationId: item.preparation.id,
        expectedRevision: item.preparation.revision,
      } };
      this.save();
    }
    const value = await this.deliver(item, "resume");
    if (value && typeof value === "object" && "type" in value && value.type === "environment.preparation") {
      item.preparation = this.mergePreparation(item, value.preparation);
      item.resume = undefined;
      item.uncertain = false;
      this.save();
      throw new EnvironmentPreparationPause(item.preparation);
    }
    if (!value || !("sessionFile" in value)) {
      item.uncertain = true;
      this.save();
      throw new Error("The host did not return the created session. Retry the pending environment resume to check the original command.");
    }
    this.validateCreatedSession(item, value);
    item.sessionId = value.id;
    item.resume = undefined;
    item.uncertain = false;
    this.save();
    return this.sendCaptured(item, onSendCommand);
  }

  private validatePreparation(item: PendingSubmission, value: LocalEnvironmentPreparationPublic): LocalEnvironmentPreparationPublic {
    const create = item.create?.command;
    const environment = item.draft.environment;
    const phases = ["validated", "worktree-creating", "worktree-created", "setup-running", "setup-failed", "setup-succeeded", "native-creating", "session-created", "cleanup-running", "cleanup-failed", "cleanup-succeeded", "removed", "unknown"];
    if (!create || create.type !== "session.create" || !create.worktree || create.environment === undefined || !create.draft
      || typeof item.create!.id !== "string" || !item.create!.id || typeof value.id !== "string" || !value.id
      || value.id !== item.create!.id || value.hostId !== this.hostId || value.projectId !== item.draft.projectId
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || !phases.includes(value.phase)
      || typeof value.worktreePath !== "string" || !value.worktreePath || typeof value.needsAttention !== "boolean"
      || value.needsAttention !== ["setup-failed", "cleanup-failed", "unknown"].includes(value.phase)
      || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || value.updatedAt < value.createdAt
      || value.sessionId !== undefined && (typeof value.sessionId !== "string" || !value.sessionId)
      || value.uncertainOperation !== undefined && !["worktree-create", "setup", "native-create", "cleanup"].includes(value.uncertainOperation)
      || (value.phase === "unknown") !== (value.uncertainOperation !== undefined)
      || environment === undefined
      || (environment === null ? value.environment !== null : !value.environment
        || value.environment.configPath !== environment.configPath || value.environment.revision !== environment.revision
        || typeof value.environment.name !== "string")
      || !this.validRunSummary(value.setup) || !this.validRunSummary(value.cleanup)) {
      throw new Error("Environment preparation differs from its captured submission.");
    }
    if (item.preparation && (value.id !== item.preparation.id || value.worktreePath !== item.preparation.worktreePath)) {
      throw new Error("Environment preparation ownership changed.");
    }
    return structuredClone(value);
  }

  private mergePreparation(item: PendingSubmission, value: LocalEnvironmentPreparationPublic): LocalEnvironmentPreparationPublic {
    const validated = this.validatePreparation(item, value);
    const current = item.preparation;
    if (!current) return validated;
    if (validated.revision < current.revision) return current;
    if (validated.revision === current.revision) {
      if (JSON.stringify(validated) !== JSON.stringify(current)) throw new Error("Environment preparation changed without a new revision.");
      return current;
    }
    return validated;
  }

  private validRunSummary(value: LocalEnvironmentPreparationPublic["setup"]): boolean {
    return value === undefined || !!value && ["succeeded", "failed", "cancelled"].includes(value.status)
      && (value.cancelReason === undefined || value.cancelReason === "aborted" || value.cancelReason === "timed-out")
      && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
      && (value.signal === null || typeof value.signal === "string")
      && Number.isFinite(value.startedAt) && Number.isFinite(value.finishedAt) && value.finishedAt >= value.startedAt
      && typeof value.outputTruncated === "boolean";
  }

  private validResumeEnvelope(envelope: CommandEnvelope, preparation: LocalEnvironmentPreparationPublic, draft: Draft): boolean {
    if (envelope.command.type !== "session.environment.resume") return false;
    return envelope.commandVersion === (hasRemoteExecution(draft.execution) ? 12 : 5) && typeof envelope.id === "string" && !!envelope.id
      && Object.keys(envelope).sort().join(",") === "command,commandVersion,id"
      && Object.keys(envelope.command).sort().join(",") === "expectedRevision,preparationId,type"
      && envelope.command.preparationId === preparation.id
      && Number.isSafeInteger(envelope.command.expectedRevision) && envelope.command.expectedRevision >= 1
      && envelope.command.expectedRevision <= preparation.revision;
  }

  private validateCreatedSession(item: PendingSubmission, value: { id: string; hostId: string; projectId: string | null; cwd: string }): void {
    if (value.hostId !== this.hostId || value.projectId !== item.draft.projectId
      || item.preparation && value.cwd !== item.preparation.worktreePath) {
      throw new Error("Created session differs from its captured environment submission.");
    }
  }

  async submitQuestion(snapshot: Draft, sessionId: string, questionId: string, questionEntryId: string, answers: DetachedQuestionAnswer[], onSendCommand?: (submitted: Draft, commandId: string) => void) {
    snapshot = captureDraft(snapshot, this.hostId);
    let item = this.pending[snapshot.id];
    if (!item?.uncertain) {
      const parsed = parseDetachedQuestionAnswers(answers);
      if (snapshot.text !== detachedAnswerDraft(parsed) || snapshot.attachments?.length || snapshot.selectedTextAttachments?.length || snapshot.wholeFileAttachments?.length) throw new Error("The saved question draft does not match these answers.");
      item = { draft: snapshot, sessionId, mode: "question", question: { questionId, questionEntryId, answers: parsed }, uncertain: false };
      this.pending[snapshot.id] = item;
    }
    if (item.mode !== "question" || !item.sessionId || !item.question) throw new Error("A different pending submission already owns this draft.");
    const saved = item.draft;
    item.send ??= { id: crypto.randomUUID(), ...(commandVersion(saved) ? { commandVersion: commandVersion(saved) } : {}), command: { type: "session.question.answer", sessionId: item.sessionId,
      questionId: item.question.questionId, questionEntryId: item.question.questionEntryId, answers: structuredClone(item.question.answers),
      draft: { id: saved.id, revision: saved.revision } } };
    this.save();
    onSendCommand?.(captureDraft(saved, this.hostId), item.send.id);
    const value = await this.deliver(item, "send");
    if (!value || !("type" in value) || value.type !== "session.question.answer" || value.receipt.questionId !== item.question.questionId) {
      item.uncertain = true; this.save();
      throw new Error("Delivery is uncertain. The host did not return the matching detached question receipt; retry checks the original command.");
    }
    const result = { sessionId: item.sessionId, submitted: captureDraft(saved, this.hostId), commandId: item.send.id };
    delete this.pending[snapshot.id];
    try { this.save(); } catch { this.cacheWarning = "The answer was accepted, but its local delivery receipt could not be cleared. A pending retry after restart checks the original command."; }
    return result;
  }
}
