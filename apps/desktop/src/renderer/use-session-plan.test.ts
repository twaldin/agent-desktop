import { expect, test } from "bun:test";
import React from "react";
import type { CommandEnvelope, CommandResult, DesktopEvent, SessionSummary } from "../../../../packages/shared/src/protocol";
import type { PlanExecutionContinuation, PlanDecisionReceipt, PlanMutationRequest, SessionPlan, SessionPlanResponse } from "../../../../packages/shared/src/session-plan";
import { planEventMatches, SessionPlanState, useSessionPlan, type SessionPlanPorts } from "./use-session-plan";
const owner = { hostId: "controlled-host", sessionId: "original-session" };
const hash = "a".repeat(64);
function plan(revision = hash): SessionPlan {
  return { ticket: { epoch: "worker", nativeSessionId: "native-session", revision }, enabled: true, canToggle: true, mode: "active",
    review: { id: "review", revision, title: "Plan", reference: "local native artifact", content: "Original", status: "ready", canKeepContext: true }, executionChoices: [] };
}
function request(value = plan()): PlanMutationRequest {
  return { sessionId: owner.sessionId, ticket: value.ticket, reviewId: value.review!.id, reviewRevision: value.review!.revision,
    mutation: { action: "approve", context: "fresh" } };
}
function receipt(envelope: CommandEnvelope, patch: Partial<PlanDecisionReceipt> = {}): PlanDecisionReceipt {
  return { commandId: envelope.id, reviewId: "review", reviewRevision: hash, action: "approve", outcome: "applied",
    artifact: "unchanged", transition: "unchanged", execution: "entered", ...patch };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const reads: Array<ReturnType<typeof deferred<SessionPlanResponse>> & { commandId?: string }> = [];
  const commands: Array<{ envelope: CommandEnvelope; hostId?: string; result: ReturnType<typeof deferred<CommandResult>> }> = [];
  const transitions: Array<Pick<SessionSummary, "id" | "hostId">> = [];
  const ports: SessionPlanPorts = { bridge: {
    getPlan: async (sessionId, hostId, commandId) => { expect({ sessionId, hostId }).toEqual(owner); const held = Object.assign(deferred<SessionPlanResponse>(), { commandId }); reads.push(held); return held.promise; },
    command: async (envelope, hostId) => { const result = deferred<CommandResult>(); commands.push({ envelope, hostId, result }); return result.promise; },
    subscribe: () => () => {},
  }, onTransition: (_owner, value) => { transitions.push(value); } };
  const state = new SessionPlanState(owner); state.configure(ports, true);
  const answer = (index: number, value = plan()) => { const commandId = reads[index]!.commandId; reads[index]!.resolve({ protocolVersion: 1, ...owner, value,
    ...(commandId ? { decisionReceipt: { commandId, state: "pending" as const } } : {}) }); };
  return { state, ports, reads, commands, transitions, answer };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function ready(f: ReturnType<typeof fixture>) { const read = f.state.refresh(); f.answer(0); await read; }

test("owner-bound v19 control invalidates a held older read and retains exact native result", async () => {
  const f = fixture(); await ready(f);
  const held = f.state.refresh();
  // A refreshing view is deliberately not an admission surface.
  await expect(f.state.control(owner, { sessionId: owner.sessionId, ticket: plan().ticket, action: "toggle" })).rejects.toThrow("Refresh");
  f.answer(1); await held;
  const operation = f.state.control(owner, { sessionId: owner.sessionId, ticket: plan().ticket, action: "toggle" });
  const c = f.commands[0]!;
  expect(c.envelope.commandVersion).toBe(19); expect(c.hostId).toBe(owner.hostId);
  expect(c.envelope.command).toEqual({ type: "session.plan.control", sessionId: owner.sessionId, ticket: plan().ticket, action: "toggle" });
  const late = f.state.refresh();
  const paused = { ...plan("b".repeat(64)), mode: "paused" as const };
  c.result.resolve({ ok: true, commandId: c.envelope.id, value: { type: "session.plan.control", state: paused } });
  await operation; f.answer(2); await late;
  expect(f.state.getSnapshot().value).toEqual(paused);
  expect(f.state.getSnapshot().fresh).toBe(true);
});

test("lost mutation response is never replayed by state refresh and remains locked", async () => {
  const f = fixture(); await ready(f);
  const operation = f.state.mutate(owner, request());
  f.commands[0]!.result.reject(new Error("controlled connection loss"));
  await expect(operation).rejects.toThrow("connection loss");
  const refresh = f.state.refresh(); f.answer(1); await refresh;
  expect(f.state.getSnapshot().uncertain).toBe(true);
  await expect(f.state.mutate(owner, request())).rejects.toThrow("original Plan action");
  expect(f.commands).toHaveLength(1);
  for (const status of ["absent", "unknown"] as const) {
    const read = f.state.refresh(), entry = f.reads.at(-1)!;
    entry.resolve({ protocolVersion: 1, ...owner, value: plan(), decisionReceipt: { commandId: f.commands[0]!.envelope.id, state: status } });
    await read; expect(f.state.getSnapshot().uncertain).toBe(true); expect(f.commands).toHaveLength(1);
  }
});

test("native committed destination is required, and a disconnected owner cannot navigate on late success", async () => {
  const f = fixture(); await ready(f);
  const operation = f.state.mutate(owner, request());
  f.state.disconnect();
  const c = f.commands[0]!;
  const session: SessionSummary = { id: "destination", hostId: owner.hostId, cwd: "/controlled", title: "New", createdAt: 1, updatedAt: 1,
    status: "idle", projectId: null, sessionFile: "/controlled/session.jsonl", model: null, archived: false };
  c.result.resolve({ ok: true, commandId: c.envelope.id, value: { type: "session.plan.mutate",
    receipt: receipt(c.envelope, { transition: "new-session", destinationSessionId: session.id }), session } });
  expect((await operation).destinationSessionId).toBe("destination"); expect(f.transitions).toEqual([]);
  expect(f.state.getSnapshot().fresh).toBe(false);
  // Reconnect does not retroactively navigate or replay the admitted decision.
  f.state.configure(f.ports, true); const refresh = f.state.refresh(); f.answer(1); await refresh;
  expect(f.commands).toHaveLength(1); expect(f.transitions).toEqual([]);
});

test("read epoch loss discards callbacks, while a reconnected controller remains usable", async () => {
  const f = fixture(); const held = f.state.refresh(); f.state.disconnect(); f.state.configure(f.ports, true);
  const current = f.state.refresh(); f.answer(0); await held;
  expect(f.state.getSnapshot().value).toBeNull(); expect(f.state.getSnapshot().loading).toBe(true);
  f.answer(1, plan("b".repeat(64))); await current;
  expect(f.state.getSnapshot().value?.ticket.revision).toBe("b".repeat(64));
  expect(f.state.getSnapshot().fresh).toBe(true);
});

test("only the exact native event owner refreshes Plan state", () => {
  const event: DesktopEvent = { type: "runtime", hostId: owner.hostId, sessionId: owner.sessionId, sequence: 1, event: { type: "plan_changed" } };
  expect(planEventMatches(event, owner)).toBe(true);
  expect(planEventMatches({ ...event, hostId: "other-host" }, owner)).toBe(false);
  expect(planEventMatches({ ...event, sessionId: "other-session" }, owner)).toBe(false);
  expect(planEventMatches({ ...event, event: { type: "message_update" } }, owner)).toBe(false);
  expect(planEventMatches({ ...event, hostId: undefined }, owner, owner.hostId)).toBe(true);
});

// The actual hook with the repository's controlled React dispatcher convention.
// This checks commit ownership; it is not mounted React, Electron, or native UI.
function hookFixture(initial: SessionPlanPorts) {
  type Effect = { phase: "layout" | "passive"; deps: readonly unknown[]; setup(): void | (() => void); cleanup?: () => void };
  let memos: Array<{ deps: readonly unknown[]; value: unknown }> = [];
  const effects = new Map<number, Effect>();
  const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  let current = initial, value!: ReturnType<typeof useSessionPlan>;
  function render(ports = current, commit = true) {
    let cursor = 0; const nextMemos = memos.slice(), pending = new Map<number, Effect>();
    const effect = (phase: Effect["phase"], setup: Effect["setup"], deps: readonly unknown[]) => {
      const i = cursor++, prior = effects.get(i); if (!prior || !same(prior.deps, deps)) pending.set(i, { phase, setup, deps });
    };
    const prior = internals.H;
    internals.H = {
      useMemo(factory: () => unknown, deps: readonly unknown[]) { const i = cursor++, previous = nextMemos[i];
        if (!previous || !same(previous.deps, deps)) nextMemos[i] = { deps, value: factory() }; return nextMemos[i]!.value; },
      useSyncExternalStore(_subscribe: unknown, get: () => unknown) { cursor++; return get(); },
      useLayoutEffect(setup: Effect["setup"], deps: readonly unknown[]) { effect("layout", setup, deps); },
      useEffect(setup: Effect["setup"], deps: readonly unknown[]) { effect("passive", setup, deps); },
    };
    let next: ReturnType<typeof useSessionPlan>;
    try { next = useSessionPlan(owner, ports, { connected: true, supported: true, active: true }); } finally { internals.H = prior; }
    if (!commit) return;
    current = ports; memos = nextMemos; value = next;
    for (const phase of ["layout", "passive"] as const) {
      for (const [i, e] of pending) if (e.phase === phase) effects.get(i)?.cleanup?.();
      for (const [i, e] of pending) if (e.phase === phase) { effects.set(i, e); e.cleanup = e.setup() || undefined; }
    }
  }
  const cleanup = () => { for (const phase of ["layout", "passive"] as const) for (const e of effects.values()) if (e.phase === phase) { e.cleanup?.(); e.cleanup = undefined; } };
  render();
  return { render, get state() { return value.state; }, dispose: cleanup, strictReplay() {
    cleanup(); for (const phase of ["layout", "passive"] as const) for (const e of effects.values()) if (e.phase === phase) e.cleanup = e.setup() || undefined;
  } };
}

test("actual hook keeps speculative ports inert; layout cleanup rejects late read and StrictMode setup refreshes", async () => {
  const a = fixture(), b = fixture(), hook = hookFixture(a.ports);
  try {
    a.answer(0); await settle(); hook.render(b.ports, false);
    const first = hook.state.refresh(); expect(a.reads).toHaveLength(2); expect(b.reads).toHaveLength(0); a.answer(1); await first;
    hook.render(b.ports); const second = hook.state.refresh(); expect(b.reads).toHaveLength(1); b.answer(0); await second;
    const stale = hook.state.refresh(); hook.strictReplay(); b.answer(1, plan("b".repeat(64))); await stale;
    expect(hook.state.getSnapshot().value?.ticket.revision).toBe(hash);
    b.answer(2, plan("c".repeat(64))); await settle();
    expect(hook.state.getSnapshot().value?.ticket.revision).toBe("c".repeat(64));
    expect(hook.state.getSnapshot().fresh).toBe(true);
    const late = hook.state.refresh(); hook.dispose(); b.answer(3); await late;
    expect(hook.state.getSnapshot().fresh).toBe(false);
  } finally { hook.dispose(); }
});

test("persisted original decision restores after reload and reconciles the journal without replay", async () => {
  const f = fixture(), stored = new Map<string, string>();
  const storage: NonNullable<SessionPlanPorts["storage"]> = { read: key => stored.get(key) ?? null,
    write: (key, text) => { stored.set(key, text); }, remove: key => { stored.delete(key); } };
  f.state.configure({ ...f.ports, storage }, true); await ready(f);
  const operation = f.state.mutate(owner, request());
  const original = f.commands[0]!;
  expect(stored.size).toBe(1); expect(JSON.parse([...stored.values()][0]!)).toEqual(original.envelope);
  original.result.reject(new Error("Response lost")); await expect(operation).rejects.toThrow("Response lost");
  const restored = new SessionPlanState(owner); restored.configure({ ...f.ports, storage }, true);
  expect(restored.getSnapshot().uncertain).toBe(true);
  const read = restored.refresh(); expect(f.reads[1]!.commandId).toBe(original.envelope.id);
  f.reads[1]!.resolve({ protocolVersion: 1, ...owner, value: plan(), decisionReceipt: {
    commandId: original.envelope.id, state: "succeeded", value: { type: "session.plan.mutate",
      receipt: receipt(original.envelope, { transition: "new-session", destinationSessionId: "committed-destination" }) } } });
  await read;
  expect(restored.getSnapshot().uncertain).toBe(false); expect(stored.size).toBe(0);
  expect(restored.getSnapshot().receipt?.commandId).toBe(original.envelope.id);
  expect(f.transitions).toEqual([{ hostId: owner.hostId, id: "committed-destination" }]);
  expect(f.commands).toHaveLength(1);
});

test("a lost toggle reads its original control journal and failed persistence sends no command", async () => {
  const f = fixture(); await ready(f);
  const operation = f.state.control(owner, { sessionId: owner.sessionId, ticket: plan().ticket, action: "toggle" });
  const original = f.commands[0]!; original.result.reject(new Error("Lost")); await expect(operation).rejects.toThrow("Lost");
  const read = f.state.refresh(); expect(f.reads[1]!.commandId).toBe(original.envelope.id);
  const paused = { ...plan(), mode: "paused" as const };
  f.reads[1]!.resolve({ protocolVersion: 1, ...owner, value: paused, decisionReceipt: {
    commandId: original.envelope.id, state: "succeeded", value: { type: "session.plan.control", state: paused } } });
  await read; expect(f.state.getSnapshot().uncertain).toBe(false); expect(f.state.getSnapshot().value?.mode).toBe("paused");
  f.state.configure({ ...f.ports, storage: { read: () => null, write: () => { throw new Error("controlled disk refusal"); }, remove: () => {} } }, true);
  await expect(f.state.mutate(owner, request())).rejects.toThrow("recovery record could not be saved");
  expect(f.commands).toHaveLength(1); expect(f.state.getSnapshot().pending).toBe(false);
});


test("only the host's explicit no-effect codes release a direct refusal for a newly reviewed action", async () => {
  for (const code of ["PLAN_NOT_LOADED", "PLAN_NOT_READY", "PLAN_REJECTED", "COMMAND_FAILED"]) {
    const f = fixture(); await ready(f); const operation = f.state.mutate(owner, request());
    const original = f.commands[0]!;
    original.result.resolve({ ok: false, commandId: original.envelope.id, error: { code, message: `Controlled ${code}` } });
    await expect(operation).rejects.toThrow(`Controlled ${code}`);
    const safe = code !== "COMMAND_FAILED";
    expect(f.state.getSnapshot().uncertain).toBe(!safe);
    expect(f.state.getSnapshot().receipt).toBeUndefined();
    expect(f.state.getSnapshot().failure?.commandId).toBe(safe ? original.envelope.id : undefined);
    const read = f.state.refresh(); f.answer(1); await read;
    if (safe) {
      const next = f.state.mutate(owner, request()); const command = f.commands[1]!;
      expect(command.envelope.id).not.toBe(original.envelope.id);
      command.result.resolve({ ok: false, commandId: command.envelope.id, error: { code: "PLAN_REJECTED", message: "Still refused" } });
      await expect(next).rejects.toThrow("Still refused");
    } else { await expect(f.state.mutate(owner, request())).rejects.toThrow("original Plan action"); expect(f.commands).toHaveLength(1); }
  }
});

test("after reload an exact no-effect journal failure forgets the original without fabricating a cancelled receipt", async () => {
  const f = fixture(), stored = new Map<string, string>();
  const storage: NonNullable<SessionPlanPorts["storage"]> = { read: key => stored.get(key) ?? null,
    write: (key, text) => { stored.set(key, text); }, remove: key => { stored.delete(key); } };
  f.state.configure({ ...f.ports, storage }, true); await ready(f);
  const pending = f.state.mutate(owner, request()), original = f.commands[0]!;
  original.result.reject(new Error("Lost refusal")); await expect(pending).rejects.toThrow("Lost refusal");
  const restored = new SessionPlanState(owner); restored.configure({ ...f.ports, storage }, true);
  const read = restored.refresh();
  f.reads[1]!.resolve({ protocolVersion: 1, ...owner, value: plan(), decisionReceipt: { commandId: original.envelope.id, state: "failed" } });
  await read;
  expect(stored.size).toBe(0); expect(restored.getSnapshot().uncertain).toBe(false);
  expect(restored.getSnapshot().receipt).toBeUndefined();
  expect(restored.getSnapshot().failure).toEqual({ owner, commandId: original.envelope.id, request: request(),
    message: "The owning host confirmed the original Plan command was refused before any effects. Review the current plan before choosing another action." });
  const next = restored.mutate(owner, request()), again = f.commands[1]!;
  expect(again.envelope.id).not.toBe(original.envelope.id);
  again.result.resolve({ ok: false, commandId: again.envelope.id, error: { code: "PLAN_REJECTED", message: "Controlled refusal" } });
  await expect(next).rejects.toThrow("Controlled refusal");
});

test("an actual parsed unknown transition retains its proposed destination without navigating", async () => {
  const f = fixture(); await ready(f);
  const operation = f.state.mutate(owner, request()), c = f.commands[0]!;
  const unknown = receipt(c.envelope, { outcome: "unknown", transition: "unknown", destinationSessionId: "not-committed", execution: "unknown" });
  c.result.resolve({ ok: true, commandId: c.envelope.id, value: { type: "session.plan.mutate", receipt: unknown } });
  await settle();
  f.reads[1]!.resolve({ protocolVersion: 1, ...owner, value: plan(), decisionReceipt: { commandId: c.envelope.id, state: "unknown",
    value: { type: "session.plan.mutate", receipt: unknown } } });
  expect((await operation).destinationSessionId).toBe("not-committed");
  expect(f.transitions).toEqual([]); expect(f.state.getSnapshot().uncertain).toBe(true);
  expect(f.commands).toHaveLength(1);
});


function continuation(patch: Partial<PlanExecutionContinuation> = {}): PlanExecutionContinuation {
  return { originSessionId: owner.sessionId, executionOwnerId: owner.sessionId, originalCommandId: "original-decision",
    latestAttemptId: "original-decision", state: "ready", ...patch };
}
function continuationResponse(value = continuation()): SessionPlanResponse {
  return { protocolVersion: 1, ...owner, value: null, unavailable: "Controlled owner not loaded", executionContinuation: value };
}

test("null-review retry consumes only the captured original attempt; another no-entry result requires a new explicit attempt", async () => {
  const f = fixture(), first = continuation(); let read = f.state.refresh(); f.reads[0]!.resolve(continuationResponse(first)); await read;
  expect(f.state.getSnapshot().value).toBeNull();
  const operation = f.state.retryExecution(first), command = f.commands[0]!;
  expect(command.envelope.commandVersion).toBe(19);
  expect(command.envelope.command).toEqual({ type: "session.plan.execution.retry", sessionId: owner.sessionId,
    originSessionId: owner.sessionId, originalCommandId: first.originalCommandId, expectedAttemptId: first.latestAttemptId });
  await expect(f.state.retryExecution(first)).rejects.toThrow("exact original"); expect(f.commands).toHaveLength(1);
  command.result.resolve({ ok: true, commandId: command.envelope.id, value: { type: "session.plan.execution.retry",
    originalCommandId: first.originalCommandId, attemptId: command.envelope.id, execution: "not-entered" } });
  await settle(); const second = continuation({ latestAttemptId: command.envelope.id }); f.reads[1]!.resolve(continuationResponse(second)); await operation;
  await expect(f.state.retryExecution(first)).rejects.toThrow("exact original"); expect(f.commands).toHaveLength(1);
  const next = f.state.retryExecution(second), retry = f.commands[1]!;
  expect(retry.envelope.id).not.toBe(command.envelope.id);
  retry.result.resolve({ ok: true, commandId: retry.envelope.id, value: { type: "session.plan.execution.retry",
    originalCommandId: first.originalCommandId, attemptId: retry.envelope.id, execution: "entered" } });
  await settle(); f.reads[2]!.resolve(continuationResponse(continuation({ latestAttemptId: retry.envelope.id, state: "entered" }))); await next;
  await expect(f.state.retryExecution(second)).rejects.toThrow("exact original"); expect(f.commands).toHaveLength(2);
});

test("lost retry survives reload and validates the original decision when reading its new command journal", async () => {
  const f = fixture(), stored = new Map<string, string>(), first = continuation();
  const storage: NonNullable<SessionPlanPorts["storage"]> = { read: key => stored.get(key) ?? null,
    write: (key, value) => { stored.set(key, value); }, remove: key => { stored.delete(key); } };
  f.state.configure({ ...f.ports, storage }, true);
  const initial = f.state.refresh(); f.reads[0]!.resolve(continuationResponse(first)); await initial;
  const operation = f.state.retryExecution(first), command = f.commands[0]!;
  expect(stored.size).toBe(1); command.result.reject(new Error("Retry response lost")); await expect(operation).rejects.toThrow("response lost");
  const restored = new SessionPlanState(owner); restored.configure({ ...f.ports, storage }, true);
  expect(restored.getSnapshot().executionRetryCommandId).toBe(command.envelope.id);
  let read = restored.refresh(); expect(f.reads[1]!.commandId).toBe(command.envelope.id);
  f.reads[1]!.resolve({ ...continuationResponse(), decisionReceipt: { commandId: command.envelope.id, state: "succeeded", value: {
    type: "session.plan.execution.retry", originalCommandId: "wrong-decision", attemptId: command.envelope.id, execution: "not-entered" } } });
  await read; expect(restored.getSnapshot().uncertain).toBe(true); expect(stored.size).toBe(1);
  read = restored.refresh();
  f.reads[2]!.resolve({ ...continuationResponse(continuation({ latestAttemptId: command.envelope.id })), decisionReceipt: {
    commandId: command.envelope.id, state: "succeeded", value: { type: "session.plan.execution.retry",
      originalCommandId: first.originalCommandId, attemptId: command.envelope.id, execution: "not-entered" } } });
  await read; expect(stored.size).toBe(0); expect(restored.getSnapshot().uncertain).toBe(false);
  expect(restored.getSnapshot().executionRetryCommandId).toBeUndefined(); expect(f.commands).toHaveLength(1);
});

test("pending, entered, unknown and another execution owner cannot be retried", async () => {
  for (const state of ["pending", "entered", "unknown"] as const) {
    const f = fixture(), value = continuation({ state }); const read = f.state.refresh(); f.reads[0]!.resolve(continuationResponse(value)); await read;
    await expect(f.state.retryExecution(value)).rejects.toThrow("exact original"); expect(f.commands).toHaveLength(0);
  }
  const f = fixture(), destination = continuation({ executionOwnerId: "approved-destination" });
  const read = f.state.refresh(); f.reads[0]!.resolve(continuationResponse(destination)); await read;
  await expect(f.state.retryExecution(destination)).rejects.toThrow("exact original");
  f.state.openExecutionOwner(destination); expect(f.transitions).toEqual([{ id: "approved-destination", hostId: owner.hostId }]);
  expect(f.commands).toHaveLength(0);
});

test("document commands require advertised v20 support and preserve that original version through uncertain reload", async () => {
  const f = fixture(), stored = new Map<string, string>();
  const storage: NonNullable<SessionPlanPorts["storage"]> = { read: key => stored.get(key) ?? null,
    write: (key, value) => { stored.set(key, value); }, remove: key => { stored.delete(key); } };
  f.state.configure({ ...f.ports, storage }, true); await ready(f);
  const mutation: PlanMutationRequest = { ...request(), mutation: { action: "document", renderColumns: 80,
    documentAction: { kind: "undo", expectedDocumentRevision: "native-document-2" } } };
  await expect(f.state.mutate(owner, mutation)).rejects.toThrow("Update the owning host");
  expect(f.commands).toHaveLength(0); expect(stored.size).toBe(0);
  f.state.configure({ ...f.ports, storage, documentSupported: true }, true);
  const operation = f.state.mutate(owner, mutation); const original = f.commands[0]!;
  expect(original.envelope.commandVersion).toBe(20);
  expect(JSON.parse([...stored.values()][0]!)).toEqual(original.envelope);
  original.result.reject(new Error("Lost document receipt")); await expect(operation).rejects.toThrow("Lost document receipt");
  const reloaded = new SessionPlanState(owner); reloaded.configure({ ...f.ports, storage, documentSupported: true }, true);
  expect(reloaded.getSnapshot().uncertain).toBe(true);
  const refresh = reloaded.refresh(); expect(f.reads[1]!.commandId).toBe(original.envelope.id);
  f.reads[1]!.resolve({ protocolVersion: 1, ...owner, value: plan(), decisionReceipt: { commandId: original.envelope.id,
    state: "succeeded", value: { type: "session.plan.mutate", receipt: receipt(original.envelope, { action: "document", execution: "not-requested" }) } } });
  await refresh;
  expect(reloaded.getSnapshot().uncertain).toBe(false); expect(stored.size).toBe(0);
  expect(f.commands).toHaveLength(1); expect(f.transitions).toEqual([]);
});

test("document inspection uses its original bridge and refuses a reply after committed bridge replacement", async () => {
  const f = fixture(); await ready(f);
  const original = { sessionId: owner.sessionId, ticket: plan().ticket, reviewId: "review", reviewRevision: hash,
    selection: { sectionId: "native-section", documentRevision: "native-document", renderColumns: 80 } };
  const held = deferred<import("../../../../packages/shared/src/session-plan").PlanDocumentResponse>();
  let firstReads = 0, replacementReads = 0;
  f.state.configure({ ...f.ports, documentSupported: true, bridge: { ...f.ports.bridge, getPlanDocumentSection: async (input, hostId) => {
    expect(input).toEqual(original); expect(hostId).toBe(owner.hostId); firstReads++; return held.promise;
  } } }, true);
  const read = f.state.readDocumentSection(owner, original);
  f.state.configure({ ...f.ports, documentSupported: true, bridge: { ...f.ports.bridge, getPlanDocumentSection: async () => {
    replacementReads++; return held.promise;
  } } }, true);
  held.resolve({ protocolVersion: 1, ...owner, ticket: original.ticket, reviewId: original.reviewId, reviewRevision: original.reviewRevision,
    value: { ...original.selection, level: 1, title: "Original", annotationCount: 0, rows: [], annotations: [] } });
  await expect(read).rejects.toThrow("owner changed");
  expect(firstReads).toBe(1); expect(replacementReads).toBe(0); expect(f.commands).toHaveLength(0);
});
