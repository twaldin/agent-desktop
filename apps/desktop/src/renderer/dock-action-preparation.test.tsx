import { createBrowserNewTab } from "./browser-new-tab";
import { closeDockTab, createDockState, draftBrowserDockTarget, hideDock, insertDockTab } from "./dock-state";
import { reconcileDockPresentations } from "./dock-presentations";
import { captureBrowserReplacement } from "./browser-workspace-replacement";
import { expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import type { DesktopBridge } from "@agent-desktop/shared";
import { defaultWindowView } from "../window-state";
import { useWorkbenchDock } from "./use-workbench-dock";
import { dockTabId } from "./dock-state";
import { workspaceKey } from "./workspace-state";
import { browserWorkspaceChoices } from "./browser-workspace-suggestions";
import { BrowserWorkspaceMenu } from "./browser-workspace-menu";
import type { DockAddAction } from "./DockPanel";
import { dockEmptyActionCatalogue } from "./dock-empty-action-model";
import { createDraftBrowserDockTab } from "./draft-browser-dock";

/** Controlled actual hook; no effect delivery, mounted App or native resource. */
function fixture(target: {sessionId:string}|{projectId:string}|{filePath:string}|null={sessionId:"session"}) {
  const slots:any[]=[],queue:Array<()=>void>=[];let cursor=0;const errors:string[]=[];
  const internals=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher={useState(init:any){const i=cursor++;if(!(i in slots))slots[i]=typeof init==="function"?init():init;return[slots[i],(next:any)=>queue.push(()=>slots[i]=typeof next==="function"?next(slots[i]):next)];},useRef(init:any){const i=cursor++;return slots[i]??(slots[i]={current:init});},useEffect(){}};
  function render(){cursor=0;const prior=internals.H;internals.H=dispatcher;try{return useWorkbenchDock({} as DesktopBridge,defaultWindowView(),"owner",target??undefined,true,e=>errors.push(e));}finally{internals.H=prior;}}
  return{render,errors,flush(){while(queue.length)queue.shift()!();}};
}

test("local preparation is owner-qualified and side-effect free; ordinary opening consumes the same descriptor",()=>{
  for(const kind of ["files","review","side-chat","goal","worktrees"] as const) {
    const f=fixture(),dock=f.render(),before=dock.snapshot,result=dock.prepareOpen(kind);f.flush();
    expect(result.status).toBe("ready");if(result.status!=="ready")throw new Error("expected prepared");
    expect(result.tab.hostId).toBe("owner");expect(result.tab.target).toBe("session:session");expect(result.tab.id).toBe(dockTabId(result.tab));expect(f.render().snapshot).toBe(before);expect(f.errors).toEqual([]);
    dock.open(kind,"bottom");f.flush();expect(f.render().snapshot.tabs).toEqual([result.tab]);expect(f.render().snapshot.state.bottom.activeTabId).toBe(result.tab.id);
  }
});

test("Browser preparation creates only a fresh local launcher and native acquisition is absent",async()=>{
  const f=fixture(),dock=f.render(),first=dock.prepareOpen("browser"),second=dock.prepareOpen("browser");
  expect(first.status).toBe("ready");expect(second.status).toBe("ready");if(first.status!=="ready"||second.status!=="ready")throw new Error("expected ready");
  expect(first.tab.id).not.toBe(second.tab.id);expect(first.tab.browserTarget).toBeUndefined();expect(first.tab.browserNewTab).toEqual({status:"idle"});
  f.flush();expect(f.render().snapshot.tabs).toEqual([]);
  await dock.browser("right",true);f.flush();expect(f.render().snapshot.tabs).toHaveLength(1);expect(f.render().snapshot.tabs[0]?.browserNewTab).toEqual({status:"idle"});
});

test("invalid workspace preparation emits no UI error or tab; ordinary unsupported opening preserves feedback",()=>{
  for(const target of [null,{filePath:"/fixture/file.ts"},{projectId:"project"}]) {
    const f=fixture(target),dock=f.render();
    const result=dock.prepareOpen("browser");
    expect(result).toMatchObject({status:"error",outcome:"not-submitted"});f.flush();expect(f.render().snapshot.tabs).toEqual([]);expect(f.errors).toEqual([]);
    dock.open("browser");expect(f.errors).toHaveLength(target === null ? 0 : 1);
  }
  const f=fixture({projectId:"project"});expect(f.render().prepareOpen("side-chat")).toMatchObject({status:"error",outcome:"not-submitted"});
  expect(f.render().prepareOpen("files")).toMatchObject({status:"ready",tab:{target:"project:project"}});
});

// Execute exact bounded App declarations, not a hand-written catalogue. This
// proves these expressions/callbacks only, not App React state or menu dispatch.
const app=readFileSync(new URL("./App.tsx",import.meta.url),"utf8");
const definitions=app.slice(app.indexOf("  const preparationTarget ="),app.indexOf("  const hostGroups ="));
const orderStart=app.indexOf("  const dockActions: DockAddAction[]"),orderEnd=app.indexOf(";",orderStart)+1;
if(!definitions.startsWith("  const preparationTarget")||orderStart<0||orderEnd<=orderStart)throw new Error("App declaration boundary missing");
const compiled=new Bun.Transpiler({loader:"ts"}).transformSync(`function build(values) { const {dockWorkspace,dockSession,hostId,dock,connected,bridge,workspace,commandKeymap,appCommandBindings,workspaceKey,dockTabId,appCommandShortcutLabel,hasNativeTerminalBridge,browserMenu,dockEmptyActionCatalogue,state,draftDockOwner,committedDraftDockOwner,draftId,draftBrowserDockTarget,createDraftBrowserDockTab}=values; ${definitions}\n${app.slice(orderStart,orderEnd)}\nreturn {dockActions,reviewAction}; }`);
const build=new Function(`${compiled};return build;`)() as (values:Record<string,unknown>)=>{dockActions:DockAddAction[];reviewAction?:DockAddAction};
function catalogue(dock:unknown,overrides:Record<string,unknown>={}) {return build({dockWorkspace:{sessionId:"session"},dockSession:{sessionId:"session"},hostId:"owner",dock,connected:true,bridge:{getBtw:()=>{}},workspace:{status:{}},commandKeymap:undefined,appCommandBindings:{bindings:{}},workspaceKey,dockTabId,appCommandShortcutLabel:()=>"shortcut",hasNativeTerminalBridge:()=>true,browserMenu:new BrowserWorkspaceMenu(()=>{}),dockEmptyActionCatalogue,state:undefined,draftDockOwner:{enabled:false},committedDraftDockOwner:{current:undefined},draftId:"draft",draftBrowserDockTarget,createDraftBrowserDockTab,...overrides});}
function actions(dock:unknown,overrides:Record<string,unknown>={}) {return catalogue(dock,overrides).dockActions;}

test("actual App Terminal preparation requires the captured browser and explicitly creates its sibling",async()=>{
  const f=fixture();let terminalCalls=0;
  const browser=createBrowserNewTab("owner","session","source");
  const presentations=reconcileDockPresentations(undefined,{tabs:[browser],state:insertDockTab(createDockState(),browser,"right")},"source");
  const origin=captureBrowserReplacement(presentations,browser.id,{kind:"chat",hostId:"owner",sessionId:"session"})!;
  const dock={...f.render(),snapshot:presentations.snapshot,prepareTerminal:async(create:boolean,signal:AbortSignal,source:unknown,settle:unknown)=>{terminalCalls++;expect(create).toBe(true);expect(signal.aborted).toBe(false);expect(source).toEqual({kind:"browser",tabId:browser.id,browserInstanceId:browser.browserInstanceId,title:origin.title,draft:origin.state.draft});expect(settle).toBeUndefined();return{status:"busy"};}};
  const rows=actions(dock);expect(rows.map(a=>a.id)).toEqual(["review","terminal","browser","files","side-chat"]);expect(terminalCalls).toBe(0);f.flush();expect(f.render().snapshot.tabs).toEqual([]);
  expect(await rows.find(a=>a.id==="terminal")!.prepare!(new AbortController().signal)).toMatchObject({status:"error",outcome:"not-submitted"});expect(terminalCalls).toBe(0);
  expect(await rows.find(a=>a.id==="terminal")!.prepare!(new AbortController().signal,origin)).toEqual({status:"busy"});expect(terminalCalls).toBe(1);
});

test("actual local action preparations respect abort and preserve existing onSelect entrypoints",async()=>{
  const f=fixture(),rows=actions(f.render()),abort=new AbortController();abort.abort();
  for(const kind of ["files","review","browser","side-chat"]) {
    const action=rows.find(a=>a.id===kind)!;
    expect(await action.prepare!(abort.signal)).toEqual({status:"cancelled",creationMayHaveRun:false});
    expect((await action.prepare!(new AbortController().signal)).status).toBe("ready");
  }
  f.flush();expect(f.render().snapshot.tabs).toEqual([]);
  rows.find(a=>a.id==="files")!.onSelect("right");f.flush();expect(f.render().snapshot.tabs[0]?.kind).toBe("files");
});

test("App eligibility/order and native singleton suppression reuse the same catalogue",()=>{
  const f=fixture();
  expect(actions(f.render(),{workspace:undefined}).map(a=>a.id)).toEqual(["files","side-chat","browser","terminal"]);
  expect(actions(f.render(),{connected:false}).map(a=>a.id)).toEqual(["review","browser","files","side-chat"]);
  expect(actions(f.render(),{dockWorkspace:undefined,dockSession:undefined}).map(a=>a.id)).toEqual([]);
  expect(actions(f.render(),{dockSession:undefined,bridge:{}}).map(a=>a.id)).toEqual(["review","terminal","files"]);
  const catalogue=actions(f.render()).map(action=>({...action,title:action.label}));
  const fileId=catalogue.find(a=>a.id==="files")!.singletonTabId!;
  const choices=browserWorkspaceChoices("Chat",[{id:fileId,instanceId:"presentation",destination:"bottom" as const,title:"My Files"}],catalogue,{id:"source",destination:"right"});
  expect(choices.filter(choice=>choice.kind==="action").map(choice=>choice.action.id)).toEqual(["review","terminal","browser","side-chat"]);
  expect(choices.find(choice=>choice.kind==="tab")?.title).toBe("My Files");
});

test("App hides an owned bottom Review but keeps its command able to activate the existing tab",()=>{
  const f=fixture();
  const command=catalogue(f.render()).reviewAction!;
  command.onSelect("bottom");f.flush();
  const opened=f.render(),reviewId=opened.snapshot.state.bottom.activeTabId!;
  opened.change(hideDock(opened.snapshot.state,"bottom"));f.flush();
  const current=catalogue(f.render());
  expect(current.dockActions.map(action=>action.id)).toEqual(["terminal","browser","files","side-chat"]);
  current.reviewAction!.onSelect("right");f.flush();
  expect(f.render().snapshot.state.bottom).toMatchObject({open:true,activeTabId:reviewId,tabIds:[reviewId]});
  expect(f.render().snapshot.state.right.tabIds).toEqual([]);
  f.render().change(closeDockTab(f.render().snapshot.state,"bottom",reviewId));f.flush();
  expect(actions(f.render()).map(action=>action.id)).toEqual(["review","terminal","browser","files","side-chat"]);
});

test("draft Browser preparation and selection cannot outlive the captured draft owner",async()=>{
  const f=fixture(null),owner={enabled:true},committed={current:owner};
  const rows=actions(f.render(),{dockWorkspace:undefined,dockSession:undefined,workspace:undefined,
    bridge:{draftBrowser:{}},state:{},draftDockOwner:owner,committedDraftDockOwner:committed});
  expect(rows.map(action=>action.id)).toEqual(["browser"]);
  const action=rows[0]!,abort=new AbortController();abort.abort();
  expect(await action.prepare!(abort.signal)).toEqual({status:"cancelled",creationMayHaveRun:false});
  const prepared=await action.prepare!(new AbortController().signal);
  expect(prepared.status).toBe("ready");
  action.onSelect("right");f.flush();
  expect(f.render().snapshot.tabs).toHaveLength(1);
  expect(f.render().snapshot.tabs[0]?.target).toBe(draftBrowserDockTarget("draft"));
  const before=f.render().snapshot;
  committed.current={enabled:true};
  expect(await action.prepare!(new AbortController().signal)).toEqual({status:"cancelled",creationMayHaveRun:false});
  action.onSelect("bottom");f.flush();
  expect(f.render().snapshot).toBe(before);
});
