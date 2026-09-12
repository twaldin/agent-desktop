import { expect, test } from "bun:test";
import { createDockState, dockTabId, insertDockTab, setRightDockFullWidth, hideDock, showDock, closeDockTab, moveDockTab, validateDockState, type DockTab } from "./dock-state";
import { activateMainTask, mainTaskTargets, type MainChatTarget } from "./main-task-targets";
import { persistentFileTabs } from "./file-preview-tabs";
import { parseDockSnapshot } from "../window-state";

const chat: MainChatTarget = {kind:"chat",hostId:"home",sessionId:"chat"};
const makeTab = (name: string): DockTab => {
  const tab = {kind:"file" as const,hostId:"home",target:"session:chat" as const,filePath:name,title:name};
  return {...tab,id:dockTabId(tab)};
};
function fixture() {
  const right = makeTab("a.ts"), bottom = makeTab("b.ts");
  const state = insertDockTab(insertDockTab(createDockState(),right,"right"),bottom,"bottom");
  return {right,bottom,snapshot:{state,tabs:[right,bottom]}};
}

test("numbered Chat from full content preserves descriptors and restores full width on the next content selection", () => {
  const f = fixture();
  const original = structuredClone(f.snapshot);
  const full = setRightDockFullWidth(f.snapshot.state,true);
  const content = mainTaskTargets({...f.snapshot,state:full},chat)[1]!;
  const chatState = activateMainTask({...f.snapshot,state:full},chat,chat)!;
  expect(chatState.right.open).toBe(false);
  expect(chatState.rightLayout).toBe("restore-full");
  expect(chatState.right.tabIds).toEqual(full.right.tabIds);
  expect(chatState.right.activeTabId).toBe(f.right.id);
  expect(chatState.bottom).toEqual(original.state.bottom);
  const restored = activateMainTask({...f.snapshot,state:chatState},chat,content)!;
  expect(restored.right.open).toBe(true);
  expect(restored.rightLayout).toBe("full");
  expect(restored.rightWidthRatio).toBe(original.state.rightWidthRatio);
  expect(f.snapshot).toEqual(original);
  expect(activateMainTask(f.snapshot,chat,chat)).toBe(f.snapshot.state);
});

test("ordinary hide clears full width while bottom operations never change it", () => {
  const f = fixture(), full = setRightDockFullWidth(f.snapshot.state,true);
  expect(showDock(hideDock(full,"right"),"right").rightLayout).toBeUndefined();
  expect(showDock(hideDock(full,"bottom"),"bottom").rightLayout).toBe("full");
  const split = setRightDockFullWidth(full,false);
  expect(split.rightLayout).toBeUndefined();
  expect(split.rightWidthRatio).toBe(full.rightWidthRatio);
  expect(split.bottomHeight).toBe(full.bottomHeight);
  const hidden = hideDock(full,"right",true);
  expect(setRightDockFullWidth(hidden,true)).toBe(hidden);
  expect(hideDock(hidden,"right").rightLayout).toBeUndefined();
});

test("last-tab close leaves chat; moving the last content to bottom remembers full width for the next right open", () => {
  const f = fixture(), full = setRightDockFullWidth(f.snapshot.state,true);
  const closed = closeDockTab(full,"right",f.right.id);
  expect(closed.right.open).toBe(false);
  expect(closed.rightLayout).toBeUndefined();
  expect(closed.bottom).toEqual(full.bottom);
  const moved = moveDockTab(full,f.right.id,"bottom");
  expect(moved.right.open).toBe(false);
  expect(moved.rightLayout).toBe("restore-full");
  expect(moved.bottom.tabIds).toEqual([f.bottom.id,f.right.id]);
  const returned = moveDockTab(moved,f.right.id,"right");
  expect(returned.rightLayout).toBe("full");
  expect(returned.right.activeTabId).toBe(f.right.id);
  expect(moveDockTab(full,f.right.id,"right").rightLayout).toBe("full");
});

test("window-state projection preserves full/restore layout, accepts legacy split and rejects contradictory saved modes", () => {
  const f = fixture(), full = setRightDockFullWidth(f.snapshot.state,true);
  for (const state of [f.snapshot.state,full,hideDock(full,"right",true)]) {
    const snapshot = {...f.snapshot,state};
    expect(parseDockSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    const resized = validateDockState(state,snapshot.tabs,{width:1200,height:900});
    expect(resized.rightLayout).toBe(state.rightLayout);
  }
  for (const state of [{...full,rightLayout:"split"},{...full,rightLayout:"restore-full"},{...hideDock(full,"right"),rightLayout:"full"}]) {
    expect(parseDockSnapshot({...f.snapshot,state})).toBeUndefined();
  }
  expect(parseDockSnapshot(f.snapshot)?.state.rightLayout).toBeUndefined();
});

test("transient preview omission retains layout without persisting preview content or changing the live owner", () => {
  const f = fixture();
  f.snapshot.tabs[0] = {...f.right,preview:true};
  for (const state of [setRightDockFullWidth(f.snapshot.state,true),hideDock(setRightDockFullWidth(f.snapshot.state,true),"right",true)]) {
    const live = {...f.snapshot,state}, before = structuredClone(live);
    const saved = persistentFileTabs(live);
    expect(saved.state.rightLayout).toBe(state.rightLayout);
    expect(saved.state.right.open).toBe(state.right.open);
    expect(saved.state.right.tabIds).toEqual([]);
    expect(saved.tabs).toEqual([f.bottom]);
    expect(parseDockSnapshot(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(live).toEqual(before);
  }
});
