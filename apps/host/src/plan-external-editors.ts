import { parsePlanExternalEditorList, parsePlanExternalEditorRequest, type PlanExternalEditorCapabilities,
  type PlanExternalEditorList, type PlanExternalEditorObservation, type PlanExternalEditorRequest,
  type PlanExternalEditorResult } from "../../../packages/shared/src/plan-external-editor";
import { parsePlanMutationRequest, type PlanMutationRequest } from "../../../packages/shared/src/session-plan";
import type { WorkerSession } from "./omp-workers/runtime";
import type { PlanEditorTerminalRun, PlanEditorTerminals } from "./plan-editor-terminal";
import type { PlanExternalEditorRecords } from "./plan-external-editor-records";

export interface PlanEditorOwner {
  handle: Pick<WorkerSession, "getPlanExternalEditorAvailable" | "preparePlanExternalEditor" | "preparePlanDecision" | "subscribeWorkerFailure">;
  /** Captures the original catalog, worker handle and native identity; no reacquisition. */
  assertCurrent(): void;
}
interface Job {
  request: PlanExternalEditorRequest;
  terminalId: string;
  cancelRequested: boolean;
  phase: "preparing" | "editing" | "committing";
  run?: PlanEditorTerminalRun;
  cancellation?: Promise<void>;
  ownerFailure?: unknown;
  completion: Promise<void>;
}

/** Durable admission with an in-memory owner for the original running editor.
 * Status reads never acquire a worker, start a pane, or replay a Plan write. */
export class PlanExternalEditors {
  private readonly jobs = new Map<string, Job>();
  private readonly failures = new Map<string, unknown>();
  private stopping = false;
  private shutdown?: Promise<void>;
  constructor(private readonly options: {
    hostId: string;
    controlEpoch: string;
    records: PlanExternalEditorRecords;
    terminals: Pick<PlanEditorTerminals, "start" | "recovery" | "cancelOriginal">;
    capture(sessionId: string): Promise<PlanEditorOwner | undefined>;
  }) {}

  async capabilities(sessionId: string): Promise<PlanExternalEditorCapabilities> {
    const base = { protocolVersion: 1 as const, hostId: this.options.hostId, controlEpoch: this.options.controlEpoch };
    if (this.stopping) return { ...base, available: false, reason: "The owning host is stopping its editors." };
    const owner = await this.options.capture(sessionId);
    if (!owner) return { ...base, available: false, reason: "The original Plan worker is unavailable." };
    owner.assertCurrent();
    const available = await owner.handle.getPlanExternalEditorAvailable();
    owner.assertCurrent();
    if (this.stopping) return { ...base, available: false, reason: "The owning host is stopping its editors." };
    return available ? { ...base, available: true }
      : { ...base, available: false, reason: "No editor configured on the owning host. Set VISUAL or EDITOR." };
  }

  start(raw: PlanExternalEditorRequest): PlanExternalEditorObservation {
    const request = parsePlanExternalEditorRequest(raw);
    if (this.options.records.get(request)) return this.observe(request);
    if (this.stopping) throw new Error("The owning host is stopping its editors.");
    if (request.controlEpoch !== this.options.controlEpoch) throw new Error("Refresh the owning host's editor capability before a new request.");
    const unresolved = this.options.records.unsettledProcesses().filter(record => !this.jobs.has(record.request.requestId));
    if (unresolved.some(record => record.request.sessionId === request.sessionId))
      throw new Error("This session has an unresolved original editor process. Inspect and cancel that original job first.");
    if (this.jobs.size + unresolved.length >= 8) throw new Error("Wait for an active Plan editor to settle before starting another.");
    if ([...this.jobs.values()].some(job => job.request.sessionId === request.sessionId))
      throw new Error("This session already owns an active Plan editor. Inspect or cancel it first.");
    const claim = this.options.records.claim(request);
    if (!claim.fresh) return this.observe(request);
    const job: Job = { request, terminalId: claim.record.terminalId, cancelRequested: false, phase: "preparing", completion: Promise.resolve() };
    this.jobs.set(request.requestId, job);
    // Reserve both the request and capacity before any callback can run.
    job.completion = Promise.resolve().then(() => this.run(job));
    void job.completion.then(() => this.jobs.delete(request.requestId), error => {
      this.jobs.delete(request.requestId); this.failures.set(request.requestId, error);
      // Storage failure makes new effects unsafe; keep observation/recovery usable.
      this.stopping = true;
    });
    return this.observe(request);
  }

  observe(raw: PlanExternalEditorRequest): PlanExternalEditorObservation {
    const request = parsePlanExternalEditorRequest(raw);
    const result = this.options.records.observe(request, this.options.controlEpoch);
    if (result.state === "pending" && this.failures.has(request.requestId)) return { ...result, state: "settled",
      result: { outcome: "unknown", message: "The editor result could not be saved. Inspect the original Plan and retained editor output; this request will not replay." } };
    return result;
  }

  list(sessionId: string, cursor?: string): PlanExternalEditorList {
    const page = this.options.records.list(sessionId, cursor);
    return parsePlanExternalEditorList({ protocolVersion: 1, hostId: this.options.hostId, sessionId,
      items: page.items.map(request => this.observe(request)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) },
    this.options.hostId, sessionId);
  }

  recovery(raw: PlanExternalEditorRequest): string | undefined {
    const request = parsePlanExternalEditorRequest(raw), record = this.options.records.get(request);
    if (!record || !record.launched || this.observe(request).result?.outcome !== "unknown"
      || !record.result && this.jobs.has(request.requestId)) return;
    const result = this.options.terminals.recovery(request.requestId);
    return result?.outcome === "completed" ? result.content : undefined;
  }

  async cancel(raw: PlanExternalEditorRequest): Promise<PlanExternalEditorObservation> {
    const request = parsePlanExternalEditorRequest(raw);
    const record = this.options.records.get(request); // Refuse same-ID changed input even after restart.
    const job = this.jobs.get(request.requestId);
    if (job) {
      job.cancelRequested = true;
      const settled = await Promise.allSettled([this.cancelRun(job), job.completion]);
      const errors = settled.flatMap(value => value.status === "rejected" ? [value.reason] : []);
      const retainedFailure = this.failures.get(request.requestId);
      if (retainedFailure) errors.push(retainedFailure);
      if (errors.length) throw new AggregateError(errors, "The original Plan editor did not drain cleanly.");
    }
    if (!job && record?.launched && !record.processSettled) {
      await this.options.terminals.cancelOriginal(request.requestId, record.terminalId);
      this.options.records.markProcessSettled(request);
      // Stopping the process cannot tell us whether a lost native write applied.
      // Retain the original unknown outcome; never replay it.
    }
    return this.observe(request);
  }

  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    for (const job of this.jobs.values()) job.cancelRequested = true;
    this.shutdown = (async () => {
      const settled = await Promise.allSettled([...this.jobs.values()].map(job => this.cancel(job.request)));
      const errors = settled.flatMap(value => value.status === "rejected" ? [value.reason] : []);
      errors.push(...this.failures.values());
      if (errors.length) throw new AggregateError(errors, "Plan editor shutdown did not complete cleanly.");
    })();
    return this.shutdown;
  }

  private cancelRun(job: Job): Promise<void> | undefined {
    if (!job.run || job.phase === "committing") return;
    if (!job.cancellation) {
      // Assign before invoking a potentially reentrant native callback.
      job.cancellation = Promise.resolve().then(() => job.run!.cancel());
      void job.cancellation.catch(() => {});
    }
    return job.cancellation;
  }

  private async run(job: Job): Promise<void> {
    let dispatched = false, unlisten: (() => void) | undefined;
    let result: PlanExternalEditorResult;
    const cancelled = (): PlanExternalEditorResult => ({ outcome: "cancelled" });
    try {
      const owner = await this.options.capture(job.request.sessionId);
      if (!owner) throw new Error("The original Plan worker is unavailable.");
      const current = () => {
        owner.assertCurrent();
        if (job.cancelRequested || this.stopping) throw new Error("The original editor request was cancelled before commit.");
      };
      if (job.cancelRequested) result = cancelled();
      else {
        current();
        const prepared = await owner.handle.preparePlanExternalEditor(job.request);
        current();
        unlisten = owner.handle.subscribeWorkerFailure(() => {
          job.cancelRequested = true;
          // Retain cancellation failure on the original job; never report a clean drain.
          job.ownerFailure = new Error("The original Plan worker stopped before the editor settled.");
          void this.cancelRun(job)?.catch(() => {});
        });
        current();
        this.options.records.markDispatched(job.request); dispatched = true;
        job.run = await this.options.terminals.start(job.terminalId, prepared, current);
        job.phase = "editing";
        if (job.cancelRequested || this.stopping) await this.cancelRun(job);
        const edited = await job.run.completion;
        if (job.ownerFailure) throw job.ownerFailure;
        if (edited.outcome === "cancelled" || job.cancelRequested || this.stopping) result = cancelled();
        else {
          current();
          const edit = job.request.edit;
          const request: PlanMutationRequest = parsePlanMutationRequest({ sessionId: job.request.sessionId, ticket: job.request.ticket,
            reviewId: job.request.reviewId, reviewRevision: job.request.reviewRevision,
            mutation: edit.kind === "plan" ? { action: "edit", content: edited.content }
              : { action: "document", renderColumns: edit.renderColumns, documentAction: { kind: "annotate",
                expectedDocumentRevision: job.request.documentRevision, target: edit.target, note: edited.content } } });
          job.phase = "committing";
          // The actual worker validates the original ticket/document in its
          // mutation admission, including changes after the host-side check.
          const preparedResult = await owner.handle.preparePlanDecision(job.request.requestId, request);
          owner.assertCurrent();
          if (preparedResult.execution || preparedResult.transition) throw new Error("The editor returned an unexpected Plan transition.");
          result = { outcome: preparedResult.receipt.outcome, receipt: preparedResult.receipt };
        }
      }
    } catch (error) {
      result = { outcome: dispatched ? "unknown" : job.cancelRequested ? "cancelled" : "not-submitted",
        message: publicMessage(error) };
    } finally {
      try { unlisten?.(); } catch (error) { this.failures.set(job.request.requestId, error); }
    }
    // A terminal exit callback may arrive before the asynchronous close result.
    // Join both retained paths before publishing an outcome or releasing capacity.
    let processSettled = false;
    if (job.run) {
      const drained = await Promise.allSettled([job.run.completion, job.cancellation]);
      processSettled = drained[0]!.status === "fulfilled";
      const errors = drained.flatMap(value => value.status === "rejected" ? [value.reason] : []);
      if (errors.length) {
        const error = new AggregateError(errors, "The original Plan editor did not drain cleanly.");
        this.failures.set(job.request.requestId, error);
        if (result.outcome !== "applied") result = { outcome: "unknown", message: publicMessage(error) };
      }
    }
    let saved = false;
    try {
      if (processSettled) this.options.records.markProcessSettled(job.request);
      this.options.records.finish(job.request, result); saved = true;
    } finally {
      // Preserve edited recovery bytes on either conflict or a failed durable
      // write, while removing the private input and scratch after verified exit.
      if (processSettled) job.run!.cleanup({ preserveEditedResult: !saved || result.outcome === "unknown" });
    }
  }
}

function publicMessage(_error: unknown): string {
  // Backend failures may contain editor commands, paths or environment values.
  // Public recovery remains useful without projecting those private details.
  return "The original editor, Plan owner, or result storage could not be confirmed. Refresh the original Plan and inspect retained editor output; this request will not replay.";
}
