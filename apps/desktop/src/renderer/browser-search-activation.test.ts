import { afterEach, beforeEach, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import type { DesktopBridge } from "@agent-desktop/shared";
import { BrowserSearchSelection, admitBrowserSearch } from "./browser-search-activation";
import { activateBrowserSearchTab, browserSearchPresentationKey, type CommandBrowserTab } from "./command-browser-tabs";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";
import { reconcileDockPresentations } from "./dock-presentations";
import { useWorkbenchDock } from "./use-workbench-dock";
import { defaultWindowView } from "../window-state";
const originalCSS = Object.getOwnPropertyDescriptor(globalThis, "CSS");
beforeEach(() => Object.defineProperty(globalThis, "CSS", { configurable: true, value: { escape: (value: string) => value } }));
afterEach(() => { if (originalCSS) Object.defineProperty(globalThis, "CSS", originalCSS); else Reflect.deleteProperty(globalThis, "CSS"); });
function setup() {
  const { browserNewTab: _local, ...local } = createBrowserNewTab("host", "session", "page");
  const tab = { ...local, browserTarget: { workerPid: 1, name: "page", targetId: "native" } };
  const presentations = reconcileDockPresentations(undefined, { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") }, "original");
  const entry: CommandBrowserTab = { id: tab.id, hostId: "host", sessionId: "session", title: "Page", pageTitle: "Page", url: "https://example.com/", detailsUnavailable: false, sourceKey: browserSearchPresentationKey(presentations, tab.id) };
  const route = { hostId: "before", sessionId: "before" }, origin = { route, settingsOpen: false, pluginDirectoryOpen: false };
  const navigation: unknown[][] = [], frames: Array<() => void> = [], cancelled: number[] = []; let focusCount = 0;
  const document = { activeElement: {} }, node = { isConnected: true, closest: () => null, getClientRects: () => [1], focus: () => { focusCount++; } };
  let currentNode: unknown = node;
  const root = { isConnected: true, ownerDocument: document, querySelector: () => currentNode } as unknown as HTMLElement;
  const selection = new BrowserSearchSelection(callback => { frames.push(callback); return frames.length; }, id => cancelled.push(id));
  const context = { presentations, pages: [], ...origin, root, navigate: (...args: unknown[]) => navigation.push(args) };
  return { tab, presentations, entry, origin, selection, navigation, frames, cancelled, context, node, document,
    replaceNode: () => { currentNode = { ...node }; }, focuses: () => focusCount };
}

test("navigation follows committed accepted original activation, focus waits for its route and node", () => {
  const s = setup(); s.selection.begin("request", s.entry, s.origin);
  s.selection.commit(s.context); expect(s.navigation).toEqual([]); expect(s.frames).toEqual([]);
  const accepted = admitBrowserSearch(s.presentations, s.entry, [], "request");
  s.selection.commit({ ...s.context, presentations: accepted }); expect(s.navigation).toEqual([["session", "host", false, false]]); expect(s.frames).toEqual([]);
  s.selection.commit({ ...s.context, presentations: accepted, route: { hostId: "host", sessionId: "session" } });
  expect(s.frames).toHaveLength(1); s.frames[0]!(); expect(s.focuses()).toBe(1);
  s.selection.commit({ ...s.context, presentations: accepted, route: { hostId: "host", sessionId: "session" } }); expect(s.navigation).toHaveLength(1); expect(s.frames).toHaveLength(1);
});

test("removed/reopened/retargeted admissions and intervening route changes cannot navigate", () => {
  for (const kind of ["removed", "reopened", "retargeted", "route"] as const) {
    const s = setup(); s.selection.begin("request", s.entry, s.origin);
    const closed = reconcileDockPresentations(s.presentations, { tabs: [], state: createDockState() }, "closed");
    const changed = kind === "removed" ? closed : kind === "reopened" ? reconcileDockPresentations(closed, s.presentations.snapshot, "replacement")
      : kind === "retargeted" ? reconcileDockPresentations(s.presentations, { ...s.presentations.snapshot, tabs: [{ ...s.tab, browserTarget: { ...s.tab.browserTarget, targetId: "replacement" } }] }, "retarget") : s.presentations;
    const receipt = admitBrowserSearch(changed, s.entry, [], "request");
    s.selection.commit({ ...s.context, presentations: receipt, ...(kind === "route" ? { route: { hostId: "newer", sessionId: "newer" } } : {}) });
    expect(s.navigation).toEqual([]); expect(s.frames).toEqual([]);
  }
});

test("deferred focus never falls back to reusable ID or overrides a newer owner/focus", () => {
  for (const kind of ["node", "route", "focus", "target", "cancel"] as const) {
    const s = setup(), route = { hostId: "host", sessionId: "session" };
    s.selection.begin("request", s.entry, s.origin);
    const receipt = admitBrowserSearch(s.presentations, s.entry, [], "request");
    s.selection.commit({ ...s.context, presentations: receipt });
    s.selection.commit({ ...s.context, presentations: receipt, route }); expect(s.frames).toHaveLength(1);
    if (kind === "node") s.replaceNode();
    if (kind === "focus") s.document.activeElement = {};
    if (kind === "cancel") s.selection.cancel();
    if (kind === "route") { s.selection.commit({ ...s.context, presentations: receipt, route: { hostId: "other", sessionId: "other" } }); s.selection.commit({ ...s.context, presentations: receipt, route }); }
    if (kind === "target") s.selection.commit({ ...s.context, presentations: { ...receipt, snapshot: { ...receipt.snapshot, tabs: [{ ...s.tab, browserTarget: { ...s.tab.browserTarget, targetId: "replacement" } }] } }, route });
    s.frames[0]!(); expect(s.focuses()).toBe(0);
  }
});

/** Controlled React slots and explicit commit/effect ordering, not React mount. */
function driver() {
  const slots: any[] = [], queue: Array<() => void> = []; let cursor = 0, layouts: Array<() => void> = [], effects: Array<() => void> = [];
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const effect = (callback: () => void | (() => void), deps: unknown[] | undefined, pending: Array<() => void>) => {
    const i = cursor++, prior = slots[i];
    if (!prior || !same(prior.deps, deps)) { slots[i] = { deps, cleanup: prior?.cleanup }; pending.push(() => { slots[i].cleanup?.(); slots[i].cleanup = callback(); }); }
  };
  const hooks = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value: any) => queue.push(() => { slots[i] = typeof value === "function" ? value(slots[i]) : value; })]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useMemo(callback: () => any, deps: unknown[]) { const i = cursor++, prior = slots[i]; if (!prior || !same(prior.deps, deps)) slots[i] = { deps, value: callback() }; return slots[i].value; },
    useEffect(callback: () => void, deps?: unknown[]) { effect(callback, deps, effects); },
    useLayoutEffect(callback: () => void, deps?: unknown[]) { effect(callback, deps, layouts); },
  };
  return {
    render<T>(run: () => T): T { while (queue.length) queue.shift()!(); cursor = 0; layouts = []; effects = [];
      const prior = internals.H; internals.H = hooks;
      try { const value = run(); layouts.forEach(run => run()); effects.forEach(run => run()); return value; } finally { internals.H = prior; }
    },
    dispose() { for (const value of slots) if (value && typeof value.cleanup === "function") { value.cleanup(); value.cleanup = undefined; } },
  };
}


test("actual App callback plus queued dock rejection produces no route or frame", () => {
  const text = readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), marker = "onSelectBrowserTab={tab => {";
  const start = text.indexOf(marker), end = text.indexOf("\n      }}", start); if (start < 0 || end < 0) throw new Error("Missing App callback");
  const invoke = new Function("tab", "dock", "committedDraftSearchPages", "setActionError", "route", "settingsOpen", "pluginDirectoryOpen", "navigate", "requestAnimationFrame", "document", "CSS", "activateBrowserSearchTab", "browserSearchSelection",
    new Bun.Transpiler({ loader: "tsx" }).transformSync(text.slice(start + marker.length, end)));
  const s = setup(), hooks = driver();
  const render = () => hooks.render(() => useWorkbenchDock({} as DesktopBridge, { ...defaultWindowView(), dock: s.presentations.snapshot }, "host", { sessionId: "session" }, false, () => {}));
  try {
    let dock = render(); const entry = { ...s.entry, sourceKey: browserSearchPresentationKey(dock.presentations, s.entry.id) };
    dock.change(createDockState());
    invoke(entry, dock, { current: [] }, () => {}, s.origin.route, false, false, s.context.navigate, (callback: () => void) => s.frames.push(callback), undefined, undefined, activateBrowserSearchTab, s.selection);
    expect(s.navigation).toEqual([]); expect(s.frames).toEqual([]);
    dock = render(); s.selection.commit({ ...s.context, presentations: dock.presentations });
    expect(dock.snapshot.tabs).toEqual([]); expect(s.navigation).toEqual([]); expect(s.frames).toEqual([]);
  } finally { hooks.dispose(); s.selection.cancel(); }
});

test.each([["settingsOpen", false], ["pluginDirectoryOpen", false], ["settingsOpen", true], ["pluginDirectoryOpen", true]] as const)("route-wait overlay transition cancels old search selection permanently (%s, initially %s)", (overlay, initiallyOpen) => {
  const s = setup(), destination = { hostId: "host", sessionId: "session" };
  const waitingOrigin = { ...s.origin, [overlay]: initiallyOpen }, waiting = { ...s.context, ...waitingOrigin };
  s.selection.begin("request", s.entry, waitingOrigin);
  const receipt = admitBrowserSearch(s.presentations, s.entry, [], "request");
  s.selection.commit({ ...waiting, presentations: receipt });
  expect(s.navigation).toEqual([["session", "host", false, false]]); expect(s.frames).toEqual([]);
  // Admission has already succeeded. The destination route has NOT committed.
  s.selection.commit({ ...waiting, presentations: receipt, [overlay]: !initiallyOpen });
  s.selection.commit({ ...waiting, presentations: receipt });
  s.selection.commit({ ...s.context, presentations: receipt, route: destination });
  for (const frame of s.frames) frame();
  expect(s.focuses()).toBe(0); expect(s.frames).toEqual([]); expect(s.navigation).toHaveLength(1);
  // Returning to the same state cannot revive it; a new explicit selection can.
  const origin = { route: destination, settingsOpen: false, pluginDirectoryOpen: false };
  s.selection.begin("fresh", s.entry, origin);
  const fresh = admitBrowserSearch(receipt, s.entry, [], "fresh");
  s.selection.commit({ ...s.context, ...origin, presentations: fresh });
  expect(s.frames).toHaveLength(1); s.frames[0]!(); expect(s.focuses()).toBe(1); expect(s.navigation).toHaveLength(1);
});

test.each(["settingsOpen", "pluginDirectoryOpen"] as const)("search from an existing overlay allows its requested destination-and-close commit (%s)", overlay => {
  const s = setup(), origin = { ...s.origin, [overlay]: true };
  s.selection.begin("request", s.entry, origin);
  const receipt = admitBrowserSearch(s.presentations, s.entry, [], "request");
  const waiting = { ...s.context, ...origin, presentations: receipt };
  s.selection.commit(waiting); s.selection.commit(waiting);
  expect(s.navigation).toEqual([["session", "host", false, false]]); expect(s.frames).toEqual([]);
  s.selection.commit({ ...s.context, presentations: receipt, route: { hostId: "host", sessionId: "session" } });
  expect(s.frames).toHaveLength(1); s.frames[0]!(); expect(s.focuses()).toBe(1);
});
