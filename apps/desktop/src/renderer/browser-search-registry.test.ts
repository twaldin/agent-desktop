import { expect, test } from "bun:test";
import React from "react";
import type { BrowserMetadataSnapshot, BrowserTargetObservation, DesktopBridge } from "@agent-desktop/shared";
import { BrowserSearchRegistry } from "./browser-search-registry";
import { activateBrowserSearchTab, browserSearchOwner, matchingBrowserTabs } from "./command-browser-tabs";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "./dock-state";
import { reconcileDockPresentations, type DockPresentations } from "./dock-presentations";
import { useCommandBrowserTabs } from "./use-command-browser-tabs";
import { useWorkbenchDock } from "./use-workbench-dock";
import { defaultWindowView } from "../window-state";

const hosts = new Set(["host"]);
function tab(instance = "page", targetId = "native"): DockTab {
  const local = createBrowserNewTab("host", "conversation", instance);
  const { browserNewTab: _launcher, ...native } = local;
  return { ...native, title: "My research", browserTarget: { workerPid: 12, name: "page", targetId } };
}
function presentations(items = [tab()], previous?: DockPresentations, seed = "original") {
  let state = createDockState(); for (const item of items) state = insertDockTab(state, item, "right");
  return reconcileDockPresentations(previous, { tabs: items, state }, seed);
}
function metadata(url = "https://example.com/first", targetId = "native"): BrowserMetadataSnapshot {
  return { protocolVersion: 1, hostId: "host", sessionId: "conversation", availability: "running", workerPid: 12,
    tabs: [{ name: "page", targetId, state: "alive", title: "Observed guide", url, backend: "worker", kindTag: "headless", viewport: { width: 800, height: 600 } }] };
}
const values = (value: BrowserMetadataSnapshot) => new Map([[browserSearchOwner("host", "conversation"), value]]);
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test("known search text survives closed/offline/failed refresh while no unobserved page is invented", () => {
  const owner = presentations(), registry = new BrowserSearchRegistry(); registry.commit(owner);
  expect(registry.entries(owner, hosts)).toEqual([]);
  registry.read().publish(values(metadata()));
  expect(matchingBrowserTabs(registry.entries(owner, hosts), "research observed first")).toHaveLength(1);
  registry.invalidateReads(); registry.read().publish(new Map());
  expect(registry.entries(owner, hosts)[0]).toMatchObject({ url: "https://example.com/first", detailsUnavailable: true });
  registry.read().publish(values({ protocolVersion: 1, hostId: "host", sessionId: "conversation", availability: "unavailable", reason: "Offline" }));
  expect(registry.entries(owner, new Set())[0]).toMatchObject({ url: "https://example.com/first", detailsUnavailable: true });
  registry.read().publish(values(metadata("https://example.com/next")));
  expect(registry.entries(owner, hosts)[0]).toMatchObject({ url: "https://example.com/next", detailsUnavailable: false });
});

test("delivery generation and original record identity reject late metadata after committed owner transitions", () => {
  const registry = new BrowserSearchRegistry(); let owner = presentations(); registry.commit(owner);
  const stale = registry.read(); registry.invalidateReads(); registry.read().publish(values(metadata("https://example.com/new")));
  stale.publish(values(metadata("https://example.com/old"))); expect(registry.entries(owner, hosts)[0]?.url).toBe("https://example.com/new");
  const original = registry.read();
  owner = presentations([tab("page", "replacement")], owner); registry.commit(owner);
  owner = presentations([tab()], owner); registry.commit(owner); original.publish(values(metadata()));
  expect(registry.entries(owner, hosts)).toEqual([]);
  registry.read().publish(values(metadata())); const oldEntry = registry.entries(owner, hosts)[0]!;
  const closed = presentations([], owner, "closed"), reopened = presentations([tab()], closed, "reopened");
  registry.commit(reopened); expect(registry.entries(reopened, hosts)).toEqual([]);
  expect(activateBrowserSearchTab(reopened.snapshot, oldEntry, reopened)).toBeUndefined();
});

test("render-only replacement cannot retire current data, while invalid native data cannot declare a known page dead", () => {
  const registry = new BrowserSearchRegistry(), owner = presentations(); registry.commit(owner); registry.read().publish(values(metadata()));
  const foreignRender = presentations([tab("other")]); expect(registry.entries(foreignRender, hosts)).toEqual([]);
  expect(registry.entries(owner, hosts)).toHaveLength(1);
  const invalid = metadata(); if (invalid.availability !== "running") throw new Error("Fixture must be running");
  invalid.tabs[0]!.viewport.width = 0; registry.read().publish(values(invalid));
  expect(registry.entries(owner, hosts)[0]).toMatchObject({ url: "https://example.com/first", detailsUnavailable: true });
  const dead = metadata(); if (dead.availability !== "running") throw new Error("Fixture must be running");
  dead.tabs[0]!.state = "dead"; registry.read().publish(values(dead)); expect(registry.entries(owner, hosts)[0]?.detailsUnavailable).toBe(true);
  registry.read().publish(values(metadata()));
  const absent = metadata(); if (absent.availability !== "running") throw new Error("Fixture must be running");
  absent.tabs = []; registry.read().publish(values(absent)); expect(registry.entries(owner, hosts)[0]?.detailsUnavailable).toBe(true);
});

test("retained text follows current title and destination without sharing mutable read/output objects", () => {
  const registry = new BrowserSearchRegistry(), owner = presentations(), incoming = metadata(); registry.commit(owner);
  const read = registry.read(); read.tabs[0]!.browserTarget!.targetId = "caller change"; read.publish(values(incoming));
  if (incoming.availability !== "running") throw new Error("Fixture must be running"); incoming.tabs[0]!.url = "https://foreign.invalid";
  const entry = registry.entries(owner, hosts)[0]!; entry.url = "https://caller.invalid";
  expect(registry.entries(owner, hosts)[0]?.url).toBe("https://example.com/first");
  const item = { ...owner.snapshot.tabs[0]!, title: "Renamed" };
  const moved = reconcileDockPresentations(owner, { tabs: [item], state: insertDockTab(createDockState(), item, "bottom") }, "move"); registry.commit(moved);
  const current = registry.entries(moved, hosts)[0]!; expect(current.title).toBe("Renamed");
  expect(activateBrowserSearchTab(moved.snapshot, current, moved)?.bottom.activeTabId).toBe(item.id);
  const replacement = presentations([tab("page", "other")], moved);
  expect(activateBrowserSearchTab(replacement.snapshot, current, replacement)).toBeUndefined();
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

test("actual search hook keeps observed URL through palette close and failed reopen refresh", async () => {
  const hooks = driver(), owner = presentations(); let open = true, fail = false, calls = 0;
  const bridge = { getBrowserMetadata: async () => { calls++; if (fail) throw new Error("Unavailable"); return metadata(); } } as unknown as DesktopBridge;
  // Both shapes are the exact same input for the maintained old-hook pair. The
  // current App passes DockPresentations; the old hook read snapshot.state/tabs.
  const input = { ...owner.snapshot, ...owner };
  const render = () => hooks.render(() => useCommandBrowserTabs(open, input, ["host"], bridge));
  try {
    render(); await tick(); expect(render()[0]?.url).toBe("https://example.com/first");
    open = false; render(); await tick(); render(); fail = true; open = true; render(); await tick();
    const entries = render(); expect(entries[0]?.url).toBe("https://example.com/first");
    expect(entries[0]?.detailsUnavailable).toBe(true); expect(calls).toBe(2);
  } finally { hooks.dispose(); await tick(); }
});

test("actual search hook discards an already-sent read when its committed connection loses and returns", async () => {
  const hooks = driver(), owner = presentations(); let connected = ["host"], calls = 0;
  const pending: Array<(value: BrowserMetadataSnapshot) => void> = [];
  const bridge = { getBrowserMetadata: () => { calls++; return new Promise<BrowserMetadataSnapshot>(resolve => pending.push(resolve)); } } as unknown as DesktopBridge;
  const render = () => hooks.render(() => useCommandBrowserTabs(true, owner, connected, bridge));
  try {
    render(); expect(calls).toBe(1); connected = []; render(); await tick(); connected = ["host"]; render(); expect(calls).toBe(2);
    pending[1]!(metadata("https://example.com/new")); await tick(); expect(render()[0]?.url).toBe("https://example.com/new");
    pending[0]!(metadata("https://example.com/old")); await tick(); expect(render()[0]?.url).toBe("https://example.com/new");
  } finally { hooks.dispose(); pending.forEach(resolve => resolve(metadata())); await tick(); }
});

test("actual dock queued selection cannot resurrect a removed search presentation", () => {
  const hooks = driver(), initial = presentations(), registry = new BrowserSearchRegistry(); registry.commit(initial); registry.read().publish(values(metadata()));
  const render = () => hooks.render(() => useWorkbenchDock({} as DesktopBridge, { ...defaultWindowView(), dock: initial.snapshot }, "host", undefined, false, () => {}));
  try {
    let dock = render(); registry.commit(dock.presentations); registry.read().publish(values(metadata()));
    const selected = registry.entries(dock.presentations, hosts)[0]!;
    dock.change(createDockState()); dock.activateBrowserSearch(selected); dock = render();
    expect(dock.snapshot.tabs).toEqual([]); expect(dock.snapshot.state.right.tabIds).toEqual([]); expect(dock.snapshot.state.right.open).toBe(false);
  } finally { hooks.dispose(); }
});

test("actual search hook consumes original-target absence and discards an old loss-return inspection", async () => {
  const hooks = driver(), owner = presentations(); let connected = ["host"], open = true;
  const requests: Array<{ value: BrowserTargetObservation; resolve(value: BrowserTargetObservation): void }> = [];
  const bridge = { getBrowserMetadata: async () => metadata(), browserObservation: { inspect: async (selectedOwner, target, hostId) => {
    const gate = Promise.withResolvers<BrowserTargetObservation>();
    const value: BrowserTargetObservation = { protocolVersion: 1, hostId, owner: selectedOwner, ...target,
      ownerId: "conversation", kindTag: "headless", presence: "absent" };
    requests.push({ value, resolve: gate.resolve }); return gate.promise;
  } } } satisfies Pick<DesktopBridge, "getBrowserMetadata" | "browserObservation">;
  const render = () => hooks.render(() => useCommandBrowserTabs(open, owner, connected, bridge as unknown as DesktopBridge));
  try {
    render(); await tick(); expect(requests).toHaveLength(1);
    connected = []; render(); connected = ["host"]; render(); await tick(); expect(requests).toHaveLength(2);
    requests[1]!.resolve({ ...requests[1]!.value, presence: "present" }); await tick(); expect(render()).toHaveLength(1);
    requests[0]!.resolve(requests[0]!.value); await tick(); expect(render()).toHaveLength(1);
    open = false; render(); open = true; render(); await tick(); expect(requests).toHaveLength(3);
    expect(requests[2]!.value).toMatchObject({ hostId: "host", owner: { kind: "session", sessionId: "conversation" }, workerPid: 12, name: "page", targetId: "native" });
    requests[2]!.resolve(requests[2]!.value); await tick(); expect(render()).toEqual([]);
    expect(owner.snapshot.tabs).toHaveLength(1);
  } finally { hooks.dispose(); requests.forEach(request => request.resolve(request.value)); await tick(); }
});
