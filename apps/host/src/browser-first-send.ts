import { createHash } from "node:crypto";
import type { DraftBrowserContinuation, DraftBrowserCreationReceipt } from "@agent-desktop/shared";
import type { HostStore } from "./store";
import type { DraftBrowserWorkers, DraftBrowserHandle } from "./browser-draft-workers";
import type { WorkerSession } from "./omp-workers/runtime";

const unknown = (message: string, cause?: unknown) => Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code: "OUTCOME_UNKNOWN" as const });
const operationId = (commandId: string, requestId: string) => `browser-send-${createHash("sha256").update(`${commandId}\0${requestId}`).digest("hex")}`;
export const isBrowserContinuationOutcomeUnknown = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "OUTCOME_UNKNOWN";

const matchesCreationReceipt = (receipt: DraftBrowserCreationReceipt | undefined,
  page: DraftBrowserContinuation["pages"][number], workerPid: number): boolean => Boolean(receipt
  && receipt.outcome === "completed" && receipt.workerPid === workerPid && page.target.workerPid === workerPid
  && receipt.tab.name === page.target.name && receipt.tab.targetId === page.target.targetId
  && receipt.tab.backend === page.backend && receipt.tab.kindTag === page.kindTag);

export interface BrowserContinuationReceipt {
  version: 1;
  ownerId: string;
  sessionId: string;
  pages: readonly { name: string; targetId: string; backend: "worker" | "cmux"; operationId: string }[];
}

/** Live first-Send handoff. Durable command replay is owned by the enclosing
 * session.create journal; once a native reservation is attempted this method
 * never recaptures, recreates, or substitutes a browser owner. */
export class BrowserFirstSend {
  private readonly attempted = new Set<string>();
  constructor(private readonly store: HostStore, private readonly workers: DraftBrowserWorkers) {}

  async attach(commandId: string, submittedDraft: { id: string; revision: number } | undefined,
    continuation: DraftBrowserContinuation | undefined, destination: WorkerSession): Promise<BrowserContinuationReceipt | undefined> {
    if (!continuation) return;
    if (!submittedDraft || submittedDraft.id !== continuation.owner.draftId) throw new Error("Browser continuation requires the submitted draft identity.");
    const draft = this.store.getDraft(submittedDraft.id);
    if (!draft || draft.revision !== submittedDraft.revision) throw new Error("The browser draft changed before session creation.");
    const owner = { hostId: this.store.host.id, ownerId: continuation.owner.ownerId,
      draftId: continuation.owner.draftId, draftRevision: continuation.owner.draftRevision };
    const status = this.workers.inspect(owner);
    if (status.state !== "ready" || status.workerPid === undefined) throw new Error("The original draft browser is unavailable; its session was not created.");
    const source = await this.workers.getExisting(owner);
    if (!source || source.workerPid !== status.workerPid) throw new Error("The original draft browser changed before session creation.");
    const checked = continuation.pages.map(page => {
      const saved = this.store.draftBrowserCreations.get(owner.ownerId, page.request), receipt = saved?.receipt;
      if (!matchesCreationReceipt(receipt, page, source.workerPid)) throw new Error("A browser page no longer matches its durable creation receipt.");
      return { page, operationId: operationId(commandId, page.request.requestId) };
    });
    if (this.attempted.has(commandId)) throw unknown("The original browser handoff was already attempted and will not be replayed.");
    let dispatched = false;
    try {
      for (const item of checked) {
        this.attempted.add(commandId);
        dispatched = true;
        const reserved = await source.reserveBrowserEvaluation(item.page.target, item.operationId);
        if (reserved.phase !== "ready" || reserved.ownerId !== owner.ownerId) throw unknown("The original browser reservation was not confirmed.");
        const evaluation = await source.openBrowserEvaluation(item.page.target, item.operationId, item.page.backend === "worker" ? "cdp" : "cmux", 30_000);
        try { await destination.installBrowserContinuation({ sourceOwnerId: owner.ownerId, operationId: item.operationId,
          target: item.page.target, kindTag: item.page.kindTag }, evaluation); }
        catch (error) { await evaluation.dispose().catch(() => {}); throw error; }
      }
      return Object.freeze({ version: 1 as const, ownerId: owner.ownerId, sessionId: destination.id,
        pages: Object.freeze(checked.map(({page,operationId}) => Object.freeze({ name:page.target.name,targetId:page.target.targetId,backend:page.backend,operationId }))) });
    } catch (error) {
      if (dispatched || isBrowserContinuationOutcomeUnknown(error))
        throw unknown("The original browser handoff outcome is unknown. The session was retained and this operation will not be replayed.", error);
      throw error;
    }
  }
}
