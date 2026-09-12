import {expect,test} from "bun:test";
import {createDockState,dockTabId,insertDockTab,hideDock,showDock,setRightDockFullWidth,validateDockState,type DockTab} from "./dock-state";
import {taskDropDestinations,taskDropGeometry,paneDropAt,resolveContentSide,setContentSide,resizeDockFromKey,resizeDockFromPointer,taskPlacementItems,placeTask} from "./content-side-placement";
import {persistentFileTabs} from "./file-preview-tabs";
import {parseDockSnapshot} from "../window-state";
const viewport={left:100,top:50,width:1200,height:800};
const chat={kind:"chat" as const,hostId:"home",sessionId:"chat"};
function fixture() {
  const make=(kind:DockTab["kind"],hostId:string,target:DockTab["target"]):DockTab=>{const d={kind,hostId,target,title:kind,...(kind==="terminal"?{terminalId:"terminal-a"}:{})};return {...d,id:dockTabId(d)};};
  const a=make("review","work","session:a"),b=make("files","home","project:b"),bottom=make("terminal","work","session:a");
  const state=insertDockTab(insertDockTab(insertDockTab(createDockState(),a,"right"),b,"right"),bottom,"bottom");
  return {state,tabs:[a,b,bottom],a,b,bottom};
}
const target=(tab:DockTab)=>({kind:"content" as const,tabId:tab.id,hostId:tab.hostId,target:tab.target});
test("legacy absence survives storage parsing and defaults at the direction-owning renderer",()=>{
  const f=fixture();delete f.state.contentSide;
  const parsed=parseDockSnapshot(f)!;expect(parsed.state.contentSide).toBeUndefined();
  expect(resolveContentSide(parsed.state,"rtl")).toBe("left");expect(resolveContentSide(parsed.state,"ltr")).toBe("right");
  expect(parseDockSnapshot({...f,state:{...f.state,contentSide:"middle"}})).toBeUndefined();
  for(const side of ["left","right"] as const) {
    expect(resolveContentSide({contentSide:side},"rtl")).toBe(side);
    expect(validateDockState(f.state,f.tabs,viewport,side).contentSide).toBe(side);
    expect(parseDockSnapshot({...f,state:setContentSide(f.state,side)})?.state.contentSide).toBe(side);
  }
});
test("placement preserves controller objects, order, full state, width, and bottom",()=>{
  const f=fixture();const full=setRightDockFullWidth(f.state,true),before=structuredClone(full),left=setContentSide(full,"left");
  expect(left.right).toBe(full.right);expect(left.bottom).toBe(full.bottom);expect(left.rightLayout).toBe("full");
  expect(left.rightWidthRatio).toBe(full.rightWidthRatio);expect(full).toEqual(before);
  expect(showDock(hideDock(left,"right",true),"right").contentSide).toBe("left");
  expect(showDock(hideDock(left,"right",true),"right").rightLayout).toBe("full");
  expect(persistentFileTabs({...f,state:left}).state.contentSide).toBe("left");
  expect(setContentSide(left,"left")).toBe(left);
});
test("physical divider pointer and keyboard directions work on both sides and Bottom",()=>{
  const f=fixture();
  for(const side of ["left","right"] as const) {
    const state=setContentSide(f.state,side);
    expect(resizeDockFromPointer(state,"right",viewport,{clientX:side==="left"?580:820,clientY:0}).rightWidthRatio).toBe(.4);
    const right=resizeDockFromKey(state,"right",viewport,"ArrowRight")!;
    expect(right.rightWidthRatio*1200).toBeCloseTo(state.rightWidthRatio*1200+(side==="left"?16:-16));
    expect(resizeDockFromKey(right,"right",viewport,"ArrowLeft")!.rightWidthRatio).toBeCloseTo(state.rightWidthRatio);
    expect(resizeDockFromKey(state,"right",viewport,"ArrowUp")).toBeUndefined();
    expect(resizeDockFromKey(state,"right",viewport,"Home")!.rightWidthRatio*1200).toBe(320);
    expect(resizeDockFromKey(state,"right",viewport,"End")!.rightWidthRatio*1200).toBe(848);
  }
  expect(resizeDockFromPointer(f.state,"bottom",viewport,{clientX:0,clientY:550}).bottomHeight).toBe(300);
  expect(resizeDockFromKey(f.state,"bottom",viewport,"ArrowUp")!.bottomHeight).toBe(296);
  expect(resizeDockFromKey(f.state,"bottom",viewport,"ArrowDown")!.bottomHeight).toBe(264);
  expect(resizeDockFromKey(f.state,"bottom",viewport,"ArrowLeft")).toBeUndefined();
});
test("tab commands disable only current physical destination, including inactive and closed tasks",()=>{
  const f=fixture();const items=taskPlacementItems(f,chat,target(f.b));
  expect(items).toEqual([{id:"unified-workspace-move-left",label:"Move to left pane",enabled:true},{id:"unified-workspace-move-right",label:"Move to right pane",enabled:false}]);
  expect(taskPlacementItems(f,chat,target(f.a)).every(i=>i.enabled)).toBe(true);
  expect(taskPlacementItems({...f,state:hideDock(f.state,"right")},chat,target(f.b)).every(i=>i.enabled)).toBe(true);
  expect(taskPlacementItems(f,chat,chat)[0]).toMatchObject({enabled:false});
  expect(taskPlacementItems({state:createDockState(),tabs:[]},chat,chat).every(i=>!i.enabled)).toBe(true);
});
test("left/right activate in place; bottom transfer retains full owner and stale targets fail closed",()=>{
  const f=fixture(),before=structuredClone(f.state),left=placeTask(f,chat,target(f.a),"left")!;
  expect(left.state.contentSide).toBe("left");expect(left.state.right.tabIds).toEqual(f.state.right.tabIds);expect(left.state.right.activeTabId).toBe(f.a.id);expect(left.state.bottom).toEqual(f.state.bottom);
  const fromBottom=placeTask(f,chat,target(f.bottom),"left")!;
  expect(fromBottom.state.right.tabIds).toContain(f.bottom.id);expect(fromBottom.state.bottom.tabIds).not.toContain(f.bottom.id);
  expect(placeTask(f,chat,{...target(f.a),hostId:"impostor"},"left")).toBeUndefined();
  expect(placeTask({...f,tabs:f.tabs.filter(t=>t.id!==f.a.id)},chat,target(f.a),"left")).toBeUndefined();
  expect(placeTask(f,chat,{...chat,sessionId:"stale"},"right")).toBeUndefined();
  expect(placeTask(f,chat,chat,"bottom")).toBeUndefined();
  expect(placeTask({...f,state:setRightDockFullWidth(f.state,true)},chat,chat,"right")!.state).toMatchObject({contentSide:"left",right:{open:true}});
  expect(placeTask({...f,state:setRightDockFullWidth(f.state,true)},chat,chat,"right")!.state.rightLayout).toBeUndefined();
  expect(f.state).toEqual(before);
});

test("physical target quarters, typed Bottom eligibility and last-Bottom inset",()=>{
  const f=fixture();
  const browserDescriptor={kind:"browser" as const,hostId:"work",target:"session:a" as const,title:"Browser"};
  const browser={...browserDescriptor,id:dockTabId(browserDescriptor)};
  const snapshot={state:insertDockTab(f.state,browser,"right"),tabs:[...f.tabs,browser]};
  expect(taskDropDestinations(snapshot,chat,target(browser))).toEqual(["left","right"]);
  expect(placeTask(snapshot,chat,target(browser),"bottom")).toBeUndefined();
  const browserGeometry=taskDropGeometry(snapshot,chat,target(browser),viewport);
  expect(browserGeometry[0]!.target).toEqual({left:100,top:50,width:300,height:800});
  expect(browserGeometry[0]!.preview.height).toBe(520);
  expect(paneDropAt(browserGeometry,{clientX:120,clientY:840})).toBe("left");
  expect(paneDropAt(browserGeometry,{clientX:600,clientY:400})).toBeUndefined();
  const terminalGeometry=taskDropGeometry(f,chat,target(f.bottom),viewport);
  expect(terminalGeometry.map(x=>x.side)).toEqual(["left","right","bottom"]);
  expect(terminalGeometry[0]!.target.height).toBe(520);
  expect(terminalGeometry[0]!.preview.height).toBe(800);
  expect(paneDropAt(terminalGeometry,{clientX:120,clientY:840})).toBe("bottom");
  const chatGeometry=taskDropGeometry(f,chat,chat,viewport);
  expect(chatGeometry).toHaveLength(2);expect(chatGeometry[0]!.preview.width+browserGeometry[0]!.preview.width).toBe(1200);
  const onlyTerminal={state:insertDockTab(createDockState("left"),f.bottom,"right"),tabs:[f.bottom]};
  const moved=placeTask({...onlyTerminal,state:setRightDockFullWidth(onlyTerminal.state,true)},chat,target(f.bottom),"bottom")!;
  expect(moved.state.rightLayout).toBe("restore-full");expect(moved.state.contentSide).toBe("left");
});

const parseSaved:typeof parseDockSnapshot=process.env.AGENT_DESKTOP_CONTENT_PARSER_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_CONTENT_PARSER_SOURCE)).parseDockSnapshot : parseDockSnapshot;
test("saved physical placement survives the actual parser without becoming a default",()=>{
  const saved={state:createDockState("left"),tabs:[]};
  expect(parseSaved(saved)?.state.contentSide).toBe("left");
  expect(resolveContentSide(parseSaved(saved)!.state,"ltr")).toBe("left");
});
