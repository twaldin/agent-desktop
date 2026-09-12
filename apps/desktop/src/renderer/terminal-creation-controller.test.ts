import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeTerminalResult, TerminalCreationBridge, TerminalCreationRequest, TerminalCreationResponse } from "@agent-desktop/shared";
import { TerminalCreationController, type TerminalCreationOptions, type TerminalCreationOwner } from "./terminal-creation-controller";
import { TerminalWindowCheckpoint } from "./terminal-window-checkpoint";
import { defaultWindowView, type WindowViewState } from "../window-state";
import type { TerminalWindowIntent } from "../terminal-window-intent";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";
import { HostStore } from "../../../host/src/store";
import { TerminalCreationHttp } from "../../../host/src/terminals/creation-http";
import { WindowStateStore } from "../main/window-state";
import { nativeTerminalResult } from "../main/host-transport";
import { requestTerminalCreate, requestTerminalCreationCapabilities, requestTerminalCreationStatus } from "../main/terminal-create-transport";

const hostId = "10000000-0000-4000-8000-000000000001", sessionId = "20000000-0000-4000-8000-000000000002";
const epoch = "30000000-0000-4000-8000-000000000003", terminalId = "40000000-0000-4000-8000-000000000004";
const tab = { ...createBrowserNewTab(hostId, sessionId, "original"), browserNewTab: { status: "idle" as const, draft: "original address" } };
const options: TerminalCreationOptions = { hostId, target: { sessionId }, cols: 120, rows: 30,
  source: { kind: "browser", tabId: tab.id, browserInstanceId: tab.browserInstanceId!, title: tab.title, draft: "original address" } };
const restored: TerminalWindowIntent = { version: 1, hostId, source: options.source,
  request: { version: 1, requestId: "50000000-0000-4000-8000-000000000005", controlEpoch: epoch, target: options.target, cols: 120, rows: 30 } };
const ok = <T>(value: T): NativeTerminalResult<T> => ({ ok: true, value });
function deferred<T>() { let resolve!: (v: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function response(request: TerminalCreationRequest, metadata = false): TerminalCreationResponse {
  return { version: 1, hostId, requestId: request.requestId, status: "settled", receipt: { outcome: "completed", terminalId },
    ...(metadata ? { terminal: { id: terminalId, target: options.target, cwd: "/fixture", protocol: "tmux-v1", serverGeneration: epoch, status: "running", attachable: true } } : {}) };
}
function fixture(saved?: TerminalWindowIntent) {
  const checkpoint = new TerminalWindowCheckpoint();
  let owner: TerminalCreationOwner = { hostId, target: options.target, enabled: true, connected: true, sourceCurrent: true };
  let view: WindowViewState = { ...defaultWindowView(), route: { hostId, sessionId }, dock: { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] },
    ...(saved ? { terminalCreations: [saved] } : {}) };
  const calls: string[] = [], inputs: TerminalCreationRequest[] = [];
  const createEntered = deferred<void>(), inspectEntered = deferred<void>();
  let capGate: Promise<NativeTerminalResult<{ version: 1; hostId: string; controlEpoch: string }>> | undefined;
  let createGate: Promise<NativeTerminalResult<TerminalCreationResponse>> | undefined, inspectGate: Promise<NativeTerminalResult<TerminalCreationResponse>> | undefined;
  const bridge: TerminalCreationBridge = {
    async getTerminalCreationCapabilities() { calls.push("capabilities"); return capGate ?? ok({ version: 1, hostId, controlEpoch: epoch }); },
    async createNativeTerminal(request) { calls.push("create"); inputs.push(structuredClone(request)); createEntered.resolve(); return createGate ?? ok(response(request)); },
    async observeTerminalCreation(request) { calls.push("inspect"); inputs.push(structuredClone(request)); inspectEntered.resolve(); return inspectGate ?? ok(response(request, true)); },
  };
  const controller = new TerminalCreationController(bridge, options, () => owner, intent => {
    view = { ...view, terminalCreations: intent ? [intent] : [] };
  }, (intent, signal) => checkpoint.wait(intent, signal), () => {}, saved);
  checkpoint.committed(view);
  return { controller, bridge, checkpoint, calls, inputs, createEntered, inspectEntered,
    get view() { return view; },
    commit(change: Partial<TerminalCreationOwner>) { owner = { ...owner, ...change }; controller.observe(); },
    save() { checkpoint.committed(view); checkpoint.saved(view); },
    capGate(value: typeof capGate) { capGate = value; }, createGate(value: typeof createGate) { createGate = value; }, inspectGate(value: typeof inspectGate) { inspectGate = value; },
  };
}

test("fresh create waits for exact window acknowledgement, observes once and retires only committed attachment", async () => {
  const f = fixture(), result = f.controller.prepare(); await drain();
  expect(f.calls).toEqual(["capabilities"]); const intent = f.controller.intent!;
  expect(intent.source).toEqual(options.source); expect(intent.request.target).toEqual(options.target); expect(intent.request.controlEpoch).toBe(epoch);
  f.save(); const ready = await result; expect(ready.status).toBe("ready"); if (ready.status !== "ready") throw new Error("ready");
  expect(f.calls).toEqual(["capabilities", "create", "inspect"]); expect(f.inputs[0]).toEqual(f.inputs[1]); expect(f.controller.intent).toEqual(intent);
  expect(f.controller.attached(f.view)).toBe(false);
  const committed = { ...f.view, dock: { tabs: [ready.tab], state: insertDockTab(createDockState(), ready.tab, "bottom") } };
  expect(f.controller.attached(committed)).toBe(true); expect(f.controller.intent).toBeUndefined();
  expect((await f.controller.prepare()).status).toBe("error"); expect(f.calls.filter(c => c === "create")).toHaveLength(1); f.controller.dispose();
});

test("failed checkpoint and pre-dispatch cancellation never create and clear only this known-unsent intent", async () => {
  for (const mode of ["save", "abort", "owner"] as const) {
    const f = fixture(), cancel = new AbortController(), result = f.controller.prepare(cancel.signal); await drain();
    if (mode === "save") f.checkpoint.failed("Disk failed");
    else if (mode === "abort") cancel.abort(); else { f.commit({ target: { projectId: sessionId } }); f.commit({ target: options.target }); }
    const value = await result; expect(value).toMatchObject(mode === "save" ? { status: "error", outcome: "not-submitted" } : { status: "cancelled", creationMayHaveRun: false });
    expect(f.calls).toEqual(["capabilities"]); expect(f.controller.intent).toBeUndefined(); f.controller.dispose();
  }
});

test("capability loss and restore is latched before intent allocation or native dispatch", async () => {
  const gate = deferred<NativeTerminalResult<{ version: 1; hostId: string; controlEpoch: string }>>(), f = fixture(); f.capGate(gate.promise);
  const result = f.controller.prepare(); f.commit({ connected: false }); f.commit({ connected: true });
  gate.resolve(ok({ version: 1, hostId, controlEpoch: epoch }));
  expect(await result).toEqual({ status: "cancelled", creationMayHaveRun: false }); expect(f.controller.intent).toBeUndefined(); expect(f.calls).toEqual(["capabilities"]); f.controller.dispose();
});

test("lost create reply keeps original intent and explicit inspection never reacquires", async () => {
  const gate = deferred<NativeTerminalResult<TerminalCreationResponse>>(), f = fixture(); f.createGate(gate.promise);
  const result = f.controller.prepare(); await drain(); f.save(); await f.createEntered.promise;
  const intent = f.controller.intent!; gate.reject(new Error("Reply lost"));
  expect(await result).toMatchObject({ status: "error", outcome: "unknown" }); expect(f.controller.intent).toEqual(intent);
  expect((await f.controller.prepare()).status).toBe("error"); expect((await f.controller.inspect()).status).toBe("ready");
  expect(f.calls).toEqual(["capabilities", "create", "inspect"]); expect(f.inputs.every(r => r.requestId === intent.request.requestId)).toBe(true); f.controller.dispose();
});

test("restored requests never create; unavailable or malformed inspection preserves them", async () => {
  const f = fixture(restored); expect((await f.controller.prepare()).status).toBe("error"); expect(f.calls).toEqual([]);
  f.inspectGate(Promise.resolve(ok({ version: 1, hostId, requestId: restored.request.requestId, status: "unavailable" })));
  expect(await f.controller.inspect()).toMatchObject({ status: "error", outcome: "unknown" });
  f.inspectGate(Promise.resolve(ok({ ...response(restored.request, true), hostId: epoch })));
  expect(await f.controller.inspect()).toMatchObject({ status: "error", outcome: "unknown" });
  expect(f.controller.intent).toEqual(restored); expect(f.calls).toEqual(["inspect", "inspect"]); f.controller.dispose();
});

test("sent create and inspection reject owner/source/connection loss-and-return before consuming a reply", async () => {
  for (const stage of ["create", "inspect"] as const) for (const change of ["host", "target", "source", "connection", "enabled"] as const) {
    const f = fixture(stage === "inspect" ? restored : undefined), gate = deferred<NativeTerminalResult<TerminalCreationResponse>>();
    if (stage === "create") f.createGate(gate.promise); else f.inspectGate(gate.promise);
    const result = stage === "create" ? f.controller.prepare() : f.controller.inspect();
    if (stage === "create") { await drain(); f.save(); await f.createEntered.promise; } else await f.inspectEntered.promise;
    const intent = f.controller.intent!;
    const bad: Partial<TerminalCreationOwner> = change === "host" ? { hostId: epoch } : change === "target" ? { target: { projectId: sessionId } }
      : change === "source" ? { sourceCurrent: false } : change === "connection" ? { connected: false } : { enabled: false };
    f.commit(bad); f.commit({ hostId, target: options.target, sourceCurrent: true, connected: true, enabled: true });
    gate.resolve(ok(response(intent.request, true)));
    expect(await result).toEqual({ status: "cancelled", creationMayHaveRun: true }); expect(f.controller.intent).toEqual(intent);
    expect(f.calls.filter(c => c === "create")).toHaveLength(stage === "create" ? 1 : 0);
    f.inspectGate(undefined); expect((await f.controller.inspect()).status).toBe("ready"); f.controller.dispose();
  }
});

test("automatic post-completion observation also latches a connection roundtrip", async () => {
  const f = fixture(), gate = deferred<NativeTerminalResult<TerminalCreationResponse>>(); f.inspectGate(gate.promise);
  const result = f.controller.prepare(); await drain(); f.save(); await f.inspectEntered.promise;
  f.commit({ connected: false }); f.commit({ connected: true }); gate.resolve(ok(response(f.controller.intent!.request, true)));
  expect(await result).toEqual({ status: "cancelled", creationMayHaveRun: true }); expect(f.controller.intent).toBeDefined(); expect(f.calls.filter(c => c === "create")).toHaveLength(1); f.controller.dispose();
});

test("explicit recovery can adopt live reserved metadata while leaving immutable unknown outcome untouched", async () => {
  const f = fixture(restored), value = response(restored.request, true);
  if (value.status !== "settled") throw new Error("settled");
  value.receipt = { outcome: "unknown", terminalId, message: "Interrupted host" }; f.inspectGate(Promise.resolve(ok(value)));
  const ready = await f.controller.inspect(); expect(ready).toMatchObject({ status: "ready", tab: { terminalId } });
  expect(value.receipt.outcome).toBe("unknown"); expect(f.controller.intent).toEqual(restored); expect(f.calls).toEqual(["inspect"]); f.controller.dispose();
});

test("changed reserved ID, changed final receipt, or nonattachable metadata never publish a tab", async () => {
  for (const mode of ["identity", "receipt", "attachable"] as const) {
    const f = fixture(), result = f.controller.prepare(); await drain();
    const value = response(f.controller.intent!.request, true); if (value.status !== "settled" || !value.terminal) throw new Error("metadata");
    if (mode === "identity") { value.receipt.terminalId = epoch; value.terminal.id = epoch; }
    else if (mode === "receipt") value.receipt = { outcome: "not-submitted", terminalId, message: "Contradiction" };
    else value.terminal.attachable = false;
    f.inspectGate(Promise.resolve(ok(value))); f.save(); expect(await result).toMatchObject({ status: "error", outcome: "unknown" });
    expect(f.controller.intent).toBeDefined(); expect(f.calls.filter(c => c === "create")).toHaveLength(1); f.controller.dispose();
  }
});

test("missing transport fails closed and disposed controllers cannot acknowledge attachment", async () => {
  const controller = new TerminalCreationController({}, options, () => ({ hostId, target: options.target, connected: true, enabled: true, sourceCurrent: true }),
    () => { throw new Error("Unexpected persistence"); }, async () => {}, () => {});
  expect(await controller.prepare()).toMatchObject({ status: "error", outcome: "not-submitted" }); controller.dispose();
  const f = fixture(restored), ready = await f.controller.inspect(); if (ready.status !== "ready") throw new Error("ready");
  f.controller.dispose(); expect(f.controller.attached({ ...f.view, dock: { tabs: [ready.tab], state: insertDockTab(createDockState(), ready.tab, "bottom") } })).toBe(false);
  expect(f.controller.intent).toEqual(restored);
});

test("controller, desktop transport, actual route and stores recover one reserved project terminal after discarded reply", async () => {
  const root = mkdtempSync(join(tmpdir(), "terminal-controller-chain-")), host = new HostStore(join(root, "host"));
  const window = new WindowStateStore(join(root, "window"), "primary"), checkpoint = new TerminalWindowCheckpoint();
  const originalFetch = globalThis.fetch;
  let view: WindowViewState = defaultWindowView(), creates = 0, gets = 0, lost = false;
  const opts: TerminalCreationOptions = { hostId: host.host.id, target: { projectId: sessionId }, cols: 120, rows: 30, source: { kind: "dock", destination: "bottom" } };
  const owner: TerminalCreationOwner = { hostId: opts.hostId, target: opts.target, enabled: true, connected: true, sourceCurrent: true };
  const route = new TerminalCreationHttp({ hostId: opts.hostId, controlEpoch: epoch, records: host.terminalCreations,
    resolveTarget: () => root, environmentForTarget: () => undefined, manager: {
      async create(input, _env, _action, reservation) {
        creates++; reservation!.validateOwner(); expect(view.terminalCreations).toHaveLength(1);
        expect(new WindowStateStore(join(root, "window"), "primary").bootstrap().state?.terminalCreations).toEqual(view.terminalCreations);
        const info = { id: reservation!.terminalId, target: input.target, cwd: root, shell: "fixture", pid: null,
          cols: 120, rows: 30, createdAt: 1, protocol: "tmux-v1" as const, status: "running" as const, serverGeneration: epoch, geometryRevision: 1, inputEpoch: epoch, attachable: true };
        return info;
      },
      get(id) { gets++; return { id, target: opts.target, cwd: root, shell: "fixture", pid: null, cols: 120, rows: 30, createdAt: 1,
        protocol: "tmux-v1", status: "running", serverGeneration: epoch, geometryRevision: 1, inputEpoch: epoch, attachable: true }; },
    } });
  const paths: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init); paths.push(new URL(request.url).pathname);
    const response = await route.handle(request); if (!response) throw new Error("Unowned path");
    if (paths.at(-1) === "/v2/terminals/create" && !lost) { lost = true; await response.body?.cancel(); throw new Error("Discarded fulfilled reply"); }
    return response;
  }) as unknown as typeof fetch;
  const endpoint = { origin: "http://unused.invalid", hostId: opts.hostId };
  const bridge: TerminalCreationBridge = {
    getTerminalCreationCapabilities: () => nativeTerminalResult(() => requestTerminalCreationCapabilities(endpoint)),
    createNativeTerminal: request => nativeTerminalResult(() => requestTerminalCreate(endpoint, request)),
    observeTerminalCreation: request => nativeTerminalResult(() => requestTerminalCreationStatus(endpoint, request)),
  };
  const persist = (intent?: TerminalWindowIntent) => { view = { ...view, terminalCreations: intent ? [intent] : [] }; };
  const controller = new TerminalCreationController(bridge, opts, () => owner, persist, (intent, signal) => checkpoint.wait(intent, signal), () => {});
  let restoredController: TerminalCreationController | undefined;
  checkpoint.committed(view);
  try {
    const result = controller.prepare();
    for (let i = 0; i < 100 && !controller.intent; i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(controller.intent).toBeDefined(); expect(creates).toBe(0);
    checkpoint.committed(view); expect(window.saveView(view)).toEqual({}); checkpoint.saved(new WindowStateStore(join(root, "window"), "primary").bootstrap().state!);
    expect(await result).toMatchObject({ status: "error", outcome: "unknown" }); expect(creates).toBe(1);
    const saved = new WindowStateStore(join(root, "window"), "primary").bootstrap().state!.terminalCreations![0]!;
    controller.dispose();
    restoredController = new TerminalCreationController(bridge, opts, () => owner, persist, async () => { throw new Error("Restoration cannot create"); }, () => {}, saved);
    expect((await restoredController.prepare()).status).toBe("error");
    const ready = await restoredController.inspect(); expect(ready).toMatchObject({ status: "ready", tab: { hostId: opts.hostId, target: `project:${sessionId}`, terminalId: host.terminalCreations.get(saved.request)!.terminalId } });
    expect(creates).toBe(1); expect(gets).toBe(1);
    expect(paths).toEqual(["/v2/terminals/creation-capabilities", "/v2/terminals/create", "/v2/terminals/creation-status"]);
  } finally { controller.dispose(); restoredController?.dispose(); globalThis.fetch = originalFetch; await route.dispose(); host.close(); rmSync(root, { recursive: true, force: true }); }
});
