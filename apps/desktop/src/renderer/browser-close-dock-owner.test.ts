import React from "react";
import { useWorkbenchDock } from "./use-workbench-dock";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import type { DraftBrowserPageIntent } from "../draft-browser-page-intent";
import type { DraftBrowserDockController } from "./draft-browser-dock-controller";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopBridge, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { browserCloseIdentity, type BrowserCloseObservation } from "../../../../packages/shared/src/browser-close";
import { BrowserCloseDockOwner, removeClosedBrowser } from "./browser-close-dock-owner";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "./dock-state";
import { captureDockPresentation, reconcileDockPresentations } from "./dock-presentations";
import { createBrowserNewTab } from "./browser-new-tab";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView } from "../window-state";
import type { BrowserCloseWindowIntent } from "../browser-close-window-intent";
const SelectedCloseDockOwner: typeof BrowserCloseDockOwner = process.env.BROWSER_CLOSE_DOCK_OWNER_SOURCE
  ? (await import(process.env.BROWSER_CLOSE_DOCK_OWNER_SOURCE)).BrowserCloseDockOwner : BrowserCloseDockOwner;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fixture(options: { local?: boolean; draft?: boolean; lost?: boolean; restored?: BrowserCloseWindowIntent[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "browser-close-app-")), store = new WindowStateStore(dir, "primary");
  const target = { workerPid: 50, name: "page", targetId: "target" };
  const native: NativeBrowserTabMetadata = { name: "page", targetId: "target", state: "alive", kindTag: "headless", backend: "worker", url: "https://example.com", viewport: { width: 800, height: 600 } };
  const descriptor = { kind: "browser" as const, title: "Page", hostId: "host", target: "session:session" as const, browserTarget: target };
  const tab: DockTab = options.draft ? createDraftBrowserDockTab("host", "draft", "page") : options.local ? createBrowserNewTab("host", "session", "launcher") : { ...descriptor, id: dockTabId(descriptor) };
  let presentations = reconcileDockPresentations(undefined, { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] }, "initial");
  const queued: (() => void)[] = [], events: string[] = [], removalFocusIds: (string | undefined)[] = [];
  const metadata = Promise.withResolvers<void>(), close = Promise.withResolvers<void>();
  const page: DraftBrowserPageIntent = { version: 1, instanceId: "page", owner: { version: 1, hostId: "host", reference: { ownerId: "owner", draftId: "draft", draftRevision: 1 } }, launcher: { status: "unknown", request: { requestId: "request", controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.com/" } } };
  let previewValid = true, previewVisible = true;
  const draftController: Pick<DraftBrowserDockController, "ready" | "previewGuard" | "state"> = {
    get ready() { return previewVisible ? { intent: page, workerPid: 50, tab: native } : undefined; },
    get previewGuard() { return () => previewValid; }, get state() { return page.launcher; },
  };
  let route = "original", enabled = true, connected = new Set(["host"]), protectedSource = false, launcher = tab.browserNewTab;
  const bridge: Pick<DesktopBridge, "browserClose" | "getBrowserMetadata" | "draftBrowser"> = {
    getBrowserMetadata: async (sessionId, hostId) => { events.push("metadata"); await metadata.promise; return { protocolVersion: 1, sessionId, hostId: hostId!, availability: "running", workerPid: 50, tabs: [native], creationTicket: { controlEpoch: "epoch", observedAt: 1 } }; },
    draftBrowser: {
      status: async (ref, hostId) => { events.push("draft-status"); return { protocolVersion: 1, hostId, ownerId: ref.ownerId, state: "ready", workerPid: 50, ticket: { controlEpoch: "owner-epoch", observedAt: 1 } }; },
      metadata: async (ref, hostId) => { events.push("draft-metadata"); await metadata.promise; return { protocolVersion: 1, hostId, ownerKind: "draft", ownerId: ref.ownerId, availability: "running", workerPid: 50, tabs: [native], controlEpoch: "viewport-epoch" }; },
      acquire: async () => { throw new Error("Unexpected acquire"); }, create: async () => { throw new Error("Unexpected create"); },
      retire: async () => { throw new Error("Unexpected retire"); }, creationStatus: async () => { throw new Error("Unexpected creation status"); },
      frame: async () => { throw new Error("Unexpected frame"); }, control: async () => { throw new Error("Unexpected control"); },
    },
    browserClose: {
      close: async (owner, request, hostId) => { events.push("close"); await close.promise; if (options.lost) throw new Error("Reply lost"); return { ...browserCloseIdentity(hostId, owner, request), outcome: "completed", released: true }; },
      status: async (owner, request, hostId): Promise<BrowserCloseObservation> => { events.push("status"); const identity = browserCloseIdentity(hostId, owner, request); return { ...identity, status: "settled", receipt: { ...identity, outcome: "completed", released: true } }; },
    },
  };
  const manager = new SelectedCloseDockOwner(bridge, options.restored ?? [], () => {}, (source, selected, allowed, focusId) => { removalFocusIds.push(focusId); queued.push(() => {
    const next = removeClosedBrowser(presentations, source, selected, allowed);
    presentations = reconcileDockPresentations(presentations, next, "queued");
  }); });
  const commit = () => manager.commit({ route, enabled, connected, presentations, drafts: options.draft ? new Map([[JSON.stringify([tab.id, presentations.instances.get(tab.id)]), draftController]]) : new Map(), pages: options.draft ? [page] : [], launcher: () => launcher, protected: () => protectedSource });
  const view = () => ({ ...defaultWindowView(), dock: presentations.snapshot, browserCloses: manager.intents });
  const save = () => { commit(); manager.committed(view()); expect(store.saveView(view())).toEqual({}); manager.saved(store.bootstrap().state!); };
  const runQueue = () => { for (const fn of queued.splice(0)) fn(); commit(); };
  const change = (kind: "disconnect" | "overlay" | "route" | "replacement" | "title" | "remove" | "retarget") => {
    if (kind === "disconnect") connected = new Set();
    if (kind === "overlay") enabled = false;
    if (kind === "route") route = "other";
    if (kind === "remove" || kind === "replacement") presentations = reconcileDockPresentations(presentations, { state: createDockState(), tabs: [] }, "remove");
    if (kind === "replacement") presentations = reconcileDockPresentations(presentations, { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] }, "replacement");
    if (kind === "title" || kind === "retarget") presentations = reconcileDockPresentations(presentations, { ...presentations.snapshot,
      tabs: presentations.snapshot.tabs.map(value => ({ ...value, title: "Renamed", ...(kind === "retarget" ? { browserTarget: { ...target, targetId: "other" } } : {}) })) }, "change");
    commit();
  };
  cleanup.push(() => { manager.dispose(); rmSync(dir, { recursive: true, force: true }); }); commit(); save();
  return { manager, tab, events, metadata, close, removalFocusIds, save, commit, runQueue, change, queued,
    start: (focusId?: string) => manager.close(tab, presentations.instances.get(tab.id), focusId),
    returnOwner: () => { enabled = true; route = "original"; connected = new Set(["host"]); commit(); },
    hidePreview: () => { previewVisible = false; commit(); },
    losePreview: () => { previewValid = false; commit(); previewValid = true; commit(); },
    protect: () => { protectedSource = true; commit(); },
    pendingLauncher: () => { launcher = { status: "pending" }; commit(); },
    presentations: () => presentations, disk: () => new WindowStateStore(dir, "primary").bootstrap().state! };
}
async function confirm(f: ReturnType<typeof fixture>) {
  const operation = f.start(); f.metadata.resolve(); await tick(); expect(f.events).toEqual(["metadata"]);
  f.save(); await tick(); expect(f.events).toEqual(["metadata", "close"]); f.close.resolve(); await tick();
  expect(f.queued).toHaveLength(0); f.save(); expect(await operation).toBe(false); return operation;
}
test("actual owner saves request and receipt before queued original removal; rename survives", async () => {
  const f = fixture(); await confirm(f); expect(f.disk().browserCloses?.[0]?.receipt?.outcome).toBe("completed");
  expect(f.presentations().snapshot.tabs).toHaveLength(1); f.change("title"); f.save(); f.runQueue();
  expect(f.presentations().snapshot.tabs).toEqual([]); expect(f.presentations().snapshot.state.right.open).toBe(false);
});
test.each(["replacement", "remove", "retarget"] as const)("queued Close rejects %s after saved confirmation", async kind => {
  const f = fixture(); await confirm(f); f.change(kind); const before = structuredClone(f.presentations().snapshot); f.runQueue();
  expect(f.presentations().snapshot).toEqual(before); expect(f.events).toEqual(["metadata", "close"]);
});
test.each(["disconnect", "overlay", "route"] as const)("committed %s loss-return at metadata cannot dispatch", async kind => {
  const f = fixture(), operation = f.start(); f.change(kind); f.returnOwner(); f.metadata.resolve(); await tick();
  expect(await operation).toBe(false); expect(f.events).toEqual(["metadata"]); expect(f.manager.intents).toEqual([]); expect(f.queued).toHaveLength(0);
});
test.each(["disconnect", "overlay", "route"] as const)("sent Close retains receipt after %s loss-return but cannot remove", async kind => {
  const f = fixture(), operation = f.start(); f.metadata.resolve(); await tick(); f.save(); await tick(); f.change(kind); f.returnOwner();
  f.close.resolve(); await tick(); f.save(); expect(await operation).toBe(false); f.runQueue();
  expect(f.presentations().snapshot.tabs).toHaveLength(1); expect(f.disk().browserCloses?.[0]?.receipt?.outcome).toBe("completed");
});
test("unsent local Close never calls native and queued pending transition retains it", async () => {
  const f = fixture({ local: true }); expect(await f.start()).toBe(false); f.pendingLauncher(); f.runQueue();
  expect(f.presentations().snapshot.tabs).toHaveLength(1); expect(f.events).toEqual([]);
  const clean = fixture({ local: true }); expect(await clean.start()).toBe(false); clean.runQueue(); expect(clean.presentations().snapshot.tabs).toEqual([]); expect(clean.events).toEqual([]);
});
test("unresolved workspace preparation retains a local source", async () => {
  const f = fixture({ local: true }); f.protect(); expect(await f.start()).toBe(false); expect(f.queued).toHaveLength(0); expect(f.events).toEqual([]);
});
test("lost Close response stays retained, explicit same-ID status recovers without replay", async () => {
  const f = fixture({ lost: true }), operation = f.start(); f.metadata.resolve(); await tick(); f.save(); await tick(); f.close.resolve(); await operation;
  expect(f.queued).toHaveLength(0); const pending = f.manager.intents[0]!; expect(pending.receipt).toBeUndefined();
  expect(await f.start()).toBe(false); expect(f.events).toEqual(["metadata", "close"]);
  f.save(); const inspection = f.manager.inspect(pending); await tick(); f.save(); await inspection; f.runQueue();
  expect(f.events).toEqual(["metadata", "close", "status"]); expect(f.presentations().snapshot.tabs).toEqual([]); expect(f.manager.intents[0]!.request.requestId).toBe(pending.request.requestId);
});
test("restored history status never removes new presentation or dispatches Close", async () => {
  const first = fixture({ lost: true }), operation = first.start(); first.metadata.resolve(); await tick(); first.save(); await tick(); first.close.resolve(); await operation;
  const restored = fixture({ restored: first.disk().browserCloses }); restored.change("replacement"); restored.save();
  const inspection = restored.manager.inspect(restored.manager.intents[0]!); await tick(); restored.save(); await inspection; restored.runQueue();
  expect(restored.events).toEqual(["status"]); expect(restored.presentations().snapshot.tabs).toHaveLength(1); expect(restored.manager.intents[0]!.receipt?.outcome).toBe("completed");
});
test("App's actual DockPanel callback reaches saved native Close instead of the generic remover", async () => {
  const source = readFileSync(process.env.BROWSER_CLOSE_APP_SOURCE ?? new URL("./App.tsx", import.meta.url), "utf8");
  const expression = source.match(/onBeforeClose=\{([^\n]+?)\} destination=/)?.[1];
  if (!expression) throw new Error("Actual App Close callback not found");
  const f = fixture(), calls: string[] = [];
  const callback = new Function("browserCloses", "dock", "fileClose", "browserCloseFocus", `return (${expression})`)(
    f.manager, { presentations: f.presentations() },
    { onBeforeClose: async (tab: DockTab) => { calls.push(`file:${tab.id}`); return true; } }, { begin: () => undefined, runClose: (_tabId: string, _instanceId: string | undefined, operation: (id: undefined) => Promise<boolean>) => operation(undefined) }) as (tab: DockTab) => Promise<boolean>;
  const operation = callback(f.tab); await tick();
  expect(f.events).toEqual(["metadata"]); expect(calls).toEqual([]);
  f.metadata.resolve(); await tick(); f.save(); await tick(); f.close.resolve(); await tick(); f.save();
  expect(await operation).toBe(false); f.runQueue(); expect(f.presentations().snapshot.tabs).toEqual([]);
  expect(await callback({ ...f.tab, id: "file", kind: "files" })).toBe(true); expect(calls).toEqual(["file:file"]);
});

test("draft preview close preserves exact owner ticket and queued target identity", async () => {
  const f = fixture({ draft: true }), operation = f.start(); await tick(); f.metadata.resolve(); await tick();
  expect(f.events).toEqual(["draft-status", "draft-metadata"]); expect(f.manager.intents[0]!.owner).toEqual({ kind: "draft", ownerId: "owner", draftId: "draft", draftRevision: 1 });
  expect(f.manager.intents[0]!.request.controlEpoch).toBe("owner-epoch"); f.save(); await tick(); f.close.resolve(); await tick(); f.save();
  expect(await operation).toBe(false); f.runQueue(); expect(f.presentations().snapshot.tabs).toEqual([]);
});
test("draft preview loss-return aborts readiness; saved page without live preview is retained", async () => {
  const f = fixture({ draft: true }), operation = f.start(); await tick(); f.losePreview(); f.metadata.resolve(); await tick();
  expect(await operation).toBe(false); expect(f.events).toEqual(["draft-status", "draft-metadata"]); expect(f.manager.intents).toEqual([]); expect(f.queued).toHaveLength(0);
  const g = fixture({ draft: true }); g.hidePreview(); expect(await g.start()).toBe(false); expect(g.events).toEqual([]); expect(g.queued).toHaveLength(0);
});

/** Existing repository controlled dispatcher style: executes queued updaters, not React commits/effects. */
function hooks() {
  const slots: any[] = [], queue: (() => void)[] = []; let cursor = 0;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (next: any) => queue.push(() => { slots[i] = typeof next === "function" ? next(slots[i]) : next; })]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); }, useEffect() {},
  };
  return { flush() { while (queue.length) queue.shift()!(); }, render<T>(fn: () => T): T { cursor = 0; const old = internals.H; internals.H = dispatcher;
    try { return fn(); } finally { internals.H = old; } } };
}
test("actual dock queued update preserves replacement and rechecks saved authority", () => {
  const tab = createBrowserNewTab("host", "session", "page"), initial = { ...defaultWindowView(), dock: { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] } };
  const driver = hooks(), render = () => driver.render(() => useWorkbenchDock({} as DesktopBridge, initial, "host", { sessionId: "session" }, true, () => {}));
  let dock = render(); const original = captureDockPresentation(dock.presentations, tab.id)!;
  dock.change(createDockState()); dock.browser("right");
  dock.closeBrowser(original, tab, () => true); driver.flush(); dock = render();
  // The original source was retired even when another browser becomes available.
  expect(dock.presentations.instances.get(tab.id)).not.toBe(original.instanceId);
  const fresh = dock.snapshot.tabs.find(value => value.kind === "browser");
  if (!fresh) throw new Error("Fresh browser launcher missing");
  const selected = captureDockPresentation(dock.presentations, fresh.id)!; let allowed = true;
  dock.closeBrowser(selected, fresh, () => allowed); allowed = false; driver.flush(); dock = render();
  expect(dock.snapshot.tabs.some(value => value.id === fresh.id)).toBe(true);
  allowed = true; dock.closeBrowser(selected, fresh, () => allowed); driver.flush(); dock = render(); expect(dock.snapshot.tabs).toEqual([]);
});

test("original focus intent reaches queued removal through native and local close", async () => {
  const local = fixture({ local: true }); await local.start("local-focus"); expect(local.removalFocusIds).toEqual(["local-focus"]);
  const native = fixture(), operation = native.start("native-focus"); native.metadata.resolve(); await tick(); native.save(); await tick(); native.close.resolve(); await tick(); native.save(); await operation;
  expect(native.removalFocusIds).toEqual(["native-focus"]);
});
