import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, SessionPlan, SessionSummary } from "@agent-desktop/shared";
import type { LocalEnvironmentWorkerEnvironment } from "./local-environments/environment";
import type { WorkerSession } from "./omp-workers/runtime";
import type { OmpPlanDecisionPreparation } from "./omp/plan-decision";
import { PlanDecisionService, planDecisionCommandKey, planDecisionKey, type PlanDecisionIntent } from "./plan-decisions";
import { HostStore } from "./store";

const roots: string[] = [];
const stores = new Set<HostStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const revision = "a".repeat(64);
const ticket = { epoch: "plan-worker", nativeSessionId: "origin", revision };
const review = { id: "review-one", revision, title: "Plan", reference: "native://plan", content: "Do the work",
  status: "ready" as const, canKeepContext: true };
const plan: SessionPlan = { ticket, mode: "paused", enabled: true, canToggle: true, review,
  executionChoices: [{ role: "default", provider: "fixture", modelId: "model", selected: true, default: true }],
  defaultExecutionRole: "default" };

type Preparation = OmpPlanDecisionPreparation | (() => OmpPlanDecisionPreparation | Promise<OmpPlanDecisionPreparation>);
function fixture(input?: { preparation?: Preparation; disposeError?: Error }) {
  const root = mkdtempSync(join(tmpdir(), "agent-plan-decision-")); roots.push(root);
  const cwd = join(root, "project"); mkdirSync(cwd);
  const store = new HostStore(join(root, "data")); stores.add(store);
  const project = store.addProject({ path: cwd, name: "Plan project" });
  const origin: SessionSummary = { id: "origin", hostId: store.host.id, projectId: project.id, cwd, title: "Original", status: "idle",
    sessionFile: join(root, "sessions", "origin.jsonl"), model: { provider: "fixture", id: "model" }, createdAt: 1, updatedAt: 1, archived: false };
  store.upsertSession(origin);
  const environment: LocalEnvironmentWorkerEnvironment = { sourceRoot: cwd, worktreeRoot: cwd,
    environmentDelta: { version: 1, set: { PLAN_FIXTURE_VALUE: "retained" }, unset: ["OLD_PLAN_FIXTURE_VALUE"] } };
  store.writeMetadata(`session-environment:${origin.id}`, { cwd, environment });
  const calls: string[] = [];
  let disposed = false;
  let afterForget: (() => void) | undefined;
  let current: WorkerSession | undefined;
  let execution: "entered" | "not-entered" = "entered";
  let preparation: Preparation = input?.preparation ?? {
    receipt: { commandId: "decision", reviewId: review.id, reviewRevision: revision, action: "save", outcome: "cancelled",
      artifact: "unchanged", transition: "unchanged", execution: "not-requested" },
  };
  const handle = {
    id: origin.id, sessionFile: origin.sessionFile, cwd, title: origin.title, model: origin.model, createdAt: origin.createdAt,
    workerFailure: undefined,
    getPlan: async () => structuredClone(plan),
    preparePlanDecision: async () => {
      calls.push("prepare");
      return typeof preparation === "function" ? preparation() : preparation;
    },
    dispose: async () => {
      calls.push("dispose");
      expect(store.getSession("child")).toBeUndefined();
      if (input?.disposeError) throw input.disposeError;
      disposed = true;
    },
  } as unknown as WorkerSession;
  current = handle;
  const reopened = { ...handle, id: "child", sessionFile: join(root, "sessions", "child.jsonl"), createdAt: 2,
    dispose: async () => { calls.push("dispose-reopened"); } } as unknown as WorkerSession;
  const service = new PlanDecisionService({ store,
    existing: async id => current?.id === id ? current : undefined,
    forget: async (id, owner) => {
      calls.push("forget");
      expect(id).toBe(origin.id); expect(owner).toBe(handle); expect(disposed).toBeTrue();
      expect(store.getSession("child")).toBeUndefined();
      current = undefined;
      afterForget?.();
    },
    reopen: async id => {
      calls.push("reopen");
      expect(id).toBe("child"); expect(store.getSession(id)?.sessionFile).toBe(reopened.sessionFile);
      expect(store.getSessionEnvironment(id)).toEqual(environment);
      current = reopened;
      return reopened;
    },
    busy: () => false,
    execute: async (owner, phaseId) => {
      calls.push("execute"); expect([handle, reopened]).toContain(owner); expect(phaseId).toBe("phase-one"); return execution;
    },
  });
  const request = (mutation: { action: "save"; destination: string } | { action: "approve"; context: "fresh" | "keep" }) =>
    ({ sessionId: origin.id, ticket, reviewId: review.id, reviewRevision: review.revision, mutation });
  const claim = (commandId: string, mutation: Parameters<typeof request>[0]) => {
    const command = { type: "session.plan.mutate" as const, ...request(mutation) };
    expect(store.claimCommand(commandId, `hash-${commandId}`, command).kind).toBe("claimed");
    return command;
  };
  return { root, store, project, origin, environment, calls, handle, service, request, claim,
    setPreparation(value: Preparation) { preparation = value; }, setCurrent(value: WorkerSession | undefined) { current = value; },
    setAfterForget(value: () => void) { afterForget = value; }, setExecution(value: "entered" | "not-entered") { execution = value; } };
}

function value(result: CommandResult) {
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error("Expected successful journal result.");
  const entry = result.value;
  if (!entry || !("type" in entry) || entry.type !== "session.plan.mutate") throw new Error("Expected a Plan mutation receipt.");
  return entry;
}

test("cancelled save retains the exact artifact receipt without catalog or environment changes", async () => {
  const f = fixture();
  f.claim("decision", { action: "save", destination: join(f.root, "PLAN.md") });
  const result = value(await f.service.decide("decision", f.request({ action: "save", destination: join(f.root, "PLAN.md") })));
  expect(result.receipt).toEqual({ commandId: "decision", reviewId: review.id, reviewRevision: revision, action: "save",
    outcome: "cancelled", artifact: "unchanged", transition: "unchanged", execution: "not-requested" });
  expect(result.session).toBeUndefined();
  expect(f.store.listSessions()).toEqual([f.origin]);
  expect(f.store.getSessionEnvironment(f.origin.id)).toEqual(f.environment);
  expect(f.calls).toEqual(["prepare"]);
});

test("fresh approval disposes the original before binding, reopens, and records entered execution", async () => {
  const f = fixture();
  const childFile = join(f.root, "sessions", "child.jsonl");
  f.setPreparation(() => {
    Object.assign(f.handle, { id: "child", sessionFile: childFile, createdAt: 2, title: "Replacement" });
    return { receipt: { commandId: "fresh", reviewId: review.id, reviewRevision: revision, action: "approve", outcome: "applied",
      artifact: "unchanged", transition: "new-session", destinationSessionId: "child", execution: "not-entered" },
      transition: { nativeSessionId: "child", sessionFile: childFile }, execution: { phaseId: "phase-one" } };
  });
  f.claim("fresh", { action: "approve", context: "fresh" });
  const result = value(await f.service.decide("fresh", f.request({ action: "approve", context: "fresh" })));
  expect(f.calls).toEqual(["prepare", "dispose", "forget", "reopen", "execute"]);
  expect(result.receipt).toMatchObject({ commandId: "fresh", outcome: "applied", transition: "new-session", execution: "entered" });
  expect(result.session).toMatchObject({ id: "child", sessionFile: childFile, projectId: f.project.id, cwd: f.origin.cwd });
  expect(f.store.getSession("child")).toEqual(result.session);
  expect(f.store.getSessionEnvironment("child")).toEqual(f.environment);
});

test("pending and lost-ack decisions are never replayed", async () => {
  for (const state of ["pending", "unknown"] as const) {
    const f = fixture();
    const commandId = `blocked-${state}`;
    f.claim(commandId, { action: "save", destination: join(f.root, "PLAN.md") });
    const intent: PlanDecisionIntent = { commandId: "original-decision", originId: f.origin.id,
      reviewId: review.id, reviewRevision: revision, state };
    f.store.writeMetadata(planDecisionKey(f.origin.id), intent);
    f.store.writeMetadata(planDecisionCommandKey(intent.commandId), intent);
    expect(await f.service.decide(commandId, f.request({ action: "save", destination: join(f.root, "PLAN.md") })))
      .toMatchObject({ ok: false, commandId, error: { code: "OUTCOME_UNKNOWN" } });
    expect(f.calls).toEqual([]);
  }
});

test("mismatched native replacement is refused and cannot enter or bind a destination", async () => {
  const f = fixture();
  const childFile = join(f.root, "sessions", "child.jsonl");
  f.setPreparation({ receipt: { commandId: "mismatch", reviewId: review.id, reviewRevision: revision, action: "approve", outcome: "applied",
    artifact: "unchanged", transition: "new-session", destinationSessionId: "child", execution: "not-entered" },
    transition: { nativeSessionId: "child", sessionFile: childFile }, execution: { phaseId: "phase-one" } });
  f.claim("mismatch", { action: "approve", context: "fresh" });
  const result = value(await f.service.decide("mismatch", f.request({ action: "approve", context: "fresh" })));
  expect(result.receipt).toMatchObject({ outcome: "unknown", transition: "new-session", execution: "unknown",
    message: "The native Plan replacement differs from its original decision." });
  expect(result.session).toBeUndefined(); expect(f.store.getSession("child")).toBeUndefined();
  expect(f.calls).toEqual(["prepare"]);
});

test("failed disposal cannot publish or execute a replacement", async () => {
  const f = fixture({ disposeError: new Error("fixture disposal failure") });
  const childFile = join(f.root, "sessions", "child.jsonl");
  f.setPreparation(() => {
    Object.assign(f.handle, { id: "child", sessionFile: childFile });
    return { receipt: { commandId: "dispose-fails", reviewId: review.id, reviewRevision: revision, action: "approve", outcome: "applied",
      artifact: "unchanged", transition: "new-session", destinationSessionId: "child", execution: "not-entered" },
      transition: { nativeSessionId: "child", sessionFile: childFile }, execution: { phaseId: "phase-one" } };
  });
  f.claim("dispose-fails", { action: "approve", context: "fresh" });
  const result = value(await f.service.decide("dispose-fails", f.request({ action: "approve", context: "fresh" })));
  expect(result.receipt).toMatchObject({ outcome: "unknown", execution: "unknown", message: "fixture disposal failure" });
  expect(result.session).toBeUndefined(); expect(f.store.getSession("child")).toBeUndefined();
  expect(f.calls).toEqual(["prepare", "dispose", "dispose"]);
});

test("failed destination binding does not return successful navigation", async () => {
  const f = fixture();
  const childFile = join(f.root, "sessions", "child.jsonl");
  f.setAfterForget(() => f.store.upsertSession({ ...f.origin, id: "child", sessionFile: childFile, createdAt: 2, updatedAt: 2 }));
  f.setPreparation(() => {
    Object.assign(f.handle, { id: "child", sessionFile: childFile });
    return { receipt: { commandId: "binding-fails", reviewId: review.id, reviewRevision: revision, action: "approve", outcome: "applied",
      artifact: "unchanged", transition: "new-session", destinationSessionId: "child", execution: "not-entered" },
      transition: { nativeSessionId: "child", sessionFile: childFile }, execution: { phaseId: "phase-one" } };
  });
  f.claim("binding-fails", { action: "approve", context: "fresh" });
  const result = value(await f.service.decide("binding-fails", f.request({ action: "approve", context: "fresh" })));
  expect(result.receipt).toMatchObject({ outcome: "unknown", execution: "unknown" });
  expect(result.session).toBeUndefined();
  expect(f.calls).not.toContain("reopen"); expect(f.calls).not.toContain("execute");
});

test("definite PLAN_REJECTED permits a fresh command retry", async () => {
  const f = fixture();
  let attempts = 0;
  f.setPreparation(() => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("review rejected"), { code: "PLAN_REJECTED" });
    return { receipt: { commandId: "retry", reviewId: review.id, reviewRevision: revision, action: "save", outcome: "applied",
      artifact: "written", savedDestination: join(f.root, "PLAN.md"), transition: "unchanged", execution: "not-requested" } };
  });
  f.claim("rejected", { action: "save", destination: join(f.root, "PLAN.md") });
  expect(await f.service.decide("rejected", f.request({ action: "save", destination: join(f.root, "PLAN.md") })))
    .toMatchObject({ ok: false, error: { code: "PLAN_REJECTED" } });
  f.claim("retry", { action: "save", destination: join(f.root, "PLAN.md") });
  expect(value(await f.service.decide("retry", f.request({ action: "save", destination: join(f.root, "PLAN.md") }))).receipt)
    .toMatchObject({ commandId: "retry", outcome: "applied", artifact: "written" });
  expect(attempts).toBe(2);
});

test("unknown retirement retains its observed replacement and blocks every replay", async () => {
  const f = fixture();
  const childFile = join(f.root, "sessions", "child.jsonl");
  f.setPreparation(() => {
    Object.assign(f.handle, { id: "child", sessionFile: childFile });
    return { receipt: { commandId: "unknown", reviewId: review.id, reviewRevision: revision, action: "approve", outcome: "unknown",
      artifact: "unchanged", transition: "unknown", destinationSessionId: "child", execution: "unknown" },
      transition: { nativeSessionId: "child", sessionFile: childFile } };
  });
  f.claim("unknown", { action: "approve", context: "fresh" });
  const result = value(await f.service.decide("unknown", f.request({ action: "approve", context: "fresh" })));
  expect(result.receipt).toMatchObject({ outcome: "unknown", transition: "unknown", destinationSessionId: "child" });
  expect(result.session).toMatchObject({ id: "child", sessionFile: childFile, status: "interrupted",
    error: "The native Plan transition completed with an unknown later outcome. Inspect this replacement before continuing." });
  expect(f.store.getSession("child")).toEqual(result.session);
  expect(f.store.getSessionEnvironment("child")).toEqual(f.environment);
  expect(f.store.readMetadata<PlanDecisionIntent>(planDecisionKey(f.origin.id))).toMatchObject({ state: "unknown",
    destination: { id: "child", sessionFile: childFile } });
  f.claim("must-not-replay", { action: "approve", context: "fresh" });
  expect(await f.service.decide("must-not-replay", f.request({ action: "approve", context: "fresh" })))
    .toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
  expect(f.calls).toEqual(["prepare", "dispose", "forget"]);
});

test("unknown replacement cleanup or binding failure never publishes execution", async () => {
  for (const failure of ["cleanup", "binding"] as const) {
    const f = fixture(failure === "cleanup" ? { disposeError: new Error("unknown cleanup failed") } : undefined);
    const childFile = join(f.root, "sessions", "child.jsonl"), commandId = `unknown-${failure}`;
    if (failure === "binding") f.setAfterForget(() => f.store.upsertSession({ ...f.origin, id: "child", sessionFile: childFile,
      title: "Conflicting session", createdAt: 2, updatedAt: 2 }));
    f.setPreparation(() => {
      Object.assign(f.handle, { id: "child", sessionFile: childFile });
      return { receipt: { commandId, reviewId: review.id, reviewRevision: revision, action: "approve", outcome: "unknown",
        artifact: "unchanged", transition: "unknown", destinationSessionId: "child", execution: "unknown",
        message: `controlled ${failure} uncertainty` }, transition: { nativeSessionId: "child", sessionFile: childFile } };
    });
    f.claim(commandId, { action: "approve", context: "fresh" });
    const result = value(await f.service.decide(commandId, f.request({ action: "approve", context: "fresh" })));
    expect(result.receipt).toMatchObject({ outcome: "unknown", execution: "unknown" });
    expect(result.session).toBeUndefined();
    expect(f.calls).not.toContain("reopen"); expect(f.calls).not.toContain("execute");
    if (failure === "cleanup") expect(f.store.getSession("child")).toBeUndefined();
    else expect(f.store.getSession("child")?.title).toBe("Conflicting session");
  }
});

test("unknown replacement identity mismatch remains unbound and unexecuted", async () => {
  const f = fixture(), childFile = join(f.root, "sessions", "child.jsonl");
  f.setPreparation({ receipt: { commandId: "unknown-mismatch", reviewId: review.id, reviewRevision: revision,
    action: "approve", outcome: "unknown", artifact: "unchanged", transition: "unknown", destinationSessionId: "child",
    execution: "unknown" }, transition: { nativeSessionId: "child", sessionFile: childFile } });
  f.claim("unknown-mismatch", { action: "approve", context: "fresh" });
  const result = value(await f.service.decide("unknown-mismatch", f.request({ action: "approve", context: "fresh" })));
  expect(result.receipt).toMatchObject({ outcome: "unknown", message: "The native Plan replacement differs from its original decision." });
  expect(result.session).toBeUndefined(); expect(f.store.getSession("child")).toBeUndefined();
  expect(f.calls).toEqual(["prepare"]);
});

test("known not-entered approval can be retried once without preparing the decision again", async () => {
  const f = fixture();
  f.setExecution("not-entered");
  f.setPreparation({ receipt: { commandId: "approve", reviewId: review.id, reviewRevision: revision, action: "approve",
    outcome: "applied", artifact: "unchanged", transition: "unchanged", execution: "not-entered" },
    execution: { phaseId: "phase-one" } });
  f.claim("approve", { action: "approve", context: "keep" });
  expect(value(await f.service.decide("approve", f.request({ action: "approve", context: "keep" }))).receipt.execution).toBe("not-entered");
  expect(f.service.continuation(f.origin.id)).toEqual({ originSessionId: f.origin.id, executionOwnerId: f.origin.id,
    originalCommandId: "approve", latestAttemptId: "approve", state: "ready" });
  const retry = { type: "session.plan.execution.retry" as const, sessionId: f.origin.id, originSessionId: f.origin.id,
    originalCommandId: "approve", expectedAttemptId: "approve" };
  expect(f.store.claimCommand("retry-one", "hash-retry-one", retry).kind).toBe("claimed");
  const { type: _retryType, ...retryRequest } = retry;
  const result = await f.service.retry("retry-one", retryRequest);
  expect(result).toEqual({ ok: true, commandId: "retry-one", value: { type: "session.plan.execution.retry",
    originalCommandId: "approve", attemptId: "retry-one", execution: "not-entered" } });
  expect(f.calls).toEqual(["prepare", "execute", "execute"]);
  expect(f.service.continuation(f.origin.id)).toMatchObject({ state: "ready", latestAttemptId: "retry-one" });
});

test("fresh execution continuation survives destination binding and explicitly reopens only that owner", async () => {
  const f = fixture(), childFile = join(f.root, "sessions", "child.jsonl");
  f.setExecution("not-entered");
  f.setPreparation(() => {
    Object.assign(f.handle, { id: "child", sessionFile: childFile, createdAt: 2 });
    return { receipt: { commandId: "fresh-ready", reviewId: review.id, reviewRevision: revision, action: "approve",
      outcome: "applied", artifact: "unchanged", transition: "new-session", destinationSessionId: "child", execution: "not-entered" },
      transition: { nativeSessionId: "child", sessionFile: childFile }, execution: { phaseId: "phase-one" } };
  });
  f.claim("fresh-ready", { action: "approve", context: "fresh" });
  expect(value(await f.service.decide("fresh-ready", f.request({ action: "approve", context: "fresh" }))).receipt.execution).toBe("not-entered");
  expect(f.service.continuation(f.origin.id)).toEqual(f.service.continuation("child"));
  expect(f.service.continuation("child")).toMatchObject({ originSessionId: f.origin.id, executionOwnerId: "child", state: "ready" });
  const later: PlanDecisionIntent = { commandId: "later-edit", originId: f.origin.id, reviewId: "later-review",
    reviewRevision: "b".repeat(64), state: "complete" };
  f.store.writeMetadata(planDecisionKey(f.origin.id), later);
  f.store.writeMetadata(planDecisionCommandKey(later.commandId), later);
  expect(f.service.continuation(f.origin.id)).toBeUndefined();
  expect(f.service.continuation("child")).toMatchObject({ originalCommandId: "fresh-ready", state: "ready" });
  f.setCurrent(undefined); f.setExecution("entered");
  const command = { type: "session.plan.execution.retry" as const, sessionId: "child", originSessionId: f.origin.id,
    originalCommandId: "fresh-ready", expectedAttemptId: "fresh-ready" };
  f.store.claimCommand("fresh-retry", "hash-fresh-retry", command);
  const { type: _type, ...request } = command;
  expect(await f.service.retry("fresh-retry", request)).toMatchObject({ ok: true,
    value: { type: "session.plan.execution.retry", execution: "entered" } });
  expect(f.calls).toEqual(["prepare", "dispose", "forget", "reopen", "execute", "reopen", "execute"]);
  expect(f.service.continuation(f.origin.id)).toBeUndefined();
  expect(f.service.continuation("child")).toMatchObject({ latestAttemptId: "fresh-retry", state: "entered" });
});

test("retry reservation rejects racing and stale clients before a second execution", async () => {
  const f = fixture();
  const intent: PlanDecisionIntent = { commandId: "approve", originId: f.origin.id, reviewId: review.id, reviewRevision: revision,
    state: "complete", execution: { phaseId: "phase-one", owner: { id: f.origin.id, sessionFile: f.origin.sessionFile, cwd: f.origin.cwd },
      latestAttemptId: "approve", state: "ready" } };
  f.store.writeMetadata(planDecisionKey(f.origin.id), intent);
  f.store.writeMetadata(planDecisionCommandKey(intent.commandId), intent);
  const first = { type: "session.plan.execution.retry" as const, sessionId: f.origin.id, originSessionId: f.origin.id,
    originalCommandId: "approve", expectedAttemptId: "approve" };
  const second = { ...first };
  f.store.claimCommand("retry-a", "hash-a", first); f.store.claimCommand("retry-b", "hash-b", second);
  f.store.reservePlanExecutionRetry(intent, "retry-a", first);
  expect(() => f.store.reservePlanExecutionRetry(intent, "retry-b", second)).toThrow("stale");
  expect(f.service.continuation(f.origin.id)).toMatchObject({ state: "pending", latestAttemptId: "retry-a" });
  const reloaded = new PlanDecisionService({ store: f.store, existing: async () => f.handle, forget: async () => {}, reopen: async () => f.handle,
    busy: () => false, active: () => false, execute: async () => "entered" });
  expect(reloaded.continuation(f.origin.id)).toMatchObject({ state: "unknown", latestAttemptId: "retry-a" });
  expect(f.calls).toEqual([]);
});

test("lost retry admission becomes durable unknown and cannot be replayed after reload", async () => {
  const f = fixture();
  const intent: PlanDecisionIntent = { commandId: "approve", originId: f.origin.id, reviewId: review.id, reviewRevision: revision,
    state: "complete", execution: { phaseId: "phase-one", owner: { id: f.origin.id, sessionFile: f.origin.sessionFile, cwd: f.origin.cwd },
      latestAttemptId: "approve", state: "ready" } };
  f.store.writeMetadata(planDecisionKey(f.origin.id), intent);
  f.store.writeMetadata(planDecisionCommandKey(intent.commandId), intent);
  const retry = { type: "session.plan.execution.retry" as const, sessionId: f.origin.id, originSessionId: f.origin.id,
    originalCommandId: "approve", expectedAttemptId: "approve" };
  f.store.claimCommand("retry-lost", "hash-lost", retry);
  const service = new PlanDecisionService({ store: f.store, existing: async () => f.handle, forget: async () => {}, reopen: async () => f.handle,
    busy: () => false, execute: async () => { throw new Error("lost worker acknowledgement"); } });
  const { type: _retryType, ...retryRequest } = retry;
  expect(await service.retry("retry-lost", retryRequest)).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
  expect(service.continuation(f.origin.id)).toMatchObject({ state: "unknown", latestAttemptId: "retry-lost" });
  const reloaded = new PlanDecisionService({ store: f.store, existing: async () => f.handle, forget: async () => {}, reopen: async () => f.handle,
    busy: () => false, execute: async () => "entered" });
  f.store.claimCommand("must-not-retry", "hash-new", { ...retry, expectedAttemptId: "retry-lost" });
  expect(await reloaded.retry("must-not-retry", { ...retryRequest, expectedAttemptId: "retry-lost" }))
    .toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
});
