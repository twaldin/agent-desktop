import { expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { createBrowserNewTab } from "./browser-new-tab";
import { activateDockTab, createDockState, dockTabId, hideDock, insertDockTab, setRightDockFullWidth, type DockTab } from "./dock-state";
import { stepWorkspaceLayout, workspaceLayoutStepAvailable } from "./workspace-layout-step";
import { useWorkbenchDock, type DockSnapshot } from "./use-workbench-dock";
import type { DesktopBridge } from "@agent-desktop/shared";
import { defaultWindowView } from "../window-state";
import { installAppShortcuts, matchAppShortcut, type AppShortcutOptions } from "./app-shortcuts";
import * as CurrentBindings from "./app-command-bindings";
import type { CommandKeymapPreferenceRecord } from "../../../../packages/shared/src/preferences-v2";
const bindings: typeof CurrentBindings = process.env.AGENT_DESKTOP_LAYOUT_BINDINGS_SOURCE
  ? await import(process.env.AGENT_DESKTOP_LAYOUT_BINDINGS_SOURCE) : CurrentBindings;
const chat = { kind: "chat" as const, hostId: "owner", sessionId: "session" };
const launcher = (id = "one") => createBrowserNewTab(chat.hostId, chat.sessionId, id);
const empty = (): DockSnapshot => ({ tabs: [], state: { ...createDockState("left"), rightWidthRatio: 0.49 } });
function add(snapshot: DockSnapshot, tab: DockTab, destination: "right" | "bottom" = "right"): DockSnapshot {
  return { tabs: [...snapshot.tabs, tab], state: insertDockTab(snapshot.state, tab, destination) };
}
function ordinary(kind: DockTab["kind"] = "file"): DockTab {
  const tab = { kind, hostId: "owner", target: "session:session" as const, title: "Retain", ...(kind === "file" ? { filePath: "sample.ts" } : {}) };
  return { ...tab, id: dockTabId(tab) };
}

test("layout step opens locally, preserves width/Bottom, restores split, then removes only a right singleton", () => {
  let snapshot = add(empty(), ordinary("terminal"), "bottom");
  snapshot = { ...snapshot, state: { ...snapshot.state, rightLayout: "restore-full" } };
  const before = structuredClone(snapshot), tab = launcher();
  expect(workspaceLayoutStepAvailable(snapshot, false)).toBe(false);
  expect(stepWorkspaceLayout(snapshot, chat)).toBe(snapshot);
  let next = stepWorkspaceLayout(snapshot, chat, tab);
  expect(snapshot).toEqual(before);
  expect(next.state.right).toEqual({ tabIds: [tab.id], activeTabId: tab.id, open: true });
  expect(next.state.rightLayout).toBeUndefined(); expect(next.state.rightWidthRatio).toBe(0.49);
  expect(next.state.bottom).toEqual(before.state.bottom); expect(next.state.contentSide).toBe("left");
  for (const state of [hideDock(next.state, "right"), hideDock(setRightDockFullWidth(next.state, true), "right", true), setRightDockFullWidth(next.state, true)]) {
    const restored = stepWorkspaceLayout({ ...next, state }, chat);
    expect(restored.state.right.open).toBe(true); expect(restored.state.rightLayout).toBeUndefined();
    expect(restored.tabs).toEqual(next.tabs); expect(restored.state.contentSide).toBe("left");
  }
  next = stepWorkspaceLayout(next, chat);
  expect(next.tabs).toEqual(before.tabs); expect(next.state.bottom).toEqual(before.state.bottom);
  expect(next.state.right).toEqual({ tabIds: [], activeTabId: undefined, open: false });
});

test("drafts, native identity, requests, titles and other owners protect the singleton presentation", () => {
  const request = { requestId: "request", controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.invalid" };
  const base = launcher();
  const variants: DockTab[] = [
    { ...base, browserNewTab: { status: "idle", draft: "" } },
    { ...base, browserNewTab: { status: "idle", draft: "address" } },
    { ...base, browserNewTab: { status: "pending" } },
    { ...base, browserNewTab: { status: "pending", request } },
    { ...base, browserNewTab: { status: "unknown", request } },
    { ...base, browserNewTab: { status: "rejected", draft: "" } },
    { ...base, browserNewTab: { status: "idle", request } },
    { ...base, title: "User title" },
    { ...base, browserTarget: { workerPid: 1, name: "agent", targetId: "native" } },
    { ...base, browserNewTab: undefined, title: "about:blank", browserTarget: { workerPid: 1, name: "agent", targetId: "native" } },
    createBrowserNewTab("other", "session", "other-owner"), createBrowserNewTab("owner", "other", "other-session"), ordinary(),
  ];
  for (const tab of variants) {
    const snapshot = add(empty(), tab), before = structuredClone(snapshot);
    const next = stepWorkspaceLayout(snapshot, chat);
    expect(next.tabs).toEqual(snapshot.tabs); expect(next.state.right.tabIds).toEqual([tab.id]);
    expect(next.state.right.open).toBe(false); expect(snapshot).toEqual(before);
  }
  const two = add(add(empty(), base), launcher("two"));
  expect(stepWorkspaceLayout(two, chat).tabs).toEqual(two.tabs);
  const bottom = add(empty(), base, "bottom");
  expect(stepWorkspaceLayout(bottom, chat)).toBe(bottom);
  expect(stepWorkspaceLayout(empty(), chat, createBrowserNewTab("other", "session", "bad"))).toEqual(empty());
  const stale = { ...base, id: "stale-instance" }, invalid = add(empty(), stale);
  expect(workspaceLayoutStepAvailable(invalid, false)).toBe(false); expect(stepWorkspaceLayout(invalid, chat)).toBe(invalid);
});

/** Controlled version-bound slots/effects, not a mounted React tree or DOM. */
function hookDriver() {
  const slots: any[] = [], pending: Array<() => void> = []; let cursor = 0;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  let effects: Array<() => void> = [];
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value: any) => pending.push(() => { slots[i] = typeof value === "function" ? value(slots[i]) : value; })]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useEffect(callback: () => void, deps: unknown[]) { const i = cursor++, prior = slots[i]; if (!prior || deps.some((v, n) => v !== prior[n])) { slots[i] = deps; effects.push(callback); } },
  };
  return { render<T>(callback: () => T): T {
    while (pending.length) pending.shift()!(); cursor = 0; effects = [];
    const prior = internals.H; internals.H = dispatcher;
    try { const result = callback(); for (const effect of effects) effect(); return result; } finally { internals.H = prior; }
  } };
}

test("actual dock functional update preserves queued empty draft and refuses a stale owner without any bridge call", () => {
  const driver = hookDriver(); let calls = 0;
  const bridge = { getBrowserMetadata: async () => { calls++; throw new Error("No native action expected"); }, createBrowserTab: async () => { calls++; throw new Error("No native action expected"); } } as unknown as DesktopBridge;
  const initial = { ...defaultWindowView(), dock: empty() };
  const render = () => driver.render(() => useWorkbenchDock(bridge, initial, "owner", { sessionId: "session" }, true, message => { throw new Error(message); }));
  let dock = render(); dock.stepLayout(chat, true); dock = render();
  const first = dock.snapshot.tabs[0]!, controller = dock.browserLauncher(first, true);
  controller.edit(""); dock.stepLayout(chat, true); // no intervening render: updater must see the queued draft
  dock = render(); expect(dock.snapshot.tabs).toHaveLength(1);
  expect(dock.snapshot.tabs[0]!.browserNewTab).toEqual({ status: "idle", draft: "" });
  expect(dock.snapshot.state.right.open).toBe(false);
  const before = structuredClone(dock.snapshot);
  dock.stepLayout({ ...chat, hostId: "other" }, true); dock = render(); expect(dock.snapshot).toEqual(before);
  dock.stepLayout(chat, true); dock = render(); expect(dock.snapshot.state.right.open).toBe(true);
  controller.edit(undefined); dock.stepLayout(chat, true); dock = render();
  expect(dock.snapshot.tabs).toEqual([]);
  controller.edit("late obsolete editor"); dock = render(); expect(dock.snapshot.tabs).toEqual([]);
  expect(controller.state).toEqual({ status: "idle" }); expect(calls).toBe(0);
});

test("retained content remains operable when the current session catalog is unavailable", () => {
  const driver = hookDriver(), snapshot = add(empty(), ordinary());
  snapshot.state = hideDock(snapshot.state, "right");
  const render = () => driver.render(() => useWorkbenchDock({} as DesktopBridge, { ...defaultWindowView(), dock: snapshot }, "owner", undefined, false, () => {}));
  let dock = render(); dock.stepLayout(chat, false); dock = render();
  expect(dock.snapshot.state.right.open).toBe(true); expect(dock.snapshot.tabs).toEqual(snapshot.tabs);
  dock.stepLayout(chat, false); dock = render();
  expect(dock.snapshot.state.right.open).toBe(false); expect(dock.snapshot.tabs).toEqual(snapshot.tabs);
  const emptyDriver = hookDriver();
  const renderEmpty = () => emptyDriver.render(() => useWorkbenchDock({} as DesktopBridge, { ...defaultWindowView(), dock: empty() }, "owner", undefined, false, () => {}));
  let absent = renderEmpty(); absent.stepLayout(chat, true); absent = renderEmpty();
  expect(absent.snapshot.tabs).toEqual([]);
});

function key() {
  const event = new Event("keydown", { cancelable: true });
  return Object.assign(event, { key: "B", code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false,
    repeat: false, isComposing: false, keyCode: 66, getModifierState: () => false, composedPath: () => [] }) as unknown as KeyboardEvent;
}
const record = (keys: string[]): CommandKeymapPreferenceRecord => ({ key: "general.commandKeymap", deleted: false,
  value: { version: 1, platform: "mac", overrides: [{ command: "stepWorkspaceLayout", keys }] },
  revision: { counter: 1, actor: "00000000-0000-4000-8000-000000000001", opId: "00000000-0000-4000-8000-000000000002" } });

test("installed layout binding dispatches once and leaves an unavailable command unhandled", () => {
  let count = 0;
  const resolved = bindings.readAppCommandBindings(undefined, true).bindings;
  expect(resolved["step-workspace-layout"]).toEqual(["CmdOrCtrl+Shift+B"]);
  const target = Object.assign(new EventTarget(), { navigator: { platform: "MacIntel" }, document: { activeElement: null, querySelectorAll: () => [] } }) as unknown as Window;
  let options: AppShortcutOptions = { bindings: resolved, actions: { "step-workspace-layout": () => count++ } };
  const listener = installAppShortcuts(target, () => options);
  try {
    const first = key(); target.dispatchEvent(first); listener.handleKey(first);
    expect(count).toBe(1); expect(first.defaultPrevented).toBe(true);
    options = { ...options, actions: {} }; const absent = key(); target.dispatchEvent(absent);
    expect(absent.defaultPrevented).toBe(false); expect(count).toBe(1);
    options = { ...options, actions: { "step-workspace-layout": () => count++ } };
    target.dispatchEvent(new Event("compositionstart")); const composing = key(); target.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false); expect(count).toBe(1);
    target.dispatchEvent(new Event("compositionend")); target.dispatchEvent(key()); expect(count).toBe(2);
  } finally { listener(); }
});

test("layout command can be rebound or cleared and remains distinct from panel toggle", () => {
  expect(bindings.APP_COMMAND_BINDING_OWNERS.stepWorkspaceLayout).toBe("step-workspace-layout");
  expect(bindings.readAppCommandBindings(record([]), true).bindings["step-workspace-layout"]).toEqual([]);
  expect(bindings.readAppCommandBindings(record(["Command+J"]), true).bindings["step-workspace-layout"]).toEqual(["Command+J"]);
  expect(bindings.readAppCommandBindings(undefined, true).bindings["toggle-side-panel"]).toEqual(["CmdOrCtrl+Alt+B"]);
  expect(matchAppShortcut(key(), "mac")).toBe("step-workspace-layout");
  expect(matchAppShortcut({ ...key(), metaKey: false, ctrlKey: true }, "other")).toBe("step-workspace-layout");
});

test("actual App eligibility omits Settings/plugin dispatch while installed support remains", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const start = source.indexOf('...(!contentOverlayOpen && workspaceLayoutStepAvailable(');
  const end = source.indexOf('\n      }),', start); expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const expression = source.slice(start + 4, end + '\n      })'.length - 1);
  const evaluate = new Function("contentOverlayOpen", "workspaceLayoutStepAvailable", "dock", "browserAction", "mainChat", "setMainTaskFocus", "draftId", "committedDraftDockOwner", "draftDockOwner", "draftBrowserDocks", new Bun.Transpiler({ loader: "tsx" }).transformSync(`const result = (${expression});`) + "\nreturn result;");
  for (const [settings, plugins, canBrowser] of [[true, false, true], [false, true, true], [false, false, false]]) {
    const result = evaluate(settings||plugins, workspaceLayoutStepAvailable, { snapshot: empty() }, canBrowser ? {} : undefined, chat, () => { throw new Error("No focus expected"); });
    expect(result && Object.keys(result).length).toBeFalsy();
  }
  let dispatched = 0, focused: unknown;
  const result = evaluate(false, workspaceLayoutStepAvailable, { snapshot: empty(), stepLayout: (owner: unknown, capable: boolean) => { expect(owner).toEqual(chat); expect(capable).toBe(true); dispatched++; } }, {}, chat, (value: unknown) => focused = value);
  result["step-workspace-layout"](); expect(dispatched).toBe(1);
  expect(focused).toEqual({ target: chat, onlyWhenContentClosed: true });
  expect(source).toContain('new Set(Object.keys(APP_COMMAND_BINDING_OWNERS))');
});
