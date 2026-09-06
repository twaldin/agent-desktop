import type { CommandEnvelope, CommandResult, Draft } from "../../../../packages/shared/src/protocol";
import { detachedAnswerDraft, parseDetachedQuestionAnswers, type DetachedQuestionAnswer } from "../../../../packages/shared/src/detached-questions";
import { captureDraft, sameDraftContent, type DraftCache } from "./drafts";

export interface PendingSubmission {
  draft: Draft;
  sessionId?: string;
  mode: "prompt" | "steer" | "question";
  question?: { questionId: string; questionEntryId: string; answers: DetachedQuestionAnswer[] };
  create?: CommandEnvelope;
  send?: CommandEnvelope;
  uncertain: boolean;
}
/** Persist envelopes before delivery so an explicit retry uses the original command identity. */
export class SubmissionController {
  private pending: Record<string, PendingSubmission> = {};
  private listeners = new Set<() => void>();
  readonly cacheKey: string;
  cacheWarning: string | undefined;
  constructor(private command: (envelope: CommandEnvelope) => Promise<CommandResult>, private hostId: string, private cache?: DraftCache) {
    this.cacheKey = `agent-desktop:submissions:v1:${hostId}`;
    try {
      const cached = JSON.parse(cache?.read(this.cacheKey) ?? "{}");
      for (const [id, value] of Object.entries(cached)) {
        const item = value as PendingSubmission;
        if (item?.draft?.id === id && typeof item.draft.text === "string" && ["prompt", "steer", "question"].includes(item.mode) && (!item.create || item.create.command.type === "session.create") && (!item.send || ["session.prompt", "session.steer", "session.question.answer"].includes(item.send.command.type))) {
          const captured = captureDraft(item.draft, hostId);
          if (item.send && (item.send.command.type === "session.prompt" || item.send.command.type === "session.steer")) {
            const command = item.send.command;
            if (!sameDraftContent(captured, captureDraft({ ...captured, attachments: command.attachments }, hostId))
              || command.text !== captured.text || command.draft?.id !== captured.id || command.draft.revision !== captured.revision) throw new Error("Pending attachment metadata differs from its exact command.");
          }
          if (item.mode === "question") {
            if (!item.sessionId || item.create || !item.question) throw new Error("Invalid pending detached question submission.");
            const answers = parseDetachedQuestionAnswers(item.question.answers);
            if (captured.text !== detachedAnswerDraft(answers) || captured.attachments?.length) throw new Error("Pending detached answers differ from their saved draft.");
            if (item.send) {
              if (item.send.command.type !== "session.question.answer") throw new Error("Invalid pending detached question command.");
              const command = item.send.command;
              if (command.sessionId !== item.sessionId || command.questionId !== item.question.questionId || command.questionEntryId !== item.question.questionEntryId
                || command.draft.id !== captured.id || command.draft.revision !== captured.revision || detachedAnswerDraft(command.answers) !== captured.text) throw new Error("Pending detached answers differ from their exact command.");
            }
            item.question = { ...item.question, answers };
          }
          this.pending[id] = { ...structuredClone(item), draft: captured, uncertain: Boolean(item.create || item.send) };
        }
      }
    } catch { this.cacheWarning = "Pending submission storage could not be read. Check conversation history before resending an earlier prompt."; }
  }
  get(id: string) { return this.pending[id] ? structuredClone(this.pending[id]) : undefined; }
  entries() { return Object.values(this.pending).map(item => structuredClone(item)); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private save() {
    this.cache?.write(this.cacheKey, JSON.stringify(this.pending));
    for (const listener of this.listeners) listener();
  }
  private async deliver(item: PendingSubmission, phase: "create" | "send") {
    let result: CommandResult;
    try {
      result = await this.command(structuredClone(item[phase]!));
      if (result.commandId !== item[phase]!.id) throw new Error("The host replied with a different command identity.");
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
    if (!result.ok) { item[phase] = undefined; this.save(); throw new Error(result.error.message); }
    return result.value;
  }
  async submit(snapshot: Draft, sessionId: string | undefined, mode: "prompt" | "steer", onSendCommand?: (submitted: Draft, commandId: string) => void) {
    snapshot = captureDraft(snapshot, this.hostId);
    let item = this.pending[snapshot.id];
    if ((item?.uncertain ? item.mode === "steer" && item.draft.attachments?.length : mode === "steer" && snapshot.attachments?.length)) throw new Error("Image attachments cannot be sent while the agent is running. Wait for the response to finish.");
    if (!item?.uncertain) {
      item = { draft: snapshot, sessionId: sessionId ?? item?.sessionId, mode, uncertain: false };
      this.pending[snapshot.id] = item;
    }
    if (!item.sessionId) {
      item.create ??= { id: crypto.randomUUID(), command: { type: "session.create", projectId: item.draft.projectId, model: item.draft.model ?? undefined, approvalMode: item.draft.approvalMode } };
      this.save();
      const value = await this.deliver(item, "create");
      if (!value || !("sessionFile" in value)) { item.uncertain = true; this.save(); throw new Error("The host did not return the created session. Retry the pending submission to check the original command."); }
      item.sessionId = value.id; item.create = undefined; this.save();
    }
    const saved = item.draft;
    const attachments = saved.attachments !== undefined ? { attachments: structuredClone(saved.attachments) } : {};
    item.send ??= { id: crypto.randomUUID(), command: item.mode === "steer"
      ? { type: "session.steer", sessionId: item.sessionId, text: saved.text, approvalMode: saved.approvalMode, ...attachments, draft: { id: saved.id, revision: saved.revision } }
      : { type: "session.prompt", sessionId: item.sessionId, text: saved.text, model: saved.model ?? undefined, thinkingLevel: saved.thinkingLevel || undefined, approvalMode: saved.approvalMode, ...attachments, draft: { id: saved.id, revision: saved.revision } } };
    this.save();
    onSendCommand?.(captureDraft(item.draft, this.hostId), item.send.id);
    await this.deliver(item, "send");
    const result = { sessionId: item.sessionId, submitted: captureDraft(item.draft, this.hostId), commandId: item.send.id };
    delete this.pending[snapshot.id];
    try { this.save(); } catch { this.cacheWarning = "The message was accepted, but its local delivery receipt could not be cleared. A pending retry after restart checks the original command."; }
    return result;
  }

  async submitQuestion(snapshot: Draft, sessionId: string, questionId: string, questionEntryId: string, answers: DetachedQuestionAnswer[], onSendCommand?: (submitted: Draft, commandId: string) => void) {
    snapshot = captureDraft(snapshot, this.hostId);
    let item = this.pending[snapshot.id];
    if (!item?.uncertain) {
      const parsed = parseDetachedQuestionAnswers(answers);
      if (snapshot.text !== detachedAnswerDraft(parsed) || snapshot.attachments?.length) throw new Error("The saved question draft does not match these answers.");
      item = { draft: snapshot, sessionId, mode: "question", question: { questionId, questionEntryId, answers: parsed }, uncertain: false };
      this.pending[snapshot.id] = item;
    }
    if (item.mode !== "question" || !item.sessionId || !item.question) throw new Error("A different pending submission already owns this draft.");
    const saved = item.draft;
    item.send ??= { id: crypto.randomUUID(), command: { type: "session.question.answer", sessionId: item.sessionId,
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
