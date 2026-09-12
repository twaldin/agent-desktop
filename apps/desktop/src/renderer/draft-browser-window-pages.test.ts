import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCreateRequest, DraftBrowserBridge, DraftBrowserCreationReceipt, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import type { DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView, type WindowViewState } from "../window-state";
import { DraftController } from "./drafts";
import { DraftBrowserWindowOwner } from "./draft-browser-window-owner";
import { browserPreviewSource } from "./browser-preview-source";
import type { DesktopBridge } from "@agent-desktop/shared";
import { DraftBrowserWindowPages } from "./draft-browser-window-pages";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const owner = { version: 1 as const, hostId: "host", reference: { ownerId: "owner", draftId: "new-conversation", draftRevision: 1 } };
const native = (requestId: string): NativeBrowserTabMetadata => ({ name: `desktop-${requestId}`, targetId: `target-${requestId}`, backend: "worker", kindTag: "headless", state: "alive",
  url: "https://example.com/redirect", title: "Verified page", viewport: { width: 800, height: 600 } });

async function fixture(options: { restored?: DraftBrowserPageIntent[]; holdCreate?: Promise<void>; loseCreate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "draft-window-pages-")), store = new WindowStateStore(dir, "primary");
  const events: string[] = [], requests = new Map<string, BrowserCreateRequest>(); let armed = false, draftSaves = 0;
  for (const value of options.restored ?? []) if (value.launcher.request) requests.set(value.launcher.request.requestId, value.launcher.request);
  const drafts = new DraftController(async envelope => {
    if (envelope.command.type !== "draft.put") throw new Error("Unexpected submission"); draftSaves++;
    return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: 1 } };
  }, "host"); drafts.setConnected(true); await drafts.ensureSaved("new-conversation");
  const receipt = (request: BrowserCreateRequest): DraftBrowserCreationReceipt => ({ protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "owner",
    requestId: request.requestId, outcome: "completed", workerPid: 55, tab: native(request.requestId), targetDisposition: "created-page" });
  const record = (operation: string) => { if (armed) events.push(operation); };
  const bridge: DraftBrowserBridge = {
    acquire: async () => { record("owner-acquire"); throw new Error("Unexpected owner acquisition"); },
    retire: async () => { record("retire"); throw new Error("Unexpected retirement"); },
    status: async () => { record("status"); return { protocolVersion: 1, hostId: "host", ownerId: "owner", state: "ready", workerPid: 55, ticket: { controlEpoch: "epoch", observedAt: 1 } }; },
    metadata: async () => { record("metadata"); return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "owner", availability: "running", workerPid: 55, tabs: [...requests.keys()].map(native) }; },
    create: async (ref, request, hostId) => {
      record("create"); expect(ref).toEqual(owner.reference); expect(hostId).toBe("host"); requests.set(request.requestId, structuredClone(request));
      await options.holdCreate; if (options.loseCreate) throw new Error("Lost response"); return receipt(request);
    },
    creationStatus: async (ref, request, hostId) => {
      record("history"); expect(ref).toEqual(owner.reference); expect(hostId).toBe("host"); expect(request).toEqual(requests.get(request.requestId)!);
      return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "owner", requestId: request.requestId, status: "settled", receipt: receipt(request) };
    },
    frame: async () => { record("frame"); throw new Error("Unexpected frame"); },
    control: async () => { record("control"); throw new Error("Unexpected control"); },
  };
  let changes = 0;
  const owners = new DraftBrowserWindowOwner(bridge, [owner], () => { changes++; });
  const pages = new DraftBrowserWindowPages(bridge, owners, options.restored ?? [], () => { changes++; });
  let context = { drafts, draftId: "new-conversation", connected: true, enabled: true };
  const commit = (patch: Partial<typeof context> = {}) => { context = { ...context, ...patch }; owners.commit(context); pages.commit(context); };
  const view = (): WindowViewState => ({ ...defaultWindowView(), route: { hostId: "host", sessionId: null }, draftBrowserOwners: owners.intents, draftBrowserPages: pages.intents });
  const flush = (patch: Partial<WindowViewState> = {}) => {
    const value = { ...view(), ...patch }; owners.committed(value); pages.committed(value);
    expect(store.saveView(value).error).toBeUndefined(); const saved = store.bootstrap().state!;
    owners.saved(saved); pages.saved(saved); return saved;
  };
  cleanup.push(() => { pages.dispose(); owners.dispose(); drafts.dispose(); rmSync(dir, { recursive: true, force: true }); });
  commit(); flush(); await owners.inspect("owner"); armed = true;
  return { pages, owners, drafts, events, requests, bridge, view, flush, commit, changes: () => changes, draftSaves: () => draftSaves,
    restore: () => new WindowStateStore(dir, "primary").bootstrap().state!, readyOwner: () => owners.inspect("owner") };
}

async function start(f: Awaited<ReturnType<typeof fixture>>, id = "page") {
  f.pages.create("owner", id); f.pages.edit(id, "example.com"); f.flush();
  const pending = f.pages.submit(id); await tick(); return { pending };
}

test("live manager preserves the existing route and waits for both request and target saves", async () => {
  const f = await fixture(), running = await start(f);
  expect(f.events).toEqual(["status"]); expect(f.pages.state("page")?.ready).toBeUndefined();
  f.flush({ settingsPage: "git" }); await tick(); expect(f.events).toEqual(["status", "create", "metadata"]);
  expect(f.pages.state("page")?.ready).toBeUndefined(); expect(f.restore().draftBrowserPages![0]!.confirmedTarget).toBeUndefined();
  const saved = f.flush({ settingsPage: "git" }); await running.pending;
  expect(saved.settingsPage).toBe("git"); expect(f.pages.state("page")?.ready?.workerPid).toBe(55);
  expect(f.restore().draftBrowserPages![0]!.confirmedTarget?.workerPid).toBe(55);
  expect(f.pages.intents[0]!.owner).toEqual(owner); expect(f.draftSaves()).toBe(1);
  await f.pages.submit("page"); expect(f.events).toHaveLength(3);
});

test("construction and route renders retain restored unknown without acquisition, inspection or ready publication", async () => {
  const initial = await fixture({ loseCreate: true }), running = await start(initial); initial.flush(); await running.pending;
  const persisted = initial.flush().draftBrowserPages!;
  const f = await fixture({ restored: persisted }); f.commit({ enabled: false, draftId: "session:other" }); f.commit({ enabled: true, draftId: "new-conversation" }); f.flush();
  expect(f.events).toEqual([]); expect(f.pages.state("page")?.ready).toBeUndefined();
  await f.pages.submit("page"); expect(f.events).toEqual([]); expect(f.pages.intents).toEqual(persisted);
  await f.readyOwner(); f.events.length = 0;
  const pending = f.pages.inspect("page"); await tick(); expect(f.events).toEqual(["history", "metadata"]);
  expect(f.pages.state("page")?.ready).toBeUndefined(); f.flush(); await pending;
  expect(f.pages.state("page")?.ready?.tab.name).toBe(`desktop-${persisted[0]!.launcher.request!.requestId}`);
});

test("disconnect-return while create is sent retains exact request and requires explicit recovery", async () => {
  const held = gate(), f = await fixture({ holdCreate: held.promise }), running = await start(f); f.flush(); await tick();
  const original = f.pages.intents[0]!;
  f.commit({ connected: false }); f.commit({ connected: true }); held.resolve(); await running.pending;
  expect(f.events).toEqual(["status", "create"]); expect(f.pages.state("page")?.ready).toBeUndefined();
  expect(f.pages.intents[0]!.launcher.request).toEqual(original.launcher.request); f.flush();
  await f.pages.submit("page"); expect(f.events).toHaveLength(2);
  await f.readyOwner(); const recovery = f.pages.inspect("page"); await tick(); f.flush(); await recovery;
  expect(f.events.filter(value => value === "create")).toHaveLength(1); expect(f.pages.state("page")?.ready).toBeDefined();
});

test("a completed controller becomes usable again only through fresh owner and page inspection after route loss", async () => {
  const f = await fixture(), running = await start(f); f.flush(); await tick(); f.flush(); await running.pending;
  expect(f.pages.state("page")?.ready).toBeDefined();
  f.commit({ enabled: false }); f.commit({ enabled: true }); f.flush();
  expect(f.pages.state("page")?.ready).toBeUndefined(); expect(f.events).toEqual(["status", "create", "metadata"]);
  await f.pages.submit("page"); expect(f.events).toHaveLength(3);
  await f.readyOwner(); const pending = f.pages.inspect("page"); await tick(); f.flush(); await pending;
  expect(f.pages.state("page")?.ready).toBeDefined(); expect(f.events.filter(value => value === "create")).toHaveLength(1);
});

test("Send and actual draft project changes cancel a target publication wait without replay", async () => {
  for (const cause of ["send", "project"] as const) {
    const f = await fixture(), running = await start(f); f.flush(); await tick();
    const original = f.pages.intents[0]!; expect(original.confirmedTarget).toBeDefined();
    if (cause === "send") { f.owners.beforeSubmission(); f.pages.beforeSubmission(); }
    else f.drafts.update("new-conversation", { projectId: "different-project" });
    await running.pending;
    expect(f.pages.state("page")?.ready).toBeUndefined(); expect(f.pages.intents[0]!.launcher.request).toEqual(original.launcher.request);
    expect(f.events).toEqual(["status", "create", "metadata"]);
  }
});

test("actual project loss settles the unsent request wait without requiring another window save", async () => {
  const f = await fixture(), running = await start(f); let settled = false;
  const pending = running.pending.then(() => { settled = true; });
  f.drafts.update("new-conversation", { projectId: "different-project" });
  await tick(); const settledBeforeDisposal = settled;
  f.pages.dispose(); await pending;
  expect(settledBeforeDisposal).toBe(true);
  expect(f.events).toEqual(["status"]);
  expect(f.pages.intents[0]!.launcher.request).toBeDefined();
});

test("dropped or malformed committed page cannot be rehabilitated by a late good save", async () => {
  for (const bad of [[], null]) {
    const f = await fixture(), running = await start(f); f.flush(); await tick(); const original = f.view();
    f.pages.committed(original);
    f.pages.committed({ ...original, draftBrowserPages: bad } as WindowViewState); f.pages.saved(original); await running.pending;
    expect(f.pages.error).toBeDefined(); expect(f.pages.state("page")?.ready).toBeUndefined();
    await expect(f.pages.inspect("page")).rejects.toThrow(); expect(f.events).toEqual(["status", "create", "metadata"]);
    f.flush(); expect(f.pages.error).toBeUndefined(); const recovery = f.pages.inspect("page"); await tick(); f.flush(); await recovery;
    expect(f.pages.state("page")?.ready).toBeDefined(); expect(f.events.filter(value => value === "create")).toHaveLength(1);
  }
});

test("current request rewrite after create admission invalidates even when the exact request returns", async () => {
  const held = gate(), f = await fixture({ holdCreate: held.promise }), running = await start(f); f.flush(); await tick(); const original = f.view();
  const changed = structuredClone(original); changed.draftBrowserPages![0]!.launcher = { status: "idle" };
  f.pages.committed(changed); f.pages.committed(original); f.pages.saved(original); held.resolve(); await running.pending;
  expect(f.pages.state("page")?.ready).toBeUndefined(); expect(f.events).toEqual(["status", "create"]);
  expect(f.pages.intents[0]!.launcher.request).toEqual(original.draftBrowserPages![0]!.launcher.request);
});

test("same-ID draft-controller replacement and foreign owner cannot bind an existing page", async () => {
  const f = await fixture(); f.pages.create("owner", "page"); f.pages.edit("page", "example.com"); f.flush();
  expect(() => f.pages.create("owner", "page")).toThrow("already exists"); expect(() => f.pages.create("foreign", "another")).toThrow("original browser owner");
  const replacement = new DraftController(async () => { throw new Error("Unexpected dispatch"); }, "host"); cleanup.push(() => replacement.dispose());
  f.commit({ drafts: replacement }); await expect(f.pages.submit("page")).rejects.toThrow("original draft controller changed");
  expect(f.events).toEqual([]); expect(f.pages.intents[0]!.owner).toEqual(owner);
});

test("a different confirmed target cannot overwrite retained history even when recovery reports it", async () => {
  const request: BrowserCreateRequest = { requestId: "saved-request", controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.com/" };
  const original: DraftBrowserPageIntent = { version: 1, instanceId: "page", owner, launcher: { status: "unknown", draft: "example.com", request },
    confirmedTarget: { workerPid: 55, tab: { ...native(request.requestId), targetId: "original-target" } } };
  const f = await fixture({ restored: [original] });
  await f.pages.inspect("page");
  expect(f.pages.intents[0]!.confirmedTarget).toEqual(original.confirmedTarget!);
  expect(f.pages.state("page")?.ready).toBeUndefined();
  expect(f.pages.intents[0]!.launcher.request).toEqual(request);
  expect(f.events).toEqual(["history", "metadata"]);
});

test("offline address edits remain local and window disposal cannot close the host browser", async () => {
  const f = await fixture(); f.pages.create("owner", "page"); f.commit({ connected: false }); f.pages.edit("page", "offline.example");
  expect(f.pages.intents[0]!.launcher.draft).toBe("offline.example"); await f.pages.submit("page"); expect(f.events).toEqual([]);
  f.pages.dispose(); const changes = f.changes(); f.pages.commit({ drafts: f.drafts, draftId: "new-conversation", connected: true, enabled: true });
  expect(f.changes()).toBe(changes); await expect(f.pages.inspect("page")).rejects.toThrow(); expect(f.events).toEqual([]);
  expect(f.pages.intents[0]!.launcher.draft).toBe("offline.example");
});


test("preview guards never revive after route loss or a fresh readiness for the same native target", async () => {
  const f = await fixture(), running = await start(f);
  const early = f.pages.attachmentGuard("page");
  f.flush(); await tick(); f.flush(); await running.pending;
  const first = f.pages.attachmentGuard("page");
  expect(early()).toBe(false); expect(first()).toBe(true);
  f.commit({ connected: false }); f.commit({ connected: true }); f.flush();
  expect(first()).toBe(false);
  await f.readyOwner(); const pending = f.pages.inspect("page"); await tick(); f.flush(); await pending;
  expect(f.pages.attachmentGuard("page")()).toBe(true); expect(first()).toBe(false);
  const recovered = f.pages.attachmentGuard("page");
  f.pages.beforeSubmission(); expect(recovered()).toBe(false);
  expect(f.events.filter(value => value === "create")).toHaveLength(1);
});


test("acknowledged page readiness gates the real preview adapter through a sent control and connection return", async () => {
  const f = await fixture(), running = await start(f); f.flush(); await tick(); f.flush(); await running.pending;
  const ready = f.pages.state("page")!.ready!, target = { workerPid: ready.workerPid, name: ready.tab.name, targetId: ready.tab.targetId };
  const source = browserPreviewSource({ draftBrowser: f.bridge } as DesktopBridge, { kind: "draft", hostId: "host", reference: owner.reference,
    target, isCurrent: f.pages.attachmentGuard("page") });
  const observed = await source.metadata(); expect(observed?.availability).toBe("running");
  const held = gate(); let calls = 0;
  f.bridge.control = async (_, request) => { calls++; await held.promise; return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "owner",
    ...target, requestId: request.requestId, outcome: "completed" }; };
  const pending = source.control({ requestId: "human-request", controlEpoch: "epoch", capturedAt: 1, target,
    context: { documentId: "doc", width: 800, height: 600, scrollX: 0, scrollY: 0 }, action: { type: "text", text: "one sent edit" } });
  f.commit({ connected: false }); f.commit({ connected: true }); held.resolve();
  await expect(pending).rejects.toThrow("original draft browser page"); expect(calls).toBe(1);
  await f.readyOwner(); const recovery = f.pages.inspect("page"); await tick(); f.flush(); await recovery;
  expect(f.pages.state("page")?.ready).toBeDefined(); await expect(source.metadata()).rejects.toThrow("original draft browser page");
  expect(calls).toBe(1); expect(f.events.filter(value => value === "create")).toHaveLength(1);
});
