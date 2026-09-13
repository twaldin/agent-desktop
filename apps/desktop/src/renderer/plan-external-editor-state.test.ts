import { expect, test } from "bun:test";
import type { PlanExternalEditorCapabilities, PlanExternalEditorObservation, PlanExternalEditorRequest } from "../../../../packages/shared/src/plan-external-editor";
import type { SessionPlan } from "../../../../packages/shared/src/session-plan";
import { PlanExternalEditorState, type PlanEditorInput, type PlanEditorPorts } from "./plan-external-editor-state";

const ids = {
  epoch: "10000000-0000-4000-8000-000000000001",
  request: "20000000-0000-4000-8000-000000000002",
  terminal: "30000000-0000-4000-8000-000000000003",
};
const reviewRevision = "a".repeat(64), ticketRevision = "b".repeat(64);
const plan = (): SessionPlan => ({
  ticket: { epoch: "worker", nativeSessionId: "native", revision: ticketRevision },
  mode: "active", enabled: true, canToggle: false, executionChoices: [],
  review: { id: "review", revision: reviewRevision, title: "Plan", reference: "plan.md", content: "# Plan\n",
    status: "ready", canKeepContext: true,
    document: { documentRevision: "document-one", renderColumns: 96, canUndo: false, feedback: "", sections: [
      { sectionId: "section-one", level: 1, title: "Plan", annotationCount: 0 },
    ], toc: ["section-one"] } },
});
const input = (hostId = "host-one", sessionId = "session-one", connected = true): PlanEditorInput =>
  ({ hostId, sessionId, connected, fresh: true, open: true, plan: plan(), dirty: false });
const request = (edit: PlanExternalEditorRequest["edit"] = { kind: "plan" }): PlanExternalEditorRequest => ({
  requestId: ids.request, controlEpoch: ids.epoch, sessionId: "session-one",
  ticket: plan().ticket, reviewId: "review", reviewRevision, documentRevision: "document-one", edit,
});
const capability = (hostId = "host-one"): PlanExternalEditorCapabilities =>
  ({ protocolVersion: 1, hostId, controlEpoch: ids.epoch, available: true });
const pending = (owner = request(), terminal = ids.terminal): PlanExternalEditorObservation =>
  ({ protocolVersion: 1, hostId: "host-one", request: owner, state: "pending", ...(terminal ? { terminalId: terminal } : {}) });
const applied = (owner = request()): PlanExternalEditorObservation => ({ protocolVersion: 1, hostId: "host-one", request: owner,
  state: "settled", terminalId: ids.terminal, result: { outcome: "applied", receipt: {
    commandId: owner.requestId, reviewId: owner.reviewId, reviewRevision: owner.reviewRevision,
    action: owner.edit.kind === "plan" ? "edit" : "document", outcome: "applied", artifact: "written",
    transition: "unchanged", execution: "not-requested",
  } } });
const unknown = (owner = request()): PlanExternalEditorObservation => ({ protocolVersion: 1, hostId: "host-one", request: owner,
  state: "settled", terminalId: ids.terminal, result: { outcome: "unknown", message: "Inspect the original editor." } });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(overrides: Partial<PlanEditorPorts["bridge"]> = {}) {
  const values = new Map<string, string>(), starts: PlanExternalEditorRequest[] = [], statuses: PlanExternalEditorRequest[] = [],
    cancels: PlanExternalEditorRequest[] = [], recovers: PlanExternalEditorRequest[] = [], terminals: string[] = [], copies: string[] = [];
  let refreshes = 0;
  const bridge: PlanEditorPorts["bridge"] = {
    getPlanEditorCapabilities: async (_sessionId, hostId) => capability(hostId),
    listPlanEditors: async (sessionId, hostId) => ({ protocolVersion: 1, hostId, sessionId, items: [] }),
    startPlanEditor: async value => { starts.push(value); return pending(value); },
    getPlanEditorStatus: async value => { statuses.push(value); return unknown(value); },
    cancelPlanEditor: async value => { cancels.push(value); return { ...pending(value), state: "settled", result: { outcome: "cancelled" } }; },
    recoverPlanEditor: async value => { recovers.push(value); return { observation: unknown(value), content: "recovered text" }; },
    ...overrides,
  };
  const storage: PlanEditorPorts["storage"] = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const ports: PlanEditorPorts = { bridge, storage, openTerminal: (_host, _session, terminalId) => { terminals.push(terminalId); },
    refreshPlan: async () => { refreshes++; }, copy: async text => { copies.push(text); } };
  return { values, starts, statuses, cancels, recovers, terminals, copies, ports, refreshes: () => refreshes };
}
async function ready(state: PlanExternalEditorState) { await state.refresh(); expect(state.getSnapshot().available).toBe(true); }

test("a failed durable save prevents dispatch and records only a local not-submitted outcome", async () => {
  const f = fixture(); f.ports.storage.setItem = () => { throw new Error("disk refused"); };
  const state = new PlanExternalEditorState(input(), f.ports); await ready(state); await state.start({ kind: "plan" });
  expect(f.starts).toHaveLength(0);
  expect(state.getSnapshot()).toMatchObject({ busy: false, error: "disk refused", jobs: [{ state: "settled", result: { outcome: "not-submitted" } }] });
  expect(f.terminals).toEqual([]); expect(f.refreshes()).toBe(0);
});

test("busy and host-pending ownership block duplicate starts", async () => {
  const held = deferred<PlanExternalEditorObservation>(), f = fixture({ startPlanEditor: async value => { f.starts.push(value); return held.promise; } });
  const state = new PlanExternalEditorState(input(), f.ports); await ready(state);
  const first = state.start({ kind: "plan" });
  expect(state.getSnapshot().busy).toBe(true);
  await state.start({ kind: "plan" }); expect(f.starts).toHaveLength(1);
  held.resolve(pending(f.starts[0]!)); await first;
  expect(state.getSnapshot()).toMatchObject({ available: false, jobs: [{ state: "pending" }] });
  await state.start({ kind: "plan" }); expect(f.starts).toHaveLength(1);
});

test("a lost start stays unknown across refresh and reconstruction without replay", async () => {
  const f = fixture({ startPlanEditor: async value => { f.starts.push(value); throw new Error("reply lost"); } });
  const state = new PlanExternalEditorState(input(), f.ports); await ready(state); await state.start({ kind: "plan" });
  expect(f.starts).toHaveLength(1); expect(state.getSnapshot().jobs[0]?.result?.outcome).toBe("unknown");
  await state.refresh();
  expect(f.starts).toHaveLength(1); expect(f.statuses).toHaveLength(1); expect(state.getSnapshot().jobs[0]?.result?.outcome).toBe("unknown");

  const restored = new PlanExternalEditorState(input(), f.ports);
  expect(restored.getSnapshot().jobs[0]?.result?.outcome).toBe("unknown");
  await restored.refresh();
  expect(f.starts).toHaveLength(1); expect(f.statuses).toHaveLength(2);
});

test("a response owned by the original route cannot open its terminal after navigation", async () => {
  const held = deferred<PlanExternalEditorObservation>(), f = fixture({ startPlanEditor: async value => { f.starts.push(value); return held.promise; } });
  const state = new PlanExternalEditorState(input(), f.ports); await ready(state);
  const operation = state.start({ kind: "plan" });
  const other = fixture(); state.configure(input("host-two", "session-two"), other.ports);
  held.resolve(pending(f.starts[0]!)); await operation;
  expect(f.terminals).toEqual([]); expect(other.terminals).toEqual([]);
  state.configure(input(), f.ports);
  expect(state.getSnapshot().jobs[0]).toMatchObject({ state: "pending", terminalId: ids.terminal });
});

test("host-listed cross-client jobs recover exact content and permit offline clipboard copy", async () => {
  const remote = unknown(), f = fixture({ listPlanEditors: async () => ({ protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [remote] }) });
  const state = new PlanExternalEditorState(input(), f.ports); await state.refresh();
  expect(state.getSnapshot().jobs).toEqual([remote]);
  await state.act(ids.request, "recover");
  expect(f.recovers).toEqual([remote.request]);
  expect(state.getSnapshot().recovery).toEqual({ requestId: ids.request, content: "recovered text" });
  state.configure(input("host-one", "session-one", false), f.ports);
  await state.act(ids.request, "copy");
  expect(f.copies).toEqual(["recovered text"]);
});

test("annotation dispatch captures the exact native target, note, width, and document owner", async () => {
  const f = fixture(), state = new PlanExternalEditorState(input(), f.ports); await ready(state);
  await state.start({ kind: "annotation", target: { kind: "line", sectionId: "section-one", rowId: "row-nine" }, note: "owner note", renderColumns: 96 });
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]).toMatchObject({ sessionId: "session-one", reviewId: "review", reviewRevision,
    documentRevision: "document-one", edit: { kind: "annotation", target: { kind: "line", sectionId: "section-one", rowId: "row-nine" }, note: "owner note", renderColumns: 96 } });
});

test("offline cancel has no effect and a late applied cancellation cannot refresh another route", async () => {
  const job = pending(), held = deferred<PlanExternalEditorObservation>(), f = fixture({
    listPlanEditors: async () => ({ protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [job] }),
    cancelPlanEditor: async value => { f.cancels.push(value); return held.promise; },
  });
  const state = new PlanExternalEditorState(input(), f.ports); await state.refresh();
  state.configure(input("host-one", "session-one", false), f.ports);
  await state.act(ids.request, "cancel"); expect(f.cancels).toEqual([]);
  state.configure(input(), f.ports);
  const cancellation = state.act(ids.request, "cancel");
  expect(f.cancels).toEqual([job.request]);
  const other = fixture(); state.configure(input("host-two", "session-two"), other.ports);
  held.resolve(applied(job.request)); await cancellation;
  expect(f.refreshes()).toBe(0); expect(other.refreshes()).toBe(0);
  state.configure(input(), f.ports);
  expect(state.getSnapshot().jobs[0]?.result?.outcome).toBe("applied");
});

test("a later host-list terminal opens once for the original pending start", async () => {
  const f = fixture({
    startPlanEditor: async value => { f.starts.push(value); return pending(value, ""); },
    listPlanEditors: async () => ({ protocolVersion: 1, hostId: "host-one", sessionId: "session-one",
      items: f.starts.length ? [pending(f.starts[0]!)] : [] }),
  });
  const state = new PlanExternalEditorState(input(), f.ports); await ready(state);
  await state.start({ kind: "plan" });
  expect(state.getSnapshot().jobs[0]?.state).toBe("pending");
  expect(state.getSnapshot().jobs[0]?.terminalId).toBeUndefined();
  expect(f.terminals).toEqual([]);
  await state.refresh(); expect(f.terminals).toEqual([ids.terminal]);
  await state.refresh(); expect(f.terminals).toEqual([ids.terminal]);
});

test("hiding or changing the owner before a held host list prevents automatic terminal opening", async () => {
  for (const change of ["hide", "owner"] as const) {
    const listing = deferred<{ protocolVersion: 1; hostId: string; sessionId: string; items: PlanExternalEditorObservation[] }>();
    let listCount = 0;
    const f = fixture({
      startPlanEditor: async value => { f.starts.push(value); return pending(value, ""); },
      listPlanEditors: async () => ++listCount === 1
        ? { protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [] }
        : listing.promise,
    });
    const state = new PlanExternalEditorState(input(), f.ports); await ready(state); await state.start({ kind: "plan" });
    const refresh = state.refresh();
    if (change === "hide") state.configure({ ...input(), open: false }, f.ports);
    else state.configure(input("host-two", "session-two"), fixture().ports);
    listing.resolve({ protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [pending(f.starts[0]!)] });
    await refresh;
    expect(f.terminals).toEqual([]);
    state.configure(input(), f.ports); await state.refresh();
    expect(f.terminals).toEqual([]);
  }
});

test("same-route worker or review replacement cannot open the original pending terminal", async () => {
  for (const replacement of ["epoch", "native", "review"] as const) {
    const listing = deferred<{ protocolVersion: 1; hostId: string; sessionId: string; items: PlanExternalEditorObservation[] }>();
    let listCount = 0;
    const f = fixture({
      startPlanEditor: async value => { f.starts.push(value); return pending(value, ""); },
      listPlanEditors: async () => ++listCount === 1
        ? { protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [] }
        : listing.promise,
    });
    const state = new PlanExternalEditorState(input(), f.ports); await ready(state); await state.start({ kind: "plan" });
    const refresh = state.refresh(), changed = input();
    if (replacement === "epoch") changed.plan = { ...changed.plan, ticket: { ...changed.plan.ticket, epoch: "replacement-worker" } };
    else if (replacement === "native") changed.plan = { ...changed.plan, ticket: { ...changed.plan.ticket, nativeSessionId: "replacement-native" } };
    else changed.plan = { ...changed.plan, review: { ...changed.plan.review!, id: "replacement-review" } };
    state.configure(changed, f.ports);
    listing.resolve({ protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [pending(f.starts[0]!)] });
    await refresh;
    expect(f.terminals).toEqual([]);
  }
});

test("a held start opens only for the exact ticket, review, and document revisions while a changed owner can retry deliberately", async () => {
  const cases = ["same", "ticket-revision", "review-revision", "document-revision"] as const;
  for (const replacement of cases) {
    const held = deferred<PlanExternalEditorObservation>();
    const f = fixture({
      startPlanEditor: async value => { f.starts.push(value); return f.starts.length === 1 ? held.promise : pending(value); },
      getPlanEditorStatus: async value => { f.statuses.push(value); return { ...pending(value), state: "settled", result: { outcome: "cancelled" } }; },
    });
    const state = new PlanExternalEditorState(input(), f.ports); await ready(state);
    const operation = state.start({ kind: "plan" }), changed = input();
    if (replacement === "ticket-revision") changed.plan = { ...changed.plan, ticket: { ...changed.plan.ticket, revision: "c".repeat(64) } };
    else if (replacement === "review-revision") changed.plan = { ...changed.plan, review: { ...changed.plan.review!, revision: "d".repeat(64) } };
    else if (replacement === "document-revision") changed.plan = { ...changed.plan, review: { ...changed.plan.review!,
      document: { ...changed.plan.review!.document!, documentRevision: "document-two" } } };
    state.configure(changed, f.ports);
    held.resolve(pending(f.starts[0]!)); await operation;

    if (replacement === "same") {
      expect(f.terminals).toEqual([ids.terminal]);
      continue;
    }
    expect(f.terminals).toEqual([]);
    await state.refresh();
    await state.start({ kind: "plan" });
    expect(f.starts).toHaveLength(2);
    expect(f.starts[1]).toMatchObject({ ticket: changed.plan.ticket, reviewId: changed.plan.review!.id,
      reviewRevision: changed.plan.review!.revision, documentRevision: changed.plan.review!.document!.documentRevision });
    expect(f.terminals).toEqual([ids.terminal]);
  }
});

test("a confirmed applied reply survives failure to remove its local saved request", async () => {
  const f = fixture({ startPlanEditor: async value => { f.starts.push(value); return applied(value); } });
  const state = new PlanExternalEditorState(input(), f.ports); await ready(state);
  const save = f.ports.storage.setItem; let writes = 0;
  f.ports.storage.setItem = (key, value) => { writes++; if (writes === 2) throw new Error("local cleanup refused"); save(key, value); };
  await state.start({ kind: "plan" });
  expect(f.starts).toHaveLength(1);
  expect(state.getSnapshot()).toMatchObject({ error: "local cleanup refused", jobs: [{ state: "settled", result: {
    outcome: "applied", receipt: { commandId: f.starts[0]!.requestId, outcome: "applied", action: "edit" },
  } }] });
  expect(f.refreshes()).toBe(0);
});

test("a failed terminal callback reports its own error without demoting the host receipt", async () => {
  const f = fixture({ startPlanEditor: async value => { f.starts.push(value); return applied(value); } });
  f.ports.openTerminal = () => { throw new Error("terminal panel refused"); };
  const state = new PlanExternalEditorState(input(), f.ports); await ready(state); await state.start({ kind: "plan" });
  expect(state.getSnapshot()).toMatchObject({ error: "terminal panel refused", jobs: [{ state: "settled", result: {
    outcome: "applied", receipt: { commandId: f.starts[0]!.requestId, outcome: "applied", action: "edit" },
  } }] });
});
