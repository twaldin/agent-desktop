import { expect, test } from "bun:test";
import { mainTaskLayoutChange, unifiedMainTaskStrip, adjacentMainTask, mainTaskContainsFocus, activateMainTask, mainTaskTargets, numberedMainTaskActions, focusMainTask, type MainChatTarget, type MainTaskTarget } from "./main-task-targets";
import { createDockState, dockTabId, insertDockTab, moveDockTab, type DockTab } from "./dock-state";

const chat: MainChatTarget = { kind: "chat", hostId: "home", sessionId: "chat" };
function tab(hostId: string, filePath: string): DockTab {
  const value = { hostId, target: "session:chat" as const, kind: "file" as const, filePath, title: filePath };
  return { ...value, id: dockTabId(value) };
}
function fixture() {
  const a = tab("home", "a.ts"), b = tab("work", "a.ts"), bottom = tab("home", "bottom.ts");
  let state = createDockState();
  for (const t of [a, b]) state = insertDockTab(state, t, "right");
  state = insertDockTab(state, bottom, "bottom");
  return { a, b, bottom, snapshot: { state, tabs: [a, b, bottom] } };
}

test("next/previous in split cycles only right content and transfers focus only across kinds", () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  const targets = mainTaskTargets(f.snapshot,chat);
  expect(adjacentMainTask(f.snapshot,chat,"content","next")).toEqual({target:targets[1]});
  expect(adjacentMainTask(f.snapshot,chat,"chat","next")).toEqual({target:targets[1],focusSource:chat});
  expect(adjacentMainTask(f.snapshot,chat,"content","previous")).toEqual({target:targets[1]});
  const first = activateMainTask(f.snapshot,chat,targets[1]!)!;
  expect(adjacentMainTask({...f.snapshot,state:first},chat,"content","previous")).toEqual({target:targets[2]});
  expect(f.snapshot).toEqual(before);
});

test("full-width next/previous includes Chat and hidden right content, preserving restore-on-next-open", () => {
  const f = fixture(); f.snapshot.state.rightLayout = "full";
  const targets = mainTaskTargets(f.snapshot,chat), transition = adjacentMainTask(f.snapshot,chat,"chat","next")!;
  expect(transition).toEqual({target:chat,focusSource:targets[2]});
  const chatState = activateMainTask(f.snapshot,chat,transition.target)!;
  expect(chatState.rightLayout).toBe("restore-full");
  expect(chatState.right.open).toBe(false);
  const previous = adjacentMainTask({...f.snapshot,state:chatState},chat,"content","previous")!;
  expect(previous).toEqual({target:targets[2],focusSource:chat});
  const restored = activateMainTask({...f.snapshot,state:chatState},chat,previous.target)!;
  expect(restored.rightLayout).toBe("full");
  expect(restored.right.activeTabId).toBe(f.b.id);
  expect(restored.bottom).toEqual(f.snapshot.state.bottom);
});

test("no right content leaves next/previous unavailable even with bottom tabs", () => {
  const f = fixture();
  f.snapshot.state = moveDockTab(moveDockTab(f.snapshot.state,f.a.id,"bottom"),f.b.id,"bottom");
  expect(adjacentMainTask(f.snapshot,chat,"content","next")).toBeUndefined();
  expect(adjacentMainTask(f.snapshot,chat,"chat","previous")).toBeUndefined();
});

test("cross-kind focus checks the actual departing panel, not the remembered focus area alone", () => {
  // Structural owner adapter, not browser/DOM/native focus proof.
  const active = {}, other = {};
  const root = {ownerDocument:{activeElement:active},querySelector:() => ({contains:(value:unknown) => value === active})} as unknown as HTMLElement;
  expect(mainTaskContainsFocus(root,chat)).toBe(true);
  (root.ownerDocument as unknown as {activeElement:unknown}).activeElement = other;
  expect(mainTaskContainsFocus(root,chat)).toBe(false);
});

test("numeric task slots include chat and ordered right content, excluding bottom without filtering hidden right tabs", () => {
  const f = fixture(); f.snapshot.state.right.open = false;
  const targets = mainTaskTargets(f.snapshot, chat);
  expect(targets).toEqual([chat,
    { kind: "content", tabId: f.a.id, hostId: "home", target: "session:chat" },
    { kind: "content", tabId: f.b.id, hostId: "work", target: "session:chat" }]);
  const selected: MainTaskTarget[] = [];
  const actions = numberedMainTaskActions(targets, "ltr", value => selected.push(value));
  actions["task-tab-1"]!(); actions["task-tab-3"]!();
  expect(selected).toEqual([chat, targets[2]!]);
  expect(actions["task-tab-4"]).toBeUndefined();
  const rtl = numberedMainTaskActions(targets, "rtl", value => selected.push(value));
  rtl["task-tab-1"]!(); rtl["task-tab-3"]!();
  expect(selected.slice(2)).toEqual([targets[2]!, chat]);
  expect(numberedMainTaskActions([chat], "rtl", () => {})["task-tab-2"]).toBeUndefined();
});

test("activation opens only the still-owned right content and preserves route, bottom state and descriptors", () => {
  const f = fixture(); f.snapshot.state.right.open = false;
  const before = structuredClone(f.snapshot), target = mainTaskTargets(f.snapshot, chat)[1]!;
  const next = activateMainTask(f.snapshot, chat, target)!;
  expect(next.right).toMatchObject({ open: true, activeTabId: f.a.id });
  expect(next.bottom).toEqual(before.state.bottom);
  expect(f.snapshot).toEqual(before);
  expect(activateMainTask(f.snapshot, chat, chat)).toBe(f.snapshot.state);
  expect(activateMainTask(f.snapshot, { ...chat, hostId: "other" }, chat)).toBeUndefined();
  const moved = { ...f.snapshot, state: moveDockTab(f.snapshot.state, f.a.id, "bottom") };
  expect(activateMainTask(moved, chat, target)).toBeUndefined();
  expect(activateMainTask({ ...f.snapshot, tabs: f.snapshot.tabs.filter(t => t.id !== f.a.id) }, chat, target)).toBeUndefined();
});

test("RTL reverses all targets before capping nine; malformed descriptors never receive a slot", () => {
  const tabs = Array.from({ length: 12 }, (_, i) => tab("home", `${i}.ts`));
  let state = createDockState(); for (const t of tabs) state = insertDockTab(state, t, "right");
  const targets = mainTaskTargets({ state, tabs }, chat), selected: MainTaskTarget[] = [];
  const actions = numberedMainTaskActions(targets, "rtl", t => selected.push(t));
  expect(Object.keys(actions)).toHaveLength(9);
  actions["task-tab-1"]!(); actions["task-tab-9"]!();
  expect(selected).toEqual([targets[12]!, targets[4]!]);
  const broken = { ...tabs[0]!, hostId: "other" };
  expect(mainTaskTargets({ state, tabs: [broken] }, chat)).toEqual([chat]);
});

test("focus adapter retains active child and refuses inactive, moved, hidden or disconnected panel", () => {
  const f = fixture(), target = mainTaskTargets(f.snapshot, chat)[2]!;
  let calls = 0, hasFocus = false, hidden = false, connected = true;
  const panel = { get isConnected() { return connected; }, closest: () => hidden ? {} : null,
    getClientRects: () => [1], ownerDocument: { activeElement: {} }, contains: () => hasFocus,
    focus: (options: unknown) => { expect(options).toEqual({ preventScroll: true }); calls++; } };
  const original = globalThis.CSS;
  Object.defineProperty(globalThis, "CSS", { configurable: true, value: { escape: (value: string) => value } });
  const root = { querySelector: () => panel } as unknown as HTMLElement;
  try {
    expect(focusMainTask(root, f.snapshot, chat, target)).toBe(true); expect(calls).toBe(1);
    hasFocus = true; expect(focusMainTask(root, f.snapshot, chat, target)).toBe(true); expect(calls).toBe(1);
    hidden = true; expect(focusMainTask(root, f.snapshot, chat, target)).toBe(false);
    hidden = false; connected = false; expect(focusMainTask(root, f.snapshot, chat, target)).toBe(false);
    connected = true; f.snapshot.state.right.open = false;
    expect(focusMainTask(root, f.snapshot, chat, target)).toBe(false);
    expect(focusMainTask(root, f.snapshot, chat, chat)).toBe(true);
    expect(calls).toBe(1);
  } finally { Object.defineProperty(globalThis, "CSS", { configurable: true, value: original }); }
});


test("unified strip appears for full or closed right with retained valid content; never bottom alone", () => {
  const f=fixture(), before=structuredClone(f.snapshot);
  expect(unifiedMainTaskStrip(f.snapshot,chat)).toBeUndefined();
  const full={...f.snapshot,state:{...f.snapshot.state,rightLayout:"full" as const}};
  const fullStrip=unifiedMainTaskStrip(full,chat)!;
  expect(fullStrip.content.map(t=>t.tabId)).toEqual([f.a.id,f.b.id]);
  expect(fullStrip.active).toEqual(mainTaskTargets(f.snapshot,chat)[2]!);
  const closed={...f.snapshot,state:{...f.snapshot.state,right:{...f.snapshot.state.right,open:false}}};
  expect(unifiedMainTaskStrip(closed,chat)?.active).toEqual(chat);
  expect(unifiedMainTaskStrip({...closed,tabs:[f.bottom]},chat)).toBeUndefined();
  expect(f.snapshot).toEqual(before);
});


test("closed retained content restores split with the original active owner and bottom intact", () => {
  const f=fixture(); f.snapshot.state.right.open=false; f.snapshot.state.rightLayout="restore-full";
  const before=structuredClone(f.snapshot), action=mainTaskLayoutChange(f.snapshot,chat)!;
  expect(action.label).toBe("Restore split");
  expect(action.state.right).toEqual({...before.state.right,open:true});
  expect(action.state.rightLayout).toBeUndefined();
  expect(action.state.bottom).toEqual(before.state.bottom);
  expect(action.state.rightWidthRatio).toBe(before.state.rightWidthRatio);
  expect(f.snapshot).toEqual(before);
});
test("layout action cycles open split/full and restores a plain closed dock without a remembered flag", () => {
  const f=fixture(), fill=mainTaskLayoutChange(f.snapshot,chat)!;
  expect(fill.label).toBe("Fullscreen");expect(fill.state.rightLayout).toBe("full");
  const restore=mainTaskLayoutChange({...f.snapshot,state:fill.state},chat)!;
  expect(restore.label).toBe("Restore split");expect(restore.state.rightLayout).toBeUndefined();
  expect(restore.state).toEqual(f.snapshot.state);
  f.snapshot.state.right.open=false;
  const closed=mainTaskLayoutChange(f.snapshot,chat)!;
  expect(closed.label).toBe("Restore split");expect(closed.state.right.open).toBe(true);expect(closed.state.rightLayout).toBeUndefined();
});
test("layout action requires retained valid right content and falls back only to its first owned tab", () => {
  const f=fixture();f.snapshot.state.right.activeTabId="stale";f.snapshot.state.right.open=false;
  const restored=mainTaskLayoutChange(f.snapshot,chat)!;
  expect(restored.state.right.activeTabId).toBe(f.a.id);
  expect(mainTaskLayoutChange({...f.snapshot,tabs:[f.bottom]},chat)).toBeUndefined();
  const moved={...f.snapshot,state:moveDockTab(moveDockTab(f.snapshot.state,f.a.id,"bottom"),f.b.id,"bottom")};
  expect(mainTaskLayoutChange(moved,chat)).toBeUndefined();
});
