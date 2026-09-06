import { randomUUID } from "node:crypto";
import { parseDetachedQuestionAnswers, parseDetachedQuestions, type DetachedQuestion, type DetachedQuestionAnswer, type DetachedQuestionDeliveryReceipt, type DetachedQuestionSnapshot, type ResolveDetachedQuestionReceipt, type ResolveDetachedQuestionRequest } from "@agent-desktop/shared";
import { z, type AgentSessionEvent, type ExtensionFactory, type SessionManager } from "@oh-my-pi/pi-coding-agent";

const OPENED = "agent-desktop.question-opened";
const ACCEPTED = "agent-desktop.question-accepted";
const CLOSED = "agent-desktop.question-closed";
const ATTEMPT = "agent-desktop.question-delivery-attempt";
const DELIVERED = "agent-desktop.question-delivered";
const REJECTED = "agent-desktop.question-rejected";

type NativeEntry = ReturnType<SessionManager["getBranch"]>[number];
type NativeAdmission =
  | { kind: "user-message"; entryId: string }
  | { kind: "not-recorded"; reason: string }
  | { kind: "outcome-unknown"; reason: string };
export interface NativeQuestionDeliveryRun {
  accepted: Promise<DetachedQuestionDeliveryReceipt>;
  completion: Promise<boolean>;
}
export interface OmpDetachedQuestionDeliveryRun extends NativeQuestionDeliveryRun {}

/** Native acceptance may already be durable when its worker response is lost. */
export class DetachedQuestionOutcomeUnknown extends Error {
  readonly code = "OUTCOME_UNKNOWN";
  constructor(cause?: unknown) {
    super(`Detached answer acceptance could not be verified. Retain the original command identity.${cause instanceof Error ? ` ${cause.message}` : ""}`, { cause });
    this.name = "DetachedQuestionOutcomeUnknown";
  }
}

interface NativeDispatchRun { accepted: Promise<NativeAdmission | null>; completion: Promise<boolean> }
interface OpenData { questionId: string; originRunId: string; openedAt: number; questions: DetachedQuestion[] }
interface AcceptedData { questionId: string; commandId: string; acceptedAt: number; answers: DetachedQuestionAnswer[]; message: string }

function data(entry: NativeEntry, type: string): Record<string, unknown> | undefined {
  return entry.type === "custom" && entry.customType === type && entry.data && typeof entry.data === "object"
    ? entry.data as Record<string, unknown> : undefined;
}
function boundedIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}
function timestamp(entry: NativeEntry): number { return Date.parse(entry.timestamp); }
function detachedError(message: string, unknown = false): Error {
  const error = new Error(message); error.name = "DetachedQuestionRejected";
  if (unknown) Object.assign(error, { code: "OUTCOME_UNKNOWN" });
  return error;
}
function boundedMessage(prefix: string, value: unknown): string {
  return `${prefix}${value instanceof Error ? value.message : String(value)}`.slice(0, 2_000);
}

function answerMessage(questionId: string, questions: readonly DetachedQuestion[], answers: readonly DetachedQuestionAnswer[]): string {
  const answerById = new Map(answers.map(answer => [answer.questionId, answer]));
  const lines = questions.map(question => {
    const answer = answerById.get(question.id)!;
    const parts = [...answer.selectedOptions, ...(answer.customInput ? [answer.customInput] : [])];
    return `- ${question.question} [${question.id}]: ${parts.length ? parts.join("; ") : "Skipped"}`;
  });
  return `Answers to detached question ${questionId}:\n${lines.join("\n")}`;
}

/** Native SessionManager custom entries are the sole question lifecycle journal. */
export class NativeDetachedQuestions {
  #activeRunId?: string;
  #resolving = new Set<string>();
  #delivering = new Map<string, string>();
  #settling: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(private readonly manager: SessionManager) {}

  readonly extension: ExtensionFactory = pi => {
    const definition = {
      name: "ask_async",
      label: "Ask asynchronously",
      description: "Ask one to three questions without blocking this turn. The operator may answer later; continue useful independent work after calling this tool.",
      parameters: z.object({ questions: z.array(z.object({ id: z.string(), question: z.string(), header: z.string().nullable().optional(),
        options: z.array(z.object({ label: z.string(), description: z.string().nullable().optional(), preview: z.string().nullable().optional() })),
        multi: z.boolean().optional(), recommended: z.number().int().nullable().optional() })).min(1).max(3) }),
      loadMode: "essential" as const, approval: "read" as const, strict: true,
      // Extension adapters proxy this native AgentTool field even though the
      // public ToolDefinition declaration in 18.1.10 does not expose it.
      concurrency: "shared" as const,
      execute: async (_toolCallId: string, params: { questions: unknown }, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const opened = await this.open(params.questions);
        return { content: [{ type: "text" as const, text: `Detached question ${opened.questionId} was opened. Continue independent work; do not wait for its answer.` }],
          details: { questionId: opened.questionId, questionEntryId: opened.questionEntryId } };
      },
    };
    pi.registerTool(definition);
  };

  async repairOnReopen(): Promise<void> {
    const open = this.list().filter(question => question.status === "open");
    if (!open.length) return;
    for (const question of open) this.manager.appendCustomEntry(CLOSED, { questionId: question.questionId, reason: "reopen-repair", closedAt: Date.now() });
    await this.manager.flush();
  }

  /** Public snapshots can reconcile host receipts, so every included entry
   * must be durable. Capture first: entries appended during flush are excluded. */
  async snapshot(): Promise<DetachedQuestionSnapshot[]> {
    const snapshot = this.list();
    await this.manager.flush();
    return snapshot;
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === "agent_start") { this.#activeRunId = randomUUID(); return; }
    if (event.type !== "agent_end") return;
    const runId = this.#activeRunId;
    this.#activeRunId = undefined;
    if (!runId) return;
    const open = this.list().filter(question => question.status === "open" && question.originRunId === runId && !this.#resolving.has(question.questionId));
    if (!open.length) return;
    for (const question of open) this.manager.appendCustomEntry(CLOSED, { questionId: question.questionId, reason: "origin-ended", closedAt: Date.now() });
    this.#settling = this.#settling.then(() => this.manager.flush());
    void this.#settling.catch(() => {});
  }

  async open(rawQuestions: unknown): Promise<{ questionId: string; questionEntryId: string }> {
    if (this.#disposed) throw detachedError("Detached question journal is closed.");
    if (!this.#activeRunId) throw detachedError("Detached questions can only be opened by an active native turn.");
    const questions = parseDetachedQuestions(rawQuestions), questionId = randomUUID(), openedAt = Date.now();
    const questionEntryId = this.manager.appendCustomEntry(OPENED, { questionId, originRunId: this.#activeRunId, openedAt, questions } satisfies OpenData);
    try { await this.manager.flush(); }
    catch (error) { throw detachedError(boundedMessage("Detached question storage could not be verified: ", error), true); }
    return { questionId, questionEntryId };
  }

  list(): DetachedQuestionSnapshot[] {
    const branch = this.manager.getBranch(), snapshots = new Map<string, DetachedQuestionSnapshot>();
    for (const entry of branch) {
      const opened = data(entry, OPENED);
      if (opened) {
        try {
          const questionId = boundedIdentity(opened.questionId), originRunId = boundedIdentity(opened.originRunId);
          if (!questionId || !originRunId || typeof opened.openedAt !== "number" || !Number.isFinite(opened.openedAt)) continue;
          snapshots.set(questionId, { questionId, questionEntryId: entry.id, originRunId, openedAt: opened.openedAt,
            questions: parseDetachedQuestions(opened.questions), status: "open", delivery: { status: "waiting" } });
        } catch { /* Malformed app-owned entries are not projected. */ }
        continue;
      }
      const accepted = data(entry, ACCEPTED), closed = data(entry, CLOSED), attempt = data(entry, ATTEMPT), delivered = data(entry, DELIVERED), rejected = data(entry, REJECTED);
      const questionId = boundedIdentity((accepted ?? closed ?? attempt ?? delivered ?? rejected)?.questionId), current = questionId && snapshots.get(questionId);
      if (!questionId || !current) continue;
      if (accepted && current.status === "open") {
        try {
          const commandId = boundedIdentity(accepted.commandId);
          if (!commandId || typeof accepted.acceptedAt !== "number" || !Number.isFinite(accepted.acceptedAt)) continue;
          current.status = "accepted";
          current.acceptance = { commandId, acceptanceEntryId: entry.id, acceptedAt: accepted.acceptedAt,
            answers: parseDetachedQuestionAnswers(accepted.answers, current.questions) };
        } catch { /* ignore malformed transition */ }
      } else if (closed && current.status === "open" && (closed.reason === "origin-ended" || closed.reason === "reopen-repair")
        && typeof closed.closedAt === "number" && Number.isFinite(closed.closedAt)) {
        current.status = "closed"; current.close = { closeEntryId: entry.id, closedAt: closed.closedAt, reason: closed.reason };
      } else if (attempt && current.status === "accepted" && current.delivery.status === "waiting") {
        current.delivery = { status: "unknown", attemptEntryId: entry.id, message: "Native answer delivery began without a durable final receipt; it will not be replayed automatically." };
      } else if (delivered && current.status === "accepted" && (current.delivery.status === "unknown" || current.delivery.status === "waiting")) {
        const attemptEntryId = boundedIdentity(delivered.attemptEntryId), nativeEntryId = boundedIdentity(delivered.nativeEntryId);
        if (attemptEntryId && nativeEntryId && (delivered.mode === "steer" || delivered.mode === "followUp")) current.delivery = { status: "delivered", attemptEntryId, nativeEntryId, mode: delivered.mode };
      } else if (rejected && current.status === "accepted" && typeof rejected.message === "string" && rejected.message.length <= 2_000) {
        const attemptEntryId = boundedIdentity(rejected.attemptEntryId);
        current.delivery = { status: "rejected", message: rejected.message, ...(attemptEntryId ? { attemptEntryId } : {}) };
      }
    }
    for (const snapshot of snapshots.values()) {
      const attemptEntryId = this.#delivering.get(snapshot.questionId);
      if (attemptEntryId && snapshot.delivery.status === "unknown" && snapshot.delivery.attemptEntryId === attemptEntryId) {
        snapshot.delivery = { status: "delivering", attemptEntryId };
      }
    }
    return [...snapshots.values()];
  }

  async resolve(request: ResolveDetachedQuestionRequest): Promise<ResolveDetachedQuestionReceipt> {
    if (this.#disposed) throw detachedError("Detached question journal is closed.");
    const current = this.list().find(question => question.questionId === request.questionId);
    if (!current || current.questionEntryId !== request.questionEntryId) throw detachedError("Detached question is absent from the current native branch.");
    if (current.status !== "open" || this.#resolving.has(current.questionId)) throw detachedError("Detached question has already been resolved or closed.");
    const answers = parseDetachedQuestionAnswers(request.answers, current.questions);
    this.#resolving.add(current.questionId);
    const acceptedAt = Date.now(), message = answerMessage(current.questionId, current.questions, answers);
    const acceptanceEntryId = this.manager.appendCustomEntry(ACCEPTED, { questionId: current.questionId, commandId: request.commandId, acceptedAt, answers, message } satisfies AcceptedData);
    try {
      await this.manager.flush();
      return { questionId: current.questionId, acceptanceEntryId, delivery: "waiting" };
    } catch (error) { throw detachedError(boundedMessage("Detached answer storage could not be verified: ", error), true); }
    finally { this.#resolving.delete(current.questionId); }
  }

  startDelivery(questionId: string, preflight: () => "steer" | "followUp", dispatch: (message: string, mode: "steer" | "followUp") => NativeDispatchRun): OmpDetachedQuestionDeliveryRun {
    if (this.#disposed) throw detachedError("Detached question journal is closed.");
    const current = this.list().find(question => question.questionId === questionId);
    if (!current || current.status !== "accepted" || !current.acceptance || current.delivery.status !== "waiting" || this.#delivering.has(questionId)) {
      throw detachedError("Detached answer is not waiting for delivery.");
    }
    const mode = preflight();
    const attemptEntryId = this.manager.appendCustomEntry(ATTEMPT, { questionId, mode, attemptedAt: Date.now() });
    this.#delivering.set(questionId, attemptEntryId);
    let nativeRun: NativeDispatchRun | undefined;
    const accepted = (async (): Promise<DetachedQuestionDeliveryReceipt> => {
      try {
        await this.manager.flush();
        nativeRun = dispatch(answerMessage(questionId, current.questions, current.acceptance!.answers), mode);
        const admission = await nativeRun.accepted;
        if (!admission || admission.kind !== "user-message") {
          const reason = (admission?.reason ?? "Native answer admission returned no user entry.").slice(0, 2_000);
          if (admission?.kind === "not-recorded") {
            this.manager.appendCustomEntry(REJECTED, { questionId, attemptEntryId, message: reason, rejectedAt: Date.now() });
            await this.manager.flush();
            return { questionId, outcome: "rejected", attemptEntryId, message: reason };
          }
          return { questionId, outcome: "unknown", attemptEntryId, message: reason };
        }
        this.manager.appendCustomEntry(DELIVERED, { questionId, attemptEntryId, nativeEntryId: admission.entryId, mode, deliveredAt: Date.now() });
        try { await this.manager.flush(); }
        catch (error) { return { questionId, outcome: "unknown", attemptEntryId, message: boundedMessage("Native answer was admitted but its delivery receipt could not be verified: ", error) }; }
        return { questionId, outcome: "delivered", attemptEntryId, nativeEntryId: admission.entryId, mode };
      } catch (error) {
        return { questionId, outcome: "unknown", attemptEntryId, message: boundedMessage("Native answer delivery outcome is unknown: ", error) };
      }
    })();
    const completion = (async () => {
      try {
        const receipt = await accepted;
        if (receipt.outcome !== "delivered" || !nativeRun) throw detachedError(receipt.outcome === "delivered" ? "Detached answer was not delivered." : receipt.message, receipt.outcome === "unknown");
        return await nativeRun.completion;
      } finally { if (this.#delivering.get(questionId) === attemptEntryId) this.#delivering.delete(questionId); }
    })();
    void accepted.catch(() => {}); void completion.catch(() => {});
    return { accepted, completion };
  }

  async settle(): Promise<void> { await this.#settling; }
  dispose(): void { this.#disposed = true; }
}
