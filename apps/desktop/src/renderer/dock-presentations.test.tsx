import { expect, test } from "bun:test";
import React from "react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileDockPresentations, captureDockPresentation, isCurrentDockPresentation } from "./dock-presentations";
import { createDockState, insertDockTab, closeDockTab, moveDockTab, hideDock, dockTabId, type DockTab } from "./dock-state";
import { createBrowserNewTab } from "./browser-new-tab";
import { useWorkbenchDock } from "./use-workbench-dock";
import { DockPanel as CurrentPanel } from "./DockPanel";
import { defaultWindowView } from "../window-state";
import { WindowStateStore } from "../main/window-state";
import type { DesktopBridge } from "@agent-desktop/shared";
const Panel: typeof CurrentPanel = process.env.AGENT_DESKTOP_PRESENTATION_PANEL
  ? (await import(process.env.AGENT_DESKTOP_PRESENTATION_PANEL)).DockPanel : CurrentPanel;
const descriptor = { kind: "files" as const, hostId: "owner", target: "session:session" as const, title: "Open file" };
const fileTab: DockTab = { ...descriptor, id: dockTabId(descriptor) };
const initial = () => ({ state: insertDockTab(createDockState(), fileTab, "right"), tabs: [fileTab] });

test("runtime identities retain rename/hide/move while stale destination references fail", () => {
  const a = reconcileDockPresentations(undefined, initial(), "first");
  const ref = captureDockPresentation(a, fileTab.id)!;
  expect(isCurrentDockPresentation(a, ref)).toBe(true);
  const renamed = reconcileDockPresentations(a, { ...a.snapshot, tabs: [{ ...fileTab, title: "Renamed" }] }, "rename");
  expect(captureDockPresentation(renamed, fileTab.id)).toEqual(ref);
  const hidden = reconcileDockPresentations(renamed, { ...renamed.snapshot, state: hideDock(renamed.snapshot.state, "right") }, "hide");
  expect(isCurrentDockPresentation(hidden, ref)).toBe(true);
  const moved = reconcileDockPresentations(hidden, { ...hidden.snapshot, state: moveDockTab(hidden.snapshot.state, fileTab.id, "bottom") }, "move");
  expect(moved.instances.get(fileTab.id)).toBe(ref.instanceId);
  expect(isCurrentDockPresentation(moved, ref)).toBe(false);
  expect(isCurrentDockPresentation(moved, { ...ref, destination: "bottom" })).toBe(true);
});

test("close/reopen renews an identity even when a stale descriptor is supplied again", () => {
  const a = reconcileDockPresentations(undefined, initial(), "first"), ref = captureDockPresentation(a, fileTab.id)!;
  const closed = reconcileDockPresentations(a, { state: closeDockTab(a.snapshot.state, "right", fileTab.id), tabs: a.snapshot.tabs }, "close");
  expect(closed.instances.size).toBe(0); expect(isCurrentDockPresentation(closed, ref)).toBe(false);
  const reopened = reconcileDockPresentations(closed, initial(), "reopen");
  expect(reopened.instances.get(fileTab.id)).not.toBe(ref.instanceId);
  expect(isCurrentDockPresentation(reopened, ref)).toBe(false);
  expect(reconcileDockPresentations(reopened, reopened.snapshot, "no-op")).toBe(reopened);
});

test("local browser materialization preserves the presentation and native target identity stays separate", () => {
  const tab = createBrowserNewTab("owner", "session", "launcher");
  const a = reconcileDockPresentations(undefined, { state: insertDockTab(createDockState(), tab, "bottom"), tabs: [tab] }, "first");
  const { browserNewTab: _launcher, ...materialized } = tab;
  const web = { ...materialized, title: "Native page", browserTarget: { workerPid: 42, name: "owned", targetId: "native-id" } };
  const b = reconcileDockPresentations(a, { ...a.snapshot, tabs: [web] }, "acquired");
  expect(b.instances.get(tab.id)).toBe(a.instances.get(tab.id));
  expect(b.snapshot.tabs[0]!.browserTarget).toEqual(web.browserTarget);
  expect(captureDockPresentation(b, tab.id)).toEqual(captureDockPresentation(a, tab.id));
});

test("ambiguous, malformed and owner-rewritten descriptors cannot supply an identity", () => {
  const a = reconcileDockPresentations(undefined, initial(), "first"), ref = captureDockPresentation(a, fileTab.id)!;
  for (const snapshot of [
    { ...a.snapshot, tabs: [fileTab, fileTab] },
    { ...a.snapshot, tabs: [{ ...fileTab, hostId: "other" }] },
    { ...a.snapshot, state: { ...a.snapshot.state, bottom: { tabIds: [fileTab.id], activeTabId: fileTab.id, open: true } } },
    { ...a.snapshot, state: { ...a.snapshot.state, right: { ...a.snapshot.state.right, tabIds: [fileTab.id, fileTab.id] } } },
  ]) {
    const next = reconcileDockPresentations(a, snapshot, "invalid");
    expect(next.instances.size).toBe(0); expect(captureDockPresentation(next, fileTab.id)).toBeUndefined();
    expect(isCurrentDockPresentation(next, ref)).toBe(false);
  }
  for (const changed of [{ ...ref, hostId: "other" }, { ...ref, target: "session:other" as const }, { ...ref, kind: "terminal" as const }])
    expect(isCurrentDockPresentation(a, changed)).toBe(false);
});

test("reexecuting a transition with its allocated seed produces identical keys without mutating prior state", () => {
  const snapshot = initial(), original = structuredClone(snapshot);
  const a = reconcileDockPresentations(undefined, snapshot, "allocated-once");
  const b = reconcileDockPresentations(undefined, snapshot, "allocated-once");
  expect([...a.instances]).toEqual([...b.instances]); expect(snapshot).toEqual(original);
  expect(reconcileDockPresentations(undefined, snapshot, "other-window").instances.get(fileTab.id)).not.toBe(a.instances.get(fileTab.id));
});

/** Controlled hook slots and queued state updaters, not a React commit or DOM mount. */
function driver() {
  const slots: unknown[] = [], queue: Array<() => void> = []; let cursor = 0;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const assignRef = (ref: React.Ref<unknown> | undefined, value: unknown) => { if (typeof ref === "function") ref(value); else if (ref) ref.current = value; };
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (next: any) => queue.push(() => { slots[i] = typeof next === "function" ? next(slots[i]) : next; })]; },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useId() { return `controlled-${cursor++}`; },
    useEffect() {},
    useImperativeHandle(ref: React.Ref<unknown> | undefined, create: () => unknown) { const i = cursor++, previous = slots[i] as { cleanup?(): void } | undefined;
      previous?.cleanup?.(); assignRef(ref, create()); slots[i] = { cleanup: () => assignRef(ref, null) }; },
  };
  return { flush() { while (queue.length) queue.shift()!(); }, render<T>(run: () => T): T {
    cursor = 0; const previous = internals.H; internals.H = dispatcher;
    try { return run(); } finally { internals.H = previous; }
  } };
}

test("actual dock owner processes close and reopen in one queued batch and preserves subsequent title identity", () => {
  const d = driver();
  const render = () => d.render(() => useWorkbenchDock({} as DesktopBridge, { ...defaultWindowView(), dock: initial() }, "owner", { sessionId: "session" }, true, message => { throw new Error(message); }));
  let dock = render(); const old = captureDockPresentation(dock.presentations, fileTab.id)!;
  dock.change(closeDockTab(dock.snapshot.state, "right", fileTab.id));
  dock.open("files", "right");
  d.flush(); dock = render();
  expect(dock.snapshot.tabs).toHaveLength(1);
  expect(dock.snapshot.tabs[0]!.id).toBe(old.tabId);
  expect(isCurrentDockPresentation(dock.presentations, old)).toBe(false);
  const current = captureDockPresentation(dock.presentations, fileTab.id)!;
  expect(current.instanceId).not.toBe(old.instanceId);
  dock.updateTitle(fileTab.id, "New title"); d.flush(); dock = render();
  expect(captureDockPresentation(dock.presentations, fileTab.id)).toEqual(current);
  expect(Object.keys(dock.snapshot).sort()).toEqual(["state", "tabs"]);
});

test("actual window save/reopen retains only durable dock data and initializes a fresh presentation lifetime", () => {
  const dir = mkdtempSync(join(tmpdir(), "dock-presentations-"));
  try {
    const a = reconcileDockPresentations(undefined, initial(), "before-restart"), store = new WindowStateStore(dir, "primary");
    expect(store.saveView({ ...defaultWindowView(), dock: a.snapshot })).toEqual({});
    const saved = new WindowStateStore(dir, "primary").bootstrap().state!.dock!;
    expect(saved).toEqual(a.snapshot);
    expect(JSON.stringify(saved)).not.toContain("before-restart");
    const b = reconcileDockPresentations(undefined, saved, "after-restart");
    expect(isCurrentDockPresentation(b, captureDockPresentation(a, fileTab.id)!)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function elementKeys(panel: React.ReactNode) {
  const keys: string[] = [];
  function visit(node: React.ReactNode) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!React.isValidElement<{ role?: string; className?: string; children?: React.ReactNode }>(node)) return;
    if (node.props.role === "tabpanel" || node.props.className?.split(" ").includes("dock-pill")) keys.push(String(node.key));
    visit(node.props.children);
  }
  visit(panel); return keys;
}
test("actual panel keys both its pill and content by the supplied presentation rather than the reusable dock ID", () => {
  const a = reconcileDockPresentations(undefined, initial(), "old");
  const closed = reconcileDockPresentations(a, { state: createDockState(), tabs: [] }, "close");
  const b = reconcileDockPresentations(closed, initial(), "new");
  const render = (state: typeof a) => driver().render(() => Panel({ destination: "right", state: state.snapshot.state, tabs: state.snapshot.tabs,
    presentationIds: state.instances, viewport: { width: 1440, height: 1000 }, renderTab: () => <div>Content</div>, onChange: () => {} }));
  const oldKeys = elementKeys(render(a)), newKeys = elementKeys(render(b));
  expect(oldKeys).toHaveLength(2); expect(newKeys).toHaveLength(2);
  expect(oldKeys).not.toEqual(newKeys);
  expect(oldKeys).toEqual([a.instances.get(fileTab.id)!, a.instances.get(fileTab.id)!]);
  expect(newKeys).toEqual([b.instances.get(fileTab.id)!, b.instances.get(fileTab.id)!]);
});
