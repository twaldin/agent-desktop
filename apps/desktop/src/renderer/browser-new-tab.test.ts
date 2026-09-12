import { expect, test } from "bun:test";
import React from "react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCreateReceipt, BrowserCreateRequest, BrowserMetadataSnapshot, DesktopBridge } from "@agent-desktop/shared";
import { BrowserNewTabController, createBrowserNewTab, parseBrowserNewTabState, type BrowserNewTabState } from "./browser-new-tab";
import { closeDockTab, createDockState, dockTabId, hideDock, insertDockTab, type BrowserFrameTarget, type DockTab } from "./dock-state";
import { defaultWindowView, parseDockSnapshot } from "../window-state";
import { WindowStateStore } from "../main/window-state";
import { useWorkbenchDock as CurrentWorkbenchDock } from "./use-workbench-dock";
const useWorkbenchDock: typeof CurrentWorkbenchDock = process.env.AGENT_DESKTOP_BROWSER_DOCK_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_BROWSER_DOCK_SOURCE)).useWorkbenchDock : CurrentWorkbenchDock;

const metadata = (): BrowserMetadataSnapshot => ({ protocolVersion: 1, hostId: "owner", sessionId: "session",
  availability: "not-started", reason: "Not started", creationTicket: { controlEpoch: "epoch", observedAt: Date.now() } });
const completed = (request: BrowserCreateRequest): BrowserCreateReceipt => ({ protocolVersion: 1, hostId: "owner", sessionId: "session", requestId: request.requestId,
  outcome: "completed", workerPid: 42, targetDisposition: "adopted-existing-target", tab: { name: `desktop-${request.requestId}`, targetId: "native", backend: "worker", kindTag: "relay", state: "alive",
    url: "https://example.invalid/redirected", title: "Page", viewport: { width: 640, height: 480 } } });
function fixture(options: { metadata?: () => Promise<BrowserMetadataSnapshot>; create?: (request: BrowserCreateRequest) => Promise<BrowserCreateReceipt>; state?: BrowserNewTabState } = {}) {
  const calls: Array<{ session: string; owner?: string; request?: BrowserCreateRequest }> = [];
  let tab = createBrowserNewTab("owner", "session", "instance");
  if (options.state) tab = { ...tab, browserNewTab: options.state };
  const snapshots: BrowserNewTabState[] = [];
  const materialized: Array<{ target: BrowserFrameTarget; title: string }> = [];
  const bridge = { getBrowserMetadata: async (session: string, owner?: string) => {
    calls.push({ session, owner }); return options.metadata ? options.metadata() : metadata();
  }, createBrowserTab: async (session: string, request: BrowserCreateRequest, owner?: string) => {
    calls.push({ session, owner, request }); return options.create ? options.create(request) : completed(request);
  } } as unknown as DesktopBridge;
  const controller = new BrowserNewTabController(bridge, tab, state => snapshots.push(structuredClone(state)),
    (target, title) => materialized.push({ target, title }), async () => {});
  controller.connected = true;
  return { tab, controller, calls, snapshots, materialized };
}

test("opening independent launchers has no bridge calls; draft edits remain local including empty presence", () => {
  const f = fixture();
  const second = createBrowserNewTab("owner", "session", "second");
  expect(second.id).not.toBe(f.tab.id);
  expect(createBrowserNewTab("other", "session", "instance").id).not.toBe(f.tab.id);
  f.controller.edit("example.com"); f.controller.edit("");
  expect(f.controller.state).toEqual({ status: "idle", draft: "" });
  f.controller.edit(undefined);
  expect(f.controller.state).toEqual({ status: "idle" });
  expect(f.calls).toEqual([]);
});

test("Enter acquires once with the exact owner/normalized URL and keeps the initiating UI identity", async () => {
  const gate = Promise.withResolvers<BrowserCreateReceipt>();
  const started = Promise.withResolvers<BrowserCreateRequest>();
  const f = fixture({ create: async request => { started.resolve(request); return gate.promise; } });
  f.controller.edit("localhost:8080/path?q=a");
  const first = f.controller.submit();
  const request = await started.promise;
  await f.controller.submit(); f.controller.edit("a different address");
  expect(f.controller.state).toMatchObject({ status: "pending", draft: "localhost:8080/path?q=a", request });
  expect(request.initialUrl).toBe("http://localhost:8080/path?q=a");
  expect(f.calls).toEqual([{ session: "session", owner: "owner" }, { session: "session", owner: "owner", request }]);
  gate.resolve(completed(request)); await first;
  expect(f.materialized).toHaveLength(1);
  expect(f.materialized[0]).toEqual({ title: "Page", target: { workerPid: 42, name: `desktop-${request.requestId}`, targetId: "native" } });
  const { browserNewTab: _newTab, ...before } = f.tab;
  const web: DockTab = { ...before, browserTarget: f.materialized[0]!.target };
  expect(dockTabId(web)).toBe(f.tab.id);
  await f.controller.submit(); expect(f.calls).toHaveLength(2);
});

test("closing before ticket lookup resolves prevents acquisition; closing after dispatch prevents replacement", async () => {
  const ticket = Promise.withResolvers<BrowserMetadataSnapshot>();
  const f = fixture({ metadata: () => ticket.promise });
  f.controller.edit("https://example.invalid"); const a = f.controller.submit();
  f.controller.dispose(); ticket.resolve(metadata()); await a;
  expect(f.calls).toHaveLength(1); expect(f.materialized).toEqual([]);
  const gate = Promise.withResolvers<BrowserCreateReceipt>(); const started = Promise.withResolvers<BrowserCreateRequest>();
  const g = fixture({ create: request => { started.resolve(request); return gate.promise; } });
  g.controller.edit("https://example.invalid"); const b = g.controller.submit(); const request = await started.promise;
  g.controller.dispose(); gate.resolve(completed(request)); await b;
  expect(g.calls).toHaveLength(2); expect(g.materialized).toEqual([]);
});

test("unknown replies, transport failure and malformed ownership retain the request and block new submissions", async () => {
  for (const create of [
    async (_request: BrowserCreateRequest): Promise<BrowserCreateReceipt> => { throw new Error("Lost response"); },
    async (request: BrowserCreateRequest): Promise<BrowserCreateReceipt> => ({ protocolVersion: 1, hostId: "owner", sessionId: "session", requestId: request.requestId, outcome: "unknown", message: "Unknown" }),
    async (request: BrowserCreateRequest): Promise<BrowserCreateReceipt> => ({ ...completed(request), hostId: "other" }),
    async (request: BrowserCreateRequest): Promise<BrowserCreateReceipt> => ({ ...completed(request), requestId: "different" }),
  ]) {
    const f = fixture({ create }); f.controller.edit("https://example.invalid"); await f.controller.submit();
    expect(f.controller.state.status).toBe("unknown"); expect(f.controller.state.request?.initialUrl).toBe("https://example.invalid");
    const retained = structuredClone(f.controller.state); f.controller.edit(undefined); await f.controller.submit();
    expect(f.controller.state).toEqual(retained); expect(f.calls).toHaveLength(2); expect(f.materialized).toEqual([]);
  }
});

test("offline/preflight failures stay local or rejected; a deliberate retry follows a definite rejection", async () => {
  const f = fixture(); f.controller.connected = false; f.controller.edit("example.com"); await f.controller.submit();
  expect(f.controller.state.status).toBe("rejected"); expect(f.calls).toEqual([]);
  f.controller.connected = true; f.controller.edit("/private/file"); await f.controller.submit(); expect(f.calls).toEqual([]);
  const g = fixture({ metadata: async () => ({ ...metadata(), hostId: "wrong" }) });
  g.controller.edit("example.com"); await g.controller.submit(); expect(g.controller.state.status).toBe("rejected"); expect(g.calls).toHaveLength(1);
  let reject = true;
  const h = fixture({ create: async request => reject ? { protocolVersion: 1, hostId: "owner", sessionId: "session", requestId: request.requestId, outcome: "rejected", message: "Disabled" } : completed(request) });
  h.controller.edit("example.com"); await h.controller.submit(); expect(h.controller.state.status).toBe("rejected");
  reject = false; await h.controller.submit(); expect(h.materialized).toHaveLength(1);
  expect(h.calls[1]!.request!.requestId).not.toBe(h.calls[3]!.request!.requestId);
});

test("saved pending acquisition restores unknown without replay, preserving draft/identity and other windows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-browser-window-"));
  try {
    const request: BrowserCreateRequest = { requestId: "request", controlEpoch: "epoch", observedAt: Date.now(), initialUrl: "https://example.invalid/" };
    const tab = { ...createBrowserNewTab("owner", "session", "instance"), browserNewTab: { status: "pending" as const, draft: "example.invalid", request } };
    const state = { ...defaultWindowView(), route: { hostId: "owner", sessionId: "session" }, dock: { tabs: [tab], state: insertDockTab(createDockState(), tab, "bottom") } };
    const a = new WindowStateStore(directory, "primary"), b = new WindowStateStore(directory, "second");
    expect(a.saveView(state)).toEqual({}); expect(b.saveView(defaultWindowView())).toEqual({});
    const loaded = new WindowStateStore(directory, "primary").bootstrap().state!;
    expect(loaded.dock!.tabs[0]!.browserNewTab).toMatchObject({ status: "unknown", draft: "example.invalid", request });
    expect(loaded.dock!.tabs[0]!.id).toBe(tab.id); expect(loaded.dock!.state.bottom.activeTabId).toBe(tab.id);
    expect(new WindowStateStore(directory, "second").bootstrap().state).toEqual(defaultWindowView());
    const f = fixture({ state: loaded.dock!.tabs[0]!.browserNewTab }); await f.controller.submit(); expect(f.calls).toEqual([]);
    expect(parseBrowserNewTabState({ status: "pending", draft: "" })).toEqual({ status: "idle", draft: "" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("window projection rejects mixed native/launcher identity and never upgrades legacy about:blank into a launcher", () => {
  const tab = createBrowserNewTab("owner", "session", "instance");
  const state = insertDockTab(createDockState(), tab, "right");
  expect(parseDockSnapshot({ state, tabs: [{ ...tab, browserTarget: { workerPid: 42, name: "native", targetId: "id" } }] })).toBeUndefined();
  expect(parseDockSnapshot({ state, tabs: [{ ...tab, browserInstanceId: "bad/id" }] })).toBeUndefined();
  expect(parseDockSnapshot({ state, tabs: [{ ...tab, browserNewTab: { status: "unknown" } }] })).toBeUndefined();
  expect(parseDockSnapshot({ state, tabs: [{ ...tab, browserNewTab: { status: "idle", draft: "x".repeat(8193) } }] })).toBeUndefined();
  const legacy = { kind: "browser" as const, hostId: "owner", target: "session:session" as const, title: "about:blank", id: "owner:session:session:browser" };
  expect(parseDockSnapshot({ state: insertDockTab(createDockState(), legacy, "right"), tabs: [legacy] })!.tabs[0]!.browserNewTab).toBeUndefined();
});

/** Version-bound controlled hook slots, not a React mount/commit or DOM proof. */
function hookDriver(deferred = false) {
  const pending: Array<() => void> = [];
  const slots: any[] = []; let cursor = 0;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [slots[i], (next: any) => { const apply = () => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }; if (deferred) pending.push(apply); else apply(); }]; },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useEffect() {},
  };
  return { flush() { for (const apply of pending.splice(0)) apply(); }, render<T>(callback: () => T): T { cursor = 0; const old = internals.H; internals.H = dispatcher;
    try { return callback(); } finally { internals.H = old; } } };
}

test("actual dock opens a NEW_TAB_PAGE without bridge calls", async () => {
  const slots = hookDriver(); let calls = 0;
  const bridge = { getBrowserMetadata: async () => { calls++; return metadata(); },
    createBrowserTab: async (session: string, request: BrowserCreateRequest) => { calls++; return completed(request); } } as unknown as DesktopBridge;
  const render = () => slots.render(() => useWorkbenchDock(bridge, defaultWindowView(), "owner", { sessionId: "session" }, true, message => { throw new Error(message); }));
  let dock = render(); await dock.browser("right"); dock = render();
  expect(calls).toBe(0);
  expect(dock.snapshot.tabs).toHaveLength(1);
  expect(dock.snapshot.tabs[0]!.browserNewTab).toEqual({ status: "idle" });
  expect(dock.snapshot.tabs[0]!.browserTarget).toBeUndefined();
  expect(dock.snapshot.state.right.activeTabId).toBe(dock.snapshot.tabs[0]!.id);
});

test("actual dock hook opens locally and replaces only the initiating tab without changing hidden layout/current owner", async () => {
  const slots = hookDriver(); let currentOwner = "owner", currentSession = "session", calls = 0;
  const gate = Promise.withResolvers<BrowserCreateReceipt>(); const started = Promise.withResolvers<BrowserCreateRequest>();
  const bridge = { getBrowserMetadata: async () => { calls++; return metadata(); },
    createBrowserTab: async (session: string, request: BrowserCreateRequest, host: string) => {
      expect([session, host]).toEqual(["session", "owner"]); calls++; started.resolve(request); return gate.promise;
    } } as unknown as DesktopBridge;
  const render = () => slots.render(() => useWorkbenchDock(bridge, defaultWindowView(), currentOwner, { sessionId: currentSession }, true, message => { throw new Error(message); }, undefined, "ltr", async () => {}));
  let dock = render(); await dock.browser("right"); dock = render();
  const first = dock.snapshot.tabs[0]!; expect(first.browserNewTab).toEqual({ status: "idle" }); expect(calls).toBe(0);
  const controller = dock.browserLauncher(first, true); controller.edit("example.com");
  const pending = controller.submit(); const request = await started.promise;
  dock = render(); await dock.browser("bottom"); dock = render();
  const second = dock.snapshot.tabs.find(tab => tab.id !== first.id)!;
  dock.browserLauncher(second, true).edit("preserved draft");
  dock = render(); dock.change(hideDock(dock.snapshot.state, "right"));
  currentOwner = "different"; currentSession = "different";
  dock = render(); gate.resolve(completed(request)); await pending; dock = render();
  expect(dock.snapshot.state.right.open).toBe(false);
  expect(dock.snapshot.tabs.find(tab => tab.id === first.id)).toMatchObject({ hostId: "owner", target: "session:session", title: "Page", browserTarget: { workerPid: 42, targetId: "native" } });
  expect(dock.snapshot.tabs.find(tab => tab.id === first.id)!.browserNewTab).toBeUndefined();
  expect(dock.snapshot.tabs.find(tab => tab.id === second.id)!.browserNewTab).toEqual({ status: "idle", draft: "preserved draft" });
  expect(calls).toBe(2);
});

test("actual dock close cancels the launcher before a delayed ticket can dispatch", async () => {
  const slots = hookDriver(); const gate = Promise.withResolvers<BrowserMetadataSnapshot>(); let creates = 0;
  const bridge = { getBrowserMetadata: () => gate.promise, createBrowserTab: async (session: string, request: BrowserCreateRequest) => { creates++; return completed(request); } } as unknown as DesktopBridge;
  const render = () => slots.render(() => useWorkbenchDock(bridge, defaultWindowView(), "owner", { sessionId: "session" }, true, () => {}));
  let dock = render(); dock.open("browser"); dock = render(); const tab = dock.snapshot.tabs[0]!;
  const controller = dock.browserLauncher(tab, true); controller.edit("example.com"); const pending = controller.submit();
  dock = render(); dock.change(closeDockTab(dock.snapshot.state, "right", tab.id)); dock = render();
  gate.resolve(metadata()); await pending; dock = render();
  expect(creates).toBe(0); expect(dock.snapshot.tabs).toEqual([]);
});


test("isolated dock without window persistence ownership refuses browser dispatch", async () => {
  const slots = hookDriver(); let creates = 0;
  const bridge = { getBrowserMetadata: async () => metadata(), createBrowserTab: async (_session: string, request: BrowserCreateRequest) => { creates++; return completed(request); } } as unknown as DesktopBridge;
  const render = () => slots.render(() => useWorkbenchDock(bridge, defaultWindowView(), "owner", { sessionId: "session" }, true, () => {}));
  let dock = render(); dock.open("browser"); dock = render(); const controller = dock.browserLauncher(dock.snapshot.tabs[0]!, true);
  controller.edit("https://example.invalid"); await controller.submit();
  expect(creates).toBe(0); expect(controller.state).toMatchObject({ status: "rejected", message: "Window save acknowledgement is unavailable for browser creation." });
});

test("Suggested original-source loss across metadata and dispatched creation cannot rebind or publish", async () => {
  const ticket = Promise.withResolvers<BrowserMetadataSnapshot>(); let retained = true;
  const a = fixture({ metadata: () => ticket.promise }); a.controller.edit('http://localhost:8080/');
  const reading = a.controller.submit(() => retained); retained = false; ticket.resolve(metadata()); await reading;
  expect(a.calls).toHaveLength(1); expect(a.controller.state.status).toBe('rejected'); expect(a.materialized).toEqual([]);
  retained = true; const dispatch = Promise.withResolvers<BrowserCreateRequest>(), receipt = Promise.withResolvers<BrowserCreateReceipt>();
  const b = fixture({ create: async request => { dispatch.resolve(request); return receipt.promise; } }); b.controller.edit('http://localhost:8080/');
  const creating = b.controller.submit(() => retained); const request = await dispatch.promise; retained = false; receipt.resolve(completed(request)); await creating;
  expect(b.calls).toHaveLength(2); expect(b.controller.state.status).toBe('unknown'); expect(b.materialized).toEqual([]);
  await b.controller.submit(() => true); expect(b.calls).toHaveLength(2);
});

test("Suggested file and website queued admission rechecks the original source, while a fresh selection remains usable", async () => {
  const slots = hookDriver(true); let current = true, calls = 0;
  const bridge = { getBrowserMetadata: async () => { calls++; return metadata(); } } as unknown as DesktopBridge;
  const render = () => slots.render(() => useWorkbenchDock(bridge, defaultWindowView(), 'owner', { sessionId: 'session' }, true, () => {}));
  let dock = render();
  dock.openOutputWebsite('http://localhost:8080/', 'owner', 'session', () => current, () => current);
  await dock.openHostFile('/task/report.pdf', 'owner', 'right', false, () => current);
  current = false; slots.flush(); dock = render(); expect(dock.snapshot.tabs).toEqual([]); expect(calls).toBe(0);
  current = true; dock.openOutputWebsite('http://localhost:8080/', 'owner', 'session', () => current, () => current);
  slots.flush(); dock = render(); expect(dock.snapshot.tabs).toHaveLength(1); expect(dock.snapshot.tabs[0]?.browserNewTab).toEqual({ status: 'idle', draft: 'http://localhost:8080/' }); expect(calls).toBe(0);
});
