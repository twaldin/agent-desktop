import { expect, test } from "bun:test";
import React from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import { createBrowserNewTab } from "./browser-new-tab";
import { captureBrowserReplacement, replaceBrowserWorkspaceDestination } from "./browser-workspace-replacement";
import { captureDockPresentation, reconcileDockPresentations, type DockPresentations } from "./dock-presentations";
import { createDockState, insertDockTab, closeDockTab, moveDockTab, dockTabId, type DockTab, type DockDestination } from "./dock-state";
import { defaultWindowView } from "../window-state";
import { useWorkbenchDock } from "./use-workbench-dock";
import type { MainChatTarget } from "./main-task-targets";
const owner: MainChatTarget = { kind: "chat", hostId: "owner", sessionId: "session" };
const files = (label = "Open file"): DockTab => {
  const descriptor = { kind: "files" as const, hostId: "owner", target: "session:session" as const, title: label };
  return { ...descriptor, id: dockTabId(descriptor) };
};
function fixture(destination: DockDestination = "right", draft?: string) {
  const source = createBrowserNewTab("owner", "session", "source");
  if (draft !== undefined) source.browserNewTab = { status: "idle", draft };
  const snapshot = { state: insertDockTab(createDockState(), source, destination), tabs: [source] };
  const state = reconcileDockPresentations(undefined, snapshot, "initial");
  return { source, state, origin: captureBrowserReplacement(state, source.id, owner)! };
}
function add(state: DockPresentations, tab: DockTab, destination: DockDestination) {
  return reconcileDockPresentations(state, { state: insertDockTab(state.snapshot.state, tab, destination), tabs: [...state.snapshot.tabs, tab] }, crypto.randomUUID());
}

test("deliberate Chat replacement accepts typed and explicit empty drafts/custom title without deleting siblings", () => {
  for (const draft of [undefined, "", "a typed URL"]) for (const destination of ["right", "bottom"] as const) {
    const f = fixture(destination, draft); f.source.title = "My empty launcher";
    const origin = captureBrowserReplacement(f.state, f.source.id, owner)!;
    const sibling = createBrowserNewTab("owner", "session", "sibling"); sibling.browserNewTab = { status: "idle", draft: "keep" };
    const state = add(f.state, sibling, destination === "right" ? "bottom" : "right");
    const before = JSON.stringify(state.snapshot);
    const result = replaceBrowserWorkspaceDestination(state, origin, { kind: "chat", target: owner }, owner, "select")!;
    expect(result.focus).toEqual(owner); expect(result.presentations.snapshot.tabs).toEqual([sibling]);
    expect(result.presentations.instances.get(sibling.id)).toBe(state.instances.get(sibling.id));
    expect(result.presentations.snapshot.state[destination].tabIds).toEqual([]);
    expect(JSON.stringify(state.snapshot)).toBe(before);
    expect(replaceBrowserWorkspaceDestination(result.presentations, origin, { kind: "chat", target: owner }, owner, "repeat")).toBeUndefined();
  }
});

test("existing destinations retain their region, descriptor and incarnation", () => {
  for (const from of ["right", "bottom"] as const) for (const to of ["right", "bottom"] as const) {
    const f = fixture(from, "Files"), destination = files("Saved title"), state = add(f.state, destination, to);
    const target = captureDockPresentation(state, destination.id)!;
    const result = replaceBrowserWorkspaceDestination(state, f.origin, { kind: "tab", target }, owner, "select")!;
    expect(result.focus).toEqual(target); expect(result.presentations.snapshot.tabs).toEqual([destination]);
    expect(result.presentations.snapshot.state[to].activeTabId).toBe(destination.id);
    expect(result.presentations.snapshot.state[to].open).toBe(true);
    expect(result.presentations.instances.get(destination.id)).toBe(target.instanceId);
  }
});

test("stale source/destination incarnations and moved destination fail before removing the launcher", () => {
  const f = fixture(), targetTab = files(), state = add(f.state, targetTab, "bottom"), target = captureDockPresentation(state, targetTab.id)!;
  const withoutTarget = reconcileDockPresentations(state, { state: closeDockTab(state.snapshot.state, "bottom", targetTab.id), tabs: [f.source] }, "closed");
  const reopenedTarget = add(withoutTarget, targetTab, "bottom");
  const moved = reconcileDockPresentations(state, { ...state.snapshot, state: moveDockTab(state.snapshot.state, targetTab.id, "right") }, "moved");
  const withoutSource = reconcileDockPresentations(state, { state: closeDockTab(state.snapshot.state, "right", f.source.id), tabs: [targetTab] }, "source-closed");
  const reopenedSource = add(withoutSource, f.source, "right");
  for (const current of [withoutTarget, reopenedTarget, moved, withoutSource, reopenedSource]) {
    const before = JSON.stringify(current.snapshot);
    expect(replaceBrowserWorkspaceDestination(current, f.origin, { kind: "tab", target }, owner, "select")).toBeUndefined();
    expect(JSON.stringify(current.snapshot)).toBe(before);
  }
  expect(replaceBrowserWorkspaceDestination(state, f.origin, { kind: "tab", target: f.origin.presentation }, owner, "self")).toBeUndefined();
});

test("queued draft edits including change-back and renamed source invalidate the original selection", () => {
  const f = fixture("right", "original");
  for (const source of [{ ...f.source, browserNewTab: { status: "idle" as const, draft: "" } },
    { ...f.source, browserNewTab: { status: "idle" as const, draft: "original" } }, { ...f.source, title: "new title" }]) {
    const state = reconcileDockPresentations(f.state, { ...f.state.snapshot, tabs: [source] }, "edit");
    expect(replaceBrowserWorkspaceDestination(state, f.origin, { kind: "chat", target: owner }, owner, "select")).toBeUndefined();
    expect(state.snapshot.tabs[0]).toBe(source);
  }
});

test("pending, unknown, native and owner-mismatched sources cannot become empty-launcher replacement authority", () => {
  const f = fixture();
  for (const source of [
    { ...f.source, browserNewTab: { status: "pending" as const } },
    { ...f.source, browserNewTab: { status: "unknown" as const } },
    { ...f.source, browserTarget: { workerPid: 42, name: "native", targetId: "id" } },
    { ...f.source, hostId: "other" },
  ]) expect(captureBrowserReplacement(reconcileDockPresentations(f.state, { ...f.state.snapshot, tabs: [source] }, "changed"), f.source.id, owner)).toBeUndefined();
  for (const current of [undefined, { ...owner, hostId: "other" }, { ...owner, sessionId: "other" }, { ...owner, sessionId: null }])
    expect(replaceBrowserWorkspaceDestination(f.state, f.origin, { kind: "chat", target: owner }, current, "select")).toBeUndefined();
  expect(replaceBrowserWorkspaceDestination(f.state, f.origin, { kind: "chat", target: { ...owner, sessionId: "other" } }, owner, "select")).toBeUndefined();
});

test("confirmed new results replace at the source position and preserve full-content layout", () => {
  const f = fixture(), sibling = createBrowserNewTab("owner", "session", "sibling"), target = files();
  const withSibling = add(f.state, sibling, "right");
  const full = reconcileDockPresentations(withSibling, { ...withSibling.snapshot, state: { ...withSibling.snapshot.state, rightLayout: "full" } }, "full");
  const result = replaceBrowserWorkspaceDestination(full, f.origin, { kind: "opened", tab: target }, owner, "opened")!;
  expect(result.presentations.snapshot.state.right.tabIds).toEqual([target.id, sibling.id]);
  expect(result.presentations.snapshot.state.rightLayout).toBe("full");
  expect(result.presentations.snapshot.state.right.activeTabId).toBe(target.id);
  expect(result.focus).toEqual(captureDockPresentation(result.presentations, target.id)!);
  const single = reconcileDockPresentations(f.state, { ...f.state.snapshot, state: { ...f.state.snapshot.state, rightLayout: "full" } }, "full");
  expect(replaceBrowserWorkspaceDestination(single, f.origin, { kind: "opened", tab: target }, owner, "opened")!.presentations.snapshot.state.rightLayout).toBe("full");
});

test("definitely rejected acquisition permits deliberate replacement without replaying its retained request", () => {
  const f = fixture("right", "failed address");
  const request = { requestId: "rejected", controlEpoch: "epoch", observedAt: 1_000_000, initialUrl: "https://example.invalid/" };
  const source = { ...f.source, browserNewTab: { status: "rejected" as const, draft: "failed address", request, message: "Not acquired" } };
  const state = reconcileDockPresentations(f.state, { ...f.state.snapshot, tabs: [source] }, "rejection");
  const origin = captureBrowserReplacement(state, source.id, owner)!;
  expect(origin.state.request).toBe(request);
  const result = replaceBrowserWorkspaceDestination(state, origin, { kind: "chat", target: owner }, owner, "select")!;
  expect(result.presentations.snapshot.tabs).toEqual([]); expect(result.focus).toEqual(owner);
  expect(source.browserNewTab.request).toBe(request); expect(source.browserNewTab.status).toBe("rejected");
});

test("confirmed existing result wins in its original dock and uncertain/malformed/foreign candidates preserve the source", () => {
  const f = fixture(), existing = files("Preserved title"), state = add(f.state, existing, "bottom");
  const result = replaceBrowserWorkspaceDestination(state, f.origin, { kind: "opened", tab: files("Returned title") }, owner, "opened")!;
  expect(result.presentations.snapshot.tabs).toEqual([existing]); expect(result.presentations.snapshot.state.bottom.activeTabId).toBe(existing.id);
  expect(result.presentations.instances.get(existing.id)).toBe(state.instances.get(existing.id));
  const uncertain = createBrowserNewTab("owner", "session", "uncertain"); uncertain.browserNewTab = { status: "pending" };
  const malformed = { ...files(), title: "x".repeat(1001) };
  const foreign = { ...files(), hostId: "other" }; foreign.id = dockTabId(foreign);
  for (const tab of [uncertain, malformed, foreign, f.source])
    expect(replaceBrowserWorkspaceDestination(f.state, f.origin, { kind: "opened", tab }, owner, "opened")).toBeUndefined();
});

test("Chat selection from Bottom reveals Chat when right content was full", () => {
  const f = fixture("bottom"), state = add(f.state, files(), "right");
  const full = reconcileDockPresentations(state, { ...state.snapshot, state: { ...state.snapshot.state, rightLayout: "full" } }, "full");
  const result = replaceBrowserWorkspaceDestination(full, f.origin, { kind: "chat", target: owner }, owner, "chat")!;
  expect(result.presentations.snapshot.state.right.open).toBe(false);
  expect(result.presentations.snapshot.state.rightLayout).toBe("restore-full");
  expect(result.presentations.snapshot.tabs.map(tab => tab.id)).toEqual([files().id]); expect(result.focus).toEqual(owner);
});

/** Controlled hook slots/queued updaters; no mounted React or DOM proof. */
function driver() {
  const slots: any[] = [], queue: Array<() => void> = []; let cursor = 0;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (next: any) => queue.push(() => { slots[i] = typeof next === "function" ? next(slots[i]) : next; })]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); }, useEffect() {},
  };
  return { flush() { while (queue.length) queue.shift()!(); }, render<T>(run: () => T): T { cursor = 0; const previous = internals.H; internals.H = dispatcher;
    try { return run(); } finally { internals.H = previous; } } };
}
test("actual dock re-reads the supplied current owner inside its queued replacement admission", () => {
  const f = fixture(), d = driver(); let current: MainChatTarget | undefined = owner;
  const render = () => d.render(() => useWorkbenchDock({} as DesktopBridge, { ...defaultWindowView(), dock: f.state.snapshot }, "owner", { sessionId: "session" }, true, () => {}));
  let dock = render(); const origin = captureBrowserReplacement(dock.presentations, f.source.id, owner)!;
  dock.replaceBrowserDestination(origin, { kind: "chat", target: owner }, () => current);
  current = undefined; d.flush(); dock = render(); expect(dock.snapshot.tabs).toEqual([f.source]);
  current = owner; dock.replaceBrowserDestination(origin, { kind: "opened", tab: files() }, () => current);
  d.flush(); dock = render(); expect(dock.snapshot.tabs).toEqual([files()]);
  expect(dock.snapshot.state.right.activeTabId).toBe(files().id);
});
