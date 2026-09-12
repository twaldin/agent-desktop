import { expect, test } from "bun:test";
import { mainTaskLayoutChange, readTaskLayoutActivation, type MainChatTarget } from "./main-task-targets";
import { createDockState, dockTabId, insertDockTab, showDock, type DockTab } from "./dock-state";

const resolve: typeof mainTaskLayoutChange = process.env.AGENT_DESKTOP_LAYOUT_MODIFIER_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_LAYOUT_MODIFIER_SOURCE)).mainTaskLayoutChange : mainTaskLayoutChange;
const chat:MainChatTarget={kind:"chat",hostId:"home",sessionId:"conversation"};
function fixture() {
  const descriptor={hostId:"work",target:"session:remote" as const,kind:"review" as const,title:"Review"};
  const content:DockTab={...descriptor,id:dockTabId(descriptor)};
  const bottomDescriptor={...descriptor,kind:"terminal" as const,title:"Terminal"};
  const bottom:DockTab={...bottomDescriptor,id:dockTabId(bottomDescriptor)};
  const state=insertDockTab(insertDockTab(createDockState(),content,"right"),bottom,"bottom");
  return {state,tabs:[content,bottom],content};
}
test("Option fills Chat from split without remembering full content or touching Bottom",()=>{
  const f=fixture(),before=structuredClone(f.state),change=resolve(f,chat,true)!;
  expect(change.state.right.open).toBe(false);
  expect(change.state.rightLayout).toBeUndefined();expect(change.focusTarget).toEqual(chat);
  expect(change.state.right.activeTabId).toBe(f.content.id);expect(change.state.right.tabIds).toEqual(before.right.tabIds);
  expect(change.state.bottom).toEqual(before.bottom);expect(change.state.rightWidthRatio).toBe(before.rightWidthRatio);
  expect(showDock(change.state,"right").rightLayout).toBeUndefined();expect(f.state).toEqual(before);
});
test("ordinary fill focuses content, while restore ignores Option and retains the active side",()=>{
  const f=fixture(),full=resolve(f,chat,false)!;
  expect(full.state.right.open).toBe(true);expect(full.state.rightLayout).toBe("full");
  expect(full.focusTarget).toEqual({kind:"content",tabId:f.content.id,hostId:"work",target:"session:remote"});
  const restored=resolve({...f,state:full.state},chat,true)!;
  expect(restored.state).toEqual(f.state);expect(restored.focusTarget).toEqual(full.focusTarget);expect(restored.label).toBe("Restore split");
  const closed={...f.state,right:{...f.state.right,open:false},rightLayout:"restore-full" as const};
  const fromChat=resolve({...f,state:closed},chat,true)!;
  expect(fromChat.state.right.open).toBe(true);expect(fromChat.state.rightLayout).toBeUndefined();expect(fromChat.focusTarget).toEqual(chat);
});
test("only the activating control's actual document focus requests panel focus",()=>{
  const document={activeElement:null as unknown};
  const control={ownerDocument:document} as unknown as HTMLElement;
  expect(readTaskLayoutActivation({altKey:true,currentTarget:control})).toEqual({fillChat:true,restoreFocus:false});
  document.activeElement=control;
  const captured=readTaskLayoutActivation({altKey:false,currentTarget:control});
  // A menu may remove focus while closing; the caller captures before closing it.
  document.activeElement={};expect(captured).toEqual({fillChat:false,restoreFocus:true});
  expect(readTaskLayoutActivation({altKey:false,currentTarget:control}).restoreFocus).toBe(false);
});
test("invalid or bottom-only targets cannot create a layout/focus transition",()=>{
  const f=fixture();expect(resolve({...f,tabs:[f.tabs[1]!]},chat,true)).toBeUndefined();
  expect(resolve({state:createDockState(),tabs:[]},chat,false)).toBeUndefined();
});
