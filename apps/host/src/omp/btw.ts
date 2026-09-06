import { prompt } from "@oh-my-pi/pi-utils";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { NativeBtwSnapshot, NativeBtwStart } from "../../../../packages/shared/src/btw";

const nativeAgentEntry = Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir);
const btwUserPrompt = readFileSync(path.join(path.dirname(nativeAgentEntry), "prompts/system/btw-user.md"), "utf8");

const MAX_QUESTION_BYTES = 32 * 1024;
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_RETAINED_RUNS = 16;
const MAX_SEEN_RUNS = 128;

type NativeSideSession = Pick<AgentSession, "sessionId" | "model" | "runEphemeralTurn" | "sessionManager" | "branchFromBtw">;
export interface NativeBtwPromotion { cancelled: boolean; sessionFile: string | undefined }
interface Promotion { state: "running" | "settled"; promise: Promise<NativeBtwPromotion> }
interface Request {
  input: NativeBtwStart;
  controller: AbortController;
  snapshot: NativeBtwSnapshot;
  origin: { leafId: string | null; sessionId: string };
  assistantMessage?: AssistantMessage;
  promotion?: Promotion;
  promotions?: Map<string, Promotion>;
  promotionFailed?: boolean;
}

function bounded(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  // Streaming decode intentionally drops an incomplete trailing code point;
  // replacement bytes could otherwise make the result exceed maxBytes.
  return new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function copy(snapshot: NativeBtwSnapshot): NativeBtwSnapshot { return { ...snapshot }; }
function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  let replacedText = false;
  for (const part of assistantMessage.content) {
    if (part.type === "thinking") { content.push({ type: "thinking", thinking: part.thinking }); continue; }
    if (part.type === "redactedThinking") continue;
    if (part.type !== "text") { content.push(part); continue; }
    if (replacedText) continue;
    content.push({ type: "text", text: replyText }); replacedText = true;
  }
  if (!replacedText) content.push({ type: "text", text: replyText });
  return { ...assistantMessage, content, providerPayload: undefined };
}

export class NativeBtwController {
  #current?: Request;
  #records = new Map<string, Request>();
  #seen = new Map<string, string>();
  #disposed = false;

  constructor(private readonly session: NativeSideSession, private readonly now: () => number = Date.now) {}

  get(): NativeBtwSnapshot | null {
    const r = this.#current;
    if (!r) return null;
    return { ...r.snapshot, ...(r.snapshot.status === "complete" ? { canPromote: !this.#disposed && !r.promotionFailed
      && r.promotion?.state !== "running" && Boolean(r.assistantMessage && r.origin.leafId)
      && this.session.sessionManager.getSessionId() === r.origin.sessionId
      && this.session.sessionManager.getLeafId() === r.origin.leafId } : {}) };
  }

  start(input: NativeBtwStart): NativeBtwSnapshot {
    this.#assertActive();
    if (this.#current?.promotion?.state === "running") throw new Error("Native /btw promotion is in progress");
    const runId = input.runId.trim(), question = input.question.trim();
    if (!runId || byteLength(runId) > 200) throw new Error("Invalid native /btw run identity");
    if (!question) throw new Error("Native /btw requires a question");
    if (new TextEncoder().encode(question).byteLength > MAX_QUESTION_BYTES) throw new Error("Native /btw question exceeds 32 KiB");
    if (!this.session.model) throw new Error("No active model available for native /btw");

    const seenQuestion = this.#seen.get(runId);
    if (seenQuestion !== undefined) {
      if (seenQuestion !== question) throw new Error("Native /btw run identity was reused with different input");
      const retained = this.#records.get(runId);
      if (!retained) throw new Error("Native /btw run is no longer inspectable and will not be replayed");
      return copy(retained.snapshot);
    }
    if (this.#seen.size >= MAX_SEEN_RUNS) throw new Error("Native /btw worker request capacity reached");

    if (this.#current) this.#cancel(this.#current);
    const startedAt = this.now();
    const request: Request = { input: { runId, question }, controller: new AbortController(), snapshot: {
      runId, sessionId: this.session.sessionId, question, status: "running", answer: "", startedAt, updatedAt: startedAt,
    }, origin: { leafId: this.session.sessionManager.getLeafId(), sessionId: this.session.sessionManager.getSessionId() } };
    this.#current = request;
    this.#records.set(runId, request);
    this.#seen.set(runId, question);
    this.#trimRecords();
    void this.#run(request);
    return copy(request.snapshot);
  }

  cancel(runId: string): NativeBtwSnapshot | null {
    this.#assertActive();
    const retained = this.#records.get(runId);
    if (!retained) return null;
    if (this.#current === retained) this.#cancel(retained);
    return copy(retained.snapshot);
  }

  async promote(runId: string, operationId = runId): Promise<NativeBtwPromotion> {
    this.#assertActive();
    const request = this.#records.get(runId);
    if (!request) throw new Error("Native /btw run is unknown or no longer inspectable");
    if (request !== this.#current) throw new Error("Native /btw run was replaced and cannot be promoted");
    if (request.snapshot.status !== "complete" || !request.assistantMessage) throw new Error("Native /btw answer is not complete");
    const prior = request.promotions?.get(operationId);
    if (prior) {
      if (prior.state === "running") throw new Error("Native /btw promotion is already in progress");
      return prior.promise;
    }
    if (request.promotion?.state === "running") throw new Error("Native /btw promotion is already in progress");
    if (request.promotionFailed) throw new Error("Native /btw promotion outcome is unknown and cannot be replayed");
    if (!operationId || operationId.length > 200 || (request.promotions?.size ?? 0) >= MAX_SEEN_RUNS) throw new Error("Invalid or exhausted native promotion identity");
    const { leafId, sessionId } = request.origin;
    if (!leafId) throw new Error("Native /btw session has no branch point");
    if (this.session.sessionManager.getSessionId() !== sessionId || this.session.sessionManager.getLeafId() !== leafId)
      throw new Error("Native /btw session changed since the side question started");
    const promise = this.session.branchFromBtw(request.input.question,
      assistantMessageWithReplyText(request.assistantMessage, request.snapshot.answer), leafId, sessionId);
    const promotion: Promotion = { state: "running", promise };
    request.promotion = promotion;
    (request.promotions ??= new Map()).set(operationId, promotion);
    void promise.then(() => { promotion.state = "settled"; }, () => { promotion.state = "settled"; request.promotionFailed = true; });
    return promise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#current) this.#cancel(this.#current);
  }

  async #run(request: Request): Promise<void> {
    try {
      const promptText = prompt.render(btwUserPrompt, { question: request.input.question });
      const result = await this.session.runEphemeralTurn({ promptText, signal: request.controller.signal, onTextDelta: delta => {
        if (request.snapshot.status !== "running") return;
        const answer = request.snapshot.answer + delta;
        if (byteLength(answer) > MAX_ANSWER_BYTES) {
          request.snapshot = { ...request.snapshot, status: "failed", answer: bounded(answer, MAX_ANSWER_BYTES),
            error: "Native /btw answer exceeded 1 MiB", updatedAt: this.now() };
          request.controller.abort();
          return;
        }
        request.snapshot = { ...request.snapshot, answer, updatedAt: this.now() };
      } });
      if (request.snapshot.status !== "running") return;
      if (byteLength(result.replyText) > MAX_ANSWER_BYTES) {
        request.snapshot = { ...request.snapshot, status: "failed", answer: bounded(result.replyText, MAX_ANSWER_BYTES),
          error: "Native /btw answer exceeded 1 MiB", updatedAt: this.now() };
        return;
      }
      request.assistantMessage = result.assistantMessage;
      request.snapshot = { ...request.snapshot, status: "complete", answer: result.replyText, updatedAt: this.now() };
    } catch (cause) {
      if (request.snapshot.status !== "running") return;
      if (request.controller.signal.aborted) {
        request.snapshot = { ...request.snapshot, status: "cancelled", updatedAt: this.now() };
      } else {
        const rawError = cause instanceof Error ? cause.message : String(cause);
        const error = bounded(rawError || "Native /btw failed", MAX_ERROR_BYTES);
        request.snapshot = { ...request.snapshot, status: "failed", error, updatedAt: this.now() };
      }
    }
  }

  #cancel(request: Request): void {
    if (request.snapshot.status !== "running") return;
    request.controller.abort();
    request.snapshot = { ...request.snapshot, status: "cancelled", updatedAt: this.now() };
  }

  #trimRecords(): void {
    while (this.#records.size > MAX_RETAINED_RUNS) {
      const oldest = this.#records.keys().next().value as string | undefined;
      if (!oldest) return;
      if (this.#current?.input.runId === oldest) {
        const value = this.#records.get(oldest)!;
        this.#records.delete(oldest); this.#records.set(oldest, value);
        continue;
      }
      this.#records.delete(oldest);
    }
  }

  #assertActive(): void { if (this.#disposed) throw new Error("Native /btw controller is disposed"); }
}
