import { afterEach, expect, test } from "bun:test";
import { parseBranchQueryObserverStatus, type BranchQueryObserverStatus, type BranchQueryObserverView, type BranchQueryRequest, type DesktopBridge } from "@agent-desktop/shared";
import { BranchQueryObserver } from "./branch-query-observer";
import { BranchQueryWindows } from "../main/branch-query-windows";
import { BranchQueryConnection } from "../main/branch-query-connection";

const target = { projectId: "project" }, query = { type: "git.recent-branches", limit: 10 } as const;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const ready: BranchQueryObserverView = { phase: "ready", update: { generation: 1, requiresRecovery: false, phase: "complete", result: { type: query.type, branches: ["main"] } } };
function status(view: BranchQueryObserverView = ready): BranchQueryObserverStatus { return { hostId: "host", subscriptionId: "one", target: { ...target }, query: { ...query }, view: structuredClone(view) }; }
function fixture() {
  const sent: BranchQueryRequest[] = [], views: BranchQueryObserverView[] = [], subscribers = new Set<(status: BranchQueryObserverStatus) => void>();
  let dispatch: (request: BranchQueryRequest) => Promise<void> = async () => {};
  let notify: ((view: BranchQueryObserverView) => void) | undefined;
  const bridge: Pick<DesktopBridge, "branchQuery" | "subscribeBranchQuery"> = {
    branchQuery(request) { sent.push(request); return dispatch(request); },
    subscribeBranchQuery(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
  };
  const observer = new BranchQueryObserver(bridge, "host", target, query, view => { views.push(view); notify?.(view); }, "one");
  cleanups.push(() => observer.dispose());
  return { observer, sent, views, subscribers, bridge, emit(value = status()) { for (const listener of [...subscribers]) listener(value); },
    set dispatch(value: typeof dispatch) { dispatch = value; }, set notify(value: typeof notify) { notify = value; } };
}

test("main delivery parser validates exact owner/query/views and nested two-way isolation", () => {
  const input = status(), parsed = parseBranchQueryObserverStatus(input);
  if (input.view.phase !== "ready" || input.view.update?.phase !== "complete" || input.view.update.result.type !== query.type
    || parsed.view.phase !== "ready" || parsed.view.update?.phase !== "complete" || parsed.view.update.result.type !== query.type) throw new Error("Fixture type changed.");
  input.view.update.result.branches.push("input"); Object.assign(input.target, { projectId: "input" });
  expect(parsed.view.update.result.branches).toEqual(["main"]); expect(parsed.target).toEqual(target);
  parsed.view.update.result.branches[0] = "parsed"; Object.assign(parsed.query, { limit: 1 });
  expect(input.view.update.result.branches).toEqual(["main", "input"]); expect(input.query).toEqual(query);
  for (const invalid of [null, { ...status(), query: { type: "git.status" } }, { ...status(), target: { filePath: "/other" } },
    { ...status(), view: { phase: "invented" } }, { ...status(), view: { phase: "released", error: "not allowed" } },
    { ...status(), view: { ...ready, phase: "pending" } }, { ...status(), view: { phase: "failed", error: 3 } },
    { ...status(), view: { phase: "ready", update: { generation: 0, requiresRecovery: false, phase: "failed", error: "bad" } } }])
    expect(() => parseBranchQueryObserverStatus(invalid)).toThrow();
});

test("construction is inert; subscription precedes dispatch and completion is not readiness", async () => {
  const f = fixture(); expect(f.sent).toEqual([]); expect(f.subscribers.size).toBe(0);
  f.dispatch = async request => { if (request.action === "retain") expect(f.subscribers.size).toBe(1); };
  await f.observer.start(); await f.observer.start();
  expect(f.sent.map(r => r.action)).toEqual(["retain"]); expect(f.observer.getSnapshot().phase).toBe("connecting");
  f.emit(status({ phase: "pending" })); expect(f.observer.getSnapshot().phase).toBe("pending");
  f.emit(); expect(f.observer.getSnapshot()).toEqual(ready);
});

test("retirement before start or queued dispatch never acquires", async () => {
  for (const start of [false, true]) {
    const f = fixture(); const pending = start ? f.observer.start() : Promise.resolve();
    await f.observer.dispose(); await pending; await f.observer.start(); await f.observer.inspect(); await f.observer.recover();
    expect(f.sent).toEqual([]); expect(f.subscribers.size).toBe(0); expect(f.observer.getSnapshot()).toEqual({ phase: "released" });
  }
});

test("unavailable desktop reports unsupported without using a different bridge", async () => {
  const views: BranchQueryObserverView[] = [];
  const observer = new BranchQueryObserver({}, "host", target, query, v => views.push(v));
  await observer.start(); await observer.inspect(); await observer.recover();
  expect(views).toHaveLength(1); expect(views[0]?.phase).toBe("unsupported"); await observer.dispose();
});

test("dispose during connecting notification prevents subscription and dispatch", async () => {
  const f = fixture(); f.notify = () => { void f.observer.dispose(); };
  await f.observer.start(); expect(f.sent).toEqual([]); expect(f.subscribers.size).toBe(0);
});

test("sent admission may settle after retirement but release acknowledgement stays independent", async () => {
  const f = fixture(), admission = deferred<void>(), release = deferred<void>();
  f.dispatch = r => r.action === "retain" ? admission.promise : release.promise;
  const started = f.observer.start(); await Promise.resolve(); await Promise.resolve();
  const oldListener = [...f.subscribers][0]!;
  let retired = false; const disposing = f.observer.dispose().then(() => { retired = true; });
  await Promise.resolve(); await Promise.resolve(); expect(retired).toBe(false);
  expect(f.sent.map(r => r.action)).toEqual(["retain", "release"]);
  const count = f.views.length; oldListener(status()); expect(f.views).toHaveLength(count);
  release.resolve(); await disposing; admission.resolve(); await started;
  await f.observer.dispose(); expect(f.sent).toHaveLength(2); expect(f.observer.getSnapshot().phase).toBe("released");
});

test("release failure remains observable and repeated dispose sends no new request", async () => {
  const f = fixture(); await f.observer.start(); f.dispatch = async () => { throw new Error("release failed"); };
  await expect(f.observer.dispose()).rejects.toThrow("release failed");
  await expect(f.observer.dispose()).rejects.toThrow("release failed");
  expect(f.sent.map(r => r.action)).toEqual(["retain", "release"]);
  // Final cleanup intentionally observes the same failed release, without another dispatch.
  cleanups.pop();
});

test("foreign IDs ignored, same-ID owner or malformed view failures cannot revive", async () => {
  for (const bad of [{ ...status(), target: { sessionId: "foreign" } }, { ...status(), query: { type: "git.default-branch" } },
    { ...status(), view: { phase: "ready", update: { generation: -1 } } }]) {
    const f = fixture(); await f.observer.start();
    f.emit({ ...status(), subscriptionId: "foreign" }); expect(f.observer.getSnapshot().phase).toBe("connecting");
    f.emit(bad as BranchQueryObserverStatus); expect(f.observer.getSnapshot().phase).toBe("failed");
    const count = f.views.length; f.emit(); await f.observer.inspect(); await f.observer.recover();
    expect(f.views).toHaveLength(count); expect(f.sent).toHaveLength(1);
  }
});

test("query failure is still ready and recoverable; invocation failure is terminal", async () => {
  const f = fixture(); await f.observer.start();
  f.emit(status({ phase: "ready", update: { generation: 1, requiresRecovery: true, phase: "failed", error: "Git failed" } }));
  const recovery = deferred<void>(); f.dispatch = r => r.action === "recover" ? recovery.promise : Promise.resolve();
  const a = f.observer.recover(), b = f.observer.recover(); await Promise.resolve();
  expect(f.sent.map(r => r.action)).toEqual(["retain", "recover"]); recovery.resolve(); await Promise.all([a, b]);
  f.emit(); expect(f.observer.getSnapshot()).toEqual(ready);
  f.dispatch = async r => { if (r.action === "inspect") throw new Error("IPC lost"); };
  await f.observer.inspect(); expect(f.observer.getSnapshot()).toEqual({ phase: "failed", error: "IPC lost" });
  f.emit(); expect(f.observer.getSnapshot().phase).toBe("failed");
});

test("loss/reconnect views drop prior data and accept new connection generation", async () => {
  const f = fixture(); await f.observer.start(); f.emit();
  f.emit(status({ phase: "disconnected", error: "offline" })); expect(f.observer.getSnapshot()).toEqual({ phase: "disconnected", error: "offline" });
  f.emit(status({ phase: "connecting" })); f.emit(status({ phase: "pending" })); f.emit();
  expect(f.observer.getSnapshot()).toEqual(ready); expect(f.sent).toHaveLength(1);
});

test("listener and caller mutations cannot affect exact subsequent requests or saved result", async () => {
  const f = fixture(); f.notify = view => {
    if (view.phase === "ready" && view.update?.phase === "complete" && view.update.result.type === query.type) view.update.result.branches.push("listener");
  };
  await f.observer.start(); const incoming = status(); f.emit(incoming);
  Object.assign(f.sent[0]!.target, { projectId: "wire edit" }); Object.assign(f.sent[0]!.query, { limit: 1 });
  if (incoming.view.phase === "ready" && incoming.view.update?.phase === "complete" && incoming.view.update.result.type === query.type) incoming.view.update.result.branches.push("input");
  expect(f.observer.getSnapshot()).toEqual(ready);
  await f.observer.inspect(); expect(f.sent.at(-1)).toMatchObject({ target, query });
});

test("queued recovery retired before dispatch sends release only", async () => {
  const f = fixture(); await f.observer.start(); f.emit();
  const recovery = f.observer.recover(); await f.observer.dispose(); await recovery;
  expect(f.sent.map(r => r.action)).toEqual(["retain", "release"]);
});

test("listener cleanup failure cannot skip release and both failures remain observable", async () => {
  const sent: string[] = [];
  const observer = new BranchQueryObserver({
    subscribeBranchQuery: () => () => { throw new Error("unsubscribe failed"); },
    branchQuery: async request => { sent.push(request.action); if (request.action === "release") throw new Error("release failed"); },
  }, "host", target, query, () => {});
  await observer.start();
  for (let attempt = 0; attempt < 2; attempt++) {
    let failure: unknown; try { await observer.dispose(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(["unsubscribe failed", "release failed"]);
  }
  expect(sent).toEqual(["retain", "release"]);
});

test("reentrant disposal from subscription cleanup releases only once", async () => {
  const sent: string[] = []; let stopped = 0, reentrant: Promise<void> | undefined;
  const observer = new BranchQueryObserver({
    subscribeBranchQuery: () => () => { stopped++; reentrant = observer.dispose(); return reentrant; },
    branchQuery: async request => { sent.push(request.action); },
  }, "host", target, query, () => {});
  await observer.start(); await observer.dispose(); await reentrant;
  expect(stopped).toBe(1); expect(sent).toEqual(["retain", "release"]);
});

test("actual renderer observer/window/client route results and retire only the old document", async () => {
  const client = new BranchQueryConnection("host"), sent: BranchQueryRequest[] = [], listeners = new Set<(value: BranchQueryObserverStatus) => void>();
  const socket = client.attach({ send: r => sent.push(r), close() {} });
  socket.receive({ type: "state", replayComplete: true, state: { host: { id: "host" }, branchQueries: { version: 1 } } });
  const windows = new BranchQueryWindows({ connect: async () => client, notify: (_id, value) => { for (const listener of listeners) listener(value); } });
  windows.reset(1); const token = windows.token(1), views: BranchQueryObserverView[] = [];
  const observer = new BranchQueryObserver({ branchQuery: request => windows.dispatch(1, request, () => true, token),
    subscribeBranchQuery: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } }, "host", target, query, view => views.push(view), "logical");
  try {
    await observer.start(); expect(sent.map(r => r.action)).toEqual(["retain"]); const { action: _, ...wire } = sent[0]!;
    socket.receive({ ...wire, event: "status", phase: "ready" });
    socket.receive({ ...wire, event: "result", update: (ready as Extract<BranchQueryObserverView, { phase: "ready" }>).update });
    expect(views.at(-1)).toEqual(ready);
    await observer.dispose(); expect(sent.map(r => r.action)).toEqual(["retain", "release"]); expect(listeners.size).toBe(0);
    windows.reset(1);
    const stale = new BranchQueryObserver({ branchQuery: request => windows.dispatch(1, request, () => true, token), subscribeBranchQuery: () => () => {} }, "host", target, query, () => {}, "stale");
    await stale.start(); expect(stale.getSnapshot().phase).toBe("failed"); expect(sent).toHaveLength(2);
    await expect(stale.dispose()).rejects.toThrow("unavailable");
  } finally { await observer.dispose(); windows.dispose(); client.dispose(); }
});

for (const throws of [false, true]) test(`synchronous subscription delivery retires before retain and keeps returned cleanup outcome (${throws ? "throw" : "success"})`, async () => {
  const sent: string[] = [], views: BranchQueryObserverView[] = []; let first: Promise<void> | undefined, again: Promise<void> | undefined;
  let cleanups = 0; const failure = new Error("synchronous returned cleanup failed");
  const observer = new BranchQueryObserver({
    subscribeBranchQuery(listener) {
      listener(status());
      return () => {
        cleanups++; again = observer.dispose();
        if (throws) throw failure;
        return again; // Void cleanup's incidental return must not self-await.
      };
    },
    branchQuery: async request => { sent.push(request.action); },
  }, "host", target, query, view => {
    views.push(view);
    if (view.phase === "ready") first = observer.dispose();
  }, "one");
  await observer.start();
  expect(first).toBeDefined();
  if (throws) {
    await expect(first!).rejects.toThrow("synchronous returned cleanup failed");
    await expect(observer.dispose()).rejects.toThrow("synchronous returned cleanup failed");
    await expect(again!).rejects.toThrow("synchronous returned cleanup failed");
  } else { await first; await observer.dispose(); await again; }
  expect(cleanups).toBe(1); expect(sent).toEqual([]);
  expect(observer.getSnapshot()).toEqual({ phase: "released" });
  expect(views.map(view => view.phase)).toEqual(["connecting", "ready"]);
});
