import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView, parseDockSnapshot, parseWindowView } from "../window-state";
import { createDockState, dockTabId, draftBrowserDockTarget, draftBrowserIdFromDock, insertDockTab, moveDockTab } from "./dock-state";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import { BrowserNewTabController, createBrowserNewTab } from "./browser-new-tab";

const tab = () => createDraftBrowserDockTab("host", "new-conversation", "original-instance", "local address draft");
const view = () => { const page = tab(); return { ...defaultWindowView(), route: { hostId: "host", sessionId: null },
  dock: { tabs: [page], state: insertDockTab(createDockState(), page, "right") } }; };

test("draft dock identity preserves exact draft bytes and cannot collide with a session or another owner", () => {
  for (const draftId of ["new-conversation", "a:b/c%? ü", "x".repeat(200)]) expect(draftBrowserIdFromDock(draftBrowserDockTarget(draftId))).toBe(draftId);
  for (const target of ["session:new-conversation", "draft:", "draft:%", "draft:%6Eew-conversation", "draft:a%00", "draft:a%7F"]) expect(draftBrowserIdFromDock(target)).toBeUndefined();
  expect(() => draftBrowserDockTarget("x".repeat(201))).toThrow("identity");
  const draft = tab(); expect(draft.id).not.toBe(createBrowserNewTab("host", "new-conversation", "original-instance").id);
  expect(draft.id).not.toBe(createDraftBrowserDockTab("other", "new-conversation", "original-instance").id);
  expect(draft.id).not.toBe(createDraftBrowserDockTab("host", "other-draft", "original-instance").id);
  expect(draft.id).toBe(dockTabId(draft)); expect(draft.browserTarget).toBeUndefined();
});

test("actual window save/reopen retains draft address and placement alongside a real session browser", () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-browser-dock-"));
  try {
    const original = view(), session = createBrowserNewTab("host", "real-session", "session-instance");
    original.dock.tabs.push(session); original.dock.state = insertDockTab(original.dock.state, session, "bottom");
    const store = new WindowStateStore(dir, "primary"); expect(store.saveView(original)).toEqual({});
    const restored = new WindowStateStore(dir, "primary").bootstrap().state!;
    expect(restored.dock?.tabs).toEqual(original.dock.tabs); expect(restored.dock?.state.right.tabIds).toEqual([tab().id]);
    expect(restored.dock?.state.bottom.tabIds).toEqual([session.id]); expect(restored.route.sessionId).toBeNull();
    const moved = { ...original, dock: { ...original.dock, state: moveDockTab(original.dock.state, tab().id, "bottom") } };
    expect(store.saveView(moved)).toEqual({}); const reopened = new WindowStateStore(dir, "primary").bootstrap().state!;
    expect(reopened.dock?.tabs[0]?.id).toBe(tab().id); expect(reopened.dock?.state.bottom.tabIds).toContain(tab().id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("draft dock payload cannot carry native/session creation claims or escape the browser kind", () => {
  const request = { requestId: "request", controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.com/" };
  for (const patch of [
    { kind: "files" }, { kind: "terminal", terminalId: "term" }, { browserInstanceId: undefined },
    { browserNewTab: undefined }, { browserTarget: { workerPid: 50, name: "page", targetId: "target" } },
    { browserNewTab: { status: "pending", draft: "address" } },
    { browserNewTab: { status: "unknown", draft: "address", request } },
    { browserNewTab: { status: "rejected", draft: "address", message: "error" } },
    { browserNewTab: { status: "idle", request } }, { target: "draft:%broken" },
  ]) {
    const original = view(); Object.assign(original.dock.tabs[0]!, patch);
    expect(parseDockSnapshot(original.dock)).toBeUndefined(); expect(parseWindowView(original)).toBeUndefined();
  }
});

test("malformed draft state is not acknowledged or allowed to replace the last saved address", () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-browser-dock-invalid-"));
  try {
    const store = new WindowStateStore(dir, "primary"), original = view(); expect(store.saveView(original)).toEqual({});
    const invalid = structuredClone(original); invalid.dock.tabs[0]!.browserNewTab = { status: "unknown", draft: "wrong" };
    expect(store.saveView(invalid).error).toBeDefined();
    expect(new WindowStateStore(dir, "primary").bootstrap().state!.dock?.tabs).toEqual(original.dock.tabs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("undefined and explicitly empty addresses remain distinct and cannot dispatch through a session controller", () => {
  const absent = createDraftBrowserDockTab("host", "new-conversation", "absent"), empty = createDraftBrowserDockTab("host", "new-conversation", "empty", "");
  expect(absent.browserNewTab).toEqual({ status: "idle" }); expect(empty.browserNewTab).toEqual({ status: "idle", draft: "" });
  let calls = 0;
  expect(() => new BrowserNewTabController({ getBrowserMetadata: async () => { calls++; return null; } }, empty, () => { calls++; }, () => { calls++; }, async () => { calls++; })).toThrow("session identity");
  expect(calls).toBe(0);
});
