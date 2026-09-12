import { BrowserSearchSelection } from "./browser-search-activation";
import { expect, test } from "bun:test";
import React from "react";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopBridge } from "@agent-desktop/shared";
import { parseDraftBrowserPageIntent, type DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView } from "../window-state";
import { draftBrowserSearchEntries } from "./draft-browser-search";
import { BrowserSearchRegistry } from "./browser-search-registry";
import { activateBrowserSearchTab, matchingBrowserTabs } from "./command-browser-tabs";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import { createDockState, hideDock, insertDockTab } from "./dock-state";
import { reconcileDockPresentations, type DockPresentations } from "./dock-presentations";
import { useCommandBrowserTabs } from "./use-command-browser-tabs";
import { useWorkbenchDock } from "./use-workbench-dock";

function page(): DraftBrowserPageIntent {
  return parseDraftBrowserPageIntent({ version: 1, instanceId: "page", owner: { version: 1, hostId: "host",
    reference: { ownerId: "owner", draftId: "new-conversation", draftRevision: 1 } },
    launcher: { status: "unknown", draft: "example.com", request: { requestId: "request", controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.com/" } },
    confirmedTarget: { workerPid: 50, tab: { name: "desktop-request", targetId: "native", state: "alive", backend: "worker", kindTag: "headless",
      title: "Observed guide", url: "https://example.com/redirect", viewport: { width: 800, height: 600 } } } });
}
function presentation(previous?: DockPresentations, destination: "right" | "bottom" = "right", seed = "original") {
  const tab = { ...createDraftBrowserDockTab("host", "new-conversation", "page", "unsent.invalid"), title: "My research" };
  return reconcileDockPresentations(previous, { tabs: [tab], state: insertDockTab(createDockState(), tab, destination) }, seed);
}

test("draft search uses confirmed original page history, not launcher address or native readiness", () => {
  const p = presentation(), value = page(), rows = draftBrowserSearchEntries(p, [value]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ hostId: "host", sessionId: null, draftId: "new-conversation", title: "My research", pageTitle: "Observed guide", url: "https://example.com/redirect", detailsUnavailable: true });
  expect(matchingBrowserTabs(rows, "research observed redirect")).toHaveLength(1);
  expect(matchingBrowserTabs(rows, "unsent.invalid")).toEqual([]);
  const untitled = { ...p, snapshot: { ...p.snapshot, tabs: p.snapshot.tabs.map(tab => ({ ...tab, title: "New tab" })) } };
  expect(draftBrowserSearchEntries(untitled, [value])[0]?.title).toBe("Observed guide");
  rows[0]!.url = "https://caller.invalid";
  expect(draftBrowserSearchEntries(p, [value])[0]?.url).toBe("https://example.com/redirect");
  const unobserved = page(); delete unobserved.confirmedTarget;
  expect(draftBrowserSearchEntries(p, [unobserved])).toEqual([]);
  const blank = page(); blank.confirmedTarget!.tab.url = "about:blank";
  expect(draftBrowserSearchEntries(p, [blank])[0]?.url).toBe("about:blank");
});

test("draft search rejects missing, ambiguous, foreign and malformed saved bindings without rewriting them", () => {
  const p = presentation(), value = page();
  const variants: DraftBrowserPageIntent[][] = [[], [value, value], [{ ...value, instanceId: "different" }],
    [{ ...value, owner: { ...value.owner, hostId: "other" } }],
    [{ ...value, owner: { ...value.owner, reference: { ...value.owner.reference, draftId: "other" } } }],
    [{ ...value, confirmedTarget: { workerPid: 0, tab: value.confirmedTarget!.tab } }],
    [{ ...value, confirmedTarget: { workerPid: 50, tab: { ...value.confirmedTarget!.tab, name: "not-its-request" } } }],
    [{ ...value, confirmedTarget: { workerPid: 50, tab: { ...value.confirmedTarget!.tab, url: "" } } }]];
  for (const values of variants) { const original = structuredClone(values); expect(draftBrowserSearchEntries(p, values)).toEqual([]); expect(values).toEqual(original); }
});

test("original draft selection follows hidden/moved presentation but rejects reopened or retargeted page", () => {
  const value = page(), p = presentation(), selected = draftBrowserSearchEntries(p, [value])[0]!;
  const moved = presentation(p, "bottom"); moved.snapshot.state = hideDock(moved.snapshot.state, "bottom");
  expect(activateBrowserSearchTab(moved.snapshot, selected, moved, [value])?.bottom).toMatchObject({ open: true, activeTabId: selected.id });
  const closed = reconcileDockPresentations(p, { tabs: [], state: createDockState() }, "closed"), reopened = presentation(closed, "right", "reopened");
  expect(activateBrowserSearchTab(reopened.snapshot, selected, reopened, [value])).toBeUndefined();
  for (const changed of [
    { ...value, owner: { ...value.owner, reference: { ...value.owner.reference, ownerId: "replacement" } } },
    { ...value, confirmedTarget: { workerPid: 51, tab: value.confirmedTarget!.tab } },
    { ...value, confirmedTarget: { workerPid: 50, tab: { ...value.confirmedTarget!.tab, targetId: "replacement" } } },
  ]) expect(activateBrowserSearchTab(p.snapshot, selected, p, [changed])).toBeUndefined();
  expect(activateBrowserSearchTab(p.snapshot, selected, p)).toBeUndefined();
  expect(activateBrowserSearchTab(p.snapshot, { ...selected, draftId: "other" }, p, [value])).toBeUndefined();
});

test("registry seeds draft history without admitting it to session metadata reads", () => {
  const p = presentation(), pages = [page()], registry = new BrowserSearchRegistry(); registry.commit(p, pages);
  expect(registry.entries(p, new Set(), pages)[0]).toMatchObject({ url: "https://example.com/redirect", detailsUnavailable: true });
  expect(registry.read().tabs).toEqual([]); registry.invalidateReads(); registry.read().publish(new Map());
  expect(registry.entries(p, new Set(["host"]), pages)).toHaveLength(1);
  expect(registry.entries(p, new Set(["host"]), [])).toEqual([]);
  const rendered = presentation(undefined, "right", "abandoned"); expect(registry.entries(rendered, new Set(), pages)).toEqual([]);
  expect(registry.entries(p, new Set(), pages)).toHaveLength(1);
});

test("actual window save/reopen supplies search history without becoming ready", () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-search-history-"));
  try {
    const value = page(), p = presentation();
    const view = { ...defaultWindowView(), dock: p.snapshot, draftBrowserOwners: [value.owner], draftBrowserPages: [value] };
    expect(new WindowStateStore(dir, "primary").saveView(view).error).toBeUndefined();
    const restored = new WindowStateStore(dir, "primary").bootstrap().state!;
    const current = reconcileDockPresentations(undefined, restored.dock!, "restored");
    const rows = draftBrowserSearchEntries(current, restored.draftBrowserPages!);
    expect(rows[0]).toMatchObject({ url: "https://example.com/redirect", detailsUnavailable: true, sessionId: null });
    expect(restored.draftBrowserPages![0]!.launcher.status).toBe("unknown");
    expect(restored.draftBrowserPages![0]!.owner).toEqual(value.owner);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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


test("actual hook includes original draft history while closed/offline and never acquires or inspects", async () => {
  const hooks = driver(), p = presentation(), pages = [page()]; let calls = 0, open = false;
  const bridge = { getBrowserMetadata: async () => { calls++; throw new Error("Draft history must not call session metadata"); },
    draftBrowser: new Proxy({}, { get() { calls++; throw new Error("Search must not inspect or acquire a draft owner"); } }) } as unknown as DesktopBridge;
  const render = () => hooks.render(() => useCommandBrowserTabs(open, p, [], bridge, pages));
  try {
    render(); const rows = render();
    expect(rows[0]?.url).toBe("https://example.com/redirect");
    expect(rows[0]?.detailsUnavailable).toBe(true);
    open = true; render(); for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(render()[0]?.url).toBe("https://example.com/redirect");
    expect(calls).toBe(0);
  } finally { hooks.dispose(); }
});

test("actual queued dock selection rechecks committed page binding without creating or replacing content", () => {
  const hooks = driver(), p = presentation(); let pages = [page()], calls = 0;
  const bridge = new Proxy({} as DesktopBridge, { get() { calls++; throw new Error("No backend needed for selection"); } });
  const render = () => hooks.render(() => useWorkbenchDock(bridge, { ...defaultWindowView(), dock: { ...p.snapshot, state: hideDock(p.snapshot.state, "right") } }, "other", undefined, false, () => {}));
  try {
    let dock = render(); const selected = draftBrowserSearchEntries(dock.presentations, pages)[0]!;
    dock.activateBrowserSearch(selected, () => pages); pages = []; dock = render();
    expect(dock.snapshot.state.right.open).toBe(false); expect(dock.snapshot.tabs).toEqual(p.snapshot.tabs);
    pages = [page()]; dock.activateBrowserSearch(selected, () => pages); dock = render();
    expect(dock.snapshot.state.right).toMatchObject({ open: true, activeTabId: selected.id });
    expect(dock.snapshot.tabs).toEqual(p.snapshot.tabs); expect(calls).toBe(0);
  } finally { hooks.dispose(); }
});

test("actual App selection routes to the original host draft and refuses a replaced committed page", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), marker = "onSelectBrowserTab={tab => {";
  const start = source.indexOf(marker), end = source.indexOf("\n      }}", start);
  if (start < 0 || end < 0) throw new Error("App browser selection callback missing");
  const invoke = new Function("tab", "dock", "committedDraftSearchPages", "setActionError", "route", "settingsOpen", "pluginDirectoryOpen", "automationsOpen", "navigate", "requestAnimationFrame", "document", "CSS", "activateBrowserSearchTab", "browserSearchSelection",
    new Bun.Transpiler({ loader: "tsx" }).transformSync(source.slice(start + marker.length, end)));
  const hooks = driver(), p = presentation(), original = page();
  const committed = { current: [original] }, navigation: unknown[][] = [], errors: string[] = [];
  let frames = 0;
  const selection = new BrowserSearchSelection(() => { frames++; return frames; }, () => {});
  const route = { hostId: "other-host", sessionId: "other-session" };
  const navigate = (...args: unknown[]) => navigation.push(args);
  const render = () => hooks.render(() => useWorkbenchDock({} as DesktopBridge, { ...defaultWindowView(), dock: p.snapshot }, "other-host", undefined, false, () => {}));
  try {
    let dock = render(); const entry = draftBrowserSearchEntries(dock.presentations, [original])[0]!;
    const select = () => invoke(entry, dock, committed, (message: string) => errors.push(message), route, false, false, false, navigate, () => { frames++; }, undefined, undefined, activateBrowserSearchTab, selection);
    select(); expect(navigation).toEqual([]); dock = render();
    selection.commit({ presentations: dock.presentations, pages: committed.current, route, settingsOpen: false, pluginDirectoryOpen: false, root: null, navigate });
    expect(navigation).toEqual([[null, "host", false, false]]);
    expect(dock.snapshot.state.right.activeTabId).toBe(entry.id); expect(frames).toBe(0); expect(errors).toEqual([]);
    committed.current = []; select(); dock = render();
    expect(errors).toEqual(["This browser tab is no longer open in this window."]); expect(navigation).toHaveLength(1); expect(frames).toBe(0);
  } finally { hooks.dispose(); }
});

test.each(["removed", "replaced", "retained"] as const)("actual App queued draft page admission controls route and frame (%s)", kind => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), marker = "onSelectBrowserTab={tab => {";
  const start = source.indexOf(marker), end = source.indexOf("\n      }}", start);
  if (start < 0 || end < 0) throw new Error("App browser selection callback missing");
  const invoke = new Function("tab", "dock", "committedDraftSearchPages", "setActionError", "route", "settingsOpen", "pluginDirectoryOpen", "automationsOpen", "navigate", "requestAnimationFrame", "document", "CSS", "activateBrowserSearchTab", "browserSearchSelection",
    new Bun.Transpiler({ loader: "tsx" }).transformSync(source.slice(start + marker.length, end)));
  const hooks = driver(), p = presentation(), original = page();
  const committed = { current: [original] }, navigation: unknown[][] = [], frames: Array<() => void> = [], errors: string[] = [];
  const selection = new BrowserSearchSelection(callback => { frames.push(callback); return frames.length; }, () => {});
  const route = { hostId: "other-host", sessionId: "other-session" }, navigate = (...args: unknown[]) => navigation.push(args);
  const render = () => hooks.render(() => useWorkbenchDock({} as DesktopBridge,
    { ...defaultWindowView(), dock: { ...p.snapshot, state: hideDock(p.snapshot.state, "right") } }, "other-host", undefined, false, () => {}));
  try {
    let dock = render(); const entry = draftBrowserSearchEntries(dock.presentations, committed.current)[0]!;
    const select = () => invoke(entry, dock, committed, (message: string) => errors.push(message), route, false, false, false,
      navigate, (callback: () => void) => frames.push(callback), undefined, undefined, activateBrowserSearchTab, selection);
    // The initial committed-page check passes. Only the page list changes before
    // the real hook drains its queued activation; the dock/presentation stays.
    select();
    if (kind === "removed") committed.current = [];
    if (kind === "replaced") committed.current = [{ ...original, confirmedTarget: { ...original.confirmedTarget!, workerPid: 51 } }];
    dock = render();
    selection.commit({ presentations: dock.presentations, pages: committed.current, route, settingsOpen: false, pluginDirectoryOpen: false, root: null, navigate });
    expect(navigation).toEqual(kind === "retained" ? [[null, "host", false, false]] : []);
    expect(frames).toEqual([]); expect(errors).toEqual([]);
    expect(dock.snapshot.tabs).toEqual(p.snapshot.tabs);
    expect(dock.snapshot.state.right.open).toBe(kind === "retained");
    expect(dock.presentations.browserSearchAdmission?.accepted).toBe(kind === "retained");
    if (kind !== "retained") {
      committed.current = [original]; select(); dock = render();
      selection.commit({ presentations: dock.presentations, pages: committed.current, route, settingsOpen: false, pluginDirectoryOpen: false, root: null, navigate });
      expect(navigation).toEqual([[null, "host", false, false]]); expect(frames).toEqual([]);
      expect(dock.snapshot.state.right.activeTabId).toBe(entry.id);
    }
  } finally { hooks.dispose(); selection.cancel(); }
});
