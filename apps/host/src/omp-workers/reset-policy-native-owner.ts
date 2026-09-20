import type {
  CodexResetPolicyOwner, NativeResetAnswer, ResetAdmission, ResetCheckpoint,
  ResetObservation, ResetPass, ResetPermit, ResetPlanSnapshot,
} from "@oh-my-pi/pi-coding-agent";
import type { ResetCreditConsumeIdentity } from "@oh-my-pi/pi-ai";
import { isDeepStrictEqual } from "node:util";
import { ResetPolicyChannel } from "./reset-policy-channel";
import type { ResetObservationWire, ResetPolicyWireEvidence } from "./reset-policy-wire";

type Evidence<K extends ResetPolicyWireEvidence["kind"]> = Extract<ResetPolicyWireEvidence, { kind: K }>;

/** A capability captured from one original native pass. Implementations must
 * retain the actual AgentSession/AuthStorage/Settings instances, not resolve
 * them again by ID. No production factory is supplied by this bridge. */
export interface NativeResetPassContext {
  readonly source: Evidence<"source">;
  dispose(): void;
  assertCurrent(): void;
  plan(snapshot: ResetPlanSnapshot): Promise<Evidence<"plan">>;
  persistence(snapshot: ResetPlanSnapshot, mode: "yes" | "no"): Promise<Evidence<"persistence">>;
  admission(snapshot: ResetPlanSnapshot, actionIndex: number): Promise<{
    evidence: Evidence<"admission">;
    beforeConsume(identity: ResetCreditConsumeIdentity): boolean;
  }>;
  /** `signal` aborts only this decision's native select when the owner pauses
   * or closes; the implementation must cancel that select, never other UI, and
   * never substitute an answer. */
  runDecision(bind: (interactionId: string) => Promise<void>, selectNative: () => Promise<NativeResetAnswer>, signal: AbortSignal): Promise<unknown>;
}

// `fenced` is permanent and names its first cause: a pass captured before a
// pause or a session close never regains authority; only its complete/finished
// settlements still flow.
type Fence = false | "pause" | "close";
type Pass = { readonly native: ResetPass; readonly context: NativeResetPassContext; readonly decisions: Set<AbortController>; fenced: Fence };
type IssuedPermit = { readonly pass: Pass; readonly wire: Omit<ResetPermit, "beforeConsume">; completing: boolean };
type Attempt<T = undefined> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
const MAX_PASSES = 128;
function fenced(pass: Pass): Error { return new Error(`Reset pass authority was fenced by ${pass.fenced}`); }

/** Connects the native awaited callbacks to the original worker's private
 * channel. Evidence capture and the synchronous native consume guard remain
 * child-local; no callback or credential object is serialized.
 *
 * `pause` is reversible recovery fencing: no new capture, and every existing
 * pass permanently loses further authority (planning, decisions, admission,
 * consume guards), while its original complete/finished settlements still
 * reach the original owner and its context is disposed only by `finished`.
 * `resume` reopens capture once no original pass remains.
 *
 * Teardown is split between this owner's local lifetime and the shared channel:
 * `beginSessionClose`/`retireSession` retire only this owner's passes and
 * contexts (a child session leaving a live worker), never touching the channel
 * other owners still use. `beginClose`/`finish` are the whole-owner teardown
 * that the root session composes with the channel's own close and drain. */
export class NativeResetChannelOwner implements CodexResetPolicyOwner {
  readonly #passes = new Map<string, Pass>();
  readonly #capturing = new Set<string>();
  readonly #permits = new WeakMap<ResetPermit, IssuedPermit>();
  readonly #errors: unknown[] = [];
  #errorCount = 0;
  #paused = false;
  #closing = false;
  #retired: Promise<void> | undefined;
  #finished: Promise<void> | undefined;

  /** `onRetired` runs exactly once after every local cleanup attempt settled,
   * whether or not it failed; its own failure is retained like any other. */
  constructor(readonly channel: ResetPolicyChannel, private capture: (pass: ResetPass) => NativeResetPassContext,
    private readonly onRetired?: () => void) {}

  #original(pass: ResetPass): Pass {
    const current = this.#passes.get(pass.passId);
    if (!current || current.native.nativeSessionId !== pass.nativeSessionId
      || !isDeepStrictEqual(current.native, pass)) throw new Error("Reset pass is not the original captured pass");
    return current;
  }

  /** Re-checked after every await: a pause during the await revokes what the
   * original pass may do next, whatever an in-flight reply says. */
  #assertAuthority(pass: Pass): void {
    if (pass.fenced) throw fenced(pass);
    pass.context.assertCurrent();
  }

  #remember(error: unknown): void {
    this.#errorCount = Math.min(Number.MAX_SAFE_INTEGER, this.#errorCount + 1);
    if (this.#errors.length < MAX_PASSES) this.#errors.push(error);
  }

  #dispose(context: NativeResetPassContext): Attempt {
    try { context.dispose(); return { ok: true, value: undefined }; }
    catch (error) { this.#remember(error); return { ok: false, error }; }
  }

  /** Cancels only this pass's registered native selects; no other UI is touched. */
  #cancelDecisions(pass: Pass): void {
    for (const decision of pass.decisions) decision.abort(new Error("Reset decision was cancelled by the owner"));
  }

  #capture(native: ResetPass): Pass {
    let context: NativeResetPassContext | undefined;
    try {
      context = this.capture(native);
      context.assertCurrent();
      // Capture is synchronous but may re-enter close, pause or another capture.
      if (this.#closing || this.#paused || this.#passes.has(native.passId)
        || this.#passes.size + this.#capturing.size > MAX_PASSES) throw new Error("Reset pass capture is unavailable");
      const pass: Pass = { native: structuredClone(native), context, decisions: new Set(), fenced: false };
      this.#passes.set(native.passId, pass);
      return pass;
    } catch (error) {
      this.#remember(error);
      const cleanup = context && this.#dispose(context);
      if (cleanup && !cleanup.ok) throw new AggregateError([error, cleanup.error], "Reset pass capture and cleanup both failed");
      throw error;
    }
  }

  async checkpoint(event: ResetCheckpoint): Promise<void> {
    const native = "pass" in event ? event.pass : event.snapshot.pass;
    let pass: Pass;
    if (event.phase === "started" || event.phase === "joined") {
      if (this.#closing || this.#paused || this.#passes.has(native.passId) || this.#capturing.has(native.passId)
        || this.#passes.size + this.#capturing.size >= MAX_PASSES) throw new Error("Reset pass capture is unavailable");
      this.#capturing.add(native.passId);
      try {
        pass = this.#capture(native);
      } finally { this.#capturing.delete(native.passId); }
    } else pass = this.#original(native);
    // Phases whose success authorizes native's next step. A defined answer
    // authorizes the Settings write; "no answer", persistence proof and the
    // final settlement only record what already happened.
    const authority = event.phase === "started" || event.phase === "joined" || event.phase === "planned"
      || (event.phase === "answer" && event.answer !== undefined);
    let evidence: ResetPolicyWireEvidence | undefined;
    let failure: Attempt = { ok: true, value: undefined };
    try {
      if (authority && pass.fenced) throw fenced(pass);
      if (event.phase === "started" || event.phase === "joined") evidence = pass.context.source;
      else if (event.phase === "planned") {
        pass.context.assertCurrent();
        evidence = await pass.context.plan(event.snapshot);
        this.#assertAuthority(pass);
      } else if (event.phase === "setting-written") {
        // The native Settings.set has already happened. A failed proof must be
        // recorded as failed, not replaced with another write or inferred Yes.
        try { evidence = await pass.context.persistence(event.snapshot, event.mode); }
        catch (error) {
          try {
            await this.channel.request(native.nativeSessionId, native.passId, { kind: "checkpoint", event }, { kind: "persistence", status: "failed" });
          } catch (recordError) {
            throw new AggregateError([error, recordError], "Native settings readback and failure accounting both failed");
          }
          throw error;
        }
      }
      await this.channel.request(native.nativeSessionId, native.passId, { kind: "checkpoint", event }, evidence);
      // A reply landing after a pause settles the journal but grants nothing:
      // a pre-pause "Yes" must never turn into a fresh Settings write.
      if (authority && pass.fenced) throw fenced(pass);
    } catch (error) {
      failure = { ok: false, error };
      this.#remember(error);
    } finally {
      // Retirement may already have disposed a pass whose final checkpoint
      // was still in flight; whoever removed it from the map owns the cleanup.
      if (event.phase === "finished" && this.#passes.delete(native.passId)) {
        const cleanup = this.#dispose(pass.context);
        if (!cleanup.ok) {
          failure = failure.ok
            ? cleanup
            : { ok: false, error: new AggregateError([failure.error, cleanup.error], "Reset checkpoint and context cleanup both failed") };
        }
      }
    }
    if (!failure.ok) throw failure.error;
  }

  async presentDecision(snapshot: ResetPlanSnapshot, selectNative: () => Promise<NativeResetAnswer>): Promise<void> {
    const pass = this.#original(snapshot.pass);
    this.#assertAuthority(pass);
    // Registered before the asynchronous prepare so a pause or close during
    // any await cancels exactly this native select and nothing else.
    const decision = new AbortController();
    pass.decisions.add(decision);
    try {
      const prepared = await this.channel.request(pass.native.nativeSessionId, pass.native.passId, { kind: "decision.prepare", snapshot });
      if (prepared.kind !== "decision.prepared") throw new Error("Reset decision was not prepared");
      this.#assertAuthority(pass);
      await pass.context.runDecision(async interactionId => {
        this.#assertAuthority(pass);
        await this.channel.request(pass.native.nativeSessionId, pass.native.passId,
          { kind: "decision.bind", decisionId: prepared.decisionId, interactionId });
        this.#assertAuthority(pass);
      }, selectNative, decision.signal);
    } finally { pass.decisions.delete(decision); }
  }

  async admit(snapshot: ResetPlanSnapshot, actionIndex: number): Promise<ResetAdmission> {
    const pass = this.#original(snapshot.pass);
    this.#assertAuthority(pass);
    const captured = await pass.context.admission(snapshot, actionIndex);
    // No durable admission is requested for a pass fenced during evidence capture.
    this.#assertAuthority(pass);
    const reply = await this.channel.request(pass.native.nativeSessionId, pass.native.passId,
      { kind: "admit", snapshot, actionIndex }, captured.evidence);
    if (reply.kind === "admission.hold") return { kind: "hold", reason: reply.reason };
    if (reply.kind === "admission.join") {
      // A join admitted for a since-fenced pass is not followed, even if the
      // channel has been resumed for new passes by now.
      const settled = pass.fenced
        ? Promise.reject<ResetObservation>(fenced(pass))
        : this.channel.request(pass.native.nativeSessionId, pass.native.passId, { kind: "join", joinId: reply.joinId })
          .then(result => {
            if (result.kind !== "joined") throw new Error("Reset join returned no native observation");
            return result.observation;
          });
      // Observe immediately; native may wait for another callback before joining.
      void settled.catch(() => {});
      return { kind: "join", attemptId: reply.attemptId, settled };
    }
    if (reply.kind !== "admission.execute") throw new Error("Reset admission returned no decision");
    const wire = reply.permit;
    let checked = false;
    const permit: ResetPermit = Object.freeze({ ...wire, beforeConsume: (identity: ResetCreditConsumeIdentity) => {
      if (checked) return false;
      checked = true;
      try {
        pass.context.assertCurrent();
        return !pass.fenced && identity.provider === "openai-codex"
          && identity.credentialId === wire.target.credentialId && identity.creditId === wire.creditId
          && wire.target.credentialId === captured.evidence.account.credentialId
          && wire.creditId === captured.evidence.credit.id
          && reply.consumeIdentity.provider === identity.provider
          && reply.consumeIdentity.credentialId === identity.credentialId
          && reply.consumeIdentity.creditId === identity.creditId
          && (["accountId", "orgId", "projectId"] as const).every(key => reply.consumeIdentity[key] === identity[key])
          && (identity.accountId !== undefined || reply.consumeIdentity.email === identity.email)
          && captured.beforeConsume(identity);
      } catch { return false; }
    } });
    // Even if ownership changed or a pause landed during admission, return the
    // original permit with a refusing guard. Native then reports the real
    // no-consume outcome; throwing here would strand an already durable host admission.
    this.#permits.set(permit, { pass, wire, completing: false });
    return { kind: "execute", permit };
  }

  async complete(permit: ResetPermit, observation: ResetObservation): Promise<void> {
    const issued = this.#permits.get(permit);
    if (!issued || issued.completing) throw new Error("Reset permit is foreign or already completing");
    // Native drained before retirement; a completion arriving after it would
    // settle a permit whose owner and context are gone.
    if (this.#retired) throw new Error("Native reset owner is retired");
    issued.completing = true;
    const safe: ResetObservationWire = observation.result.kind === "error"
      ? { consumeBoundary: observation.consumeBoundary, result: { kind: "error", error: { name: "Error", message: "Native reset operation failed" } } }
      : { consumeBoundary: observation.consumeBoundary, result: { kind: "outcome", outcome: {
          ok: observation.result.outcome.ok, code: observation.result.outcome.code,
          ...(observation.result.outcome.creditId === undefined ? {} : { creditId: observation.result.outcome.creditId }),
        } } };
    await this.channel.request(issued.pass.native.nativeSessionId, issued.pass.native.passId,
      { kind: "complete", permit: issued.wire, observation: safe });
  }

  /** Reversible recovery fence: no new capture; every original pass permanently
   * loses further authority and its pending native select is cancelled. Native
   * sessions, contexts and the shared channel are left intact for settlement. */
  pause(): void {
    this.#paused = true;
    this.#fence("pause");
    this.channel.pause();
  }

  /** Cancels only this owner's registered native selects; no other UI is touched. */
  #fence(cause: Exclude<Fence, false>): void {
    for (const pass of this.#passes.values()) {
      pass.fenced ||= cause;
      this.#cancelDecisions(pass);
    }
  }

  /** Reopens capture for genuinely new passes. The shared channel is resumed
   * separately by its owner once every owner on it has quiesced. */
  resume(): void {
    if (this.#closing) throw new Error("Native reset owner is closing");
    if (this.#passes.size || this.#capturing.size) throw new Error("Native reset owner still holds original passes");
    this.#paused = false;
  }

  /** Local, permanent fence for this owner's session only: no new capture, and
   * every original pass loses further authority while its pending native select
   * is cancelled. Factual complete/finished settlements still flow, and the
   * shared channel is untouched because sibling sessions still use it. */
  beginSessionClose(): void {
    this.#closing = true;
    this.#fence("close");
  }

  /** Call only after this session's native callbacks have drained, never before
   * their final checkpoints. Disposes stranded contexts once, notifies
   * `onRetired` once, and rejects with every retained local failure. Never
   * closes or drains the shared channel. */
  retireSession(): Promise<void> {
    // Publish before the fence: a cancelled select's abort listener or a
    // disposer reentering here must observe this one promise.
    this.#retired ??= Promise.resolve().then(() => this.#retire());
    this.beginSessionClose();
    return this.#retired;
  }

  #retire(): void {
    for (const [passId, pass] of this.#passes) {
      this.#passes.delete(passId);
      this.#dispose(pass.context);
    }
    try { this.onRetired?.(); } catch (error) { this.#remember(error); }
    if (this.#errors.length) throw new AggregateError([...this.#errors],
      `Native reset pass contexts did not drain cleanly (${this.#errorCount} owner failures)`);
  }

  /** Whole-owner close: the local fence plus the shared channel's admission
   * close. Only the root session, which owns the channel, calls this. */
  beginClose(): void {
    this.beginSessionClose();
    this.channel.beginClose();
  }

  /** Whole-owner drain: local retirement joined with the shared channel's
   * drain, each awaited whatever the other reports. Root-only, like `beginClose`. */
  finish(): Promise<void> {
    this.#finished ??= Promise.resolve().then(() => this.#finish());
    // The fence is synchronous even though retirement is deferred: a capture
    // reentering from the factory must already be refused.
    this.beginSessionClose();
    return this.#finished;
  }

  async #finish(): Promise<void> {
    // Local failures are read from the live retained set after both drains,
    // so one remembered while the channel was still draining is not lost.
    try { await this.retireSession(); } catch { /* retained in #errors */ }
    let channel: Attempt = { ok: true, value: undefined };
    try { await this.channel.finish(); } catch (error) { channel = { ok: false, error }; }
    const failures = [...this.#errors, ...(channel.ok ? [] : [channel.error])];
    if (failures.length) throw new AggregateError(failures,
      `Native reset pass contexts did not drain cleanly (${this.#errorCount} owner failures${channel.ok ? "" : " plus channel failure"})`);
  }
}
