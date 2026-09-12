import { projectNativeErrorMessage } from "../omp-workers/events";
import type { NativeBrowserOwner } from "./owner";
import type { WorkerBrowserReservations } from "./reservation";
import { copyEvaluationBinding, copyEvaluationDescriptor, copyEvaluationFrame, copyEvaluationValue, evaluationKey,
  type BrowserEvaluationBinding, type BrowserEvaluationDescriptor, type BrowserEvaluationFrame, type NativeCdpEvaluation, type NativeCmuxEvaluation } from "./evaluation-wire";

interface ChannelRecord {
  binding: BrowserEvaluationBinding;
  key: string;
  owner: NativeBrowserOwner;
  opening: Promise<BrowserEvaluationDescriptor>;
  native?: Readonly<NativeCdpEvaluation> | Readonly<NativeCmuxEvaluation>;
  descriptor?: BrowserEvaluationDescriptor;
  post: (frame: BrowserEvaluationFrame) => void;
  started: boolean;
  retiring: boolean;
  disposal?: Promise<void>;
  failures: unknown[];
  pending: Set<Promise<void>>;
  sequence: number;
  deliveries: Map<number, { failed: boolean; delivered: boolean; error?: unknown }>;
  cdpRequests: Set<string>;
}

function cdpRequestIds(data:string):string[]{
  const value=JSON.parse(data) as {id?:unknown;sessionId?:unknown;params?:{sessionId?:unknown;message?:unknown}};const result:string[]=[];
  if(typeof value.id==="string"||Number.isSafeInteger(value.id))result.push(JSON.stringify(["top",typeof value.sessionId==="string"?value.sessionId:null,value.id]));
  if(typeof value.params?.message==="string"){
    const inner=JSON.parse(value.params.message) as {id?:unknown};
    if(typeof inner.id==="string"||Number.isSafeInteger(inner.id))result.push(JSON.stringify(["nested",typeof value.params.sessionId==="string"?value.params.sessionId:null,inner.id]));
  }
  return result;
}

/** Original child only. Receipt slots survive failure/retirement. Disposing a
 * channel removes evaluator access, never the resource or its reservation. */
export class WorkerBrowserEvaluationChannels {
  readonly #records = new Map<string, ChannelRecord>();
  #closing?: Promise<void>;
  #pending = 0;
  readonly #cancelled = new Error("Original browser evaluation is retired.");
  constructor(readonly reservations: WorkerBrowserReservations, readonly readOwner: () => NativeBrowserOwner,
    readonly post: (binding: BrowserEvaluationBinding, frame: BrowserEvaluationFrame) => void) {}

  #current(record: ChannelRecord): void {
    if (this.#closing || record.retiring) throw this.#cancelled;
    if (this.reservations.assertReady(record.binding, record.binding.operationId, record.binding.ownerId) !== record.owner
      || this.readOwner() !== record.owner) throw new Error("Original browser evaluation owner changed.");
    if (this.#closing || record.retiring) throw this.#cancelled;
  }
  #lookup(binding: BrowserEvaluationBinding): ChannelRecord {
    const key = evaluationKey(binding), record = this.#records.get(binding.operationId);
    if (!record || record.key !== key) throw new Error("Original browser evaluation channel is missing or changed.");
    return record;
  }
  #remember(record: ChannelRecord, error: unknown): void {
    if (error === this.#cancelled) return;
    if (!record.failures.includes(error) && record.failures.length < 256) record.failures.push(error);
  }
  #fail(record: ChannelRecord, error: unknown): never {
    this.#remember(record, error);
    void this.#dispose(record).catch(() => {});
    throw error;
  }

  open(input: BrowserEvaluationBinding, timeoutMs: number): Promise<BrowserEvaluationDescriptor> {
    try {
      const binding = Object.freeze(copyEvaluationBinding(input)), key = evaluationKey(binding);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new Error("Invalid browser evaluation opening timeout.");
      const prior = this.#records.get(binding.operationId);
      if (prior) {
        if (prior.key !== key) throw new Error("Browser evaluation operation changed binding.");
        this.#current(prior);
        return prior.opening.then(value => { this.#current(prior); return copyEvaluationValue(value); });
      }
      if (this.#closing || this.#records.size >= 64) throw new Error("Browser evaluation admission is closed or full.");
      const owner = this.readOwner();
      if (this.reservations.assertReady(binding, binding.operationId, binding.ownerId) !== owner) throw new Error("Original ready browser reservation is required.");
      const ready = Promise.withResolvers<BrowserEvaluationDescriptor>();
      const record: ChannelRecord = { binding, key, owner, opening: ready.promise, post: frame => this.#post(record, frame),
        started: false, retiring: false, failures: [], pending: new Set(), sequence: 0, deliveries: new Map(),cdpRequests:new Set() };
      this.#records.set(binding.operationId, record); // Publish before native callbacks.
      void ready.promise.catch(() => {});
      void Promise.resolve().then(async () => {
        this.#current(record);
        record.native = await owner.openBrowserEvaluation(binding, binding.operationId, binding.backend, timeoutMs);
        // Retain the returned handle before descriptor parsing or owner checks.
        const native = record.native;
        if (!native || typeof native.dispose !== "function") throw new Error("Native evaluator omitted channel cleanup.");
        let value: BrowserEvaluationDescriptor;
        if (binding.backend === "cdp") {
          const cdp = native as NativeCdpEvaluation;
          if (typeof cdp.start !== "function" || typeof cdp.receive !== "function") throw new Error("Native CDP evaluator omitted its channel operations.");
          value = { binding, backend: "cdp", descriptor: cdp.descriptor };
        } else {
          const cmux = native as NativeCmuxEvaluation;
          if (typeof cmux.request !== "function") throw new Error("Native cmux evaluator omitted its request operation.");
          value = { binding, backend: "cmux", state: cmux.state };
        }
        const copied = copyEvaluationDescriptor(value, binding);
        this.#current(record);
        record.descriptor = copied;
        return copied;
      }).then(ready.resolve, error => {
        this.#remember(record, error);
        ready.reject(error); // Settle allocation before cleanup joins it.
        void this.#dispose(record).catch(() => {});
      });
      return ready.promise.then(value => { this.#current(record); return copyEvaluationValue(value); });
    } catch (error) { return Promise.reject(error); }
  }

  #post(record: ChannelRecord, frame: BrowserEvaluationFrame): void {
    try {
      if (record.descriptor?.backend !== "cdp") throw new Error("CDP frame preceded its original descriptor.");
      const copied = copyEvaluationFrame(frame, record.descriptor.descriptor.channel);
      if(copied.kind==="data")for(const id of cdpRequestIds(copied.data))record.cdpRequests.delete(id);
      if (copied.kind === "data" || copied.kind === "ack") this.#current(record);
      else {
        for (const error of copied.errors ?? []) this.#remember(record, new Error(error));
        // Terminal routing survives stopping. Publish retirement before observers.
        void this.#dispose(record).catch(() => {});
      }
      this.post(copyEvaluationBinding(record.binding), copied);
    } catch (error) { this.#fail(record, error); }
  }

  async start(binding: BrowserEvaluationBinding): Promise<void> {
    const record = this.#lookup(binding);
    await record.opening;
    try {
      this.#current(record);
      if (record.descriptor?.backend !== "cdp") throw new Error("Only CDP evaluation has a frame receiver.");
      if (record.started) return;
      record.started = true;
      (record.native as NativeCdpEvaluation).start(record.post);
      this.#current(record);
    } catch (error) { this.#fail(record, error); }
  }

  receive(binding: BrowserEvaluationBinding, frame: BrowserEvaluationFrame): void {
    const record = this.#lookup(binding);
    try {
      // Close is an explicit channel drain even after owner retirement. It does
      // not reopen or destroy the original resource. No host-generated ACK.
      if (record.descriptor?.backend !== "cdp" || !record.started) throw new Error("Original CDP channel has not started.");
      const copied = copyEvaluationFrame(frame, record.descriptor.descriptor.channel);
      if(copied.kind==="data")for(const id of cdpRequestIds(copied.data))record.cdpRequests.add(id);
      if (copied.kind === "close") {
        for (const error of copied.errors ?? []) this.#remember(record, new Error(error));
        void this.#dispose(record).catch(() => {});
        return;
      }
      this.#current(record);
      (record.native as NativeCdpEvaluation).receive(copied);
    } catch (error) { this.#fail(record, error); }
  }

  /** Delivery is part of the admitted operation: a lost reply must not erase an
   * operational error that native considered delivered to this wrapper. */
  async request(binding: BrowserEvaluationBinding, sequence: number, method: string, params: Record<string, unknown>, options: { timeoutMs?: number } | undefined,
    deliver: (ok: boolean, value?: unknown, error?: unknown) => void): Promise<void> {
    const record = this.#lookup(binding);
    this.#current(record);
    if (record.descriptor?.backend !== "cmux") throw new Error("Original cmux evaluation is not ready.");
    if (!Number.isSafeInteger(sequence) || sequence <= record.sequence) throw new Error("Cmux evaluation request was repeated or reordered.");
    if (record.pending.size >= 64 || this.#pending >= 64 || [...this.#records.values()].reduce((count, item) => count + item.deliveries.size, 0) >= 64) throw new Error("Cmux evaluation request capacity reached.");
    const input = copyEvaluationValue({ method, params, options });
    this.#current(record);
    record.sequence = sequence;
    const receipt: { failed: boolean; delivered: boolean; error?: unknown } = { failed: false, delivered: false };
    record.deliveries.set(sequence, receipt);
    const done = Promise.withResolvers<void>(); record.pending.add(done.promise); this.#pending++;
    let failure: unknown, failed = false, value: unknown;
    try {
      try {
        value = copyEvaluationValue(await (record.native as NativeCmuxEvaluation).request(input.method, input.params, input.options));
      } catch (error) { failed = true; failure = error; }
      // Preserve parsing/native failures before a post-read retirement check.
      try { this.#current(record); }
      catch (error) {
        if (failed) this.#remember(record, failure);
        failed = true; failure = error;
      }
      receipt.failed = failed; receipt.error = failure; receipt.delivered = true;
      try { deliver(!failed, failed ? undefined : value, failed ? failure : undefined); }
      catch (error) {
        if (failed) this.#remember(record, failure);
        this.#remember(record, error);
        void this.#dispose(record).catch(() => {});
        throw error;
      }
    } finally { this.#pending--; record.pending.delete(done.promise); done.resolve(); }
  }

  acknowledge(binding: BrowserEvaluationBinding, sequence: number): void {
    const record = this.#lookup(binding);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid cmux response acknowledgement.");
    if (record.deliveries.get(sequence)?.delivered) record.deliveries.delete(sequence);
  }

  #dispose(record: ChannelRecord): Promise<void> {
    if (record.disposal) return record.disposal;
    record.retiring = true;
    const done = Promise.withResolvers<void>(); record.disposal = done.promise;
    void done.promise.catch(() => {});
    void (async () => {
      await record.opening.catch(() => {});
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => record.native?.dispose()),
        ...record.pending,
      ]);
      for (const receipt of record.deliveries.values()) if (receipt.failed) this.#remember(record, receipt.error);
      record.deliveries.clear();
      for (const outcome of outcomes) if (outcome.status === "rejected") this.#remember(record, outcome.reason);
      if (record.failures.length) throw new AggregateError(record.failures, `Original browser evaluation drain failed: ${record.failures.map(error => projectNativeErrorMessage(error instanceof Error ? error.message : "Unknown evaluation failure")).join("; ").slice(0, 8192)}`);
    })().then(done.resolve, done.reject);
    return done.promise;
  }
  close(binding: BrowserEvaluationBinding): Promise<void> { return this.#dispose(this.#lookup(binding)); }
  inspect(binding: BrowserEvaluationBinding): Readonly<{ descriptor: BrowserEvaluationDescriptor; started: boolean; sequence: number; pending: number; unacknowledged: number }> {
    const record = this.#lookup(binding); this.#current(record);
    if (!record.descriptor) throw new Error("Original browser evaluation descriptor is unavailable.");
    return Object.freeze({ descriptor: copyEvaluationValue(record.descriptor), started: record.started,
      sequence: record.sequence, pending: record.pending.size+record.cdpRequests.size, unacknowledged: record.deliveries.size });
  }
  dispose(): Promise<void> {
    if (this.#closing) return this.#closing;
    const done = Promise.withResolvers<void>(); this.#closing = done.promise;
    void done.promise.catch(() => {});
    const tasks = [...this.#records.values()].map(record => this.#dispose(record));
    void Promise.allSettled(tasks).then(outcomes => {
      const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
      if (errors.length) done.reject(new AggregateError(errors, `Browser evaluation channels failed to drain: ${errors.map(error => error instanceof Error ? error.message : "Unknown drain failure").join("; ").slice(0, 8192)}`)); else done.resolve();
    });
    return done.promise;
  }
}
