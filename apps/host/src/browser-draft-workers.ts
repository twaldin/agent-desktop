import type { WorkerBrowserEvaluation } from "./omp-browser/evaluation-client";
import { DraftBrowserAdmissions, type DraftBrowserAdmission, type DraftBrowserAdmissionRequest } from "./browser-draft-admission";
import type { DraftBrowserOwnerRecord } from "./browser-draft-owner-records";
import type { WorkerBrowserOwner, WorkerRuntime } from "./omp-workers";
import { browserReservationOutcomeUnknown } from "./omp-browser/reservation";
import type { HostStore } from "./store";
import type { BrowserFrameTarget, BrowserHistoryEntry } from "@agent-desktop/shared";

export type DraftBrowserHandle = Pick<WorkerBrowserOwner, "id" | "cwd" | "workerPid" | "getBrowserMetadata" | "createBrowserTab" | "controlBrowser" | "getBrowserFrame" | "closeBrowserTab" | "inspectBrowserTab" | "reserveBrowserEvaluation" | "inspectBrowserEvaluationReservation" | "openBrowserEvaluation" | "enableBrowserRecovery"> & {getBrowserHistory(target:BrowserFrameTarget):Promise<BrowserHistoryEntry[]>};
interface Entry {
  admission: DraftBrowserAdmission;
  setup: Promise<WorkerBrowserOwner>;
  ready: Promise<DraftBrowserHandle>;
  worker?: WorkerBrowserOwner;
  unsubscribe?: () => void;
  failure?: unknown;
  closing?: Promise<void>;
}
export interface DraftBrowserOwnerStatus {
  state: "absent" | "starting" | "ready" | "unavailable" | "retired";
  record?: Readonly<DraftBrowserOwnerRecord>;
  workerPid?: number;
  error?: string;
}

/** Host-owned workers, independent of client connections. Native create request journaling belongs above this layer. */
export class DraftBrowserWorkers {
  private readonly admissions: DraftBrowserAdmissions;
  private readonly entries = new Map<string, Entry>();
  private closing?: Promise<void>;
  constructor(private readonly store: HostStore, defaultDirectory: string,
    private readonly runtime: Pick<WorkerRuntime, "createBrowserOwner">, private readonly limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid draft browser worker limit");
    this.admissions = new DraftBrowserAdmissions(store, defaultDirectory);
  }

  acquire(request: DraftBrowserAdmissionRequest): Promise<DraftBrowserHandle> {
    try {
      if (this.closing) throw new Error("Draft browser workers are stopping");
      const existing = this.entries.get(request.ownerId);
      if (existing) {
        this.match(request, existing.admission.record);
        this.assertCurrent(existing);
        return existing.ready;
      }
      if (this.entries.size >= this.limit) throw new Error("Draft browser worker limit reached");
      const admission = this.admissions.admit(request);
      if (!admission.fresh) throw new Error("The saved draft browser owner has no live worker; it cannot be recreated automatically");
      // Publish the entry before calling any asynchronous or reentrant worker factory.
      const setup = Promise.withResolvers<WorkerBrowserOwner>();
      const ready = Promise.withResolvers<DraftBrowserHandle>();
      const entry: Entry = { admission, setup: setup.promise, ready: ready.promise };
      this.entries.set(admission.record.id, entry);
      void entry.ready.catch(() => {});
      void Promise.resolve().then(() => {
        this.assertCurrent(entry);
        return this.runtime.createBrowserOwner({ id: admission.record.id, cwd: admission.record.cwd });
      }).then(setup.resolve, setup.reject);
      void entry.setup.then(worker => {
        entry.worker = worker;
        if (worker.id !== admission.record.id || worker.cwd !== admission.record.cwd || !Number.isSafeInteger(worker.workerPid) || worker.workerPid <= 0) throw new Error("Draft browser worker returned a different owner");
        this.assertCurrent(entry);
        entry.unsubscribe = worker.subscribeWorkerFailure(failure => this.fail(entry, new Error(failure.message)));
        this.assertCurrent(entry);
        return this.handle(entry, worker);
      }).then(ready.resolve, error => { this.fail(entry, error); ready.reject(error); });
      return entry.ready;
    } catch (error) { return Promise.reject(error); }
  }

  /** Durable history and current registry state only; never starts or probes a worker. */
  inspect(request: DraftBrowserAdmissionRequest): DraftBrowserOwnerStatus {
    const record = this.store.draftBrowserOwners.get(request.ownerId);
    this.match(request, record);
    if (!record) return { state: "absent" };
    const entry = this.entries.get(record.id);
    const state = record.retiredAt !== undefined ? "retired" : !entry || entry.closing ? "unavailable" : entry.worker ? "ready" : "starting";
    return { state, record, ...(entry?.worker ? { workerPid: entry.worker.workerPid } : {}),
      ...(entry?.failure === undefined ? {} : { error: entry.failure instanceof Error ? entry.failure.message : String(entry.failure) }) };
  }

  /** Join only an existing setup. Missing history never creates a worker through lookup. */
  async getExisting(request: DraftBrowserAdmissionRequest): Promise<DraftBrowserHandle | undefined> {
    const saved = this.store.draftBrowserOwners.get(request.ownerId);
    this.match(request, saved);
    const entry = this.entries.get(request.ownerId);
    if (!entry || entry.closing || this.closing) return undefined;
    this.assertCurrent(entry);
    const handle = await entry.ready;
    this.assertCurrent(entry);
    return handle;
  }

  /** Transfers a promoted live worker out of draft lifecycle cleanup. */
  transferToRecovery(request:DraftBrowserAdmissionRequest,workerPid:number):void{
    const record=this.store.draftBrowserOwners.get(request.ownerId);this.match(request,record);
    const entry=this.entries.get(request.ownerId);
    if(!entry||entry.closing||!entry.worker||entry.worker.workerPid!==workerPid)throw new Error("Draft browser recovery owner changed before transfer.");
    entry.unsubscribe?.();entry.unsubscribe=undefined;
    if(this.entries.get(request.ownerId)===entry)this.entries.delete(request.ownerId);
  }

  /** Explicit owner retirement, not a window/client detach callback. Drain even if persistence fails. */
  async retire(request: DraftBrowserAdmissionRequest): Promise<void> {
    const record = this.store.draftBrowserOwners.get(request.ownerId);
    this.match(request, record);
    if (!record) return;
    const errors: unknown[] = [];
    try { this.store.draftBrowserOwners.retire(record.id); } catch (error) { errors.push(error); }
    const entry = this.entries.get(record.id);
    if (entry) try { await this.closeEntry(entry); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Draft browser retirement did not complete");
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const deferred = Promise.withResolvers<void>();
    this.closing = deferred.promise;
    void Promise.allSettled([...this.entries.values()].map(entry => this.closeEntry(entry))).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) deferred.reject(new AggregateError(errors, "Draft browser worker cleanup failed"));
      else deferred.resolve();
    });
    return this.closing;
  }

  private match(request: DraftBrowserAdmissionRequest, record?: Readonly<DraftBrowserOwnerRecord>) {
    if (request.hostId !== this.store.host.id || !request.draftId || !Number.isSafeInteger(request.draftRevision) || request.draftRevision < 1
      || record && (record.id !== request.ownerId || record.draftId !== request.draftId || record.draftRevision !== request.draftRevision)) throw new Error("Draft browser owner binding does not match");
  }

  private assertCurrent(entry: Entry) {
    if (entry.closing || this.closing) throw new Error("Draft browser owner is unavailable");
    try {
      entry.admission.assertCurrent();
      if (entry.worker?.workerFailure) throw new Error(entry.worker.workerFailure.message);
    } catch (error) { this.fail(entry, error); throw error; }
  }

  private fail(entry: Entry, error: unknown) {
    entry.failure ??= error;
    // Retain the rejecting close promise for explicit retirement/shutdown; avoid background unhandled rejection.
    void this.closeEntry(entry).catch(() => {});
  }

  private closeEntry(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    const deferred = Promise.withResolvers<void>();
    entry.closing = deferred.promise;
    void (async () => {
      let worker: WorkerBrowserOwner;
      try { worker = await entry.setup; } catch { return; } // Failed setup is cleaned by WorkerRuntime.
      const errors: unknown[] = [];
      try { entry.unsubscribe?.(); } catch (error) { errors.push(error); }
      try { await worker.dispose(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Draft browser worker cleanup failed");
    })().then(() => {
      if (this.entries.get(entry.admission.record.id) === entry) this.entries.delete(entry.admission.record.id);
      deferred.resolve();
    }, deferred.reject);
    return entry.closing;
  }

  private handle(entry: Entry, worker: WorkerBrowserOwner): DraftBrowserHandle {
    const evaluations = new WeakMap<WorkerBrowserEvaluation, WorkerBrowserEvaluation>();
    const run = async <T>(operation: () => Promise<T>): Promise<T> => {
      this.assertCurrent(entry);
      const result = await operation();
      this.assertCurrent(entry);
      return result;
    };
    return Object.freeze({ id: worker.id, cwd: worker.cwd, workerPid: worker.workerPid,
      getBrowserMetadata: () => run(() => worker.getBrowserMetadata()),
      createBrowserTab: (name: string, url?: string) => run(() => worker.createBrowserTab(name, url)),
      controlBrowser: (request: Parameters<WorkerBrowserOwner["controlBrowser"]>[0]) => run(() => worker.controlBrowser(request)),
      getBrowserHistory: (target: BrowserFrameTarget) => run(() => { if(!worker.getBrowserHistory)throw new Error("Native browser history is unavailable.");return worker.getBrowserHistory(target); }),
      getBrowserFrame: (target: Parameters<WorkerBrowserOwner["getBrowserFrame"]>[0]) => run(() => worker.getBrowserFrame(target)),
      closeBrowserTab: (target: Parameters<WorkerBrowserOwner["closeBrowserTab"]>[0]) => run(() => worker.closeBrowserTab(target)),
      inspectBrowserTab: (target: Parameters<WorkerBrowserOwner["inspectBrowserTab"]>[0]) => run(() => worker.inspectBrowserTab(target)),
      reserveBrowserEvaluation: async (target: Parameters<WorkerBrowserOwner["reserveBrowserEvaluation"]>[0], operationId: string) => {
        this.assertCurrent(entry);
        const result = await worker.reserveBrowserEvaluation(target, operationId);
        try {
          this.assertCurrent(entry);
          return result;
        } catch (error) { throw browserReservationOutcomeUnknown(error); }
      },
      openBrowserEvaluation: async (target: Parameters<WorkerBrowserOwner["openBrowserEvaluation"]>[0], operationId: string, backend: "cdp" | "cmux", timeoutMs: number) => {
        this.assertCurrent(entry);
        const channel = await worker.openBrowserEvaluation(target, operationId, backend, timeoutMs);
        let retirement: Promise<void> | undefined;
        const dispose = () => retirement ??= channel.dispose();
        const current = () => {
          try { this.assertCurrent(entry); }
          catch (error) { void dispose().catch(() => {}); throw error; }
        };
        try { current(); } catch (error) {
          try { await dispose(); } catch (cleanup) { throw browserReservationOutcomeUnknown(new AggregateError([error, cleanup], "Draft evaluator publication and cleanup failed.")); }
          throw browserReservationOutcomeUnknown(error);
        }
        const prior = evaluations.get(channel);
        if (prior) return prior;
        if (channel.backend === "cdp") {
          let receiver: Parameters<typeof channel.start>[0] | undefined, forward: Parameters<typeof channel.start>[0] | undefined;
          const wrapped: WorkerBrowserEvaluation = Object.freeze({ backend: "cdp" as const,
          get descriptor() { return channel.descriptor; },
          start: async (post: Parameters<typeof channel.start>[0]) => {
            current();
            if (receiver && receiver !== post) throw new Error("Browser evaluation already has a receiver.");
            if (!receiver) {
              receiver = post;
              forward = frame => { if (frame.kind === "data" || frame.kind === "ack") current(); post(frame); };
            }
            await channel.start(forward!);
            try { current(); } catch (error) { throw browserReservationOutcomeUnknown(error); }
          },
          receive: (frame: Parameters<typeof channel.receive>[0]) => { if (frame.kind === "data" || frame.kind === "ack") current(); channel.receive(frame); },
          waitForIdle: async (timeoutMs: number) => { current(); await channel.waitForIdle(timeoutMs); current(); },
          dispose,
        });
          evaluations.set(channel, wrapped); return wrapped;
        }
        const wrapped: WorkerBrowserEvaluation = Object.freeze({ backend: "cmux" as const,
          get state() { current(); return channel.state; },
          request: async (...args: Parameters<typeof channel.request>) => {
            current(); const result = await channel.request(...args);
            try { current(); } catch (error) { throw browserReservationOutcomeUnknown(error); }
            return result;
          }, waitForIdle: async (timeoutMs: number) => { current(); await channel.waitForIdle(timeoutMs); current(); }, dispose,
        });
        evaluations.set(channel, wrapped); return wrapped;
      },
      inspectBrowserEvaluationReservation: (target: Parameters<WorkerBrowserOwner["inspectBrowserEvaluationReservation"]>[0], operationId: string) => run(() => worker.inspectBrowserEvaluationReservation(target, operationId)),
      enableBrowserRecovery: worker.enableBrowserRecovery
        ? (socketPath: string, token: string, instanceId: string) => run(() => worker.enableBrowserRecovery!(socketPath, token, instanceId))
        : undefined,
    });
  }
}
