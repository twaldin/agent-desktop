import { validBrowserFrameTarget, type BrowserFrameTarget } from "@agent-desktop/shared";
import { projectNativeErrorMessage } from "../omp-workers/events";
import type { BrowserEvaluationReservation } from "./owner";

export interface WorkerBrowserReservationStatus extends BrowserFrameTarget {
  ownerId: string;
  operationId: string;
  phase: "pending" | "ready" | "failed";
  error?: string;
}
interface Owner {
  readonly id: string;
  reserveBrowserEvaluation(target: Readonly<{ name: string; targetId: string }>, operationId: string): Promise<Readonly<BrowserEvaluationReservation>>;
}
interface Reservation {
  owner: Owner;
  status: WorkerBrowserReservationStatus;
  task: Promise<void>;
  native?: Readonly<BrowserEvaluationReservation>;
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
function targetForWorker(value: unknown, pid: number): BrowserFrameTarget {
  if (!validBrowserFrameTarget(value) || value.workerPid !== pid) throw new Error("Browser reservation belongs to a stale or invalid worker.");
  return { workerPid: value.workerPid, name: value.name, targetId: value.targetId };
}
function requireOperation(operationId: unknown): asserts operationId is string {
  if (!identity(operationId)) throw new Error("Invalid browser reservation operation.");
}
function failed(record: Reservation, error: unknown): void {
  if (record.status.phase === "failed") return;
  record.status.phase = "failed";
  record.status.error = (error instanceof Error ? projectNativeErrorMessage(error.message) : "").slice(0, 8192) || "Browser reservation failed.";
}

/** Worker-local operation receipts. The original NativeBrowserOwner keeps all
 * native handles and cleanup authority; these records never reconstruct them. */
export class WorkerBrowserReservations {
  readonly #records = new Map<string, Reservation>();
  #closing?: Promise<void>;
  constructor(readonly pid: number, readonly readOwner: () => Owner) {}

  #active(): Owner {
    if (this.#closing) throw new Error("The browser worker is stopping.");
    const owner = this.readOwner();
    if (!identity(owner.id)) throw new Error("The browser worker has no valid original owner.");
    if (this.#closing) throw new Error("The browser worker is stopping.");
    return owner;
  }

  #current(record: Reservation): void {
    const owner = this.#active();
    if (owner !== record.owner || owner.id !== record.status.ownerId) throw new Error("The original browser reservation owner changed.");
  }

  #lookup(target: BrowserFrameTarget, operationId: string): Reservation | undefined {
    const record = this.#records.get(operationId);
    if (record && (record.status.name !== target.name || record.status.targetId !== target.targetId)) {
      throw new Error("Browser reservation operation changed target.");
    }
    return record;
  }

  reserve(value: BrowserFrameTarget, operationId: string): Promise<WorkerBrowserReservationStatus> {
    let target: BrowserFrameTarget, owner: Owner, record: Reservation | undefined;
    try {
      target = targetForWorker(value, this.pid); requireOperation(operationId);
      record = this.#lookup(target, operationId);
      if (record) {
        try { this.#current(record); } catch (error) { failed(record, error); }
      }
      else {
        owner = this.#active();
        // Retiring, failed and pending records all retain their slot. A new id
        // must not replay an operation whose native outcome is still retained.
        if (this.#records.size >= 64) throw new Error("Browser reservation receipt limit reached.");
        if ([...this.#records.values()].some(item => item.status.name === target.name)) throw new Error("Original browser name already has a reservation operation.");
        const completion = Promise.withResolvers<void>();
        record = { owner, status: { ...target, ownerId: owner.id, operationId, phase: "pending" }, task: completion.promise };
        this.#records.set(operationId, record);
        const original = record;
        void Promise.resolve().then(async () => {
          this.#current(original);
          const native = await owner.reserveBrowserEvaluation({ name: target.name, targetId: target.targetId }, operationId);
          original.native = native;
          if (native.ownerSessionId !== original.status.ownerId || native.name !== target.name || native.targetId !== target.targetId || native.operationId !== operationId) {
            throw new Error("Native reservation returned a different original owner or target.");
          }
          await native.ready;
          this.#current(original); native.assertCurrent();
          this.#current(original);
          if (original.status.phase === "failed") return;
          original.status.phase = "ready";
        }).then(completion.resolve, error => { failed(original, error); completion.resolve(); });
      }
    } catch (error) { return Promise.reject(error); }
    const retained = record;
    return retained.task.then(() => this.#status(retained));
  }

  #status(record: Reservation): WorkerBrowserReservationStatus {
    try {
      this.#current(record);
      if (record.status.phase === "ready") record.native!.assertCurrent();
      this.#current(record);
    } catch (error) { failed(record, error); }
    return { ...record.status };
  }

  inspect(value: BrowserFrameTarget, operationId: string): WorkerBrowserReservationStatus | null {
    const target = targetForWorker(value, this.pid); requireOperation(operationId);
    const record = this.#lookup(target, operationId);
    if (record) return this.#status(record);
    this.#active();
    return null;
  }

  /** Lookup only. No implicit reservation or replacement owner is admitted. */
  assertReady(value: BrowserFrameTarget, operationId: string, ownerId: string): Owner {
    const target = targetForWorker(value, this.pid); requireOperation(operationId);
    const record = this.#lookup(target, operationId);
    if (!record || record.status.ownerId !== ownerId) throw new Error("Original browser reservation is missing.");
    const status = this.#status(record);
    if (status.phase !== "ready") throw new Error(status.error ?? "Original browser reservation is not ready.");
    return record.owner;
  }

  /** Stops new receipt admission and joins work. Native resource destruction
   * belongs to the concurrently invoked original owner's dispose operation. */
  dispose(): Promise<void> {
    if (this.#closing) return this.#closing;
    const completion = Promise.withResolvers<void>(); this.#closing = completion.promise;
    void Promise.all([...this.#records.values()].map(record => record.task)).then(() => completion.resolve(), completion.reject);
    return completion.promise;
  }
}

type ReservationOperation = { operation: "reserveBrowserEvaluation" | "inspectBrowserEvaluationReservation"; args: { target: BrowserFrameTarget; operationId: string } };
interface ReservationClient { readonly pid: number; request(operation: ReservationOperation): Promise<unknown> }
const pendingRequests = new WeakMap<ReservationClient, Map<string, { inspectOnly: boolean; promise: Promise<unknown> }>>();

export function browserReservationOutcomeUnknown(cause: unknown): Error & { code: "OUTCOME_UNKNOWN" } {
  return Object.assign(new Error("The original browser reservation outcome is unknown; inspect the same operation before continuing.", { cause }), { code: "OUTCOME_UNKNOWN" as const });
}
function parseStatus(value: unknown, target: BrowserFrameTarget, ownerId: string, operationId: string): WorkerBrowserReservationStatus {
  if (!value || typeof value !== "object") throw new Error("Worker omitted its original browser reservation receipt.");
  const row = value as Record<string, unknown>;
  if (row.ownerId !== ownerId || row.workerPid !== target.workerPid || row.name !== target.name || row.targetId !== target.targetId || row.operationId !== operationId
    || !["pending", "ready", "failed"].includes(row.phase as string)
    || (row.phase === "failed" ? typeof row.error !== "string" || !row.error || row.error.length > 8192 : row.error !== undefined)) {
    throw new Error("Worker returned a stale or invalid browser reservation receipt.");
  }
  return { ...target, ownerId, operationId, phase: row.phase as WorkerBrowserReservationStatus["phase"], ...(row.phase === "failed" ? { error: row.error as string } : {}) };
}

/** A lost dispatched reservation reply is unknown. Status is lookup-only in
 * the same owned client; neither path reconnects, retries or creates a target. */
export async function requestWorkerBrowserReservation(client: ReservationClient,
  ownerId: string, value: BrowserFrameTarget, operationId: string, inspectOnly = false): Promise<WorkerBrowserReservationStatus | null> {
  const target = targetForWorker(value, client.pid); requireOperation(operationId);
  if (!identity(ownerId)) throw new Error("Invalid browser reservation owner.");
  let requests = pendingRequests.get(client);
  if (!requests) { requests = new Map(); pendingRequests.set(client, requests); }
  const key = JSON.stringify([inspectOnly, ownerId, target.workerPid, target.name, target.targetId, operationId]);
  let pending = requests.get(key);
  if (!pending) {
    if ([...requests.values()].filter(item => item.inspectOnly === inspectOnly).length >= (inspectOnly ? 8 : 64)) {
      throw new Error("Browser reservation request limit reached.");
    }
    const completion = Promise.withResolvers<unknown>();
    pending = { inspectOnly, promise: completion.promise };
    requests.set(key, pending);
    const original = pending;
    const retained = requests;
    void Promise.resolve().then(() => client.request({ operation: inspectOnly ? "inspectBrowserEvaluationReservation" : "reserveBrowserEvaluation", args: { target: { ...target }, operationId } }))
      .then(completion.resolve, completion.reject);
    void completion.promise.finally(() => { if (retained.get(key) === original) retained.delete(key); }).catch(() => {});
  }
  try {
    const result = await pending.promise;
    if (client.pid !== target.workerPid) throw new Error("The original browser worker changed during reservation.");
    return inspectOnly && result === null ? null : parseStatus(result, target, ownerId, operationId);
  } catch (cause) {
    if (inspectOnly) throw cause;
    throw browserReservationOutcomeUnknown(cause);
  }
}
