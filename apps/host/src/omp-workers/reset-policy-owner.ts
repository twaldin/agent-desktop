import { randomUUID } from "node:crypto";

import {
  NativeResetPolicy,
  type NativeResetAccountEvidence,
  type NativeResetCompletion,
  type NativeResetProvenance,
} from "../native-reset-policy";
import { sanitizeResetObservation } from "../session-reset-admission";
import type { HostStore } from "../store";
import type { SessionSnapshot } from "./protocol";
import type { WorkerResetPolicyOwner } from "./runtime";
import {
  RESET_POLICY_MAX_INFLIGHT,
  type ResetObservationWire,
  type ResetPassWire,
  type ResetPlanSnapshotWire,
  type ResetPolicyWireEvidence,
  type ResetPolicyWireRequest,
  type ResetPolicyWireResult,
} from "./reset-policy-wire";

export interface NativeResetPolicyWorkerOwnerOptions {
  store: HostStore;
  policy: NativeResetPolicy;
  context: Readonly<{ workerEpoch: string; workerPid: number; snapshot: SessionSnapshot }>;
}

type Decision = { passId: string; nativeSessionId: string };
type Join = { passId: string; nativeSessionId: string; settlement: Promise<NativeResetCompletion> };

const evidence = <K extends ResetPolicyWireEvidence["kind"]>(request: ResetPolicyWireRequest, kind: K): Extract<ResetPolicyWireEvidence, { kind: K }> => {
  if (request.evidence?.kind !== kind) throw new Error(`Reset-policy ${kind} evidence is required`);
  return request.evidence as Extract<ResetPolicyWireEvidence, { kind: K }>;
};

const noEvidence = (request: ResetPolicyWireRequest): void => {
  if (request.evidence !== undefined) throw new Error("Reset-policy evidence is not accepted for this operation");
};

function accountEvidence(input: {
  provider: "openai-codex"; baseUrl?: string; accountId?: string; email?: string; orgId?: string; projectId?: string;
  credentialId: number; credentialFingerprint: string; authAuthority: string; emailUnambiguous?: boolean;
}): NativeResetAccountEvidence {
  return { ...input };
}

function hold(reason: string): Extract<ResetPolicyWireResult, { kind: "admission.hold" }> {
  if (["stale", "binding-changed", "stale-generation", "already-admitted", "incompatible"].includes(reason)) return { kind: "admission.hold", reason: "stale" };
  if (["fenced", "manual-collision"].includes(reason)) return { kind: "admission.hold", reason: "unknown" };
  return { kind: "admission.hold", reason: "owner-unavailable" };
}

function joinedObservation(completion: NativeResetCompletion): ResetObservationWire {
  if (completion.terminal === "worker-exit" || !completion.observation) {
    throw new Error("Reset outcome is unknown because the original worker exited");
  }
  const observation = completion.observation;
  return observation.result.kind === "outcome"
    ? { consumeBoundary: observation.consumeBoundary, result: { kind: "outcome", outcome: { ok: observation.result.ok, code: observation.result.code } } }
    : { consumeBoundary: observation.consumeBoundary, result: { kind: "error", error: { name: "Error", message: "Native reset completion failed" } } };
}

/** Per-worker adapter over the host's shared durable reset policy. Its captured
 * snapshot and epoch are the authority; packet identifiers never select or
 * replace an owner. */
export class NativeResetPolicyWorkerOwner implements WorkerResetPolicyOwner {
  readonly #store: HostStore;
  readonly #policy: NativeResetPolicy;
  readonly #epoch: string;
  readonly #snapshot: SessionSnapshot;
  readonly #decisions = new Map<string, Decision>();
  readonly #joins = new Map<string, Join>();
  readonly #settlements = new Set<Promise<NativeResetCompletion>>();
  readonly #errors: unknown[] = [];
  #errorCount = 0;
  #closing = false;

  constructor(options: NativeResetPolicyWorkerOwnerOptions) {
    this.#store = options.store;
    this.#policy = options.policy;
    this.#epoch = options.context.workerEpoch;
    this.#snapshot = structuredClone(options.context.snapshot);
    if (!this.#epoch || !this.#snapshot.id || !this.#snapshot.sessionFile || !this.#snapshot.cwd || !Number.isSafeInteger(options.context.workerPid) || options.context.workerPid <= 0)
      throw new Error("Invalid reset-policy worker owner context");
  }

  async handle(request: ResetPolicyWireRequest): Promise<ResetPolicyWireResult> {
    this.#binding(request);
    const operation = request.operation;
    if (this.#closing && operation.kind !== "join" && operation.kind !== "complete"
      && !(operation.kind === "checkpoint" && ["joined", "answer", "setting-written", "finished"].includes(operation.event.phase)))
      throw new Error("Reset-policy owner is closing");

    if (operation.kind === "checkpoint") {
      const event = operation.event;
      if (event.phase === "started") {
        const source = evidence(request, "source");
        this.#policy.start({ provenance: this.#provenance(event.pass, source), policy: event.pass.policy });
      } else if (event.phase === "planned") {
        const proof = evidence(request, "plan");
        if (proof.accounts.length !== event.snapshot.plan.actions.length) throw new Error("Reset-policy plan account evidence does not match every action");
        this.#assertPass(event.snapshot.pass, request);
        this.#policy.plan(request.passId, { reportRevision: event.snapshot.reportRevision, plannedAtMs: event.snapshot.plannedAtMs,
          actions: event.snapshot.plan.actions.map((native, index) => ({ native, account: accountEvidence(proof.accounts[index]!) })) });
      } else if (event.phase === "joined") {
        const source = evidence(request, "source");
        this.#policy.joined({ provenance: this.#provenance(event.pass, source), policy: event.pass.policy }, event.originalPassId);
      } else if (event.phase === "answer") {
        noEvidence(request); this.#assertPlan(event.snapshot, request);
        this.#policy.answer(request.passId, event.answer);
      } else if (event.phase === "setting-written") {
        const proof = evidence(request, "persistence"); this.#assertPlan(event.snapshot, request);
        this.#policy.persistence(request.passId, { status: proof.status, globalMode: proof.globalMode,
          effectivePolicy: proof.effectivePolicy, layersUnchanged: proof.layersUnchanged, policyRevision: proof.policyRevision });
      } else {
        noEvidence(request); this.#assertPass(event.pass, request);
        this.#policy.finish(request.passId, event.settlement);
      }
      return { kind: "checkpointed" };
    }

    if (operation.kind === "decision.prepare") {
      noEvidence(request); this.#assertPlan(operation.snapshot, request);
      if (this.#decisions.size >= RESET_POLICY_MAX_INFLIGHT) throw new Error("Reset-policy decision capacity exceeded");
      if (!this.#policy.requestDecision(request.passId)) throw new Error("Native reset decision is unavailable");
      const decisionId = randomUUID();
      this.#decisions.set(decisionId, { passId: request.passId, nativeSessionId: request.nativeSessionId });
      return { kind: "decision.prepared", decisionId };
    }
    if (operation.kind === "decision.bind") {
      noEvidence(request);
      const decision = this.#decisions.get(operation.decisionId);
      if (!decision || decision.passId !== request.passId || decision.nativeSessionId !== request.nativeSessionId)
        throw new Error("Native reset decision binding is unavailable");
      this.#decisions.delete(operation.decisionId);
      return { kind: "decision.bound" };
    }
    if (operation.kind === "admit") {
      const proof = evidence(request, "admission"); this.#assertPlan(operation.snapshot, request);
      if (this.#joins.size >= RESET_POLICY_MAX_INFLIGHT) throw new Error("Reset-policy join capacity exceeded");
      const admitted = this.#policy.admit(request.passId, operation.actionIndex, {
        current: { workerEpoch: this.#epoch, nativeSessionId: request.nativeSessionId,
          selectionRevision: proof.selectionRevision, policyRevision: proof.policyRevision },
        account: accountEvidence(proof.account), credit: proof.credit,
      });
      if (admitted.kind === "hold") return hold(admitted.reason);
      this.#track(admitted.settlement);
      if (admitted.kind === "join") {
        const joinId = randomUUID();
        this.#joins.set(joinId, { passId: request.passId, nativeSessionId: request.nativeSessionId, settlement: admitted.settlement });
        return { kind: "admission.join", attemptId: admitted.attemptId, joinId };
      }
      return { kind: "admission.execute",
        permit: { attemptId: admitted.attemptId, target: { credentialId: admitted.credentialId }, creditId: admitted.creditId, redeemRequestId: admitted.redeemRequestId },
        consumeIdentity: { provider: proof.account.provider, credentialId: admitted.credentialId, accountId: proof.account.accountId,
          email: proof.account.email, projectId: proof.account.projectId, orgId: proof.account.orgId, creditId: admitted.creditId } };
    }
    if (operation.kind === "join") {
      noEvidence(request);
      const join = this.#joins.get(operation.joinId);
      if (!join || join.passId !== request.passId || join.nativeSessionId !== request.nativeSessionId) throw new Error("Reset-policy join is unavailable");
      this.#joins.delete(operation.joinId);
      return { kind: "joined", observation: joinedObservation(await join.settlement) };
    }
    if (operation.kind === "complete") {
      noEvidence(request);
      const inspected = this.#policy.inspectAttempt(operation.permit.attemptId);
      const attempt = inspected.attempt;
      if (!attempt || attempt.kind !== "automatic" || !inspected.provenance
        || inspected.provenance.workerEpoch !== this.#epoch || inspected.provenance.nativeSessionId !== request.nativeSessionId
        || inspected.provenance.passId !== request.passId || inspected.provenance.sessionId !== this.#snapshot.id
        || attempt.evidence.account.credentialId !== operation.permit.target.credentialId
        || attempt.evidence.credit.id !== operation.permit.creditId || attempt.evidence.redeemRequestId !== operation.permit.redeemRequestId)
        throw new Error("Reset-policy completion does not match its original permit");
      const raw = operation.observation.result.kind === "outcome"
        ? { consumeBoundary: operation.observation.consumeBoundary, result: { kind: "outcome" as const,
          ok: operation.observation.result.outcome.ok, code: operation.observation.result.outcome.code } }
        : { consumeBoundary: operation.observation.consumeBoundary, result: { kind: "error" as const } };
      this.#policy.complete(operation.permit.attemptId, { workerEpoch: this.#epoch, nativeSessionId: request.nativeSessionId,
        passId: request.passId, sessionId: this.#snapshot.id }, sanitizeResetObservation(raw));
      return { kind: "completed" };
    }
    throw new Error("Unsupported reset-policy operation");
  }

  beginClose(): void { this.#closing = true; this.#decisions.clear(); }
  workerLost(): void {
    this.#closing = true; this.#decisions.clear();
    try { this.#policy.workerLost(this.#epoch); }
    catch (error) { this.#remember(error); throw error; }
  }
  workerExited(): void {
    this.#closing = true; this.#decisions.clear();
    let completions: readonly NativeResetCompletion[];
    try { completions = this.#policy.workerExited(this.#epoch); }
    catch (error) { this.#remember(error); throw error; }
    const failed = completions.filter(completion => completion.persistence === "failed");
    if (failed.length) {
      const error = new AggregateError(failed.map(completion => new Error(`Native reset terminal accounting failed for attempt ${completion.attemptId}`)),
        `Native reset worker exit had ${failed.length} persistence failure${failed.length === 1 ? "" : "s"}`);
      this.#remember(error);
      throw error;
    }
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#settlements]);
    if (this.#errors.length) throw new AggregateError([...this.#errors], `Native reset worker owner did not drain cleanly (${this.#errorCount} failures)`);
  }

  #binding(request: ResetPolicyWireRequest): void {
    if (request.binding.workerEpoch !== this.#epoch || request.binding.rootSessionId !== this.#snapshot.id)
      throw new Error("Reset-policy request belongs to another worker owner");
  }
  #assertPass(pass: ResetPassWire, request: ResetPolicyWireRequest) {
    if (pass.passId !== request.passId || pass.nativeSessionId !== request.nativeSessionId) throw new Error("Reset-policy pass identity changed");
    const retained = this.#policy.inspectPass(request.passId);
    if (!retained || !("record" in retained) || retained.record.provenance.workerEpoch !== this.#epoch
      || retained.record.provenance.sessionId !== this.#snapshot.id || retained.record.provenance.nativeSessionId !== request.nativeSessionId)
      throw new Error("Reset-policy pass is not owned by this worker");
    return retained.record;
  }
  #assertPlan(snapshot: ResetPlanSnapshotWire, request: ResetPolicyWireRequest): void {
    const retained = this.#assertPass(snapshot.pass, request);
    if (!retained.plan || retained.plan.reportRevision !== snapshot.reportRevision)
      throw new Error("Reset-policy callback does not match its sealed report");
  }
  #provenance(pass: ResetPassWire, source: Extract<ResetPolicyWireEvidence, { kind: "source" }>): NativeResetProvenance {
    return { hostId: this.#store.host.id, sessionId: this.#snapshot.id, sessionFile: this.#snapshot.sessionFile, cwd: this.#snapshot.cwd,
      workerEpoch: this.#epoch, nativeSessionId: pass.nativeSessionId, passId: pass.passId, trigger: pass.trigger, source: pass.source,
      startedAtMs: pass.startedAtMs, provider: pass.provider, modelId: pass.modelId,
      selectionRevision: source.selectionRevision, policyRevision: source.policyRevision };
  }
  #track(settlement: Promise<NativeResetCompletion>): void {
    if (this.#settlements.has(settlement)) return;
    this.#settlements.add(settlement);
    void settlement.then(
      () => this.#settlements.delete(settlement),
      error => { this.#settlements.delete(settlement); this.#remember(error); },
    );
  }
  #remember(error: unknown): void {
    this.#errorCount = Math.min(Number.MAX_SAFE_INTEGER, this.#errorCount + 1);
    if (this.#errors.length < RESET_POLICY_MAX_INFLIGHT) this.#errors.push(error);
  }
}
