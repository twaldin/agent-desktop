import { parseSessionProcessNativeReply, parseSessionProcessReceipt, parseSessionProcessesRequest,
  type SessionProcessMutation, type SessionProcessReceipt,
  type SessionProcessesRequest, type SessionProcessesResult } from "../../../packages/shared/src/session-processes";
import { NativeProcessesAdmissionError } from "./omp/session-processes";
import { SessionProcessRecords } from "./session-process-records";

export interface SessionProcessesHandle {
  workerFailure?: { message: string };
  nativeProcesses(request: Exclude<SessionProcessesRequest, { action: "receipt" }>): Promise<unknown>;
}
interface Pending { promise: Promise<SessionProcessesResult>; errors: unknown[] }

/** Host lifetime owner of process requests. A journal claim precedes every
 * mutation, and its durable finish precedes confirmation. Losing the original
 * worker or a finish write never authorizes replay. Receipt lookup is independent
 * of worker availability and remains usable while shutdown joins admitted work. */
export class SessionProcessRequests {
  readonly #pending = new Set<Pending>();
  readonly #mutations = new Map<string, Pending>();
  #stopping = false;
  #disposal: Promise<void> | undefined;
  constructor(private readonly records: SessionProcessRecords, private readonly options: {
    getExistingHandle(sessionId: string): Promise<SessionProcessesHandle | undefined>;
    isCurrent(sessionId: string, handle: SessionProcessesHandle): boolean;
  }) {}
  #key(sessionId: string, operationId: string): string { return JSON.stringify([sessionId, operationId]); }
  #history(sessionId: string, receipt: SessionProcessReceipt): SessionProcessReceipt {
    return receipt.status === "pending" && !this.#mutations.has(this.#key(sessionId, receipt.operationId))
      ? { ...receipt, status: "unknown" } : receipt;
  }
  request(sessionId: string, raw: SessionProcessesRequest): Promise<SessionProcessesResult> {
    try {
      if (!sessionId || sessionId.length > 200 || /[\u0000-\u001f\u007f]/.test(sessionId)) throw new Error("Invalid process session.");
      const request = parseSessionProcessesRequest(raw);
      if (request.action === "receipt") {
        const receipt = this.records.get(sessionId, request.operationId);
        return Promise.resolve({ action: "receipt", receipt: receipt ? this.#history(sessionId, receipt) : null });
      }
      if (request.owner && request.owner.nativeSessionId !== sessionId) throw new Error("The process request belongs to another session.");
      const mutation = request.action === "stop" || request.action === "restart" || request.action === "input" ? request : undefined;
      if (mutation && this.records.get(sessionId, mutation.operationId)) {
        // claim checks the complete original input hash, even after retirement.
        const prior = this.records.claim(mutation);
        return Promise.resolve({ action: "mutation", receipt: this.#history(sessionId, prior.receipt) });
      }
      if (this.#stopping) throw new NativeProcessesAdmissionError("The native process host is stopping.");
      if (this.#pending.size >= 16) throw new NativeProcessesAdmissionError("Too many native process requests are pending.");
      if (mutation) {
        const claim = this.records.claim(mutation);
        if (!claim.fresh) return Promise.resolve({ action: "mutation", receipt: this.#history(sessionId, claim.receipt) });
      }
      const entry: Pending = { promise: undefined!, errors: [] };
      this.#pending.add(entry);
      const key = mutation && this.#key(sessionId, mutation.operationId);
      if (key) this.#mutations.set(key, entry);
      // No callback runs before both request and operation reservations exist.
      entry.promise = Promise.resolve().then(() => this.#run(sessionId, request, mutation, entry)).finally(() => {
        this.#pending.delete(entry);
        if (key) this.#mutations.delete(key);
      });
      return entry.promise;
    } catch (error) { return Promise.reject(error); }
  }
  #current(sessionId: string, handle: SessionProcessesHandle): void {
    if (this.#stopping || handle.workerFailure || !this.options.isCurrent(sessionId, handle))
      throw new NativeProcessesAdmissionError("The original native process worker is unavailable.");
  }
  async #run(sessionId: string, request: Exclude<SessionProcessesRequest, { action: "receipt" }>,
    mutation: SessionProcessMutation | undefined, entry: Pending): Promise<SessionProcessesResult> {
    let dispatched = false, received = false, result: SessionProcessesResult;
    const base = mutation && { action: mutation.action, operationId: mutation.operationId, owner: mutation.owner, target: mutation.target };
    try {
      if (this.#stopping) throw new NativeProcessesAdmissionError("The native process host is stopping.");
      const handle = await this.options.getExistingHandle(sessionId);
      if (!handle) throw new NativeProcessesAdmissionError("Open the original session before inspecting its processes.");
      this.#current(sessionId, handle);
      dispatched = true;
      const raw = await handle.nativeProcesses(request);
      received = true;
      // Parsing must run before retirement checks so a malformed dispatched
      // response is retained by a shutdown already joining this request.
      const native = parseSessionProcessNativeReply(raw, request, sessionId);
      if (native.action === "mutation") result = { action: "mutation", receipt: parseSessionProcessReceipt({ ...base, status: "completed", row: native.row }) };
      else result = native;
      this.#current(sessionId, handle);
    } catch (error) {
      // Only a pre-dispatch admission failure proves that no effect occurred.
      // An admission error thrown by the original worker is also an explicit
      // zero-dispatch result; post-read retirement is deliberately unknown.
      const rejected = !dispatched || (!received && error instanceof NativeProcessesAdmissionError);
      if (!(error instanceof NativeProcessesAdmissionError)) entry.errors.push(error);
      if (!base) throw error;
      result = { action: "mutation", receipt: rejected
        ? { ...base, status: "rejected", message: "The original native process request was not admitted." }
        : { ...base, status: "unknown" } };
    }
    if (mutation && result.action === "mutation") {
      try { result = { action: "mutation", receipt: this.records.finish(mutation, result.receipt) }; }
      catch (error) { entry.errors.push(error); throw error; }
    }
    return result;
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#stopping = true;
    const admitted = [...this.#pending];
    this.#disposal = Promise.resolve().then(async () => {
      await Promise.allSettled(admitted.map(entry => entry.promise));
      const errors = admitted.flatMap(entry => entry.errors);
      if (errors.length) throw new AggregateError(errors, "Native process requests or durable receipts failed during host shutdown.");
    });
    return this.#disposal;
  }
}
