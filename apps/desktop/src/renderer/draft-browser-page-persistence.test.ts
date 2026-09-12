import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftBrowserBridge, DraftBrowserCreationReceipt, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { WindowStateStore as CurrentStore } from "../main/window-state";
import { defaultWindowView, parseWindowView, type WindowViewState } from "../window-state";
import { createDraftBrowserPageIntent, parseDraftBrowserPageIntents, type DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { DraftBrowserPageController } from "./draft-browser-page";
import { DraftBrowserPageCheckpoint } from "./draft-browser-page-checkpoint";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";
const SelectedStore: typeof CurrentStore = process.env.AGENT_DESKTOP_DRAFT_PAGE_WINDOW_STORE
  ? (await import(process.env.AGENT_DESKTOP_DRAFT_PAGE_WINDOW_STORE)).WindowStateStore : CurrentStore;
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "draft-page-persistence-")); directories.push(path); return path; };
const owner = { version: 1 as const, hostId: "host", reference: { ownerId: "owner", draftId: "new-conversation", draftRevision: 2 } };
const page = (instanceId = "page"): DraftBrowserPageIntent => ({ ...createDraftBrowserPageIntent(owner, instanceId), launcher: { status: "pending", draft: "localhost:3000/test", request: { requestId: `request-${instanceId}`, controlEpoch: "epoch", observedAt: 3, initialUrl: "http://localhost:3000/test" } } });
const view = (pages = [page()]): WindowViewState => ({ ...defaultWindowView(), draftBrowserOwners: [owner], draftBrowserPages: pages });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("persist draft page request and reopen as unknown while preserving exact owner, route and sibling address", () => {
  const profile = temporary(), store = new SelectedStore(profile, "primary");
  const sibling = createBrowserNewTab("other", "conversation", "sibling"); sibling.browserNewTab = { status: "idle", draft: "keep this other address" };
  const value = { ...view(), route: { hostId: "other", sessionId: "conversation" }, dock: { tabs: [sibling], state: insertDockTab(createDockState(), sibling, "bottom") } };
  expect(store.saveView(value)).toEqual({});
  const reopened = new SelectedStore(profile, "primary").bootstrap();
  expect(reopened.state?.draftBrowserPages).toEqual(parseDraftBrowserPageIntents(value.draftBrowserPages, [owner]));
  expect(reopened.state?.draftBrowserPages?.[0]?.launcher).toMatchObject({ status: "unknown", draft: page().launcher.draft, request: page().launcher.request });
  expect(reopened.state?.draftBrowserOwners).toEqual([owner]); expect(reopened.state?.route).toEqual(value.route);
  expect(reopened.state?.dock?.tabs[0]?.browserNewTab?.draft).toBe("keep this other address"); expect(reopened.error).toBeUndefined();
  expect(new SelectedStore(profile, "secondary").bootstrap().state).toBeUndefined();
});

test("oversized valid page lists cannot acknowledge an unreadable window document or replace last good state", () => {
  const profile = temporary(), store = new SelectedStore(profile, "primary"); expect(store.saveView(view())).toEqual({}); const before = readFileSync(store.file, "utf8");
  const large = view(Array.from({ length: 100 }, (_, i) => ({ ...createDraftBrowserPageIntent(owner, `page-${i}`), launcher: { status: "idle", draft: "x".repeat(8192) } })));
  expect(parseWindowView(large)?.draftBrowserPages).toHaveLength(100);
  expect(store.saveView(large).error).toContain("could not be saved");
  expect(readFileSync(store.file, "utf8")).toBe(before);
  expect(store.bootstrap().state?.draftBrowserPages).toHaveLength(1); expect(new SelectedStore(profile, "primary").bootstrap().state?.draftBrowserPages).toHaveLength(1);
  expect(store.saveView({ ...view(), sidebarOpen: false })).toEqual({}); expect(store.bootstrap().error).toBeUndefined();
});

test("invalid, duplicate, conflicting-parent or duplicate-request pages reject saves without dropping prior knowledge", () => {
  const store = new CurrentStore(temporary(), "primary"); expect(store.saveView(view())).toEqual({}); const before = readFileSync(store.file, "utf8");
  const second = page("second"); second.launcher.request = { ...page().launcher.request! };
  for (const pages of [null, {}, [null], [page(), page()], [page(), second], [{ ...page(), token: "not permitted" }],
    [{ ...page(), owner: { ...owner, reference: { ...owner.reference, draftRevision: 3 } } }], [{ ...page(), owner: { ...owner, hostId: "foreign" } }],
    Array.from({ length: 101 }, (_, i) => createDraftBrowserPageIntent(owner, `p-${i}`))]) {
    expect(parseWindowView({ ...view(), draftBrowserPages: pages })).toBeUndefined();
    expect(store.saveView({ ...view(), draftBrowserPages: pages }).error).toContain("invalid"); expect(readFileSync(store.file, "utf8")).toBe(before);
  }
  expect(parseWindowView({ ...view(), draftBrowserOwners: [] })).toBeUndefined();
  const other = { ...page(), owner: { ...owner, hostId: "other" } };
  expect(parseDraftBrowserPageIntents([page(), other], [owner, other.owner])).toHaveLength(2);
});

test("legacy shape is unchanged and page owner/request/draft snapshots are independent", () => {
  const legacy = defaultWindowView(); expect(parseWindowView(legacy)).toEqual(legacy);
  const input = view(), parsed = parseWindowView(input)!;
  input.draftBrowserPages![0]!.owner.reference.draftRevision = 99; input.draftBrowserPages![0]!.launcher.request!.initialUrl = "https://wrong.invalid";
  expect(parsed.draftBrowserPages![0]!.owner.reference.draftRevision).toBe(2); expect(parsed.draftBrowserPages![0]!.launcher.request!.initialUrl).toBe(page().launcher.request!.initialUrl);
  parsed.draftBrowserPages![0]!.launcher.draft = "parsed only"; expect(input.draftBrowserPages![0]!.launcher.draft).toBe("localhost:3000/test");
});

test("checkpoint requires this window's committed page and exact saved original request", async () => {
  const cp = new DraftBrowserPageCheckpoint(), other = new DraftBrowserPageCheckpoint(), abort = new AbortController();
  const idle = createDraftBrowserPageIntent(owner, "page"); cp.committed(view([idle])); let admitted = false;
  const pending = cp.wait(page(), abort.signal).then(() => { admitted = true; });
  try {
    other.committed(view()); other.saved(view()); await tick(); expect(admitted).toBe(false);
    cp.saved(view()); await tick(); expect(admitted).toBe(false);
    cp.committed({ ...view(), route: { hostId: "newhost", sessionId: "newsession" } }); await pending; expect(admitted).toBe(true);
  } finally { abort.abort(); cp.dispose(); other.dispose(); await pending.catch(() => {}); }
});

test("removal, owner switch, request rewrite and clearing an appeared request cancel without later revival", async () => {
  for (const changed of [view([]), { ...view(), draftBrowserOwners: [] }, view([{ ...page(), launcher: { status: "pending", draft: "other", request: page().launcher.request } }]),
    view([{ ...page(), launcher: { ...page().launcher, request: { ...page().launcher.request!, requestId: "replacement" } } }]), view([createDraftBrowserPageIntent(owner, "page")])]) {
    const cp = new DraftBrowserPageCheckpoint(), abort = new AbortController(); cp.committed(view());
    const result = cp.wait(page(), abort.signal).then(() => "admitted", cause => String(cause));
    cp.committed(changed); cp.committed(view()); cp.saved(view());
    expect(await result).not.toBe("admitted"); cp.dispose();
  }
});

test("dropped or corrupt saves and failed acknowledgements never reuse an earlier success", async () => {
  for (const failure of ["drop", "corrupt", "error", "abort", "dispose"] as const) {
    const cp = new DraftBrowserPageCheckpoint(), abort = new AbortController(); cp.committed(view());
    const result = cp.wait(page(), abort.signal).then(() => "admitted", cause => String(cause));
    if (failure === "drop") cp.saved(view([])); else if (failure === "corrupt") cp.saved({ ...view(), draftBrowserPages: [null] } as unknown as WindowViewState);
    else if (failure === "error") cp.failed("Disk failed"); else if (failure === "abort") abort.abort(); else cp.dispose();
    expect(await result).not.toBe("admitted"); cp.dispose();
  }
  const cp = new DraftBrowserPageCheckpoint(); cp.committed(view()); cp.saved(view()); cp.failed("Later disk failure");
  const abort = new AbortController(); let admitted = false; const pending = cp.wait(page(), abort.signal).then(() => { admitted = true; });
  try { await tick(); expect(admitted).toBe(false); cp.saved(view()); await pending; expect(admitted).toBe(true); }
  finally { abort.abort(); cp.dispose(); await pending.catch(() => {}); }
  await expect(cp.wait(page(), new AbortController().signal)).rejects.toThrow("closed");
});

test("actual page controller waits for real Store acknowledgement and reopened request only queries its journal", async () => {
  const profile = temporary(), store = new CurrentStore(profile, "primary"), cp = new DraftBrowserPageCheckpoint();
  let latest = view([createDraftBrowserPageIntent(owner, "page")]); cp.committed(latest);
  let received: DraftBrowserCreationReceipt | undefined; const calls: string[] = [];
  const bridge: Pick<DraftBrowserBridge, "status" | "create" | "creationStatus" | "metadata"> = {
    status: async () => { calls.push("status"); return { protocolVersion: 1, hostId: "host", ownerId: "owner", state: "ready", workerPid: 30, ticket: { controlEpoch: "epoch", observedAt: 3 } }; },
    create: async (ref, request, hostId) => {
      calls.push("create"); const tab: NativeBrowserTabMetadata = { name: `desktop-${request.requestId}`, targetId: "native-target", backend: "worker", kindTag: "headless", state: "alive", url: request.initialUrl!, viewport: { width: 500, height: 800 } };
      return received = { protocolVersion: 1, ownerKind: "draft", hostId, ownerId: ref.ownerId, requestId: request.requestId, outcome: "completed", workerPid: 30, targetDisposition: "created-page", tab };
    },
    creationStatus: async (ref, request, hostId) => { calls.push("history"); if (!received) throw new Error("No original receipt"); return { protocolVersion: 1, ownerKind: "draft", hostId, ownerId: ref.ownerId, requestId: request.requestId, status: "settled", receipt: received }; },
    metadata: async () => { calls.push("metadata"); if (!received || received.outcome !== "completed") throw new Error("No original target"); return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "owner", availability: "running", workerPid: 30, tabs: [received.tab] }; },
  };
  let publications = 0;
  const controller = new DraftBrowserPageController(bridge, latest.draftBrowserPages![0]!, intent => { latest = { ...latest, draftBrowserPages: [intent] }; cp.committed(latest); },
    (intent, signal) => cp.wait(intent, signal), () => () => true, async (_, guard) => { if (!guard()) return false; publications++; return true; });
  controller.observe({ connected: true, enabled: true }); controller.edit("localhost:3000/test"); const running = controller.submit(); await tick();
  expect(calls).toEqual(["status"]); latest = { ...latest, route: { hostId: "later", sessionId: "selected" }, settingsPage: "git" };
  expect(store.saveView(latest)).toEqual({}); cp.saved(store.bootstrap().state!); await running;
  expect(calls).toEqual(["status", "create", "metadata"]); expect(publications).toBe(1);
  const reopened = new CurrentStore(profile, "primary").bootstrap().state!;
  const recovered = new DraftBrowserPageController(bridge, reopened.draftBrowserPages![0]!, () => {}, async () => { throw new Error("Recovery cannot save/recreate"); }, () => () => true, async (_, guard) => guard());
  recovered.observe({ connected: true, enabled: true }); expect(recovered.state.status).toBe("unknown"); await recovered.submit(); expect(calls).toHaveLength(3); await recovered.inspect();
  expect(calls).toEqual(["status", "create", "metadata", "history", "metadata"]); expect(reopened.route.sessionId).toBe("selected"); expect(reopened.settingsPage).toBe("git");
  controller.dispose(); recovered.dispose(); cp.dispose();
});
