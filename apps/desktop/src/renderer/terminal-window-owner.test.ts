import { expect, test } from "bun:test";
import type { NativeTerminalResult, TerminalCreationBridge, TerminalCreationRequest, TerminalCreationResponse } from "@agent-desktop/shared";
import { TerminalWindowOwner, type TerminalWindowContext } from "./terminal-window-owner";
import type { TerminalCreationOptions } from "./terminal-creation-controller";
import type { TerminalWindowIntent } from "../terminal-window-intent";
import { defaultWindowView, type WindowViewState } from "../window-state";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";
import { reconcileDockPresentations } from "./dock-presentations";

const hostId = "10000000-0000-4000-8000-000000000001", sessionId = "20000000-0000-4000-8000-000000000002";
const epoch = "30000000-0000-4000-8000-000000000003", terminalId = "40000000-0000-4000-8000-000000000004";
const tab = { ...createBrowserNewTab(hostId, sessionId, "original"), browserNewTab: { status: "idle" as const, draft: "address" } };
const options: TerminalCreationOptions = { hostId, target: { sessionId }, cols: 120, rows: 30,
  source: { kind: "browser", tabId: tab.id, browserInstanceId: tab.browserInstanceId!, title: tab.title, draft: "address" } };
const saved: TerminalWindowIntent = { version: 1, hostId, source: options.source,
  request: { version: 1, requestId: "50000000-0000-4000-8000-000000000005", controlEpoch: epoch, target: options.target, cols: 120, rows: 30 } };
const ok = <T>(value: T): NativeTerminalResult<T> => ({ ok: true, value });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function drain() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function response(request: TerminalCreationRequest, metadata = false): TerminalCreationResponse {
  return { version: 1, hostId, requestId: request.requestId, status: "settled", receipt: { outcome: "completed", terminalId },
    ...(metadata ? { terminal: { id: terminalId, target: request.target, cwd: "/fixture", protocol: "tmux-v1", serverGeneration: epoch, status: "running", attachable: true } } : {}) };
}
function fixture(restored: TerminalWindowIntent[] = [], error?: string) {
  let state: WindowViewState = { ...defaultWindowView(), route: { hostId, sessionId }, terminalCreations: restored,
    dock: { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] } };
  let context: TerminalWindowContext = { hostId, target: options.target, connected: true, enabled: true,
    presentations: reconcileDockPresentations(undefined, state.dock!, "initial") };
  let createGate: Promise<NativeTerminalResult<TerminalCreationResponse>> | undefined;
  let inspectGate: Promise<NativeTerminalResult<TerminalCreationResponse>> | undefined;
  const calls: string[] = [], entered = deferred<void>(); let notices = 0;
  const bridge: TerminalCreationBridge = {
    async getTerminalCreationCapabilities() { calls.push("capabilities"); return ok({ version: 1, hostId, controlEpoch: epoch }); },
    async createNativeTerminal(request) { calls.push("create"); entered.resolve(); return createGate ?? ok(response(request)); },
    async observeTerminalCreation(request) { calls.push("inspect"); return inspectGate ?? ok(response(request, true)); },
  };
  const owner = new TerminalWindowOwner(bridge, restored, () => { notices++; }, error);
  owner.commit(context); owner.committed(state);
  return { owner, calls, entered, get notices() { return notices; }, get state() { return state; }, get context() { return context; },
    createGate(value: typeof createGate) { createGate = value; }, inspectGate(value: typeof inspectGate) { inspectGate = value; },
    commit(change: Partial<TerminalWindowContext> = {}) { context = { ...context, ...change }; owner.commit(context); },
    view(change: Partial<WindowViewState> = {}) { state = { ...state, terminalCreations: owner.intents, ...change }; owner.committed(state); return state; },
    save() { owner.saved(state); },
  };
}

test("retained window owner serializes one workspace before capability reply and blocks unresolved siblings", async () => {
  const f = fixture(), result = f.owner.prepare(options);
  expect(await f.owner.prepare({ ...options, source: { kind: "dock", destination: "bottom" } })).toEqual({ status: "busy" });
  await drain(); expect(f.calls).toEqual(["capabilities"]); expect(f.owner.intents).toHaveLength(1);
  f.view(); f.save(); expect((await result).status).toBe("ready");
  expect(await f.owner.prepare(options)).toMatchObject({ status: "error", outcome: "not-submitted" });
  expect(f.calls).toEqual(["capabilities", "create", "inspect"]); f.owner.dispose();
});

test("ready attachment remains fenced until matching descriptor and removal are acknowledged together", async () => {
  const f = fixture(), result = f.owner.prepare(options); await drain(); f.view(); f.save();
  const ready = await result; if (ready.status !== "ready") throw new Error("ready");
  const original = f.owner.intents;
  const dock = { tabs: [tab, ready.tab], state: insertDockTab(f.state.dock!.state, ready.tab, "bottom") };
  f.view({ dock }); expect(f.owner.intents).toEqual([]);
  expect((await f.owner.prepare(options)).status).toBe("error");
  f.owner.saved({ ...f.state, terminalCreations: [] , dock: { state: createDockState(), tabs: [] } });
  expect((await f.owner.prepare(options)).status).toBe("error");
  f.owner.saved({ ...f.state, terminalCreations: original }); expect((await f.owner.prepare(options)).status).toBe("error");
  f.view(); f.save();
  const abort = new AbortController(); abort.abort();
  expect(await f.owner.prepare(options, abort.signal)).toEqual({ status: "cancelled", creationMayHaveRun: false });
  expect(f.calls.filter(call => call === "create")).toHaveLength(1); f.owner.dispose();
});

test("restored unknown blocks creation without network and permits only explicit original observation", async () => {
  const f = fixture([saved]); expect(f.calls).toEqual([]);
  expect(await f.owner.prepare(options)).toMatchObject({ status: "error", outcome: "not-submitted" }); expect(f.calls).toEqual([]);
  const ready = await f.owner.inspect(`${hostId}:${saved.request.requestId}`);
  expect(ready).toMatchObject({ status: "ready", tab: { terminalId } });
  expect(f.calls).toEqual(["inspect"]); expect(f.owner.intents).toEqual([saved]); f.owner.dispose();
});

test("committed navigation or connection roundtrip cancels late create while retaining request and source", async () => {
  for (const loss of [{ connected: false }, { enabled: false }, { hostId: epoch }, { target: undefined }] satisfies Partial<TerminalWindowContext>[]) {
    const f = fixture(), gate = deferred<NativeTerminalResult<TerminalCreationResponse>>(); f.createGate(gate.promise);
    const result = f.owner.prepare(options); await drain(); f.view(); f.save(); await f.entered.promise;
    const intent = f.owner.intents[0]!; const initial = f.context;
    f.commit(loss); f.commit(initial); gate.resolve(ok(response(intent.request)));
    expect(await result).toEqual({ status: "cancelled", creationMayHaveRun: true });
    expect(f.owner.intents).toEqual([intent]); expect(f.owner.retainsSource(f.context.presentations, tab.id)).toBe(true);
    expect((await f.owner.inspect(`${hostId}:${intent.request.requestId}`)).status).toBe("ready");
    expect(f.calls).toEqual(["capabilities", "create", "inspect"]); f.owner.dispose();
  }
});

test("same logical browser reopened with a new runtime incarnation cannot receive old recovery", async () => {
  const f = fixture([saved]); expect((await f.owner.inspect(`${hostId}:${saved.request.requestId}`)).status).toBe("ready");
  const empty = reconcileDockPresentations(f.context.presentations, { state: createDockState(), tabs: [] }, "close");
  f.commit({ presentations: empty });
  const reopened = reconcileDockPresentations(empty, f.state.dock!, "reopen"); f.commit({ presentations: reopened });
  expect(await f.owner.inspect(`${hostId}:${saved.request.requestId}`)).toEqual({ status: "cancelled", creationMayHaveRun: true });
  expect(f.calls).toEqual(["inspect"]); expect(f.owner.intents).toEqual([saved]);
  expect(f.owner.retainsSource(reopened, tab.id)).toBe(false); f.owner.dispose();
});

test("moving the original unresolved browser keeps cleanup protection while rejecting old attachment", async () => {
  const f = fixture([saved]), gate = deferred<NativeTerminalResult<TerminalCreationResponse>>(); f.inspectGate(gate.promise);
  const pending = f.owner.inspect(`${hostId}:${saved.request.requestId}`); await drain();
  const moved = reconcileDockPresentations(f.context.presentations,
    { tabs: [tab], state: insertDockTab(createDockState(), tab, "bottom") }, "move");
  f.commit({ presentations: moved });
  expect(f.owner.retainsSource(moved, tab.id)).toBe(true);
  gate.resolve(ok(response(saved.request, true)));
  expect(await pending).toEqual({ status: "cancelled", creationMayHaveRun: true });
  f.inspectGate(undefined);
  expect((await f.owner.inspect(`${hostId}:${saved.request.requestId}`)).status).toBe("ready");
  expect(f.calls).toEqual(["inspect", "inspect"]); expect(f.owner.intents).toEqual([saved]); f.owner.dispose();
});

test("restoration and write failures fail closed; a successful save never waives restoration error", async () => {
  const f = fixture([], "Invalid saved request history"); f.save();
  expect(await f.owner.prepare(options)).toMatchObject({ status: "error", outcome: "not-submitted" }); expect(f.calls).toEqual([]); f.owner.dispose();
  const g = fixture(), result = g.owner.prepare(options); await drain(); g.view(); g.owner.failed("disk unavailable");
  expect(await result).toMatchObject({ status: "cancelled", creationMayHaveRun: false });
  expect(g.owner.intents).toEqual([]); expect((await g.owner.prepare(options)).status).toBe("error");
  g.view(); g.save(); expect(g.owner.error).toBeUndefined(); expect(g.calls).toEqual(["capabilities"]); g.owner.dispose();
});

test("confirmed not-submitted inspection retires that entry without deleting sibling intent", async () => {
  const sibling = { ...saved, request: { ...saved.request, requestId: epoch, target: { projectId: sessionId } }, source: { kind: "dock" as const, destination: "bottom" as const } };
  const f = fixture([saved, sibling]);
  f.inspectGate(Promise.resolve(ok({ version: 1, hostId, requestId: saved.request.requestId, status: "settled", receipt: { outcome: "not-submitted", terminalId, message: "Rejected before create" } })));
  expect(await f.owner.inspect(`${hostId}:${saved.request.requestId}`)).toMatchObject({ status: "error", outcome: "not-submitted" });
  expect(f.owner.intents).toEqual([sibling]);
  const abort = new AbortController(); abort.abort(); expect((await f.owner.prepare(options, abort.signal)).status).toBe("cancelled");
  expect(f.calls).toEqual(["inspect"]); f.owner.dispose();
});

test("scope bound never evicts saved history and disposal retains pending request", async () => {
  const restored = Array.from({ length: 64 }, (_, index) => ({ ...saved, request: { ...saved.request,
    requestId: `50000000-0000-4000-8000-${index.toString().padStart(12, "0")}` } }));
  const f = fixture(restored);
  expect(await f.owner.prepare({ ...options, target: { projectId: epoch }, source: { kind: "dock", destination: "right" } })).toMatchObject({ status: "error", outcome: "not-submitted" });
  expect(f.owner.intents).toEqual(restored); expect(f.calls).toEqual([]); f.owner.dispose(); expect(f.owner.intents).toEqual(restored);
  const leaked = f.owner.intents; leaked.length = 0; expect(f.owner.intents).toHaveLength(64);
});

test("explicit detached recovery observes original request after browser close without recreating source", async () => {
  const f = fixture([saved]);
  const empty = reconcileDockPresentations(f.context.presentations, { state: createDockState(), tabs: [] }, "closed");
  f.commit({ presentations: empty });
  expect(await f.owner.inspect(`${hostId}:${saved.request.requestId}`)).toEqual({ status: "cancelled", creationMayHaveRun: true });
  expect(f.calls).toEqual([]);
  expect(await f.owner.inspectToDock(`${hostId}:${saved.request.requestId}`)).toMatchObject({ status: "ready", tab: { terminalId } });
  expect(f.calls).toEqual(["inspect"]); expect(f.context.presentations.snapshot.tabs).toEqual([]); expect(f.owner.intents).toEqual([saved]);
  f.owner.dispose();
});

test("detached recovery still rejects host or connection roundtrip and queued publication guards", async () => {
  const f = fixture([saved]), gate = deferred<NativeTerminalResult<TerminalCreationResponse>>(); f.inspectGate(gate.promise);
  const guard = f.owner.attachmentGuard({ ...options, source: { kind: "dock", destination: "bottom" } });
  const pending = f.owner.inspectToDock(`${hostId}:${saved.request.requestId}`); await drain();
  f.commit({ connected: false }); f.commit({ connected: true }); gate.resolve(ok(response(saved.request, true)));
  expect(await pending).toEqual({ status: "cancelled", creationMayHaveRun: true }); expect(guard()).toBe(false);
  expect(f.calls).toEqual(["inspect"]); expect(f.owner.intents).toEqual([saved]); f.owner.dispose();
});

test("saved-request recovery guards preserve original source while allowing explicit detached adoption", async () => {
  const f=fixture([saved]),requestKey=`${hostId}:${saved.request.requestId}`;
  try {
    const browser=f.owner.recoveryAttachmentGuard(requestKey),detached=f.owner.recoveryAttachmentGuard(requestKey,true);
    expect(browser()).toBe(true);expect(detached()).toBe(true);
    expect(f.owner.recoveryAttachmentGuard("missing",true)()).toBe(false);expect(f.calls).toEqual([]);
    f.commit({presentations:reconcileDockPresentations(f.context.presentations,{state:createDockState(),tabs:[]},"closed")});
    expect(browser()).toBe(false);expect(f.owner.recoveryAttachmentGuard(requestKey)()).toBe(false);expect(detached()).toBe(true);
    const result=await f.owner.inspectToDock(requestKey);expect(result).toMatchObject({status:"ready",tab:{terminalId}});
    expect(detached()).toBe(true);expect(f.owner.intents).toEqual([saved]);expect(f.calls).toEqual(["inspect"]);
    if(result.status!=="ready")throw new Error("Ready result required");
    f.view({dock:{state:insertDockTab(createDockState(),result.tab,"bottom"),tabs:[result.tab]}});
    f.view();f.save(); // Acknowledge the subsequent projection with the retired intent removed.
    expect(detached()).toBe(false);expect(f.owner.intents).toEqual([]);
  } finally {f.owner.dispose();}
});

for(const loss of ["host","workspace","connection","enabled"] as const){
  test(`saved-request detached guard latches ${loss} roundtrip and requires a fresh capture`,()=>{
    const f=fixture([saved]),requestKey=`${hostId}:${saved.request.requestId}`;
    try {
      const guard=f.owner.recoveryAttachmentGuard(requestKey,true);expect(guard()).toBe(true);
      const original=f.context;
      if(loss==="host")f.commit({hostId:epoch});
      if(loss==="workspace")f.commit({target:{projectId:sessionId}});
      if(loss==="connection")f.commit({connected:false});
      if(loss==="enabled")f.commit({enabled:false});
      f.commit(original);expect(guard()).toBe(false);
      const fresh=f.owner.recoveryAttachmentGuard(requestKey,true);expect(fresh()).toBe(true);
      f.commit();expect(fresh()).toBe(true);expect(f.calls).toEqual([]);expect(f.owner.intents).toEqual([saved]);
      f.owner.dispose();expect(fresh()).toBe(false);
    } finally {f.owner.dispose();}
  });
}
