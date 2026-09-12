import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCreateRequest, DraftBrowserBridge, DraftBrowserCreationReceipt, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { parseDraftBrowserPageIntent, type DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView, parseWindowView, type WindowViewState } from "../window-state";
import { DraftBrowserPageCheckpoint } from "./draft-browser-page-checkpoint";
import { DraftBrowserPageController } from "./draft-browser-page";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const owner = { version: 1 as const, hostId: "host", reference: { ownerId: "owner", draftId: "new-conversation", draftRevision: 1 } };
const request: BrowserCreateRequest = { requestId: "request", controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.com/" };
const tab = (id = request.requestId): NativeBrowserTabMetadata => ({ name: `desktop-${id}`, targetId: "native-target", backend: "worker", kindTag: "headless", state: "alive",
  url: "https://example.com/redirect", title: "Observed title", viewport: { width: 800, height: 600 } });
const page = (): DraftBrowserPageIntent => ({ version: 1, instanceId: "page", owner, launcher: { status: "pending", draft: "example.com", request } });
const confirmed = (): DraftBrowserPageIntent => parseDraftBrowserPageIntent({ ...page(), confirmedTarget: { workerPid: 50, tab: tab() } });
const view = (value: DraftBrowserPageIntent): WindowViewState => ({ ...defaultWindowView(), draftBrowserOwners: [owner], draftBrowserPages: [value] });
function checkpoint(value = page()) {
  const cp = new DraftBrowserPageCheckpoint(); cleanup.push(() => cp.dispose());
  cp.committed(view(value)); cp.saved(view(value)); return cp;
}
function store() {
  const dir = mkdtempSync(join(tmpdir(), "draft-target-persistence-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const location = dir; return { location, value: new WindowStateStore(location, "primary") };
}

test("confirmed original target saves and reopens as history beside its unknown original request", () => {
  const disk = store(), target = confirmed();
  const input = { ...view(target), route: { hostId: "other", sessionId: "newer-route" }, settingsPage: "git" as const };
  expect(disk.value.saveView(input).error).toBeUndefined();
  target.confirmedTarget!.tab.url = "https://caller-mutated.example/";
  const restored = new WindowStateStore(disk.location, "primary").bootstrap().state!;
  expect(restored.draftBrowserPages).toEqual([confirmed()]);
  expect(restored.route).toEqual(input.route); expect(restored.settingsPage).toBe("git");
  expect(restored.draftBrowserPages![0]!.launcher.status).toBe("unknown");
  expect(restored.draftBrowserPages![0]!.launcher.request).toEqual(request);
  expect(restored.draftBrowserPages![0]!.confirmedTarget!.tab.url).toBe("https://example.com/redirect");
  const again = parseDraftBrowserPageIntent(restored.draftBrowserPages![0]); again.confirmedTarget!.tab.viewport.width = 1;
  expect(restored.draftBrowserPages![0]!.confirmedTarget!.tab.viewport.width).toBe(800);
});

test("unbound or malformed target rejects the whole view and preserves the last acknowledged file", () => {
  const disk = store(); disk.value.saveView(view(page()));
  const baseline = disk.value.bootstrap().state!;
  const good = confirmed();
  const invalid: unknown[] = [
    { ...good, launcher: { status: "idle" } },
    { ...good, launcher: { ...good.launcher, status: "rejected" } },
    ...[0, -1, 1.5, Infinity].map(workerPid => ({ ...good, confirmedTarget: { ...good.confirmedTarget, workerPid } })),
    ...[{ name: "another-request" }, { targetId: "" }, { state: "dead" }, { backend: "invented" }, { viewport: { width: 0, height: 1 } }].map(change => ({ ...good, confirmedTarget: { workerPid: 50, tab: { ...tab(), ...change } } })),
    { ...good, confirmedTarget: { ...good.confirmedTarget, debuggerEndpoint: "do-not-persist" } },
  ];
  for (const value of invalid) {
    const invalidView = { ...view(good), draftBrowserPages: [value] };
    expect(parseWindowView(invalidView)).toBeUndefined();
    expect(disk.value.saveView(invalidView as WindowViewState).error).toBeDefined();
    expect(new WindowStateStore(disk.location, "primary").bootstrap().state!).toEqual(baseline);
  }
  expect(parseDraftBrowserPageIntent(page())).toMatchObject({ ...page(), launcher: { ...page().launcher, status: "unknown" } });
});

test("target publication waits for its full committed AND saved projection in this window", async () => {
  const cp = checkpoint(), target = confirmed(), abort = new AbortController();
  let done = false; const pending = cp.waitTarget(target, abort.signal).then(() => { done = true; });
  target.confirmedTarget!.tab.title = "Caller changed";
  cp.saved(view(confirmed())); await tick(); expect(done).toBe(false);
  const other = checkpoint(); other.committed(view(confirmed())); other.saved(view(confirmed())); await tick(); expect(done).toBe(false);
  cp.committed(view(confirmed())); await pending; expect(done).toBe(true);

  const next = checkpoint(); let nextDone = false;
  const waiting = next.waitTarget(confirmed(), new AbortController().signal).then(() => { nextDone = true; });
  next.committed(view(confirmed())); await tick(); expect(nextDone).toBe(false);
  const disk = store(), saved = disk.value.saveView(view(confirmed())); expect(saved.error).toBeUndefined();
  next.saved(disk.value.bootstrap().state!); await waiting; expect(nextDone).toBe(true);
});

test("target publication rejects dropped, rewritten, foreign or malformed current projection without revival", async () => {
  const good = confirmed();
  const badViews: WindowViewState[] = [
    { ...view(good), draftBrowserPages: [] },
    { ...view(good), draftBrowserOwners: [] }, view(page()),
    view({ ...good, launcher: { ...good.launcher, draft: "different" } }),
    view({ ...good, confirmedTarget: { ...good.confirmedTarget!, workerPid: 51 } }),
    view({ ...good, confirmedTarget: { workerPid: 50, tab: { ...tab(), targetId: "replacement" } } }),
    view({ ...good, confirmedTarget: { workerPid: 50, tab: { ...tab(), title: "changed after commit" } } }),
    { ...view(good), draftBrowserPages: [{ ...good, version: 2 } as unknown as DraftBrowserPageIntent] },
  ];
  for (const bad of badViews) {
    const cp = checkpoint(); const pending = cp.waitTarget(good, new AbortController().signal).then(() => "accepted", () => "rejected");
    cp.committed(view(good)); cp.committed(bad); cp.saved(view(good)); cp.committed(view(good));
    expect(await pending).toBe("rejected");
  }
});

test("metadata refresh permits the same target before commit but requires acknowledgement of the fresh metadata", async () => {
  const old = confirmed(), fresh = confirmed(); fresh.confirmedTarget!.tab.url = "https://example.com/new"; fresh.confirmedTarget!.tab.title = "New title";
  const cp = checkpoint(old); let done = false;
  const pending = cp.waitTarget(fresh, new AbortController().signal).then(() => { done = true; });
  cp.committed(view(old)); cp.saved(view(old)); await tick(); expect(done).toBe(false);
  cp.committed(view(fresh)); await tick(); expect(done).toBe(false);
  cp.saved(view(fresh)); await pending; expect(done).toBe(true);
  const stale = checkpoint(old); const rejected = stale.waitTarget(fresh, new AbortController().signal).then(() => "accepted", () => "rejected");
  stale.committed(view(fresh)); stale.saved(view(old)); expect(await rejected).toBe("rejected");
});

test("existing target identity cannot be rebound through a new publication wait", async () => {
  for (const change of [
    { workerPid: 51, tab: tab() },
    { workerPid: 50, tab: { ...tab(), targetId: "another-target" } },
    { workerPid: 50, tab: { ...tab(), backend: "cmux" as const, kindTag: "cmux" as const } },
  ]) {
    const cp = checkpoint(confirmed());
    await expect(cp.waitTarget({ ...confirmed(), confirmedTarget: change }, new AbortController().signal)).rejects.toThrow("different draft browser target");
  }
});

test("publication cancellation, failure and disposal retain existing request acknowledgement boundaries", async () => {
  for (const mode of ["abort", "failed", "dispose", "dropped-save"] as const) {
    const cp = checkpoint(), abort = new AbortController(), pending = cp.waitTarget(confirmed(), abort.signal).then(() => "accepted", () => "rejected");
    cp.committed(view(confirmed()));
    if (mode === "abort") abort.abort(); else if (mode === "failed") cp.failed("Disk failed"); else if (mode === "dispose") cp.dispose(); else cp.saved(view(page()));
    cp.saved(view(confirmed())); expect(await pending).toBe("rejected");
  }
  const cp = checkpoint(confirmed()); cp.failed("Disk failed"); let done = false;
  const pending = cp.waitTarget(confirmed(), new AbortController().signal).then(() => { done = true; });
  await tick(); expect(done).toBe(false); cp.saved(view(confirmed())); await pending; expect(done).toBe(true);
  const noRequest = { ...page(), launcher: { status: "idle" as const } };
  await expect(checkpoint(noRequest).waitTarget(confirmed(), new AbortController().signal)).rejects.toThrow("request");
  await expect(checkpoint().waitTarget(page(), new AbortController().signal)).rejects.toThrow("confirmed");
});

test("actual page controller waits for request save then target save, and restored history never repeats create", async () => {
  const disk = store(), cp = new DraftBrowserPageCheckpoint(); cleanup.push(() => cp.dispose());
  let projection: DraftBrowserPageIntent = { ...page(), launcher: { status: "idle", draft: "example.com" } };
  const events: string[] = [], published: string[] = [];
  let sent: BrowserCreateRequest | undefined;
  const receipt = (): DraftBrowserCreationReceipt => ({ protocolVersion: 1, ownerKind: "draft", hostId: owner.hostId, ownerId: owner.reference.ownerId,
    requestId: sent!.requestId, outcome: "completed", workerPid: 50, tab: tab(sent!.requestId), targetDisposition: "created-page" });
  const bridge: Pick<DraftBrowserBridge, "status" | "create" | "creationStatus" | "metadata"> = {
    status: async () => { events.push("status"); return { protocolVersion: 1, hostId: "host", ownerId: "owner", state: "ready", workerPid: 50, ticket: { controlEpoch: "epoch", observedAt: 1 } }; },
    create: async (_owner, request) => { events.push("create"); sent = request; return receipt(); },
    creationStatus: async (_owner, request) => { events.push("history"); expect(request).toEqual(sent!); return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "owner", requestId: request.requestId, status: "settled", receipt: receipt() }; },
    metadata: async () => { events.push("metadata"); return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "owner", availability: "running", workerPid: 50, tabs: [tab(sent!.requestId)] }; },
  };
  const makeController = (restored: DraftBrowserPageIntent) => {
    const controller = new DraftBrowserPageController(bridge, restored, value => { projection = value; },
      (value, signal) => cp.wait(value, signal), () => () => true,
      async (result, guard) => {
        projection = parseDraftBrowserPageIntent({ ...result.intent, confirmedTarget: { workerPid: result.workerPid, tab: result.tab } });
        await cp.waitTarget(projection, new AbortController().signal);
        if (!guard()) return false;
        published.push(result.tab.targetId); return true;
      });
    controller.observe({ connected: true, enabled: true }); cleanup.push(() => controller.dispose()); return controller;
  };
  const save = () => { cp.committed(view(projection)); const result = disk.value.saveView(view(projection)); expect(result.error).toBeUndefined(); cp.saved(disk.value.bootstrap().state!); };
  save(); const controller = makeController(projection), running = controller.submit(); await tick();
  expect(events).toEqual(["status"]); save(); await tick();
  expect(events).toEqual(["status", "create", "metadata"]); expect(published).toEqual([]);
  expect(new WindowStateStore(disk.location, "primary").bootstrap().state!.draftBrowserPages![0]!.confirmedTarget).toBeUndefined();
  save(); await running; expect(published).toEqual(["native-target"]);
  const reopened = new WindowStateStore(disk.location, "primary").bootstrap().state!.draftBrowserPages![0]!;
  expect(reopened.confirmedTarget?.workerPid).toBe(50); expect(reopened.launcher.request).toEqual(sent!);
  const restored = makeController(reopened); await restored.submit(); expect(events).toHaveLength(3);
  const inspection = restored.inspect(); await tick();
  // The unchanged exact target is already committed and saved in this window;
  // the fresh journal and metadata checks still precede publication.
  await inspection; expect(events).toEqual(["status", "create", "metadata", "history", "metadata"]);
  expect(published).toEqual(["native-target", "native-target"]);
});
