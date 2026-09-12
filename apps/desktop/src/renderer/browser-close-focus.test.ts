import { afterEach, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { BrowserCloseDockOwner } from "./browser-close-dock-owner";
import { BrowserCloseFocus, admitBrowserClose, type BrowserClosePresentations } from "./browser-close-focus";
import { captureDockPresentation, reconcileDockPresentations } from "./dock-presentations";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab, type DockDestination } from "./dock-state";
import { useWorkbenchDock as CurrentWorkbenchDock } from "./use-workbench-dock";
import { defaultWindowView } from "../window-state";
import type { DesktopBridge } from "@agent-desktop/shared";

const useWorkbenchDock: typeof CurrentWorkbenchDock = process.env.BROWSER_CLOSE_FOCUS_DOCK_SOURCE
  ? (await import(process.env.BROWSER_CLOSE_FOCUS_DOCK_SOURCE)).useWorkbenchDock : CurrentWorkbenchDock;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
/** Controlled document/node/event shapes; no browser or layout engine. */
function fixture(options: { empty?: boolean; destination?: DockDestination } = {}) {
  const previousCSS = globalThis.CSS;
  if (!previousCSS) Object.defineProperty(globalThis, "CSS", { value: { escape: (text: string) => text }, configurable: true });
  const destination = options.destination ?? "right";
  const tab = createBrowserNewTab("host", "session", "first"), next = createBrowserNewTab("host", "session", "next");
  let state = insertDockTab(createDockState(), tab, destination);
  if (!options.empty) state = insertDockTab(state, next, destination);
  state[destination].activeTabId = tab.id;
  let presentations: BrowserClosePresentations = reconcileDockPresentations(undefined, { state, tabs: options.empty ? [tab] : [tab, next] }, "initial");
  const listeners = new Set<() => void>(); let active: NodeShape;
  const document = { get activeElement() { return active; }, body: undefined as unknown as NodeShape,
    addEventListener(_type: string, fn: () => void) { listeners.add(fn); }, removeEventListener(_type: string, fn: () => void) { listeners.delete(fn); } };
  class NodeShape {
    isConnected = true; hidden = false; disabled = false; focused = 0; parent?: NodeShape;
    ownerDocument = document;
    contains(node: NodeShape): boolean { return node === this || Boolean(node.parent && this.contains(node.parent)); }
    closest(selector: string): NodeShape | null { return selector === ".dock-pill" ? this.parent ?? this : this.hidden ? this : null; }
    matches(_selector: string) { return this.disabled; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    focus() { this.focused++; active = this; for (const listener of [...listeners]) listener(); }
  }
  document.body = new NodeShape();
  const wrapper = new NodeShape(), pill = new NodeShape(), close = new NodeShape(), content = new NodeShape(), target = new NodeShape(), chat = new NodeShape(), other = new NodeShape();
  pill.parent = wrapper; close.parent = wrapper; active = close;
  const queries = new Map<string, NodeShape>([
    [`[data-dock-content-tab][data-dock-tab-id="${tab.id}"]`, pill], [`[data-dock-content-id="${tab.id}"]`, content],
    [`[data-dock-tab-id="${next.id}"]`, target], ["[data-main-task-chat]", chat],
  ]);
  const root = Object.assign(new NodeShape(), { querySelector(selector: string) { return queries.get(selector) ?? null; } });
  const frames = new Map<number, () => void>(); let counter = 0;
  const manager = new BrowserCloseFocus(fn => { const id = ++counter; frames.set(id, fn); return id; }, id => frames.delete(id));
  let route = "route", enabled = true, connected = new Set(["host"]);
  const commit = () => manager.commit({ presentations, root: root as unknown as HTMLElement, route, enabled, connected });
  const begin = () => manager.begin(tab.id, presentations.instances.get(tab.id));
  const moveFocus = (node: NodeShape) => { active = node; for (const listener of [...listeners]) listener(); };
  const remove = (id: string, allowed = true) => {
    presentations = admitBrowserClose(presentations, captureDockPresentation(presentations, tab.id)!, tab, () => allowed, id);
    if (allowed) { close.isConnected = false; pill.isConnected = false; content.isConnected = false; active = document.body; }
    commit();
  };
  const execute = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
  cleanup.push(() => { manager.cancel(); if (!previousCSS) delete (globalThis as { CSS?: typeof CSS }).CSS; });
  commit();
  return { manager, begin, remove, execute, frames, listeners, commit, target, chat, close, content, document, other, root, queries, moveFocus, tab, next,
    snapshot: () => presentations,
    state: (change: "overlay" | "route" | "disconnect") => { if (change === "overlay") enabled = false; if (change === "route") route = "other"; if (change === "disconnect") connected = new Set(); commit(); },
    restore: () => { enabled = true; route = "route"; connected = new Set(["host"]); commit(); },
    replaceNext: () => {
      const receipt = presentations.browserCloseAdmission;
      const empty = reconcileDockPresentations(presentations, { state: createDockState(), tabs: [] }, "gone");
      presentations = { ...reconcileDockPresentations(empty, { state: insertDockTab(createDockState(), next, destination), tabs: [next] }, "reopened"), browserCloseAdmission: receipt }; commit();
    },
  };
}
test.each(["right", "bottom"] as const)("accepted %s close focuses exact surviving tab only after commit and frame", destination => {
  const f = fixture({ destination }), id = f.begin()!; expect(id).toBeDefined(); expect(f.frames.size).toBe(0); expect(f.listeners.size).toBe(1);
  f.remove(id); expect(f.target.focused).toBe(0); expect(f.frames.size).toBe(1); f.execute(); expect(f.target.focused).toBe(1); expect(f.listeners.size).toBe(0);
  f.commit(); f.execute(); expect(f.target.focused).toBe(1);
});
test("last tab returns focus to visible Chat; focused close button may become disabled while waiting", () => {
  const f = fixture({ empty: true }), id = f.begin()!; f.close.disabled = true; f.moveFocus(f.document.body); f.commit();
  expect(f.listeners.size).toBe(1); f.remove(id); f.execute(); expect(f.chat.focused).toBe(1);
});
test("rejected queued removal leaves tab and focus untouched", () => {
  const f = fixture(), id = f.begin()!; f.remove(id, false); f.execute(); expect(f.frames.size).toBe(0); expect(f.target.focused).toBe(0);
  expect(f.snapshot().snapshot.tabs).toHaveLength(2); expect(f.listeners.size).toBe(0);
});
test.each(["overlay", "route", "disconnect"] as const)("%s loss-return while waiting cannot revive old focus", kind => {
  const f = fixture(), id = f.begin()!; f.state(kind); f.restore(); f.remove(id); f.execute(); expect(f.target.focused).toBe(0);
  expect(f.listeners.size).toBe(0);
});
test.each(["overlay", "route", "disconnect"] as const)("%s loss-return after admission cancels even a retained old frame", kind => {
  const f = fixture(), id = f.begin()!; f.remove(id); const frame = [...f.frames.values()][0]!; f.state(kind); f.restore(); frame();
  expect(f.target.focused).toBe(0); expect(f.listeners.size).toBe(0);
});
test("focus excursion is latched without requiring React commit; fresh deliberate close works", () => {
  const f = fixture(), id = f.begin()!; f.moveFocus(f.other); f.moveFocus(f.close); f.remove(id); f.execute(); expect(f.target.focused).toBe(0);
  const g = fixture(), fresh = g.begin()!; g.remove(fresh); g.execute(); expect(g.target.focused).toBe(1);
});
test("successor close/reopen and DOM node replacement cannot inherit old frame", () => {
  const f = fixture(), id = f.begin()!; f.remove(id); const frame = [...f.frames.values()][0]!; f.replaceNext(); frame(); expect(f.target.focused).toBe(0);
  const g = fixture(), fresh = g.begin()!; g.remove(fresh); g.queries.set(`[data-dock-tab-id="${g.next.id}"]`, g.other); g.execute(); expect(g.other.focused).toBe(0); expect(g.target.focused).toBe(0);
});
test("external focused controls, hidden destination and disposed window never receive fallback focus", () => {
  const f = fixture(); f.moveFocus(f.other); expect(f.begin()).toBeUndefined(); expect(f.frames.size).toBe(0);
  const g = fixture(), id = g.begin()!; g.target.hidden = true; g.remove(id); g.execute(); expect(g.target.focused).toBe(0);
  const h = fixture(), third = h.begin()!; h.remove(third); const frame = [...h.frames.values()][0]!; h.manager.cancel(); frame(); expect(h.target.focused).toBe(0); expect(h.listeners.size).toBe(0);
});
/** Same controlled dispatcher style as existing dock tests, not mounted React. */
function hooks() {
  const slots: any[] = [], queue: (() => void)[] = []; let cursor = 0;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = { useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (next: any) => queue.push(() => { slots[i] = typeof next === "function" ? next(slots[i]) : next; })]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); }, useEffect() {} };
  return { flush() { while (queue.length) queue.shift()!(); }, render<T>(run: () => T): T { cursor = 0; const old = internals.H; internals.H = dispatcher;
    try { return run(); } finally { internals.H = old; } } };
}
test("actual hook commits removal receipt with successor identity and never persists it", () => {
  const first = createBrowserNewTab("host", "session", "first"), next = createBrowserNewTab("host", "session", "next");
  const driver = hooks(), initial = { ...defaultWindowView(), dock: { state: insertDockTab(insertDockTab(createDockState(), first, "right"), next, "right"), tabs: [first, next] } };
  const render = () => driver.render(() => useWorkbenchDock({} as DesktopBridge, initial, "host", { sessionId: "session" }, true, () => {}));
  let dock = render(); const source = captureDockPresentation(dock.presentations, first.id)!, successor = captureDockPresentation(dock.presentations, next.id)!;
  dock.closeBrowser(source, first, () => true, "focus-id"); expect(dock.presentations.browserCloseAdmission).toBeUndefined(); driver.flush(); dock = render();
  expect(dock.presentations.browserCloseAdmission).toEqual({ id: "focus-id", accepted: true, source, next: successor });
  expect(dock.persisted?.tabs.map(tab => tab.id)).toEqual([next.id]); expect("browserCloseAdmission" in dock.persisted!).toBe(false);
  dock.updateTitle(next.id, "Renamed"); driver.flush(); dock = render(); expect(dock.presentations.browserCloseAdmission?.id).toBe("focus-id");
});


function appCloseSelection(f: ReturnType<typeof fixture>, browserCloses: Pick<BrowserCloseDockOwner, "close">) {
  const source = readFileSync(process.env.BROWSER_CLOSE_SETTLEMENT_APP_SOURCE ?? new URL("./App.tsx", import.meta.url), "utf8");
  const expression = source.match(/onBeforeClose=\{([^\n]+?)\} destination=/)?.[1];
  if (!expression) throw new Error("Actual App Close callback not found");
  return new Function("browserCloses", "dock", "fileClose", "browserCloseFocus", `return (${expression})`)(browserCloses,
    { presentations: f.snapshot() }, { onBeforeClose: async () => true }, f.manager) as (tab: typeof f.tab) => Promise<boolean>;
}
function appCloseOwner(f: ReturnType<typeof fixture>, mode: "offline" | "missing-bridge" | "readiness" | "unknown" | "local") {
  if (mode === "unknown") f.tab.browserNewTab = { ...f.tab.browserNewTab!, status: "unknown" };
  else if (mode !== "local") f.tab.browserTarget = { workerPid: 50, name: "page", targetId: "target" };
  const source = readFileSync(process.env.BROWSER_CLOSE_SETTLEMENT_APP_SOURCE ?? new URL("./App.tsx", import.meta.url), "utf8");
  const expression = source.match(/\n    (\(source, tab, allowed, focusId\) => [^\n]+), windowRestoration.error/ )?.[1];
  if (!expression) throw new Error("Actual App removal callback not found");
  const queue: { id: string; allowed: () => boolean }[] = [], events: string[] = [];
  const remove = new Function("closeBrowserDock", "browserCloseFocus", `return (${expression})`)({ current: (_source: unknown, _tab: unknown, allowed: () => boolean, id: string) => queue.push({ id, allowed }) }, f.manager);
  const bridge: Pick<DesktopBridge, "browserClose" | "getBrowserMetadata"> = mode === "missing-bridge" ? {} : {
    getBrowserMetadata: async () => { events.push("metadata"); throw new Error("Readiness unavailable"); },
    browserClose: { close: async () => { throw new Error("Unexpected native close"); }, status: async () => { throw new Error("Unexpected status"); } },
  };
  const owner = new BrowserCloseDockOwner(bridge, [], () => {}, remove);
  owner.commit({ route: "route", enabled: true, connected: new Set(mode === "offline" ? [] : ["host"]), presentations: f.snapshot(), drafts: new Map(), pages: [], launcher: tab => tab.browserNewTab, protected: () => false });
  const view = { ...defaultWindowView(), browserCloses: [] }; owner.committed(view); owner.saved(view); cleanup.push(() => owner.dispose());
  return { owner, queue, events, callback: appCloseSelection(f, owner) };
}
test.each(["offline", "missing-bridge", "readiness", "unknown"] as const)("App non-removing %s Close settles its captured focus listener", async mode => {
  const f = fixture(), app = appCloseOwner(f, mode);
  const close = app.callback(f.tab); expect(f.listeners.size).toBe(1);
  expect(await close).toBe(false); expect(f.listeners.size).toBe(0); expect(app.queue).toEqual([]);
  expect(f.frames.size).toBe(0); expect(f.snapshot().snapshot.tabs.map(tab => tab.id)).toContain(f.tab.id);
  expect(app.events).toEqual(mode === "readiness" ? ["metadata"] : []);
});
test.each(["refused", "accepted"])("App queued removal retains focus ownership until %s receipt", async decision => {
  const accepted = decision === "accepted";
  const f = fixture(), app = appCloseOwner(f, "local");
  expect(await app.callback(f.tab)).toBe(false); expect(app.queue).toHaveLength(1); expect(f.listeners.size).toBe(1);
  const operation = app.queue[0]!; expect(operation.allowed()).toBe(true); f.remove(operation.id, accepted);
  expect(f.frames.size).toBe(accepted ? 1 : 0); f.execute(); expect(f.listeners.size).toBe(0); expect(f.target.focused).toBe(accepted ? 1 : 0);
});
test("older Close settlement or queued marker cannot cancel a newer selection", async () => {
  const f = fixture(), first = Promise.withResolvers<boolean>(), second = Promise.withResolvers<boolean>(); let count = 0;
  const callback = appCloseSelection(f, { close: async () => ++count === 1 ? first.promise : second.promise });
  const older = callback(f.tab), newer = callback(f.tab); expect(f.listeners.size).toBe(1);
  first.resolve(false); expect(await older).toBe(false); expect(f.listeners.size).toBe(1);
  f.manager.queued("unrelated-old-token"); second.resolve(false); expect(await newer).toBe(false); expect(f.listeners.size).toBe(0);
});
test("unexpected action rejection releases listener, while completed queued frame survives settlement", async () => {
  const f = fixture();
  await expect(appCloseSelection(f, { close: async () => { throw new Error("Unexpected operation failure"); } })(f.tab)).rejects.toThrow("Unexpected operation failure");
  expect(f.listeners.size).toBe(0);
  const waiting = Promise.withResolvers<boolean>();
  const run = appCloseSelection(f, { close: async (_tab, _instance, id) => { f.manager.queued(id); f.remove(id!); return waiting.promise; } })(f.tab);
  expect(f.frames.size).toBe(1); waiting.resolve(false); expect(await run).toBe(false); expect(f.frames.size).toBe(1);
  f.execute(); expect(f.target.focused).toBe(1); expect(f.listeners.size).toBe(0);
});
