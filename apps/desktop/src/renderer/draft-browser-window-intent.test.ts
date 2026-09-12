import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDraftBrowserWindowIntent, parseDraftBrowserWindowIntents, type DraftBrowserWindowIntent } from "../draft-browser-window-intent";
import { defaultWindowView, parseWindowView, type WindowViewState } from "../window-state";
import { WindowStateStore as CurrentStore } from "../main/window-state";
import { DraftBrowserOwnerCheckpoint } from "./draft-browser-owner-checkpoint";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";

const WindowStore: typeof CurrentStore = process.env.AGENT_DESKTOP_DRAFT_OWNER_WINDOW_STORE
  ? (await import(process.env.AGENT_DESKTOP_DRAFT_OWNER_WINDOW_STORE)).WindowStateStore : CurrentStore;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "draft-browser-window-")); directories.push(path); return path; };
const intent = (): DraftBrowserWindowIntent => ({ version: 1, hostId: "owner-host", reference: { ownerId: "browser-owner", draftId: "new-conversation", draftRevision: 3 } });
const view = (owners: DraftBrowserWindowIntent[] = [intent()]): WindowViewState => ({ ...defaultWindowView(), draftBrowserOwners: owners });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

// Selected actual old/current Store+parser pair uses this same final test.
test("persist and reopen draft browser recovery identity without dropping newer route or sibling address", () => {
  const root = temporary(), store = new WindowStore(root, "primary"), value = view();
  const sibling = createBrowserNewTab("other-host", "other-session", "other-browser");
  sibling.browserNewTab = { status: "idle", draft: "unsubmitted sibling address" };
  value.route = { hostId: "new-current-host", sessionId: "selected-session" };
  value.sidebarOpen = false;
  value.dock = { tabs: [sibling], state: insertDockTab(createDockState(), sibling, "bottom") };
  expect(store.saveView(value)).toEqual({});
  const restored = new WindowStore(root, "primary").bootstrap();
  expect(restored.state?.draftBrowserOwners).toEqual([intent()]);
  expect(restored.error).toBeUndefined();
  expect(restored.state?.route).toEqual(value.route);
  expect(restored.state?.sidebarOpen).toBe(false);
  expect(restored.state?.dock?.tabs[0]?.browserNewTab?.draft).toBe("unsubmitted sibling address");
  expect(new WindowStore(root, "second").bootstrap().state).toBeUndefined();
  const bytes = readFileSync(store.file, "utf8");
  expect(JSON.parse(bytes).view.draftBrowserOwners).toEqual([intent()]);
});

test("legacy views stay unchanged and owner references are captured in both directions", () => {
  const old = defaultWindowView(); expect(parseWindowView(old)).toEqual(old);
  const value = intent(), saved = parseDraftBrowserWindowIntent(value);
  value.reference.draftRevision = 9; expect(saved.reference.draftRevision).toBe(3);
  saved.reference.ownerId = "changed-copy"; expect(value.reference.ownerId).toBe("browser-owner");
  const raw = view(), parsed = parseWindowView(raw)!;
  raw.draftBrowserOwners![0]!.reference.draftId = "later-draft";
  expect(parsed.draftBrowserOwners![0]!.reference.draftId).toBe("new-conversation");
  parsed.draftBrowserOwners![0]!.hostId = "other-copy"; expect(raw.draftBrowserOwners![0]!.hostId).toBe("owner-host");
});

test("invalid, duplicate or over-capacity intents reject the save instead of dropping existing knowledge", () => {
  const root = temporary(), store = new CurrentStore(root, "primary"); expect(store.saveView(view())).toEqual({});
  const before = readFileSync(store.file, "utf8");
  for (const bad of [null, {}, [null], [{ ...intent(), version: 2 }], [{ ...intent(), hostId: "bad\0host" }],
    [{ ...intent(), cwd: "/host/path" }], [{ ...intent(), token: "not-permitted" }],
    [{ ...intent(), reference: { ...intent().reference, workerPid: 9 } }],
    [{ ...intent(), reference: { ...intent().reference, draftRevision: 0 } }], [intent(), intent()],
    [intent(), { ...intent(), reference: { ...intent().reference, draftId: "foreign-draft" } }],
    Array.from({ length: 65 }, (_, i) => ({ ...intent(), reference: { ...intent().reference, ownerId: `owner-${i}` } }))]) {
    expect(parseWindowView({ ...view(), draftBrowserOwners: bad })).toBeUndefined();
    expect(store.saveView({ ...view(), draftBrowserOwners: bad }).error).toContain("invalid");
    expect(readFileSync(store.file, "utf8")).toBe(before);
  }
  const separate = [intent(), { ...intent(), hostId: "other-host" }];
  expect(parseDraftBrowserWindowIntents(separate)).toEqual(separate);
  expect(store.bootstrap().state?.draftBrowserOwners).toEqual([intent()]);
});

test("checkpoint waits for committed AND acknowledged exact intent, preserving unrelated newer view", async () => {
  const cp = new DraftBrowserOwnerCheckpoint(), cancellation = new AbortController();
  cp.committed(view([])); let acknowledged = false;
  const running = cp.wait(intent(), cancellation.signal).then(() => { acknowledged = true; });
  try {
    cp.saved(view()); await tick(); expect(acknowledged).toBe(false);
    cp.committed(view([])); await tick(); expect(acknowledged).toBe(false);
    const latest = { ...view(), route: { hostId: "new-current-host", sessionId: "new-session" }, sidebarOpen: false };
    cp.committed(latest); await running; expect(acknowledged).toBe(true);
    // The earlier exact acknowledgement remains sufficient: route is not owner authority.
    expect(latest.route.sessionId).toBe("new-session"); expect(latest.sidebarOpen).toBe(false);
  } finally { cancellation.abort(); cp.dispose(); await running.catch(() => {}); }
});

test("current intent without save never admits, and another window cannot acknowledge it", async () => {
  const cp = new DraftBrowserOwnerCheckpoint(), other = new DraftBrowserOwnerCheckpoint(), cancellation = new AbortController();
  cp.committed(view()); let acknowledged = false;
  const running = cp.wait(intent(), cancellation.signal).then(() => { acknowledged = true; });
  try {
    other.committed(view()); other.saved(view()); await tick(); expect(acknowledged).toBe(false);
    const root = temporary(), store = new CurrentStore(root, "primary"); expect(store.saveView(view())).toEqual({});
    const restored = new CurrentStore(root, "primary").bootstrap().state!;
    await tick(); expect(acknowledged).toBe(false);
    cp.saved(restored); await running; expect(acknowledged).toBe(true);
  } finally { cancellation.abort(); cp.dispose(); other.dispose(); await running.catch(() => {}); }
});

test("owner replacement, removal and changed revision cancel the old wait without later revival", async () => {
  for (const next of [view([]), view([{ ...intent(), hostId: "other-host" }]),
    view([{ ...intent(), reference: { ...intent().reference, ownerId: "new-owner" } }]),
    view([{ ...intent(), reference: { ...intent().reference, draftRevision: 4 } }]),
    view([{ ...intent(), reference: { ...intent().reference, draftId: "changed-draft" } }])]) {
    const cp = new DraftBrowserOwnerCheckpoint(), cancellation = new AbortController(); cp.committed(view());
    const result = cp.wait(intent(), cancellation.signal).then(() => "acknowledged", error => (error as Error).message);
    cp.committed(next); expect(await result).toContain("changed");
    cp.committed(view()); cp.saved(view()); expect(await result).toContain("changed"); cp.dispose();
  }
});

test("projection drop, malformed acknowledgement, save failure, abort and disposal fail closed", async () => {
  for (const cause of ["drop", "malformed", "failed", "abort", "dispose"]) {
    const cp = new DraftBrowserOwnerCheckpoint(), cancellation = new AbortController(); cp.committed(view());
    const result = cp.wait(intent(), cancellation.signal).then(() => "acknowledged", () => "rejected");
    if (cause === "drop") cp.saved(view([]));
    if (cause === "malformed") cp.saved({ ...view(), draftBrowserOwners: [{}] } as WindowViewState);
    if (cause === "failed") cp.failed("controlled save error");
    if (cause === "abort") cancellation.abort();
    if (cause === "dispose") cp.dispose();
    expect(await result).toBe("rejected"); cp.committed(view()); cp.saved(view()); expect(await result).toBe("rejected"); cp.dispose();
  }
  const uncommitted = new DraftBrowserOwnerCheckpoint(); await expect(uncommitted.wait(intent(), new AbortController().signal)).rejects.toThrow("committed window");
  uncommitted.dispose(); await expect(uncommitted.wait(intent(), new AbortController().signal)).rejects.toThrow("committed window");
});

test("checkpoint captures observed inputs and failed save clears previous acknowledgement for explicit retry", async () => {
  const cp = new DraftBrowserOwnerCheckpoint(), current = view(), saved = view(), cancellation = new AbortController();
  cp.committed(current); cp.saved(saved);
  current.draftBrowserOwners![0]!.reference.draftRevision = 9;
  saved.draftBrowserOwners![0]!.reference.draftRevision = 9;
  await cp.wait(intent(), cancellation.signal);
  cp.failed("disk failure"); let acknowledged = false;
  const retry = cp.wait(intent(), cancellation.signal).then(() => { acknowledged = true; });
  try {
    await tick(); expect(acknowledged).toBe(false);
    cp.saved(view()); await retry; expect(acknowledged).toBe(true);
  } finally { cancellation.abort(); cp.dispose(); await retry.catch(() => {}); }
});
