import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { type BrowserCreateRequest, type DesktopBridge } from "@agent-desktop/shared";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView, type WindowViewState } from "../window-state";
import { BrowserWindowCheckpoint } from "./browser-window-checkpoint";
import { BrowserNewTabController as CurrentController, createBrowserNewTab, type BrowserNewTabState } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";
import { useWindowViewPersistence } from "./window-view-state";
const Controller: typeof CurrentController = process.env.AGENT_DESKTOP_BROWSER_CHECKPOINT_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_BROWSER_CHECKPOINT_SOURCE)).BrowserNewTabController : CurrentController;
const request: BrowserCreateRequest = { requestId: "saved-request", controlEpoch: "epoch", observedAt: 1_000_000, initialUrl: "https://example.invalid/" };
function viewFor(state: BrowserNewTabState = { status: "idle" }) {
  const tab = { ...createBrowserNewTab("owner", "session", "instance"), browserNewTab: state };
  return { ...defaultWindowView(), dock: { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") } };
}
function fixture(checkpoint = new BrowserWindowCheckpoint()) {
  let view = viewFor(), creates = 0, materializations = 0;
  const tab = view.dock.tabs[0]!;
  const bridge = { getBrowserMetadata: async () => ({ hostId: "owner", sessionId: "session", creationTicket: { controlEpoch: "epoch", observedAt: 1_000_000 } }),
    createBrowserTab: async (_session: string, input: BrowserCreateRequest) => {
      creates++;
      return { protocolVersion: 1, hostId: "owner", sessionId: "session", requestId: input.requestId, outcome: "completed", workerPid: 42,
        targetDisposition: "created-page", tab: { name: `desktop-${input.requestId}`, targetId: "target", backend: "worker", kindTag: "headless", state: "alive", url: input.initialUrl, title: "Page", viewport: { width: 640, height: 480 } } };
    } } as unknown as DesktopBridge;
  const controller = new Controller(bridge, tab, state => { view = { ...view, dock: { ...view.dock, tabs: [{ ...tab, browserNewTab: state }] } }; },
    () => { materializations++; }, (tab, state, signal) => checkpoint.wait(tab, state, signal));
  checkpoint.committed(view); controller.connected = true;
  return { controller, checkpoint, get view() { return view; }, counts: () => ({ creates, materializations }) };
}
const drainMetadata = async () => { await Promise.resolve(); await Promise.resolve(); };

test("creation waits for exact acknowledged window request before dispatch and preserves newer sibling layout", async () => {
  const root = mkdtempSync(join(tmpdir(), "browser-window-checkpoint-")), f = fixture(), store = new WindowStateStore(root, "primary");
  f.controller.edit("https://example.invalid"); const running = f.controller.submit();
  try {
    await drainMetadata();
    expect(f.counts()).toEqual({ creates: 0, materializations: 0 });
    expect(f.controller.state.request?.initialUrl).toBe("https://example.invalid");
    const sibling = { ...createBrowserNewTab("other-owner", "other-session", "sibling"), browserNewTab: { status: "idle" as const, draft: "unsent sibling" } };
    const current: WindowViewState = { ...f.view, route: { hostId: "new-current-owner", sessionId: "new-session" }, sidebarOpen: false,
      dock: { state: insertDockTab(f.view.dock.state, sibling, "bottom"), tabs: [...f.view.dock.tabs, sibling] } };
    f.checkpoint.committed(current); await drainMetadata(); expect(f.counts().creates).toBe(0);
    expect(store.saveView(current)).toEqual({});
    const persisted = new WindowStateStore(root, "primary").bootstrap().state!;
    expect(persisted.route).toEqual(current.route); expect(persisted.sidebarOpen).toBe(false);
    expect(persisted.dock?.tabs[0]?.browserNewTab).toMatchObject({ status: "unknown", request: f.controller.state.request });
    expect(persisted.dock?.tabs[1]?.browserNewTab?.draft).toBe("unsent sibling");
    // Save success alone is not an implicit callback; the existing persistence owner acknowledges it.
    expect(f.counts().creates).toBe(0); f.checkpoint.saved(current); await running;
    expect(f.counts()).toEqual({ creates: 1, materializations: 1 });
  } finally { f.controller.dispose(); await running; rmSync(root, { recursive: true, force: true }); }
});

test("save failure, close and disconnect while awaiting acknowledgement prevent creation", async () => {
  for (const action of ["save-failure", "close", "disconnect"] as const) {
    const f = fixture(); f.controller.edit("example.invalid"); const running = f.controller.submit();
    try {
      await drainMetadata(); f.checkpoint.committed(f.view);
      if (action === "save-failure") f.checkpoint.failed("controlled disk failure");
      else if (action === "close") f.controller.dispose();
      else { f.controller.connected = false; f.checkpoint.saved(f.view); }
      await running; expect(f.counts().creates).toBe(0); expect(f.controller.state.draft).toBe("example.invalid");
      if (action !== "close") expect(f.controller.state.status).toBe("rejected");
    } finally { f.controller.dispose(); await running; }
  }
});

test("checkpoint requires exact owner, request and draft; stale saves and separate windows cannot acknowledge", async () => {
  const state = { status: "pending" as const, draft: "exact draft", request }, initial = viewFor(), matching = viewFor(state);
  const cp = new BrowserWindowCheckpoint(), other = new BrowserWindowCheckpoint(), cancel = new AbortController();
  cp.committed(initial); let resolved = false;
  const waiting = cp.wait(initial.dock.tabs[0]!, state, cancel.signal).then(() => { resolved = true; });
  try {
    cp.saved(matching); await drainMetadata(); expect(resolved).toBe(false); // Not committed.
    for (const changed of [
      { ...state, draft: "other draft" }, { ...state, request: { ...request, observedAt: request.observedAt + 1 } },
    ]) { cp.saved(viewFor(changed)); await drainMetadata(); expect(resolved).toBe(false); }
    const wrong = structuredClone(matching); wrong.dock.tabs[0]!.hostId = "foreign";
    cp.saved(wrong); cp.committed(matching); await drainMetadata(); expect(resolved).toBe(false);
    other.committed(matching); other.saved(matching); await drainMetadata(); expect(resolved).toBe(false);
    cp.saved(matching); await waiting; expect(resolved).toBe(true);
  } finally { cancel.abort(); await waiting.catch(() => {}); }
});

test("removed, replaced or changed committed request cancels wait and late saves cannot revive it", async () => {
  for (const change of ["removed", "owner", "instance", "request", "draft"]) {
    const cp = new BrowserWindowCheckpoint(), initial = viewFor(), state = { status: "pending" as const, draft: "draft", request };
    cp.committed(initial); const cancel = new AbortController();
    const outcome = cp.wait(initial.dock.tabs[0]!, state, cancel.signal).then(() => "resolved", () => "rejected");
    const next = viewFor(state);
    if (change === "removed") next.dock.tabs = [];
    else if (change === "owner") next.dock.tabs[0]!.hostId = "other";
    else if (change === "instance") next.dock.tabs[0]!.browserInstanceId = "other";
    else if (change === "request") next.dock.tabs[0]!.browserNewTab = { ...state, request: { ...request, requestId: "other-request" } };
    else next.dock.tabs[0]!.browserNewTab = { ...state, draft: "other draft" };
    cp.committed(next); expect(await outcome).toBe("rejected"); cp.saved(viewFor(state)); expect(await outcome).toBe("rejected"); cancel.abort();
  }
});

/** Controlled hook phases, not a React mount or native beforeunload scheduling proof. */
test("window persistence acknowledges actual save and beforeunload excludes an abandoned render", async () => {
  const root = mkdtempSync(join(tmpdir(), "browser-window-hook-")), store = new WindowStateStore(root, "primary");
  const original = Object.getOwnPropertyDescriptor(globalThis, "window"), listeners = new Map<string, () => void>();
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: any[] = []; let cursor = 0, layout: Array<() => void> = [], effects: Array<() => void> = [], saves = 0;
  const dispatcher = { useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
    return [slots[i], (v: any) => { slots[i] = v; }]; }, useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useLayoutEffect(f: () => void) { cursor++; layout.push(f); }, useEffect(f: () => void) { cursor++; effects.push(f); } };
  const cp = new BrowserWindowCheckpoint(), initial = viewFor(), restoration = { state: defaultWindowView() };
  const render = (view: WindowViewState) => { cursor = 0; layout = []; effects = []; const old = internals.H; internals.H = dispatcher;
    try { useWindowViewPersistence(view, restoration, cp); } finally { internals.H = old; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { agentDesktopWindow: { save: (view: unknown) => { saves++; return store.saveView(view); } },
    addEventListener: (name: string, f: () => void) => listeners.set(name, f), removeEventListener: (name: string) => listeners.delete(name) } });
  const cancel = new AbortController();
  try {
    render(initial); layout.forEach(f => f()); effects.forEach(f => f()); expect(saves).toBe(1);
    const state = { status: "pending" as const, draft: "draft", request }; let acknowledged = false;
    const pending = cp.wait(initial.dock.tabs[0]!, state, cancel.signal).then(() => { acknowledged = true; });
    render(viewFor(state)); // Discarded render: neither layout nor passive phase commits.
    listeners.get("beforeunload")!(); await drainMetadata(); expect(saves).toBe(1); expect(acknowledged).toBe(false);
    expect(new WindowStateStore(root, "primary").bootstrap().state?.dock?.tabs[0]?.browserNewTab?.request).toBeUndefined();
    render(viewFor(state)); layout.forEach(f => f()); expect(acknowledged).toBe(false); effects.forEach(f => f()); await pending;
    expect(acknowledged).toBe(true); expect(saves).toBe(2);
    expect(new WindowStateStore(root, "primary").bootstrap().state?.dock?.tabs[0]?.browserNewTab?.request).toEqual(request);
    const nextState = { ...state, request: { ...request, requestId: "second-request" } };
    const lost = cp.wait(initial.dock.tabs[0]!, nextState, cancel.signal).then(() => "resolved", error => String(error));
    const malformed = viewFor(nextState); malformed.dock.state = createDockState(); // Tab list is inconsistent and gets discarded by parseWindowView.
    render(malformed); layout.forEach(f => f()); effects.forEach(f => f());
    expect(await lost).toContain("did not retain");
    expect(new WindowStateStore(root, "primary").bootstrap().state?.dock).toBeUndefined();
  } finally { cancel.abort(); if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); rmSync(root, { recursive: true, force: true }); }
});


test("a failed pre-dispatch save permits a deliberate new request only after its own acknowledgement", async () => {
  const f = fixture(); f.controller.edit("https://example.invalid"); let running = f.controller.submit();
  try {
    await drainMetadata(); const original = f.controller.state.request!; f.checkpoint.failed("disk unavailable"); await running;
    expect(f.controller.state).toMatchObject({ status: "rejected", request: original }); expect(f.counts().creates).toBe(0);
    running = f.controller.submit(); await drainMetadata(); const retry = f.controller.state.request!;
    expect(retry.requestId).not.toBe(original.requestId); expect(f.counts().creates).toBe(0);
    f.checkpoint.committed(f.view); f.checkpoint.saved(f.view); await running; expect(f.counts().creates).toBe(1);
  } finally { f.controller.dispose(); await running; }
});
