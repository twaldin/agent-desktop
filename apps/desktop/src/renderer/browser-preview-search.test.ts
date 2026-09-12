import { expect, test } from "bun:test";
import React from "react";
import type { BrowserMetadataSnapshot, DesktopBridge, DraftBrowserMetadataSnapshot } from "@agent-desktop/shared";
import { BrowserPanel } from "./BrowserPanel";
import { useCommandBrowserTabs } from "./use-command-browser-tabs";
import { BrowserSearchRegistry } from "./browser-search-registry";
import { browserSearchOwner, browserSearchPresentationKey } from "./command-browser-tabs";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import { parseDraftBrowserPageIntent } from "../draft-browser-page-intent";
import { createDockState, insertDockTab, type DockTab } from "./dock-state";
import { reconcileDockPresentations, type DockPresentations } from "./dock-presentations";

const hosts = new Set(["host"]);
function tab(id = "page"): DockTab {
  const { browserNewTab: _local, ...tab } = createBrowserNewTab("host", "session", id);
  return { ...tab, title: "Personal title", browserTarget: { workerPid: 12, name: id, targetId: id } };
}
function layout(tabs = [tab()], previous?: DockPresentations, seed = "original") {
  let state = createDockState(); for (const tab of tabs) state = insertDockTab(state, tab, "right");
  return reconcileDockPresentations(previous, { tabs, state }, seed);
}
function metadata(id = "page", url = "https://example.com/observed"): BrowserMetadataSnapshot {
  return { protocolVersion: 1, hostId: "host", sessionId: "session", availability: "running", workerPid: 12,
    tabs: [{ name: id, targetId: id, state: "alive", title: "Observed title", url, backend: "worker", kindTag: "headless", viewport: { width: 800, height: 600 } }] };
}
const values = (value: BrowserMetadataSnapshot) => new Map([[browserSearchOwner("host", "session"), value]]);
function setup(tabs = [tab()]) {
  const presentations = layout(tabs), registry = new BrowserSearchRegistry(); registry.commit(presentations);
  const observe = (id = tabs[0]!.id) => registry.observe(id, browserSearchPresentationKey(presentations, id))!;
  return { presentations, registry, observe, entries: () => registry.entries(presentations, hosts) };
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test("preview observations seed only their presentation and arbitrate older search and preview reads", () => {
  const s = setup([tab(), tab("sibling")]);
  s.registry.read().publish(values(metadata("sibling", "https://example.com/sibling")));
  const olderSearch = s.registry.read(), original = s.observe(); original(metadata());
  expect(s.entries().map(entry => entry.url)).toEqual(["https://example.com/observed", "https://example.com/sibling"]);
  olderSearch.publish(values(metadata("page", "https://old.invalid")));
  expect(s.entries()[0]).toMatchObject({ title: "Personal title", pageTitle: "Observed title", url: "https://example.com/observed" });
  const oldPreview = s.observe(), newPreview = s.observe(); newPreview(metadata("page", "https://new.invalid")); oldPreview(metadata());
  expect(s.entries()[0]?.url).toBe("https://new.invalid");
  const priorPreview = s.observe(); s.registry.read().publish(values(metadata("page", "https://poll.invalid"))); priorPreview(metadata());
  expect(s.entries()[0]?.url).toBe("https://poll.invalid");
});

test("retired record, connection generation, foreign identity and malformed details cannot publish replacements", () => {
  const s = setup(); const before = s.observe(); s.registry.invalidateReads(); before(metadata()); expect(s.entries()).toEqual([]);
  s.observe()(metadata()); const late = s.observe();
  const empty = layout([], s.presentations, "closed"), reopened = layout([tab()], empty, "reopened");
  s.registry.commit(empty); s.registry.commit(reopened); late(metadata());
  expect(s.registry.entries(reopened, hosts)).toEqual([]);
  expect(s.registry.observe(tab().id, browserSearchPresentationKey(s.presentations, tab().id))).toBeUndefined();
  const publish = () => s.registry.observe(tab().id, browserSearchPresentationKey(reopened, tab().id))!;
  publish()(metadata()); publish()({ ...metadata(), sessionId: "foreign" });
  expect(s.registry.entries(reopened, hosts)[0]).toMatchObject({ url: "https://example.com/observed", detailsUnavailable: true });
  const bad = metadata(); if (bad.availability !== "running") throw new Error("Expected running fixture"); bad.tabs[0]!.viewport.width = 0;
  publish()(bad); expect(s.registry.entries(reopened, hosts)).toHaveLength(1);
  publish()({ ...bad, tabs: [] }); expect(s.registry.entries(reopened, hosts)[0]?.detailsUnavailable).toBe(true);
});

test("draft preview updates saved history without surviving owner replacement", () => {
  const page = parseDraftBrowserPageIntent({ version: 1, instanceId: "page", owner: { version: 1, hostId: "host", reference: { ownerId: "owner", draftId: "new-conversation", draftRevision: 1 } },
    launcher: { status: "unknown", request: { requestId: "page", controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.com/" } },
    confirmedTarget: { workerPid: 12, tab: { name: "desktop-page", targetId: "native", state: "alive", backend: "worker", kindTag: "headless", title: "Saved", url: "https://saved.invalid", viewport: { width: 800, height: 600 } } } });
  const item = createDraftBrowserDockTab("host", "new-conversation", "page"), presentations = layout([item]), registry = new BrowserSearchRegistry(); registry.commit(presentations, [page]);
  const entry = () => registry.entries(presentations, hosts, [page])[0]!;
  const read = () => registry.observe(item.id, entry().sourceKey)!;
  const snapshot: DraftBrowserMetadataSnapshot = { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "owner", availability: "running", workerPid: 12,
    tabs: [{ ...page.confirmedTarget!.tab, title: "Viewed", url: "https://viewed.invalid" }] };
  read()(snapshot); registry.commit(presentations, [page]); expect(entry()).toMatchObject({ title: "Viewed", pageTitle: "Viewed", url: "https://viewed.invalid", detailsUnavailable: false });
  read()(null); expect(entry().detailsUnavailable).toBe(true);
  const late = read(); registry.commit(presentations, []); registry.commit(presentations, [page]); late(snapshot);
  expect(entry().url).toBe("https://saved.invalid");
});

/** Private hook slots with explicit render/layout/effect phases, not a React mount
 * or browser DOM. Actual panel metadata promises and cleanup callbacks run. */
function hooks() {
  const slots: any[] = []; let cursor = 0, layouts: Array<() => void> = [], effects: Array<() => void> = [];
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const effect = (fn: () => void | (() => void), deps: unknown[] | undefined, pending: Array<() => void>) => {
    const index = cursor++, old = slots[index]; if (!old || !same(old.deps, deps)) {
      slots[index] = { deps, cleanup: old?.cleanup }; pending.push(() => { slots[index].cleanup?.(); slots[index].cleanup = fn(); });
    }
  };
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useMemo(fn: () => unknown, deps: unknown[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect(fn: () => void, deps?: unknown[]) { effect(fn, deps, effects); },
    useLayoutEffect(fn: () => void, deps?: unknown[]) { effect(fn, deps, layouts); },
  };
  return {
    render<T>(fn: () => T, commit = true) { cursor = 0; layouts = []; effects = []; const prior = internals.H; internals.H = dispatcher;
      try { const result = fn(); if (commit) { layouts.forEach(run => run()); effects.forEach(run => run()); } return result; }
      finally { internals.H = prior; } },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test.each([false, true])("actual preview publishes through the callback captured before await, unless retired (%s)", async (retired) => {
  const s = setup(), outer = hooks(), inner = hooks(); let calls = 0, frames = 0, replacement = 0, resolve!: (value: BrowserMetadataSnapshot) => void;
  const bridge = { getBrowserMetadata: async () => { calls++; return await new Promise<BrowserMetadataSnapshot>(done => { resolve = done; }); },
    getBrowserFrame: async () => { frames++; throw new Error("Controlled frame unavailable"); } } as unknown as DesktopBridge;
  const original = () => s.observe(); let callback = original;
  const render = () => {
    const element = outer.render(() => BrowserPanel({ bridge, hostId: "host", sessionId: "session", nativeTarget: tab().browserTarget, active: true, onReadMetadata: callback }));
    inner.render(() => (element.type as Function)(element.props));
  };
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, "document"), rafBefore = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame"), cancelBefore = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
  try {
    render(); expect(calls).toBe(1); callback = () => () => { replacement++; }; render();
    if (retired) inner.dispose();
    resolve(metadata()); await tick();
    if (retired) expect(s.entries()).toEqual([]);
    else expect(s.entries()[0]?.url).toBe("https://example.com/observed");
    expect(replacement).toBe(0); expect(calls).toBe(1); expect(frames).toBe(retired ? 0 : 1);
  } finally {
    inner.dispose(); outer.dispose(); await tick();
    for (const [key, descriptor] of [["document", documentBefore], ["requestAnimationFrame", rafBefore], ["cancelAnimationFrame", cancelBefore]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});


test("closed palette hook consumes its App-owned registry without issuing a search read", () => {
  const owner = setup(), driver = hooks(); let calls = 0;
  const bridge = { getBrowserMetadata: async () => { calls++; return metadata(); } } as unknown as DesktopBridge;
  const render = () => driver.render(() => useCommandBrowserTabs(false, owner.presentations, ["host"], bridge, [], owner.registry));
  try {
    expect(render()).toEqual([]);
    owner.observe()(metadata());
    expect(render()[0]).toMatchObject({ title: "Personal title", pageTitle: "Observed title", url: "https://example.com/observed" });
    expect(calls).toBe(0);
  } finally { driver.dispose(); }
});
