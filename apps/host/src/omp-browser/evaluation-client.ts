import type { BrowserFrameTarget } from "@agent-desktop/shared";
import { copyEvaluationBinding, copyEvaluationDescriptor, copyEvaluationFrame, copyEvaluationValue, evaluationKey,
  type BrowserCdpDescriptor, type BrowserCmuxState, type BrowserEvaluationBinding, type BrowserEvaluationDescriptor,
  type BrowserEvaluationFrame, type BrowserEvaluationOperation } from "./evaluation-wire";

export type WorkerBrowserEvaluation = {
  readonly backend: "cdp";
  readonly descriptor: Readonly<BrowserCdpDescriptor>;
  start(post: (frame: BrowserEvaluationFrame) => void): Promise<void>;
  receive(frame: BrowserEvaluationFrame): void;
  dispose(): Promise<void>;
} | {
  readonly backend: "cmux";
  readonly state: Readonly<BrowserCmuxState>;
  request(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
};

/** The exact source WorkerClient, never a PID lookup or replacement connection. */
export interface BrowserEvaluationClient {
  readonly pid: number;
  request<T>(operation: BrowserEvaluationOperation): Promise<T>;
  subscribeBrowserEvaluation(binding: BrowserEvaluationBinding, post: (frame: BrowserEvaluationFrame) => void, lost: (error: unknown) => void): () => void;
  postBrowserEvaluationFrame(binding: BrowserEvaluationBinding, frame: BrowserEvaluationFrame): void;
}

const clients = new WeakMap<BrowserEvaluationClient, Map<string, EvaluationRecord>>();
function unknownOutcome(cause: unknown): Error {
  return Object.assign(new Error("Original browser evaluation delivery is unknown; do not replay the operation.", { cause }), { code: "OUTCOME_UNKNOWN" as const });
}

class EvaluationRecord {
  readonly ready = Promise.withResolvers<WorkerBrowserEvaluation>();
  readonly #drained = Promise.withResolvers<void>();
  readonly #work = new Set<Promise<unknown>>();
  readonly #errors: unknown[] = [];
  readonly #cancelled = new Error("Original browser evaluation is retired.");
  #descriptor?: BrowserEvaluationDescriptor;
  #post?: (frame: BrowserEvaluationFrame) => void;
  #unsubscribe?: () => void;
  #start?: Promise<void>;
  #started = false;
  #openingIssued = false;
  #opening?: Promise<void>;
  #closing?: Promise<void>;
  #retired = false;
  #lost = false;
  #sequence = 0;
  #sawClose = false;
  #sawDrained = false;

  constructor(readonly client: BrowserEvaluationClient, readonly binding: Readonly<BrowserEvaluationBinding>) {
    void this.ready.promise.catch(() => {});
    void this.#drained.promise.catch(() => {});
  }

  #remember(error: unknown): void {
    if (error === this.#cancelled || this.#errors.includes(error)) return;
    if (this.#errors.length < 256) this.#errors.push(error);
    else if (this.#errors.length === 256) this.#errors.push(new Error("Additional browser evaluation errors exceeded the retained limit."));
  }
  #current(): void {
    if (this.#retired || this.#lost) throw this.#cancelled;
    if (this.client.pid !== this.binding.workerPid) throw new Error("Original browser worker changed.");
  }
  #fail(error: unknown): void {
    this.#remember(error);
    this.#retired = true;
    void this.dispose().catch(() => {});
  }
  #lose = (error: unknown): void => {
    this.#lost = true;
    this.#remember(error);
    this.#drained.reject(error);
    this.#fail(error);
  };

  open(timeoutMs: number): void {
    // Store the opening before subscription callbacks or asynchronous dispatch.
    const opened = Promise.withResolvers<void>();
    this.#opening = opened.promise;
    void Promise.resolve().then(async () => {
      this.#current();
      const unsubscribe = this.client.subscribeBrowserEvaluation(this.binding, this.#frame, this.#lose);
      this.#unsubscribe = unsubscribe;
      this.#current();
      this.#openingIssued = true;
      const value = await this.client.request<BrowserEvaluationDescriptor>({ operation: "openBrowserEvaluation", args: { binding: { ...this.binding }, timeoutMs } });
      this.#descriptor = copyEvaluationDescriptor(value, this.binding);
      const captured = this.#descriptor;
      this.#current();
      const handle: WorkerBrowserEvaluation = this.#descriptor.backend === "cdp"
        ? Object.freeze({ backend: "cdp" as const, descriptor: Object.freeze({ ...this.#descriptor.descriptor }),
          start: (post: (frame: BrowserEvaluationFrame) => void) => this.start(post),
          receive: (frame: BrowserEvaluationFrame) => this.receive(frame), dispose: () => this.dispose() })
        : Object.freeze({ backend: "cmux" as const,
          get state() { return copyEvaluationValue(captured.backend === "cmux" ? captured.state : undefined) as BrowserCmuxState; },
          request: (method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }) => this.request(method, params, options),
          dispose: () => this.dispose() });
      this.ready.resolve(handle);
    }).then(opened.resolve, error => {
      this.ready.reject(this.#openingIssued ? unknownOutcome(error) : error);
      this.#fail(error);
      opened.resolve();
    });
  }

  start(post: (frame: BrowserEvaluationFrame) => void): Promise<void> {
    try {
      this.#current();
      if (typeof post !== "function") throw new Error("Invalid browser evaluation receiver.");
      if (this.#post && this.#post !== post) throw new Error("Browser evaluation already has a receiver.");
      if (this.#start) return this.#start;
      const started = Promise.withResolvers<void>();
      this.#start = started.promise;
      void this.#start.catch(() => {});
      this.#post = post; // Publish before native start can synchronously replay.
      void Promise.resolve().then(() => {
        this.#current();
        return this.client.request({ operation: "startBrowserEvaluation", args: { binding: { ...this.binding } } });
      }).then(() => { this.#started = true; this.#current(); started.resolve(); }, error => { throw error; })
        .catch(error => { this.#fail(error); started.reject(error); });
      return started.promise;
    } catch (error) { return Promise.reject(error); }
  }

  #frame = (value: BrowserEvaluationFrame): void => {
    try {
      if (this.#descriptor?.backend !== "cdp") throw new Error("CDP frame arrived without its original descriptor.");
      const frame = copyEvaluationFrame(value, this.#descriptor.descriptor.channel);
      if (frame.kind === "close" || frame.kind === "drained") {
        if (frame.kind === "close" ? this.#sawClose : this.#sawDrained) return;
        if (frame.kind === "close") this.#sawClose = true;
        else this.#sawDrained = true;
        this.#retired = true;
        for (const message of frame.errors ?? []) this.#remember(new Error(message));
      } else if (this.#retired) return;
      if (!this.#post) throw new Error("CDP frame arrived before receiver installation.");
      try { this.#post(frame); }
      finally {
        // Completion cannot escape a nested callback before its exception is retained.
        if (frame.kind === "drained") queueMicrotask(() => this.#drained.resolve());
      }
      if (frame.kind === "close" || frame.kind === "drained") void this.dispose().catch(() => {});
    } catch (error) { this.#fail(error); }
  };

  receive(frame: BrowserEvaluationFrame): void {
    try {
      if (this.#descriptor?.backend !== "cdp" || !this.#post) throw new Error("CDP evaluation has not started.");
      const copy = copyEvaluationFrame(frame, this.#descriptor.descriptor.channel);
      if (copy.kind === "drained") throw new Error("Destination cannot publish the source's native drain receipt.");
      if (this.#retired) return; // Queued credits/close never resurrect a retired route.
      if (copy.kind === "close") {
        for (const message of copy.errors ?? []) this.#remember(new Error(message));
        this.#retired = true;
      } else this.#current();
      this.client.postBrowserEvaluationFrame(this.binding, copy);
      if (copy.kind === "close") void this.dispose().catch(() => {});
    } catch (error) { this.#fail(error); throw error; }
  }

  request(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<Record<string, unknown>> {
    try {
      this.#current();
      if (this.#work.size >= 64 || this.#sequence >= Number.MAX_SAFE_INTEGER) throw new Error("Browser evaluation request capacity reached.");
      const args = copyEvaluationValue({ binding: { ...this.binding }, sequence: ++this.#sequence, method, params, ...(options === undefined ? {} : { options }) });
      const completion = Promise.withResolvers<Record<string, unknown>>();
      const drained = Promise.withResolvers<void>();
      this.#work.add(drained.promise);
      void completion.promise.catch(() => {});
      void Promise.resolve().then(() => {
        this.#current();
        return this.client.request<Record<string, unknown>>({ operation: "requestBrowserEvaluation", args });
      }).then(value => { this.#current(); completion.resolve(copyEvaluationValue(value)); }, error => { throw error; })
        .catch(error => {
          if (this.#retired || this.#lost) this.#remember(error);
          if (error && typeof error === "object" && "code" in error && error.code === "OUTCOME_UNKNOWN") this.#fail(error);
          completion.reject(this.#lost ? unknownOutcome(error) : error);
        }).finally(() => { this.#work.delete(drained.promise); drained.resolve(); });
      return completion.promise;
    } catch (error) { return Promise.reject(error); }
  }

  dispose(): Promise<void> {
    if (this.#closing) return this.#closing;
    const done = Promise.withResolvers<void>();
    this.#closing = done.promise;
    this.#retired = true;
    void this.#closing.catch(() => {});
    // Do not wait for opening/start before initiating cancellation: native allocation
    // can need its retained dispose to settle. Original-resource cleanup stays separate.
    const closing = this.#openingIssued && !this.#lost
      ? Promise.resolve().then(() => this.client.request({ operation: "disposeBrowserEvaluation", args: { binding: { ...this.binding } } }))
      : Promise.resolve();
    void closing.catch(() => {});
    void (async () => {
      const results = await Promise.allSettled([closing, this.#opening, this.#start, ...this.#work]);
      for (const result of results) if (result.status === "rejected") this.#remember(result.reason);
      if (this.#started) try { await this.#drained.promise; } catch (error) { this.#remember(error); }
      // Include failures from synchronous terminal callbacks before publishing completion.
      await Promise.resolve();
      // A pre-dispatch disposal rejection is not proof of native drain. Keep the
      // bounded route until its terminal frame or definitive process loss.
      if (results[0]?.status === "fulfilled" || this.#sawDrained || this.#lost) this.#unsubscribe?.();
      if (this.#errors.length) throw new AggregateError(this.#errors, "Original browser evaluation cleanup failed.");
    })().then(done.resolve, done.reject);
    return done.promise;
  }
}

/** One retained attempt per original reservation; failed attempts never reopen. */
export function openWorkerBrowserEvaluation(client: BrowserEvaluationClient, ownerId: string, target: BrowserFrameTarget,
  operationId: string, backend: "cdp" | "cmux", timeoutMs: number): Promise<WorkerBrowserEvaluation> {
  try {
    const binding = Object.freeze(copyEvaluationBinding({ ...target, ownerId, operationId, backend }));
    if (binding.workerPid !== client.pid || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid original browser evaluation opening.");
    let records = clients.get(client);
    if (!records) { records = new Map(); clients.set(client, records); }
    const key = evaluationKey(binding), prior = records.get(key);
    if (prior) return prior.ready.promise;
    if (records.size >= 64) throw new Error("Browser evaluation channel limit reached.");
    if ([...records.values()].some(record => record.binding.operationId === operationId || record.binding.name === binding.name)) throw new Error("Original browser evaluation binding changed.");
    const record = new EvaluationRecord(client, binding);
    records.set(key, record);
    record.open(timeoutMs);
    return record.ready.promise;
  } catch (error) { return Promise.reject(error); }
}
