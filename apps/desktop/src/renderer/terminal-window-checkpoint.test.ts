import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { WindowStateStore as CurrentStore } from "../main/window-state";
import { parseTerminalWindowIntent, parseTerminalWindowIntents, type TerminalWindowIntent } from "../terminal-window-intent";
import { defaultWindowView, parseWindowView, type WindowViewState } from "../window-state";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";
import { TerminalWindowCheckpoint } from "./terminal-window-checkpoint";
import { useWindowViewPersistence } from "./window-view-state";

const Store: typeof CurrentStore = process.env.AGENT_DESKTOP_TERMINAL_INTENT_STORE
  ? (await import(process.env.AGENT_DESKTOP_TERMINAL_INTENT_STORE)).WindowStateStore : CurrentStore;
const hostId = "10000000-0000-4000-8000-000000000001", sessionId = "20000000-0000-4000-8000-000000000002";
const request = { version: 1 as const, requestId: "30000000-0000-4000-8000-000000000003", controlEpoch: "40000000-0000-4000-8000-000000000004", target: { sessionId }, cols: 120, rows: 30 };
const tab = { ...createBrowserNewTab(hostId, sessionId, "browser-instance"), browserNewTab: { status: "idle" as const, draft: "unsent address" } };
const intent: TerminalWindowIntent = { version: 1, hostId, request, source: { kind: "browser", tabId: tab.id, browserInstanceId: tab.browserInstanceId!, title: tab.title, draft: "unsent address" } };
function view(intents?: TerminalWindowIntent[]): WindowViewState {
  return { ...defaultWindowView(), route: { hostId, sessionId }, dock: { tabs: [structuredClone(tab)], state: insertDockTab(createDockState(), tab, "right") },
    ...(intents ? { terminalCreations: structuredClone(intents) } : {}) };
}
const drain = async () => { await Promise.resolve(); await Promise.resolve(); };

test("terminal intent survives actual local window save/reopen with original source and unrelated navigation", () => {
  const root = mkdtempSync(join(tmpdir(), "terminal-window-intent-"));
  try {
    const store = new Store(root, "primary"), saved = { ...view([intent]), settingsOpen: true, settingsPage: "connections" as const };
    expect(store.saveView(saved)).toEqual({});
    const restored = new Store(root, "primary").bootstrap().state!;
    expect(restored.terminalCreations).toEqual([intent]); expect(restored.dock?.tabs[0]?.browserNewTab?.draft).toBe("unsent address");
    expect(restored.settingsPage).toBe("connections");
    expect(store.saveView({ ...restored, route: { hostId, sessionId: null } })).toEqual({});
    expect(new Store(root, "primary").bootstrap().state?.terminalCreations).toEqual([intent]);
    expect(new Store(root, "secondary").bootstrap().state).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("strict intent projection preserves exact requests and rejects ambiguous, duplicate or oversized entries", () => {
  const ordinary: TerminalWindowIntent = { ...intent, request: { ...request, target: { projectId: sessionId } }, source: { kind: "dock", destination: "bottom" } };
  expect(parseTerminalWindowIntent(ordinary)).toEqual(ordinary); expect(parseTerminalWindowIntent(intent)).toEqual(intent);
  for (const bad of [{ ...intent, hostId: "other" }, { ...intent, request: { ...request, rows: 0 } }, { ...intent, source: { ...intent.source, tabId: "other" } },
    { ...intent, source: { ...intent.source, draft: "x".repeat(8193) } }, { ...intent, source: { ...intent.source, title: "bad\0title" } },
    { ...intent, request: ordinary.request }, { ...ordinary, source: { kind: "dock", destination: "right", draft: "extra" } },
    { ...intent, outcome: "completed" }]) {
    expect(() => parseTerminalWindowIntent(bad)).toThrow();
    expect(parseWindowView({ ...view(), terminalCreations: [bad] })).toBeUndefined();
  }
  expect(() => parseTerminalWindowIntents([intent, intent])).toThrow("Duplicate");
  expect(() => parseTerminalWindowIntents(Array.from({ length: 65 }, () => intent))).toThrow("Too many");
  expect(parseWindowView(view())).toEqual(view());
});

test("checkpoint waits for the same committed and acknowledged intent without saving a captured view", async () => {
  const cp = new TerminalWindowCheckpoint(), other = new TerminalWindowCheckpoint(), cancel = new AbortController();
  cp.committed(view()); let done = false;
  const waiting = cp.wait(intent, cancel.signal).then(() => { done = true; });
  cp.saved(view([intent])); await drain(); expect(done).toBe(false);
  const wrong = { ...intent, request: { ...request, cols: 121 } };
  cp.saved(view([wrong])); cp.committed(view([intent])); await drain(); expect(done).toBe(false);
  other.committed(view([intent])); other.saved(view([intent])); await drain(); expect(done).toBe(false);
  cp.saved(view([intent])); await waiting; expect(done).toBe(true); cancel.abort();
});

test("committed source loss and request removal or change cannot be revived by late saves", async () => {
  for (const change of ["source", "draft", "title", "native", "request", "remove", "instance"] as const) {
    const cp = new TerminalWindowCheckpoint(), cancel = new AbortController();cp.committed(view([intent]));
    const result = cp.wait(intent, cancel.signal).then(() => "resolved", () => "rejected");
    const next = view([intent]);
    if (change === "source") next.dock!.tabs = [];
    else if (change === "draft") next.dock!.tabs[0]!.browserNewTab!.draft = "changed";
    else if (change === "title") next.dock!.tabs[0]!.title = "changed";
    else if (change === "native") next.dock!.tabs[0]!.browserTarget = { name: "n", targetId: "t", workerPid: 42 };
    else if (change === "instance") next.dock!.tabs[0]!.browserInstanceId = "replacement";
    else if (change === "request") next.terminalCreations![0]!.request.cols = 121;
    else next.terminalCreations = [];
    cp.committed(next); expect(await result).toBe("rejected"); cp.committed(view([intent])); cp.saved(view([intent])); expect(await result).toBe("rejected"); cancel.abort();
  }
});

test("projection loss, failed saves and abort never acknowledge a terminal attempt", async () => {
  for (const mode of ["projection", "failed", "abort"] as const) {
    const cp = new TerminalWindowCheckpoint(), cancel = new AbortController(); cp.committed(view());
    const result = cp.wait(intent, cancel.signal).then(() => "resolved", () => "rejected");cp.committed(view([intent]));
    if (mode === "projection") cp.saved(view()); else if (mode === "failed") cp.failed("Disk unavailable"); else cancel.abort();
    expect(await result).toBe("rejected");cp.saved(view([intent]));expect(await result).toBe("rejected");
  }
});

test("actual save-hook phases acknowledge terminal intent only after the existing store accepts it", async () => {
  const root = mkdtempSync(join(tmpdir(), "terminal-save-hook-")), store = new CurrentStore(root, "primary");
  const original = Object.getOwnPropertyDescriptor(globalThis, "window"), listeners = new Map<string, () => void>();
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: any[] = []; let cursor = 0, layout: Array<() => void> = [], effects: Array<() => void> = [], saves = 0;
  const dispatcher = { useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
    return [slots[i], (v: any) => { slots[i] = v; }]; }, useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useLayoutEffect(f: () => void) { cursor++; layout.push(f); }, useEffect(f: () => void) { cursor++; effects.push(f); } };
  const cp = new TerminalWindowCheckpoint(), restoration = { state: defaultWindowView() };
  const render = (state: WindowViewState) => { cursor = 0; layout = []; effects = []; const old = internals.H; internals.H = dispatcher;
    try { useWindowViewPersistence(state, restoration, cp); } finally { internals.H = old; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { agentDesktopWindow: { save: (state: unknown) => { saves++; return store.saveView(state); } },
    addEventListener: (name: string, f: () => void) => listeners.set(name, f), removeEventListener: (name: string) => listeners.delete(name) } });
  const cancel = new AbortController(); let acknowledged = false;
  try {
    render(view()); layout.forEach(f => f()); effects.forEach(f => f());
    const waiting = cp.wait(intent, cancel.signal).then(() => { acknowledged = true; });
    render(view([intent])); listeners.get("beforeunload")!(); await drain(); expect(acknowledged).toBe(false);expect(saves).toBe(1);
    const next = { ...view([intent]), route: { hostId, sessionId: null }, settingsOpen: true };
    render(next); layout.forEach(f => f());expect(acknowledged).toBe(false);effects.forEach(f => f());await waiting;
    expect(acknowledged).toBe(true);expect(saves).toBe(2);
    const reopened = new CurrentStore(root, "primary").bootstrap().state!;
    expect(reopened.terminalCreations).toEqual([intent]);expect(reopened.route.sessionId).toBeNull();expect(reopened.settingsOpen).toBe(true);
  } finally { cancel.abort(); if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); rmSync(root, { recursive: true, force: true }); }
});

test("App saves the retained terminal owner projection through the combined observer", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const windowWarning = useWindowViewPersistence(");
  expect(source.slice(start, source.indexOf(";", start))).toContain("terminalCreations: terminalRequests.intents");
});
