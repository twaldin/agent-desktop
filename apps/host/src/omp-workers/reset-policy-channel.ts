import {
  RESET_POLICY_MAX_INFLIGHT,
  parseResetPolicyWireRequest,
  parseResetPolicyWireResponse,
  projectResetPolicyError,
  type ResetPolicyWireBinding,
  type ResetPolicyWireEvidence,
  type ResetPolicyWireOperation,
  type ResetPolicyWireRequest,
  type ResetPolicyWireResponse,
  type ResetPolicyWireResult,
} from "./reset-policy-wire";

// Settlement messages must remain deliverable when every ordinary slot is a
// join awaiting one of those settlements. This is a separate, bounded reserve.
const MAX_SETTLEMENT_REQUESTS = RESET_POLICY_MAX_INFLIGHT;
type Reply = ResetPolicyWireResponse["response"];
type Pending = {
  // The original serialized envelope: retransmission after transport loss
  // resends this exact request under its original ID, never a fresh one.
  readonly request: ResetPolicyWireRequest;
  readonly settlement: boolean;
  sent: boolean;
  // Inside the send callback: a reentrant reconnect must not post it twice.
  sending: boolean;
  reply?: Reply;
  resolve(value: ResetPolicyWireResult): void;
  reject(error: unknown): void;
};

function settlementOperation(operation: ResetPolicyWireOperation): boolean {
  return operation.kind === "complete" || (operation.kind === "checkpoint" &&
    ["finished", "answer", "setting-written"].includes(operation.event.phase));
}

/** Parent-side dispatcher, constructed only after the original WorkerClient's
 * init snapshot is validated. The supplied handler closes over that client's
 * host-owned authority; it must not look up an owner from packet identifiers.
 */
export class ResetPolicyHostChannel {
  readonly #binding: ResetPolicyWireBinding;
  readonly #handle: (request: ResetPolicyWireRequest) => Promise<ResetPolicyWireResult>;
  readonly #post: (response: ResetPolicyWireResponse) => void;
  readonly #pending = new Map<number, boolean>();
  readonly #errors: unknown[] = [];
  #errorCount = 0;
  #lastId = 0;
  #closing = false;
  #sealed = false;
  #drain: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  constructor(binding: ResetPolicyWireBinding, handle: (request: ResetPolicyWireRequest) => Promise<ResetPolicyWireResult>,
    post: (response: ResetPolicyWireResponse) => void) {
    this.#binding = Object.freeze({ ...binding });
    this.#handle = handle;
    this.#post = post;
  }

  async receive(value: unknown): Promise<void> {
    const request = parseResetPolicyWireRequest(value, this.#binding);
    if (request.requestId <= this.#lastId) throw new Error("Reset-policy request was already delivered or reordered");
    this.#lastId = request.requestId;
    const settlement = settlementOperation(request.operation);
    let count = 0;
    for (const item of this.#pending.values()) if (item === settlement) count++;
    const refusal = this.#sealed || (this.#closing && !allowedWhileClosing(request.operation))
      ? "Reset-policy owner is closing"
      : count >= RESET_POLICY_MAX_INFLIGHT ? "Reset-policy owner capacity exceeded" : undefined;
    if (refusal) {
      try {
        this.#post({ type: "resetPolicyResponse", binding: this.#binding, requestId: request.requestId,
          response: { ok: false, error: { name: "Error", message: refusal } } });
      } catch (error) {
        this.#rememberError(error);
        this.#checkDrain();
        throw error;
      }
      return;
    }
    this.#pending.set(request.requestId, settlement);
    try {
      let response: ResetPolicyWireResponse;
      try {
        const result = await this.#handle(request);
        // Parse dispatched results before considering retirement. A malformed
        // late result is still an operational failure, not a clean cancellation.
        response = parseResetPolicyWireResponse({ type: "resetPolicyResponse", binding: this.#binding,
          requestId: request.requestId, response: { ok: true, result } }, this.#binding);
        if (!response.response.ok || !matches(request.operation, response.response.result)) throw new Error("Reset-policy owner returned the wrong result kind");
      } catch (error) {
        this.#rememberError(error);
        response = { type: "resetPolicyResponse", binding: this.#binding, requestId: request.requestId,
          response: { ok: false, error: projectResetPolicyError(error) } };
      }
      try { this.#post(response); }
      catch (error) { this.#rememberError(error); throw error; }
    } finally {
      this.#pending.delete(request.requestId);
      this.#checkDrain();
    }
  }

  beginClose(): void { this.#closing = true; }

  /** The original child's native drain/exit, not elapsed time, ends production. */
  finish(): Promise<void> {
    this.#closing = this.#sealed = true;
    this.#drain ??= Promise.withResolvers<void>();
    this.#checkDrain();
    return this.#drain.promise;
  }

  #rememberError(error: unknown): void {
    this.#errorCount = Math.min(Number.MAX_SAFE_INTEGER, this.#errorCount + 1);
    if (this.#errors.length < RESET_POLICY_MAX_INFLIGHT) this.#errors.push(error);
  }

  #checkDrain(): void {
    if (!this.#drain || this.#pending.size) return;
    if (this.#errors.length) this.#drain.reject(new AggregateError([...this.#errors], `Reset-policy owner channel did not drain cleanly (${this.#errorCount} failures)`));
    else this.#drain.resolve();
  }
}

function allowedWhileClosing(operation: ResetPolicyWireOperation): boolean {
  return settlementOperation(operation) || operation.kind === "join" ||
    (operation.kind === "checkpoint" && operation.event.phase === "joined");
}

function matches(operation: ResetPolicyWireOperation, result: ResetPolicyWireResult): boolean {
  switch (operation.kind) {
    case "checkpoint": return result.kind === "checkpointed";
    case "decision.prepare": return result.kind === "decision.prepared";
    case "decision.bind": return result.kind === "decision.bound";
    case "admit": return result.kind === "admission.execute" || result.kind === "admission.join" || result.kind === "admission.hold";
    case "join": return result.kind === "joined";
    case "complete": return result.kind === "completed";
  }
}

/** Child-side RPC ownership. The parent must separately authenticate the actual
 * WorkerClient and durable owner; a matching envelope alone grants no authority.
 * Close admission before native disposal, then seal only after native callbacks
 * have finished producing their final checkpoints. No timer fabricates a drain.
 *
 * Recovery lifecycle (all reversible, none of it terminal):
 * - `pause` fences new ordinary admission; settlements still flow.
 * - `transportLost` fails ordinary in-flight RPCs locally with the transport
 *   error (their outcome is unknown) and retains settlement RPCs unsent under
 *   their original IDs; settlements requested while offline wait the same way.
 * - `reconnect` retransmits retained settlements once, in ID order, without
 *   resuming admission. `resume` reopens admission only over a live, idle channel.
 * `disconnect` and `finish` remain terminal and are never undone by reconnect.
 */
export class ResetPolicyChannel {
  readonly #binding: ResetPolicyWireBinding;
  readonly #post: (request: ResetPolicyWireRequest) => void;
  readonly #pending = new Map<number, Pending>();
  // Every caller receives its own error. Keep bounded drain diagnostics even
  // when a long-lived worker repeatedly encounters an unavailable owner.
  readonly #errors: unknown[] = [];
  #errorCount = 0;
  #nextId = 0;
  #paused = false;
  #closing = false;
  #sealed = false;
  #disconnected = false;
  #retransmitting = false;
  #lost: Error | undefined;
  #drain: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  #quiet: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  constructor(binding: ResetPolicyWireBinding, post: (request: ResetPolicyWireRequest) => void) {
    this.#binding = Object.freeze({ ...binding });
    this.#post = post;
  }

  request(nativeSessionId: string, passId: string, operation: ResetPolicyWireOperation, evidence?: ResetPolicyWireEvidence): Promise<ResetPolicyWireResult> {
    if (this.#disconnected) return Promise.reject(this.#lost);
    if (this.#sealed || (this.#closing && !allowedWhileClosing(operation))) return Promise.reject(new Error("Reset-policy channel is closing"));
    const settlement = settlementOperation(operation);
    if (!settlement) {
      if (this.#lost) return Promise.reject(this.#lost);
      if (this.#paused) return Promise.reject(new Error("Reset-policy channel is paused"));
    }
    let count = 0;
    for (const pending of this.#pending.values()) if (pending.settlement === settlement) count++;
    if (count >= (settlement ? MAX_SETTLEMENT_REQUESTS : RESET_POLICY_MAX_INFLIGHT)) return Promise.reject(new Error("Reset-policy channel capacity exceeded"));
    let request: ResetPolicyWireRequest;
    try {
      request = parseResetPolicyWireRequest({ type: "resetPolicyRequest", requestId: ++this.#nextId,
        binding: this.#binding, nativeSessionId, passId, operation, ...(evidence === undefined ? {} : { evidence }) }, this.#binding);
    } catch (error) { return Promise.reject(error); }
    const deferred = Promise.withResolvers<ResetPolicyWireResult>();
    const pending: Pending = { ...deferred, request, settlement, sent: false, sending: false };
    this.#pending.set(request.requestId, pending);
    // An offline settlement waits for reconnect; nothing is sent or fabricated meanwhile.
    if (!this.#lost) this.#send(request.requestId, pending);
    return deferred.promise;
  }

  #send(id: number, pending: Pending): void {
    pending.sending = true;
    try {
      this.#post(pending.request);
    } catch (error) {
      // A settlement whose transport was reported lost inside this send stays
      // retained for retransmission; any other send failure is the caller's.
      if (this.#lost && pending.settlement) return;
      // Even a reentrant response cannot erase a failure from the enclosing
      // send callback. Settle only after that callback has returned.
      if (this.#pending.delete(id)) {
        this.#rememberError(error);
        pending.reject(error);
      }
      this.#checkDrain();
      return;
    } finally { pending.sending = false; }
    // Transport loss reported during the send leaves delivery unconfirmed.
    if (!this.#lost) pending.sent = true;
    if (pending.reply) this.#settle(id, pending, pending.reply);
  }

  receive(value: unknown): void {
    if (this.#disconnected || this.#lost) return;
    let message: ResetPolicyWireResponse;
    try { message = parseResetPolicyWireResponse(value, this.#binding); }
    catch (error) {
      this.disconnect(error instanceof Error ? error : new Error("Malformed reset-policy response"));
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending || pending.reply) return;
    pending.reply = message.response;
    if (pending.sent) this.#settle(message.requestId, pending, message.response);
  }

  #settle(id: number, pending: Pending, reply: Reply): void {
    if (!this.#pending.delete(id)) return;
    if (reply.ok && matches(pending.request.operation, reply.result)) pending.resolve(reply.result);
    else {
      const error = reply.ok ? new Error("Reset-policy response does not match its request") : Object.assign(new Error(reply.error.message), { name: reply.error.name });
      this.#rememberError(error);
      pending.reject(error);
    }
    this.#checkDrain();
  }

  /** Reversible new-admission fence. Settlements of already admitted work still flow. */
  pause(): void { this.#paused = true; }

  /** Reopens admission. Requires a live transport with nothing pending; never undoes close or disconnect. */
  resume(): void {
    if (this.#disconnected || this.#sealed || this.#closing) throw new Error("Reset-policy channel is closing");
    if (this.#lost) throw new Error("Reset-policy transport is not connected");
    if (this.#pending.size) throw new Error("Reset-policy channel still has pending requests");
    this.#paused = false;
  }

  /** Called by the transport adapter on a real send/connection failure. Ordinary
   * RPCs fail locally with that error: their outcome is unknown and no response
   * is fabricated. Settlement RPCs keep their IDs and promises for reconnect. */
  transportLost(error: Error): void {
    if (this.#disconnected || this.#lost) return;
    this.#lost = error;
    let interrupted = false;
    for (const [id, pending] of this.#pending) {
      if (pending.settlement) { pending.sent = false; continue; }
      this.#pending.delete(id);
      interrupted = true;
      pending.reject(error);
    }
    if (interrupted) this.#rememberError(error);
    this.#checkDrain();
  }

  /** Retransmits retained settlements once, in original ID order. Admission stays fenced. */
  reconnect(): void {
    if (this.#disconnected) throw new Error("Reset-policy channel is disconnected");
    this.#lost = undefined;
    if (this.#retransmitting) return;
    this.#retransmitting = true;
    try {
      for (const [id, pending] of this.#pending) {
        if (pending.sent || pending.sending) continue;
        this.#send(id, pending);
        if (this.#lost) return;
      }
    } finally { this.#retransmitting = false; }
  }

  /** Resolves once nothing is pending, whatever the outcomes were. Never rejects. */
  quiesce(): Promise<void> {
    if (!this.#pending.size) return Promise.resolve();
    this.#quiet ??= Promise.withResolvers<void>();
    return this.#quiet.promise;
  }

  beginClose(): void { this.#closing = true; }

  /** Invoke after native drain, not before it: final checkpoints still need RPC. */
  finish(): Promise<void> {
    this.#closing = this.#sealed = true;
    this.#drain ??= Promise.withResolvers<void>();
    this.#checkDrain();
    return this.#drain.promise;
  }

  disconnect(error: Error): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    this.#lost = error;
    this.#closing = this.#sealed = true;
    this.#rememberError(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#checkDrain();
  }

  #checkDrain(): void {
    if (this.#pending.size) return;
    if (this.#quiet) { this.#quiet.resolve(); this.#quiet = undefined; }
    if (!this.#drain) return;
    if (this.#errors.length) this.#drain.reject(new AggregateError([...this.#errors], `Reset-policy channel did not drain cleanly (${this.#errorCount} failures)`));
    else this.#drain.resolve();
  }

  #rememberError(error: unknown): void {
    this.#errorCount = Math.min(Number.MAX_SAFE_INTEGER, this.#errorCount + 1);
    if (this.#errors.length < RESET_POLICY_MAX_INFLIGHT) this.#errors.push(error);
  }
}
