import { expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import type { DesktopBridge } from "@agent-desktop/shared";
import { defaultWindowView } from "../window-state";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import { createDockState, hideDock, insertDockTab, setRightDockFullWidth, type DockTab } from "./dock-state";
import { stepWorkspaceLayout, workspaceLayoutStepAvailable } from "./workspace-layout-step";
import { useWorkbenchDock, type DockSnapshot } from "./use-workbench-dock";
const chat = { kind: "chat" as const, hostId: "host", sessionId: null };
const owner = { ...chat, draftId: "draft" };
const empty = (): DockSnapshot => ({ state: { ...createDockState("left"), rightWidthRatio: 0.43 }, tabs: [] });
const insert = (snapshot: DockSnapshot, tab: DockTab, where: "right" | "bottom" = "right"): DockSnapshot => ({
  tabs: [...snapshot.tabs, tab], state: insertDockTab(snapshot.state, tab, where),
});

test("draft layout creates a local right singleton, restores retained split and removes only its unused owner", () => {
  const tab = createDraftBrowserDockTab("host", "draft", "page"), bottom = createDraftBrowserDockTab("host", "draft", "bottom", "saved");
  const before = insert(empty(), bottom, "bottom"); before.state.rightLayout = "restore-full";
  let next = stepWorkspaceLayout(before, owner, tab);
  expect(next.state.right).toEqual({ open: true, tabIds: [tab.id], activeTabId: tab.id });
  expect(next.state.rightLayout).toBeUndefined(); expect(next.state.rightWidthRatio).toBe(0.43);
  expect(next.state.bottom).toEqual(before.state.bottom); expect(next.state.contentSide).toBe("left");
  for (const state of [hideDock(next.state, "right"), setRightDockFullWidth(next.state, true)]) {
    const restored = stepWorkspaceLayout({ ...next, state }, owner);
    expect(restored.state.right.open).toBe(true); expect(restored.state.rightLayout).toBeUndefined(); expect(restored.tabs).toEqual(next.tabs);
  }
  next = stepWorkspaceLayout(next, owner);
  expect(next.tabs).toEqual([bottom]); expect(next.state.bottom).toEqual(before.state.bottom); expect(next.state.right.open).toBe(false);
  expect(stepWorkspaceLayout(empty(), { ...owner, draftId: "other" }, tab).tabs).toEqual([]);
  expect(stepWorkspaceLayout(empty(), chat, tab).tabs).toEqual([]);
});

test("draft addresses, foreign identities, native targets, titles, requests and unresolved controller state are retained", () => {
  const base = createDraftBrowserDockTab("host", "draft", "page");
  for (const tab of [
    createDraftBrowserDockTab("host", "draft", "page", ""), createDraftBrowserDockTab("host", "draft", "page", "typed"),
    createDraftBrowserDockTab("host", "other", "page"), createDraftBrowserDockTab("other", "draft", "page"),
    { ...base, title: "Saved name" }, { ...base, browserNewTab: { status: "pending" as const } },
    { ...base, browserNewTab: { status: "unknown" as const, request: { requestId: "request", controlEpoch: "epoch", observedAt: 1 } } },
    { ...base, browserTarget: { workerPid: 1, name: "page", targetId: "native" } },
  ]) {
    const snapshot = insert(empty(), tab), next = stepWorkspaceLayout(snapshot, owner);
    expect(next.tabs).toEqual(snapshot.tabs); expect(next.state.right.open).toBe(false);
  }
  const snapshot = insert(empty(), base);
  expect(stepWorkspaceLayout(snapshot, owner, undefined, () => false).tabs).toEqual([base]);
});

/** Version-bound controlled React slots/queued functional updates; not a mounted tree. */
function driver() {
  const slots: any[] = [], queue: Array<() => void> = []; let cursor = 0;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value: any) => queue.push(() => { slots[i] = typeof value === "function" ? value(slots[i]) : value; })]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useEffect() { cursor++; },
  };
  return { render<T>(run: () => T): T { while (queue.length) queue.shift()!(); cursor = 0; const prior = internals.H; internals.H = hooks;
    try { return run(); } finally { internals.H = prior; } } };
}

test("actual dock queues local draft creation, protects a queued empty edit and rechecks retired owner before publication", () => {
  const hooks = driver(); let current = true, disposable = true, protectedAttempt = false, bridgeCalls = 0;
  const bridge = new Proxy({} as DesktopBridge, { get() { bridgeCalls++; throw new Error("No bridge access expected"); } });
  const render = () => hooks.render(() => useWorkbenchDock(bridge, { ...defaultWindowView(), dock: empty() }, "host", undefined, false, () => {}, undefined, "ltr", undefined, () => protectedAttempt));
  const draft = { draftId: "draft", isCurrent: () => current, canDispose: () => disposable };
  let dock = render(); dock.stepLayout(chat, true, draft); dock = render();
  expect(dock.snapshot.tabs).toHaveLength(1); const tab = dock.snapshot.tabs[0]!, instance = dock.presentations.instances.get(tab.id)!;
  expect(tab.target).toBe("draft:draft"); expect(tab.browserNewTab).toEqual({ status: "idle" });
  dock.updateDraftBrowserAddress(tab.id, instance, { status: "idle", draft: "" }, () => true);
  dock.stepLayout(chat, true, draft); dock = render();
  expect(dock.snapshot.tabs[0]!.browserNewTab).toEqual({ status: "idle", draft: "" }); expect(dock.snapshot.state.right.open).toBe(false);
  dock.stepLayout(chat, true, draft); dock = render();
  dock.updateDraftBrowserAddress(tab.id, instance, { status: "idle" }, () => true); dock = render();
  disposable = false; dock.stepLayout(chat, true, draft); dock = render(); expect(dock.snapshot.tabs).toHaveLength(1);
  dock.stepLayout(chat, true, draft); dock = render(); disposable = true; protectedAttempt = true;
  dock.stepLayout(chat, true, draft); dock = render(); expect(dock.snapshot.tabs).toHaveLength(1);
  protectedAttempt = false; dock.stepLayout(chat, true, draft); dock = render();
  dock.stepLayout(chat, true, draft); dock = render(); expect(dock.snapshot.tabs).toEqual([]);
  dock.stepLayout(chat, true, draft); current = false; dock = render(); expect(dock.snapshot.tabs).toEqual([]);
  current = true; dock.stepLayout(chat, true, draft); dock = render(); expect(dock.snapshot.tabs).toHaveLength(1);
  expect(bridgeCalls).toBe(0);
});

function appAction() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const start = source.indexOf('...(!contentOverlayOpen && workspaceLayoutStepAvailable('), end = source.indexOf('\n      }),', start);
  if (start < 0 || end < 0) throw new Error("App layout action was not found");
  return new Function("contentOverlayOpen", "workspaceLayoutStepAvailable", "dock", "browserAction", "mainChat", "setMainTaskFocus", "draftId", "committedDraftDockOwner", "draftDockOwner", "draftBrowserDocks", new Bun.Transpiler({ loader: "tsx" }).transformSync(`const result = (${source.slice(start + 4, end + '\n      })'.length - 1)});`) + "\nreturn result;");
}

test("retained draft through actual App action hides and reopens without browser capability, then disposes when available", () => {
  const hooks = driver(), evaluate = appAction(), tab = createDraftBrowserDockTab("host", "draft", "page");
  let bridgeCalls = 0;
  const bridge = new Proxy({} as DesktopBridge, { get() { bridgeCalls++; throw new Error("No bridge access expected"); } });
  const initial = { ...defaultWindowView(), dock: insert(empty(), tab) };
  const render = () => hooks.render(() => useWorkbenchDock(bridge, initial, "host", undefined, false, () => {}));
  let dock = render();
  const instance = dock.presentations.instances.get(tab.id)!;
  const draftOwner = { enabled: true }, committed = { current: draftOwner };
  const controllers = new Map([[JSON.stringify([tab.id, instance]), { enabled: true, needsInspection: false, hasObservedPristinePresentation: true }]]);
  const step = (browserAction: unknown) => {
    const actions = evaluate(false, workspaceLayoutStepAvailable, dock, browserAction, chat, () => {}, "draft", committed, draftOwner, controllers);
    expect(typeof actions["step-workspace-layout"]).toBe("function");
    actions["step-workspace-layout"](); dock = render();
  };
  step(null);
  expect(dock.snapshot.tabs).toEqual([tab]); expect(dock.snapshot.state.right.open).toBe(false);
  expect(dock.presentations.instances.get(tab.id)).toBe(instance);
  step(null);
  expect(dock.snapshot.tabs).toEqual([tab]); expect(dock.snapshot.state.right.open).toBe(true);
  expect(dock.presentations.instances.get(tab.id)).toBe(instance);
  step({});
  expect(dock.snapshot.tabs).toEqual([]); expect(dock.snapshot.state.right.open).toBe(false);
  expect(bridgeCalls).toBe(0);
});

test("actual App callback uses committed draft scope and original observed controller for singleton disposal", () => {
  const evaluate = appAction(), tab = createDraftBrowserDockTab("host", "draft", "page"), controller = { enabled: true, needsInspection: false, hasObservedPristinePresentation: true };
  const draftOwner = { enabled: true }, committed: { current: unknown } = { current: draftOwner };
  const controllers = new Map([[JSON.stringify([tab.id, "original"]), controller]]);
  let args: any[] = [], focus: any;
  const dock = { snapshot: empty(), stepLayout: (...values: any[]) => { args = values; } };
  const invoke = (overlay = false, browser: unknown = {}) => evaluate(overlay, workspaceLayoutStepAvailable, dock, browser, chat, (value: any) => { focus = value; }, "draft", committed, draftOwner, controllers);
  expect(invoke(true)).toBeFalsy(); expect(invoke(false, null)).toBeFalsy();
  invoke()["step-workspace-layout"](); expect(args[0]).toEqual(chat); expect(args[1]).toBe(true);
  const admitted = args[2], presentations = { instances: new Map([[tab.id, "original"]]) };
  expect(admitted.draftId).toBe("draft"); expect(admitted.isCurrent()).toBe(true); expect(admitted.canDispose(tab, presentations)).toBe(true);
  controller.needsInspection = true; expect(admitted.canDispose(tab, presentations)).toBe(false); controller.needsInspection = false;
  controller.hasObservedPristinePresentation = false; expect(admitted.canDispose(tab, presentations)).toBe(false); controller.hasObservedPristinePresentation = true;
  controller.enabled = false; expect(admitted.canDispose(tab, presentations)).toBe(false); controller.enabled = true;
  presentations.instances.set(tab.id, "replacement"); expect(admitted.canDispose(tab, presentations)).toBe(false);
  const queuedFocus = focus; committed.current = { enabled: true }; expect(admitted.isCurrent()).toBe(false); expect(queuedFocus.isCurrent()).toBe(false);
  args = []; invoke()["step-workspace-layout"](); expect(args).toEqual([]);
});
