import { expect, test } from "bun:test";
import React from "react";
import type { BrowserMetadataSnapshot, BrowserTargetObservation, DesktopBridge, DraftBrowserBridge, DraftBrowserMetadataSnapshot } from "@agent-desktop/shared";
import { parseDraftBrowserPageIntent, type DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { BrowserSearchRegistry } from "./browser-search-registry";
import { draftBrowserSearchOwner, readDraftBrowserSearchMetadata } from "./draft-browser-search";
import { readWindowBrowserMetadata } from "./command-browser-tabs";
import { useCommandBrowserTabs } from "./use-command-browser-tabs";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab, type DockTab } from "./dock-state";
import { reconcileDockPresentations } from "./dock-presentations";

function page(ownerId = "owner"): DraftBrowserPageIntent {
  return parseDraftBrowserPageIntent({ version: 1, instanceId: ownerId, owner: { version: 1, hostId: "host", reference: { ownerId, draftId: "new-conversation", draftRevision: 1 } },
    launcher: { status: "unknown", request: { requestId: ownerId, controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.com/" } }, confirmedTarget: { workerPid: 50,
      tab: { name: `desktop-${ownerId}`, targetId: ownerId, state: "alive", backend: "worker", kindTag: "headless", title: "Saved title", url: "https://example.com/saved", viewport: { width: 800, height: 600 } } } });
}
function metadata(value = page(), url = "https://example.com/live"): DraftBrowserMetadataSnapshot {
  return { protocolVersion: 1, ownerKind: "draft", hostId: value.owner.hostId, ownerId: value.owner.reference.ownerId,
    availability: "running", workerPid: 50, tabs: [{ ...value.confirmedTarget!.tab, title: "Live title", url }] };
}
function setup(value = page()) {
  const tab = createDraftBrowserDockTab(value.owner.hostId, value.owner.reference.draftId, value.instanceId);
  const presentations = reconcileDockPresentations(undefined, { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") }, "original");
  const registry = new BrowserSearchRegistry(); registry.commit(presentations, [value]);
  const entries = () => registry.entries(presentations, new Set(["host"]), [value]);
  const publish = (input: DraftBrowserMetadataSnapshot | undefined) => registry.read().publish(new Map(), input ? new Map([[draftBrowserSearchOwner(value), input]]) : new Map());
  return { value, tab, presentations, registry, entries, publish };
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test("live draft metadata replaces saved search text and survives repeated commit and failed refresh", () => {
  const s = setup(), input = metadata(); s.publish(input);
  expect(s.entries()[0]).toMatchObject({ url: "https://example.com/live", title: "Live title", pageTitle: "Live title", detailsUnavailable: false });
  s.registry.commit(s.presentations, [page()]);
  expect(s.entries()[0]?.url).toBe("https://example.com/live");
  if (input.availability !== "running") throw new Error("Fixture running"); input.tabs[0]!.url = "https://caller.invalid";
  s.publish(undefined); expect(s.entries()[0]).toMatchObject({ url: "https://example.com/live", detailsUnavailable: true });
  const invalid = metadata(); if (invalid.availability !== "running") throw new Error("Fixture running"); invalid.tabs[0]!.viewport.width = 0;
  s.publish(invalid); expect(s.entries()[0]?.url).toBe("https://example.com/live");
  const emptyUrl = metadata(); if (emptyUrl.availability !== "running") throw new Error("Fixture running"); emptyUrl.tabs[0]!.url = "";
  s.publish(emptyUrl); expect(s.entries()[0]?.url).toBe("https://example.com/live");
});

test("cached missing, dead or replacement preserves history without claiming live readiness", () => {
  for (const mutate of [
    (m: Extract<DraftBrowserMetadataSnapshot, { availability: "running" }>) => { m.tabs = []; },
    (m: Extract<DraftBrowserMetadataSnapshot, { availability: "running" }>) => { m.tabs[0]!.state = "dead"; },
    (m: Extract<DraftBrowserMetadataSnapshot, { availability: "running" }>) => { m.workerPid = 51; },
    (m: Extract<DraftBrowserMetadataSnapshot, { availability: "running" }>) => { m.tabs[0]!.targetId = "different"; },
  ]) {
    const s = setup(), input = metadata(); if (input.availability !== "running") throw new Error("Fixture running"); mutate(input);
    s.publish(input); expect(s.entries()[0]).toMatchObject({ url: "https://example.com/saved", detailsUnavailable: true });
    s.registry.commit(s.presentations, [page()]); expect(s.entries()[0]).toMatchObject({ url: "https://example.com/saved", detailsUnavailable: true });
    s.publish(metadata()); expect(s.entries()[0]?.url).toBe("https://example.com/live");
  }
});

test("captured draft reads reject generation loss and committed owner replacement", () => {
  const s = setup(), old = s.registry.read(); s.registry.invalidateReads();
  old.publish(new Map(), new Map([[draftBrowserSearchOwner(s.value), metadata()]]));
  expect(s.entries()[0]).toMatchObject({ url: "https://example.com/saved", detailsUnavailable: true });
  const stale = s.registry.read(); s.registry.commit(s.presentations, []); s.registry.commit(s.presentations, [s.value]);
  stale.publish(new Map(), new Map([[draftBrowserSearchOwner(s.value), metadata()]]));
  expect(s.entries()[0]?.url).toBe("https://example.com/saved");
  s.publish({ ...metadata(), ownerId: "foreign" }); expect(s.entries()[0]?.url).toBe("https://example.com/saved");
});

test("draft reads deduplicate exact owners, skip offline, preserve request identity and only invoke metadata", async () => {
  const original = page(), calls: unknown[] = [];
  const bridge = { metadata: async (reference: unknown, host: string) => { calls.push([structuredClone(reference), host]); return metadata(); } } satisfies Pick<DraftBrowserBridge, "metadata">;
  const result = await readDraftBrowserSearchMetadata([original, page()], new Set(["host"]), bridge, new AbortController().signal);
  expect(calls).toEqual([[original.owner.reference, "host"]]); expect(result.get(draftBrowserSearchOwner(original))?.ownerId).toBe("owner");
  await readDraftBrowserSearchMetadata([original], new Set(), bridge, new AbortController().signal); expect(calls).toHaveLength(1);
  const foreign = await readDraftBrowserSearchMetadata([original], new Set(["host"]), { metadata: async () => ({ ...metadata(), hostId: "other" }) } satisfies Pick<DraftBrowserBridge, "metadata">, new AbortController().signal);
  expect(foreign.size).toBe(0);
});

function sessionTab(id: string): DockTab {
  const { browserNewTab: _local, ...tab } = createBrowserNewTab("host", id);
  return { ...tab, browserTarget: { workerPid: 1, name: id, targetId: id } };
}
test("draft and session search share four uncancellable slots across aborted and replacement rounds", async () => {
  const releases: Array<() => void> = [], calls: string[] = []; let active = 0, peak = 0;
  const pending = <T>(id: string, result: T) => { calls.push(id); peak = Math.max(peak, ++active); return new Promise<T>(resolve => releases.push(() => { active--; resolve(result); })); };
  const sessionAbort = new AbortController(), draftAbort = new AbortController(), retired = new AbortController();
  const session = readWindowBrowserMetadata([0,1,2,3].map(i => sessionTab(`s${i}`)), new Set(["host"]), {
    getBrowserMetadata: id => pending<BrowserMetadataSnapshot | null>(id, null),
  }, sessionAbort.signal);
  const bridge = { metadata: (ref: { ownerId: string }) => pending(ref.ownerId, metadata(page(ref.ownerId))) } satisfies Pick<DraftBrowserBridge, "metadata">;
  const cancelled = readDraftBrowserSearchMetadata([page("retired")], new Set(["host"]), bridge, retired.signal); retired.abort();
  const draft = readDraftBrowserSearchMetadata([page("d0"), page("d1")], new Set(["host"]), bridge, draftAbort.signal);
  try {
    expect(calls).toEqual(["s0", "s1", "s2", "s3"]); sessionAbort.abort();
    releases.shift()!(); await tick(); expect(calls).toEqual(["s0", "s1", "s2", "s3", "d0"]); expect(active).toBe(4); expect(peak).toBe(4);
  } finally {
    sessionAbort.abort(); draftAbort.abort(); retired.abort(); releases.splice(0).forEach(release => release()); await Promise.all([session, draft, cancelled]);
  }
  expect(active).toBe(0); expect(calls).not.toContain("retired"); expect(calls).not.toContain("d1");
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


test("actual hook refreshes draft metadata but discards loss-return responses and retains fresh history after close", async () => {
  const hooks = driver(), s = setup(), replies: Array<(value: DraftBrowserMetadataSnapshot) => void> = [];
  let open = true, connected = ["host"], sessionCalls = 0;
  const bridge = { getBrowserMetadata: async () => { sessionCalls++; return null; },
    draftBrowser: { metadata: () => new Promise<DraftBrowserMetadataSnapshot>(resolve => replies.push(resolve)) } } as unknown as DesktopBridge;
  const render = () => hooks.render(() => useCommandBrowserTabs(open, s.presentations, connected, bridge, [s.value]));
  try {
    render(); expect(replies).toHaveLength(1);
    connected = []; render(); connected = ["host"]; render(); expect(replies).toHaveLength(2);
    replies[1]!(metadata(s.value, "https://example.com/current")); await tick(); expect(render()[0]?.url).toBe("https://example.com/current");
    replies[0]!(metadata(s.value, "https://example.com/obsolete")); await tick(); expect(render()[0]?.url).toBe("https://example.com/current");
    open = false; render(); expect(render()[0]).toMatchObject({ url: "https://example.com/current", detailsUnavailable: true }); expect(sessionCalls).toBe(0);
  } finally { hooks.dispose(); replies.forEach(resolve => resolve(metadata())); await tick(); }
});

test("actual draft hook inspects the confirmed owner and retires only search text on exact absence", async () => {
  const hooks = driver(), s = setup(), before = structuredClone(s.value), seen: unknown[] = [];
  const gate = Promise.withResolvers<BrowserTargetObservation>();
  const bridge = { draftBrowser: { metadata: async () => metadata(s.value) }, browserObservation: { inspect: (owner: unknown, target: unknown, hostId: string) => {
    seen.push([structuredClone(owner), structuredClone(target), hostId]); return gate.promise;
  } } } as unknown as DesktopBridge;
  const render = () => hooks.render(() => useCommandBrowserTabs(true, s.presentations, ["host"], bridge, [s.value]));
  const result: BrowserTargetObservation = { protocolVersion: 1, hostId: "host", owner: { kind: "draft", ...s.value.owner.reference },
    workerPid: 50, name: "desktop-owner", targetId: "owner", ownerId: "owner", kindTag: "headless", presence: "absent" };
  try {
    render(); expect(render()).toHaveLength(1); await tick();
    expect(seen).toEqual([[result.owner, { workerPid: 50, name: "desktop-owner", targetId: "owner" }, "host"]]);
    gate.resolve(result); await tick(); expect(render()).toEqual([]);
    expect(s.value).toEqual(before); expect(s.presentations.snapshot.tabs).toHaveLength(1);
  } finally { hooks.dispose(); gate.resolve(result); await tick(); }
});

function draftObservation(value: DraftBrowserPageIntent, presence: "present" | "absent"): BrowserTargetObservation {
  const target = value.confirmedTarget!;
  return { protocolVersion: 1, hostId: value.owner.hostId, owner: { kind: "draft", ...value.owner.reference },
    workerPid: target.workerPid, name: target.tab.name, targetId: target.tab.targetId,
    ownerId: value.owner.reference.ownerId, kindTag: target.tab.kindTag, presence };
}

test("actual hook title-only preview rerender cannot mask a held original-target absence", async () => {
  const hooks = driver(), s = setup(), gates: Array<ReturnType<typeof Promise.withResolvers<BrowserTargetObservation>>> = [];
  let presentations = s.presentations;
  const bridge = { draftBrowser: { metadata: async () => metadata(s.value) }, browserObservation: { inspect: () => {
    const gate = Promise.withResolvers<BrowserTargetObservation>(); gates.push(gate); return gate.promise;
  } } } as unknown as DesktopBridge;
  const render = () => hooks.render(() => useCommandBrowserTabs(true, presentations, ["host"], bridge, [s.value], s.registry));
  const unchangedIntent = structuredClone(s.value);
  try {
    render(); await tick(); const original = render()[0]!;
    expect(gates).toHaveLength(1);
    // This is the shared registry callback captured by the preview before its
    // metadata read. The title update below mirrors its committed dock update.
    const preview = s.registry.observe(original.id, original.sourceKey);
    expect(preview).toBeDefined(); preview!(metadata(s.value, "https://example.com/preview"));
    presentations = reconcileDockPresentations(presentations, { ...presentations.snapshot,
      tabs: presentations.snapshot.tabs.map(tab => ({ ...tab, title: "New preview title" })) }, "title-render");
    render(); const renamed = render()[0]!;
    expect(renamed).toMatchObject({ title: "New preview title", pageTitle: "Live title", url: "https://example.com/preview", sourceKey: original.sourceKey });
    gates[0]!.resolve(draftObservation(s.value, "absent")); await tick();
    expect(render()).toEqual([]);
    expect(gates).toHaveLength(1);
    expect(s.value).toEqual(unchangedIntent);
    expect(presentations.snapshot.tabs).toHaveLength(1);
    preview!(metadata(s.value, "https://example.com/late-preview"));
    expect(render()).toEqual([]);
  } finally { hooks.dispose(); gates.forEach(gate => gate.resolve(draftObservation(s.value, "present"))); await tick(); }
});

test.each(["source", "connection", "bridge", "open"] as const)("actual hook title correction preserves %s loss-return rejection and fresh inspection", async loss => {
  const hooks = driver(), s = setup(), gates: Array<ReturnType<typeof Promise.withResolvers<BrowserTargetObservation>>> = [];
  let presentations = s.presentations, connected = ["host"], open = true;
  let bridge = { draftBrowser: { metadata: async () => metadata(s.value) }, browserObservation: { inspect: () => {
    const gate = Promise.withResolvers<BrowserTargetObservation>(); gates.push(gate); return gate.promise;
  } } } as unknown as DesktopBridge;
  const render = () => hooks.render(() => useCommandBrowserTabs(open, presentations, connected, bridge, [s.value], s.registry));
  try {
    render(); await tick(); expect(render()).toHaveLength(1); expect(gates).toHaveLength(1);
    if (loss === "source") {
      presentations = reconcileDockPresentations(undefined, presentations.snapshot, "replacement-source"); render();
    } else if (loss === "connection") {
      connected = []; render(); connected = ["host"]; render();
    } else if (loss === "bridge") {
      const original = bridge; bridge = { ...bridge }; render(); bridge = original; render();
    } else {
      open = false; render(); open = true; render();
    }
    await tick(); expect(gates.length).toBeGreaterThan(1);
    gates[0]!.resolve(draftObservation(s.value, "absent")); await tick();
    expect(render()).toHaveLength(1);
    gates.at(-1)!.resolve(draftObservation(s.value, "absent")); await tick();
    expect(render()).toEqual([]);
    expect(presentations.snapshot.tabs).toHaveLength(1);
  } finally { hooks.dispose(); gates.forEach(gate => gate.resolve(draftObservation(s.value, "present"))); await tick(); }
});
