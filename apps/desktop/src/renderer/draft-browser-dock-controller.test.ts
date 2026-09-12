import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftBrowserDockPanel } from "./DraftBrowserDockPanel";
import type { DesktopBridge } from "@agent-desktop/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCreateRequest, DraftBrowserBridge, DraftBrowserCreationReceipt, DraftBrowserOwnerReference, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView, type WindowViewState } from "../window-state";
import { DraftController } from "./drafts";
import { DraftBrowserWindowOwner } from "./draft-browser-window-owner";
import { DraftBrowserWindowPages } from "./draft-browser-window-pages";
import { DraftBrowserDockController } from "./draft-browser-dock-controller";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import { createDockState, insertDockTab } from "./dock-state";
import { reconcileDockPresentations } from "./dock-presentations";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const native = (requestId: string): NativeBrowserTabMetadata => ({ name: `desktop-${requestId}`, targetId: `target-${requestId}`, backend: "worker", kindTag: "headless", state: "alive",
  url: "https://example.com/redirect", title: "Verified page", viewport: { width: 800, height: 600 } });
function fixture(options: { holdAcquire?: Promise<void>; holdCreate?: Promise<void>; loseCreate?: boolean; restored?: WindowViewState } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "draft-browser-dock-controller-")), store = new WindowStateStore(dir, "primary");
  const events: string[] = [], requests = new Map<string, BrowserCreateRequest>(); let draftSaves = 0, changes = 0;
  const drafts = new DraftController(async envelope => {
    if (envelope.command.type !== "draft.put") throw new Error("No prompt submission is allowed"); draftSaves++;
    return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: 1 } };
  }, "host"); drafts.setConnected(true);
  const snapshot = (ref: DraftBrowserOwnerReference) => ({ protocolVersion: 1 as const, hostId: "host", ownerId: ref.ownerId, state: "ready" as const, workerPid: 55, ticket: { controlEpoch: "epoch", observedAt: 1 } });
  const receipt = (ref: DraftBrowserOwnerReference, request: BrowserCreateRequest): DraftBrowserCreationReceipt => ({ protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: ref.ownerId,
    requestId: request.requestId, outcome: "completed", workerPid: 55, tab: native(request.requestId), targetDisposition: "created-page" });
  const bridge: DraftBrowserBridge = {
    acquire: async ref => { events.push("acquire"); await options.holdAcquire; return snapshot(ref); },
    status: async ref => { events.push("status"); return snapshot(ref); },
    metadata: async ref => { events.push("metadata"); return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: ref.ownerId, availability: "running", workerPid: 55, tabs: [...requests.keys()].map(native) }; },
    create: async (ref, request) => { events.push("create"); requests.set(request.requestId, structuredClone(request)); await options.holdCreate;
      if (options.loseCreate) throw new Error("Lost response"); return receipt(ref, request); },
    creationStatus: async (ref, request) => { events.push("history"); expect(request).toEqual(requests.get(request.requestId)!);
      return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: ref.ownerId, requestId: request.requestId, status: "settled", receipt: receipt(ref, request) }; },
    retire: async () => { events.push("retire"); throw new Error("Unexpected retirement"); },
    frame: async () => { events.push("frame"); throw new Error("Unexpected frame"); },
    control: async () => { events.push("control"); throw new Error("Unexpected control"); },
  };
  for (const page of options.restored?.draftBrowserPages ?? []) if (page.launcher.request) requests.set(page.launcher.request.requestId, page.launcher.request);
  const owners = new DraftBrowserWindowOwner(bridge, options.restored?.draftBrowserOwners ?? [], () => { changes++; });
  const pages = new DraftBrowserWindowPages(bridge, owners, options.restored?.draftBrowserPages ?? [], () => { changes++; });
  const tab = options.restored?.dock?.tabs[0] ?? createDraftBrowserDockTab("host", "new-conversation", "page", "example.com");
  let presentations = reconcileDockPresentations(undefined, options.restored?.dock ?? { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") }, "initial");
  let context = { drafts, draftId: "new-conversation", connected: true, enabled: true };
  const controller = new DraftBrowserDockController(tab, presentations.instances.get(tab.id)!, drafts, owners, pages, () => { changes++; }, (state, guard) => {
    if (guard()) presentations = reconcileDockPresentations(presentations, { ...presentations.snapshot, tabs: presentations.snapshot.tabs.map(value => value.id === tab.id ? { ...value, browserNewTab: state } : value) }, "edit");
  });
  const commit = (patch: Partial<typeof context> = {}) => { context = { ...context, ...patch }; owners.commit(context); pages.commit(context); controller.commit({ ...context, presentations }); };
  const view = (): WindowViewState => ({ ...defaultWindowView(), route: { hostId: "host", sessionId: null }, dock: presentations.snapshot,
    draftBrowserOwners: owners.intents, draftBrowserPages: pages.intents });
  const flush = () => { commit(); const value = view(); owners.committed(value); pages.committed(value);
    expect(store.saveView(value).error).toBeUndefined(); const saved = store.bootstrap().state!; owners.saved(saved); pages.saved(saved); return saved; };
  const close = () => { presentations = reconcileDockPresentations(presentations, { tabs: [], state: createDockState() }, "close"); commit(); controller.dispose(); };
  cleanup.push(() => { controller.dispose(); pages.dispose(); owners.dispose(); drafts.dispose(); rmSync(dir, { recursive: true, force: true }); });
  commit(); flush();
  return { controller, owners, pages, bridge, drafts, events, requests, view, flush, close, commit, changes: () => changes, draftSaves: () => draftSaves,
    reopen: () => new WindowStateStore(dir, "primary").bootstrap().state! };
}

test("opening/editing is local; Enter waits for owner, local page, request and target saves", async () => {
  const f = fixture(); expect(f.controller.enabled).toBe(true); expect(f.events).toEqual([]); expect(f.owners.intents).toEqual([]);
  const oldChanges = f.changes(); f.commit(); expect(f.changes()).toBe(oldChanges);
  f.controller.edit("example.com/path"); f.flush(); expect(f.reopen().dock?.tabs[0]?.browserNewTab?.draft).toBe("example.com/path"); expect(f.events).toEqual([]);
  const pending = f.controller.submit(); await tick(); expect(f.events).toEqual([]); expect(f.owners.intents).toHaveLength(1); expect(f.draftSaves()).toBe(1);
  f.flush(); await tick(); expect(f.events).toEqual(["acquire", "metadata"]); expect(f.pages.intents).toHaveLength(1);
  expect(f.reopen().draftBrowserPages ?? []).toEqual([]);
  f.flush(); await tick(); expect(f.events).toEqual(["acquire", "metadata", "status"]); expect(f.controller.ready).toBeUndefined();
  f.flush(); await tick(); expect(f.events).toEqual(["acquire", "metadata", "status", "create", "metadata"]); expect(f.controller.ready).toBeUndefined();
  f.flush(); await pending; expect(f.controller.ready?.workerPid).toBe(55); expect(f.controller.previewGuard()).toBe(true);
  expect(f.reopen().draftBrowserPages?.[0]?.confirmedTarget?.workerPid).toBe(55);
  expect([...f.requests.values()][0]?.initialUrl).toBe("https://example.com/path");
  await f.controller.submit(); expect(f.events.filter(value => value === "create")).toHaveLength(1);
});

test("closing while owner save is pending aborts unsent work and retains allocated identity", async () => {
  const f = fixture(), pending = f.controller.submit(); await tick(); const original = f.owners.intents;
  f.close(); f.flush(); await pending;
  expect(original).toHaveLength(1); expect(f.owners.intents).toEqual(original); expect(f.events).toEqual([]); expect(f.pages.intents).toEqual([]);
});

test("closing a sent acquisition suppresses its late metadata/page continuation", async () => {
  const held = gate(), f = fixture({ holdAcquire: held.promise }), pending = f.controller.submit(); await tick(); f.flush(); await tick();
  const sent = [...f.events], original = f.owners.intents; f.close(); held.resolve(); await pending;
  expect(sent).toEqual(["acquire"]); expect(f.events).toEqual(sent); expect(f.owners.intents).toEqual(original); expect(f.pages.intents).toEqual([]);
});

test("closing during the new local-page save prevents page status/create and keeps the address", async () => {
  const f = fixture(), pending = f.controller.submit(); await tick(); f.flush(); await tick();
  const original = f.pages.intents; f.close(); f.flush(); await pending;
  expect(original[0]?.launcher).toEqual({ status: "idle", draft: "example.com" }); expect(f.pages.intents).toEqual(original);
  expect(f.events).toEqual(["acquire", "metadata"]); expect(f.controller.ready).toBeUndefined();
});

test("sent page loss retains original request; restored explicit check attaches without another acquisition or create", async () => {
  const f = fixture({ loseCreate: true }); const pending = f.controller.submit(); await tick(); f.flush(); await tick(); f.flush(); await tick(); f.flush(); await pending;
  expect(f.controller.state.status).toBe("unknown"); const saved = f.flush(), original = saved.draftBrowserPages![0]!.launcher.request;
  const restored = fixture({ restored: saved }); expect(restored.events).toEqual([]); await restored.controller.submit(); expect(restored.events).toEqual([]);
  const checking = restored.controller.inspect(); await tick(); expect(restored.events).toEqual(["status", "metadata", "history", "metadata"]);
  expect(restored.controller.ready).toBeUndefined(); restored.flush(); await checking;
  expect(restored.controller.ready?.tab.name).toBe(`desktop-${original!.requestId}`); expect(restored.pages.intents[0]?.launcher.request).toEqual(original);
  expect(restored.events).not.toContain("create"); expect(restored.events).not.toContain("acquire");
});

for (const loss of ["connection", "submission", "route"] as const) test(`${loss} during sent create never publishes late page`, async () => {
  const held = gate(), f = fixture({ holdCreate: held.promise }), pending = f.controller.submit(); await tick(); f.flush(); await tick(); f.flush(); await tick(); f.flush(); await tick();
  const original = f.pages.intents[0]?.launcher.request, before = [...f.events];
  if (loss === "connection") { f.commit({ connected: false }); f.commit({ connected: true }); }
  else if (loss === "route") { f.commit({ draftId: "other" }); f.commit({ draftId: "new-conversation" }); }
  else { f.owners.beforeSubmission(); f.pages.beforeSubmission(); f.controller.beforeSubmission(); }
  held.resolve(); await pending;
  expect(before).toContain("create"); expect(f.events).toEqual(before); expect(f.controller.ready).toBeUndefined(); expect(f.pages.intents[0]?.launcher.request).toEqual(original);
});


test("closing the original dock during sent page creation retains uncertainty without a late attachment", async () => {
  const held = gate(), f = fixture({ holdCreate: held.promise }), pending = f.controller.submit(); await tick(); f.flush(); await tick(); f.flush(); await tick(); f.flush(); await tick();
  const original = f.pages.intents[0]!, sent = [...f.events]; f.close(); held.resolve(); await pending; f.flush();
  expect(sent).toContain("create"); expect(f.events).toEqual(sent); expect(f.pages.intents[0]?.launcher.request).toEqual(original.launcher.request);
  expect(f.pages.intents[0]?.confirmedTarget).toBeUndefined(); expect(f.controller.ready).toBeUndefined();
  expect(f.reopen().dock?.tabs).toEqual([]); expect(f.reopen().draftBrowserPages?.[0]?.launcher.request).toEqual(original.launcher.request);
});


test("shared initial browser panel renders the original address without bridge work", () => {
  const f = fixture();
  const html = renderToStaticMarkup(createElement(DraftBrowserDockPanel, { bridge: { draftBrowser: f.bridge } as DesktopBridge,
    controller: f.controller, active: true, onMetadata: () => { throw new Error("Unexpected render metadata"); } }));
  expect(html).toContain('aria-label="Browser preview"'); expect(html).toContain('value="example.com"');
  expect(html).toContain('data-browser-address-owner="[&quot;draft&quot;,&quot;host&quot;,&quot;new-conversation&quot;]"');
  expect(html).toContain("Start browsing"); expect(f.events).toEqual([]); expect(f.draftSaves()).toBe(0);
});

test("multiple saved owners require an explicit choice and inspection without allocating another owner", async () => {
  const owners = ["first", "second"].map(ownerId => ({ version: 1 as const, hostId: "host", reference: { ownerId, draftId: "new-conversation", draftRevision: 1 } }));
  const f = fixture({ restored: { ...defaultWindowView(), draftBrowserOwners: owners } });
  await f.controller.submit(); expect(f.events).toEqual([]); expect(f.controller.state.message).toContain("Choose");
  f.controller.chooseOwner("second"); await f.controller.inspect(); expect(f.events).toEqual(["status", "metadata"]);
  expect(f.pages.intents).toEqual([]); expect(f.owners.intents).toEqual(owners);
  const pending = f.controller.submit(); await tick(); f.flush(); await tick(); f.flush(); await tick(); f.flush(); await pending;
  expect(f.controller.ready?.intent.owner.reference.ownerId).toBe("second"); expect(f.events).not.toContain("acquire");
  expect(f.draftSaves()).toBe(0); expect(f.owners.intents).toEqual(owners);
});
