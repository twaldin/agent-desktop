import { expect, test } from "bun:test";
import React from "react";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserMetadataSnapshot, DesktopBridge } from "@agent-desktop/shared";
import { BrowserNewTabController, createBrowserNewTab } from "./browser-new-tab";
import { BrowserNewTabPanel as CurrentPanel } from "./BrowserNewTabPanel";
import { cleanupPreviousBrowserConversation } from "./browser-conversation-cleanup";
import { createDockState, insertDockTab, type DockTab } from "./dock-state";
import { useWorkbenchDock, type DockSnapshot } from "./use-workbench-dock";
import { defaultWindowView } from "../window-state";
import { WindowStateStore } from "../main/window-state";
const Panel: typeof CurrentPanel = process.env.AGENT_DESKTOP_CONVERSATION_PANEL_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_CONVERSATION_PANEL_SOURCE)).BrowserNewTabPanel : CurrentPanel;
const previous = { kind: "chat" as const, hostId: "owner", sessionId: "old" };
const current = { ...previous, sessionId: "new" };
const launcher = (instance = "one") => createBrowserNewTab("owner", "old", instance);
const empty = (): DockSnapshot => ({ state: createDockState("left"), tabs: [] });
function add(snapshot: DockSnapshot, tab: DockTab, destination: "right" | "bottom" = "right"): DockSnapshot {
  return { state: insertDockTab(snapshot.state, tab, destination), tabs: [...snapshot.tabs, tab] };
}

test("conversation transition removes only observed prior-owner local launchers across both regions", () => {
  const first = launcher(), second = launcher("two"), next = createBrowserNewTab("owner", "new", "three"), foreign = createBrowserNewTab("foreign", "old", "four");
  const snapshot = add(add(add(add(empty(), first), second, "bottom"), next), foreign, "bottom"), before = structuredClone(snapshot);
  const all = new Set(snapshot.tabs.map(tab => tab.id));
  expect(cleanupPreviousBrowserConversation(snapshot, previous, previous, all)).toBe(snapshot);
  expect(cleanupPreviousBrowserConversation(snapshot, { ...previous, sessionId: null }, current, all)).toBe(snapshot);
  expect(cleanupPreviousBrowserConversation(snapshot, previous, current, new Set())).toBe(snapshot);
  const after = cleanupPreviousBrowserConversation(snapshot, previous, current, all);
  expect(after.tabs).toEqual([next, foreign]); expect(after.state.right.tabIds).toEqual([next.id]);
  expect(after.state.bottom.tabIds).toEqual([foreign.id]); expect(after.state.right.activeTabId).toBe(next.id);
  expect(after.state.bottom.activeTabId).toBe(foreign.id); expect(after.state.contentSide).toBe("left");
  expect(snapshot).toEqual(before);
  const hostSwitch = cleanupPreviousBrowserConversation(snapshot, previous, { ...previous, hostId: "foreign" }, all);
  expect(hostSwitch.tabs).toEqual([next, foreign]);
});

test("unknown, edited, titled, materialized, stale and unobserved presentations survive route cleanup", () => {
  const base = launcher(), request = { requestId: "request", controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.invalid/" };
  const protectedTabs: DockTab[] = [
    { ...base, browserNewTab: { status: "idle", draft: "" } }, { ...base, browserNewTab: { status: "idle", draft: "address" } },
    { ...base, browserNewTab: { status: "pending" } }, { ...base, browserNewTab: { status: "unknown", request } },
    { ...base, browserNewTab: { status: "rejected", request } }, { ...base, browserNewTab: { status: "idle", request } },
    { ...base, title: "Personal title" }, { ...base, browserNewTab: undefined, title: "about:blank", browserTarget: { workerPid: 42, name: "agent", targetId: "target" } },
    { ...base, browserTarget: { workerPid: 42, name: "agent", targetId: "target" } },
    { ...base, id: "stale-instance" }, createBrowserNewTab("other", "old", "another-owner"), createBrowserNewTab("owner", "different", "another-conversation"),
  ];
  for (const tab of protectedTabs) {
    const snapshot = add(empty(), tab);
    expect(cleanupPreviousBrowserConversation(snapshot, previous, current, new Set([tab.id]))).toBe(snapshot);
  }
  const replacement = launcher("replacement"), snapshot = add(empty(), replacement);
  expect(cleanupPreviousBrowserConversation(snapshot, previous, current, new Set([base.id]))).toBe(snapshot);
});

/** Controlled private React dispatcher: queues state and explicitly executes recorded
 * commit effects. It does not create an actual React root, DOM or native view. */
function driver() {
  const slots: any[] = [], queued: Array<() => void> = []; let cursor = 0, effects: Array<() => void> = [];
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const useEffect = (callback: () => void, deps: unknown[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => v !== old[n])) { slots[i] = deps; effects.push(callback); } };
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value: any) => queued.push(() => { slots[i] = typeof value === "function" ? value(slots[i]) : value; })]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useEffect, useLayoutEffect: useEffect,
  };
  return { render<T>(callback: () => T, commit = true): { result: T; commit(): void } {
    while (queued.length) queued.shift()!(); cursor = 0; effects = [];
    const old = internals.H; internals.H = dispatcher;
    try { const result = callback(), pending = effects; const finish = () => { for (const effect of pending) effect(); };
      if (commit) finish(); return { result, commit: finish }; } finally { internals.H = old; }
  } };
}
const forbiddenBridge = (calls: string[]): DesktopBridge => new Proxy({}, { get(_target, property) {
  return () => { calls.push(String(property)); throw new Error(`Unexpected native operation ${String(property)}`); };
} }) as DesktopBridge;
function fixture(snapshot = add(empty(), launcher())) {
  const hooks = driver(), calls: string[] = [], bridge = forbiddenBridge(calls), initial = { ...defaultWindowView(), dock: snapshot };
  const render = () => hooks.render(() => useWorkbenchDock(bridge, initial, "owner", { sessionId: "old" }, true, () => {})).result;
  return { render, calls, bridge };
}

test("actual panel committed observation enables prior-conversation cleanup; render alone does not", () => {
  const f = fixture(); let dock = f.render(); const tab = dock.snapshot.tabs[0]!, controller = dock.browserLauncher(tab, true);
  expect(controller.hasObservedPristinePresentation).toBe(false);
  const panel = driver().render(() => Panel({ controller, active: false }), false);
  dock.leaveBrowserConversation(previous, current); dock = f.render(); expect(dock.snapshot.tabs).toHaveLength(1);
  panel.commit(); expect(controller.hasObservedPristinePresentation).toBe(true);
  dock.leaveBrowserConversation(previous, current); dock = f.render();
  expect(dock.snapshot.tabs).toEqual([]); expect(dock.snapshot.state.right.open).toBe(false);
  controller.edit("late"); dock = f.render(); expect(dock.snapshot.tabs).toEqual([]);
  expect(controller.hasObservedPristinePresentation).toBe(false); expect(f.calls).toEqual([]);
});

test("queued draft and title edits are revalidated instead of deleting a stale snapshot", () => {
  for (const edit of ["draft", "title"] as const) {
    const f = fixture(); let dock = f.render(); const tab = dock.snapshot.tabs[0]!, controller = dock.browserLauncher(tab, true);
    controller.observePresentation();
    if (edit === "draft") controller.edit(""); else dock.updateTitle(tab.id, "Saved title");
    dock.leaveBrowserConversation(previous, current); dock = f.render();
    expect(dock.snapshot.tabs).toHaveLength(1);
    if (edit === "draft") expect(dock.snapshot.tabs[0]!.browserNewTab?.draft).toBe("");
    else expect(dock.snapshot.tabs[0]!.title).toBe("Saved title");
    expect(f.calls).toEqual([]);
  }
});

test("observer cannot authorize cleanup while acquiring or after disposal", async () => {
  const gate = Promise.withResolvers<BrowserMetadataSnapshot>(); let creates = 0;
  const bridge = { getBrowserMetadata: () => gate.promise, createBrowserTab: async () => { creates++; throw new Error("No acquisition expected"); } } as unknown as DesktopBridge;
  const controller = new BrowserNewTabController(bridge, launcher(), () => {}, () => {}, async () => {});
  controller.connected = true; controller.observePresentation(); expect(controller.hasObservedPristinePresentation).toBe(true);
  controller.edit("example.com"); expect(controller.hasObservedPristinePresentation).toBe(false);
  const submitting = controller.submit();
  expect(controller.state.status).toBe("pending"); expect(controller.hasObservedPristinePresentation).toBe(false);
  controller.edit(undefined); expect(controller.state.draft).toBe("example.com");
  const f = fixture(); let dock = f.render(); const observed = dock.browserLauncher(dock.snapshot.tabs[0]!, true);
  observed.observePresentation(); observed.dispose(); observed.observePresentation(); expect(observed.hasObservedPristinePresentation).toBe(false);
  controller.dispose(); gate.resolve({ protocolVersion: 1, hostId: "owner", sessionId: "old", availability: "not-started", reason: "Not started", creationTicket: { controlEpoch: "epoch", observedAt: 1 } });
  await submitting; expect(creates).toBe(0); expect(controller.hasObservedPristinePresentation).toBe(false);
});

test("cleaned window projection reopens without deleting another window or protected draft", () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-conversation-cleanup-"));
  try {
    const blank = launcher(), draft = { ...launcher("draft"), browserNewTab: { status: "idle" as const, draft: "" } };
    const snapshot = add(add(empty(), blank), draft, "bottom"), initial = { ...defaultWindowView(), route: { hostId: "owner", sessionId: "old" }, dock: snapshot };
    const primary = new WindowStateStore(directory, "primary"), second = new WindowStateStore(directory, "second");
    expect(primary.saveView(initial)).toEqual({}); expect(second.saveView(initial)).toEqual({});
    const savedSecond = new WindowStateStore(directory, "second").bootstrap().state;
    const after = cleanupPreviousBrowserConversation(snapshot, previous, current, new Set([blank.id, draft.id]));
    expect(primary.saveView({ ...initial, route: { hostId: "owner", sessionId: "new" }, dock: after })).toEqual({});
    const loaded = new WindowStateStore(directory, "primary").bootstrap().state!;
    expect(loaded.dock!.tabs).toEqual([draft]); expect(loaded.route).toEqual({ hostId: "owner", sessionId: "new" });
    expect(new WindowStateStore(directory, "second").bootstrap().state).toEqual(savedSecond);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("actual App effect keys cleanup to route identity, not loaded workspace or Settings state", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const match = source.match(/useLayoutEffect\(\(\) => \{\n    const previous = previousBrowserConversation.current;([\s\S]*?)\n  \}, \[hostId, selectedId\]\);/);
  expect(match).not.toBeNull();
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(`const previous = previousBrowserConversation.current;${match![1]}`);
  const run = new Function("previousBrowserConversation", "hostId", "selectedId", "dock", body);
  const ref = { current: undefined as typeof previous | undefined }, calls: unknown[] = [];
  const dock = { leaveBrowserConversation: (before: unknown, after: unknown) => calls.push([before, after]) };
  run(ref, "owner", "old", dock); expect(calls).toEqual([]);
  run(ref, "owner", "new", dock); expect(calls).toEqual([[previous, current]]);
  run(ref, "foreign", "new", dock); expect(calls[1]).toEqual([current, { ...current, hostId: "foreign" }]);
});
