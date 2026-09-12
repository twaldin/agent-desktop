import { expect, test } from "bun:test";
import type { BrowserWorkspaceMenuContext } from "./browser-workspace-menu";
const { BrowserWorkspaceMenu, browserWorkspaceRows }: typeof import("./browser-workspace-menu") = await import(process.env.BROWSER_ACTION_MENU_SOURCE ?? "./browser-workspace-menu");
import { admitBrowserReplacement, acknowledgeBrowserAdmissions, type BrowserReplacementPresentations } from "./browser-replacement-admission";
import { reconcileDockPresentations } from "./dock-presentations";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, dockTabId, insertDockTab, closeDockTab, moveDockTab, type DockTab } from "./dock-state";
import type { DockAddAction } from "./DockPanel";
import type { TerminalPreparation } from "./use-workbench-dock";

const owner={kind:"chat" as const,hostId:"owner",sessionId:"session"};
function panel(kind:DockTab["kind"],title:string,terminalId?:string):DockTab {
  const descriptor={kind,hostId:"owner",target:"session:session" as const,title,...(terminalId?{terminalId}:{})};return {...descriptor,id:dockTabId(descriptor)};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
function fixture(actions:DockAddAction[]=[]) {
  const source=createBrowserNewTab("owner","session","source");source.browserNewTab={status:"idle",draft:""};
  const files=panel("files","Open file"),terminal=panel("terminal","Shell","shell");
  let state=createDockState();state=insertDockTab(state,files,"right");state=insertDockTab(state,source,"right");state=insertDockTab(state,terminal,"bottom");
  let presentations:BrowserReplacementPresentations=reconcileDockPresentations(undefined,{state,tabs:[files,source,terminal]},"initial");
  const queue:Array<()=>void>=[], queued=deferred<void>();let count=0,notices=0;
  const menu=new BrowserWorkspaceMenu(()=>notices++);
  let context:BrowserWorkspaceMenuContext={presentations,owner,enabled:true,connected:true,actions,chatTitle:"Task title",replace:(origin,destination,readOwner)=>{
    const id=`request-${++count}`;queue.push(()=>{presentations=admitBrowserReplacement(presentations,origin,destination,readOwner(),id);});queued.resolve();return id;
  }};
  const commit=(change:Partial<BrowserWorkspaceMenuContext>={})=>{context={...context,...change,presentations};menu.commit(context);};commit();
  return {menu,source,files,terminal,queue,queued:queued.promise,
    get context(){return context;},get state(){return presentations;},get notices(){return notices;},
    rows(query=""){return browserWorkspaceRows(context,source.id,query,"en");},commit,
    update(change:(value:BrowserReplacementPresentations)=>BrowserReplacementPresentations){presentations=change(presentations);commit();},
    flush(){while(queue.length)queue.shift()!();commit();const admissions=menu.committed(presentations.browserAdmissions);presentations=acknowledgeBrowserAdmissions(presentations,[...presentations.browserAdmissions?.keys()??[]]);commit();return admissions;},
  };
}
const action=(prepare:DockAddAction["prepare"],extra:Partial<DockAddAction>={}):DockAddAction=>({preparationTarget:{hostId:"owner",target:"session:session"},id:"terminal",label:"Terminal",icon:"terminal",prepare,onSelect:()=>{throw new Error("Address menu must not use unacknowledged ordinary onSelect");},...extra});
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};

test("App menu inventory uses both real regions and shared actions without preparing; singleton and ownership restrictions apply",()=>{
  let calls=0;const f=fixture([action(async()=>{calls++;return{status:"ready",tab:panel("terminal","New shell","new")};}),action(async()=>({status:"ready",tab:panel("files","Open file")}),{id:"files",label:"Files",icon:"folder",singletonTabId:panel("files","Open file").id,requiresConnection:false})]);
  expect(f.rows().map(row=>row.title)).toEqual(["Terminal"]);expect(calls).toBe(0);
  expect(f.rows("Task")[0]).toMatchObject({kind:"chat",title:"Task title",origin:{owner}});
  const file=f.rows("Open")[0]!;expect(file.kind).toBe("tab");if(file.kind!=="tab")throw new Error("tab");expect(file.tab.reference.destination).toBe("right");expect(file.tab.descriptor).toBe(f.files);
  const shell=f.rows("Shell")[0]!;expect(shell.kind).toBe("tab");if(shell.kind!=="tab")throw new Error("tab");expect(shell.tab.reference.destination).toBe("bottom");
  f.commit({enabled:false});expect(f.rows()).toEqual([]);f.commit({enabled:true,owner:{...owner,sessionId:"other"}});expect(f.rows("Open")).toEqual([]);expect(calls).toBe(0);f.menu.dispose();
});

test("existing Bottom selection commits once before returning a focus result, retaining its original descriptor",()=>{
  const f=fixture(),row=f.rows("Shell")[0]!;
  expect(f.menu.choose(row)).toBe(true);expect(f.state.snapshot.tabs).toContain(f.source);expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("committing");
  expect(f.menu.choose(row)).toBe(false);expect(f.queue).toHaveLength(1);
  const completed=f.flush();expect(completed).toHaveLength(1);expect(completed[0]?.focus).toMatchObject({tabId:f.terminal.id,destination:"bottom"});
  expect(f.state.snapshot.tabs).toEqual([f.files,f.terminal]);expect(f.state.snapshot.state.bottom.activeTabId).toBe(f.terminal.id);expect(f.state.browserAdmissions?.size).toBe(0);f.menu.dispose();
});

test("stale source edits, owner changes and moved destination reject without deleting the launcher",()=>{
  for(const kind of ["edit","owner","destination"] as const){
    const f=fixture(),row=f.rows("Shell")[0]!;expect(f.menu.choose(row)).toBe(true);
    if(kind==="owner")f.commit({owner:{...owner,sessionId:"other"}});
    else f.update(previous=>({...reconcileDockPresentations(previous,{...previous.snapshot,...(kind==="edit"?{tabs:previous.snapshot.tabs.map(tab=>tab.id===f.source.id?{...tab,browserNewTab:{status:"idle" as const,draft:"new unsent value"}}:tab)}:{state:moveDockTab(previous.snapshot.state,f.terminal.id,"right")})},"changed"),browserAdmissions:previous.browserAdmissions}));
    expect(f.flush()).toEqual([]);expect(f.state.snapshot.tabs.some(tab=>tab.id===f.source.id)).toBe(true);f.menu.dispose();
  }
});

test("async action uses latest shared preparation once and waits for actual queued commit",async()=>{
  const gate=deferred<TerminalPreparation>();let old=0,current=0;let signal:AbortSignal|undefined;
  const f=fixture([action(async()=>{old++;return{status:"busy"};})]),row=f.rows()[0]!;
  f.commit({actions:[action(s=>{signal=s;current++;return gate.promise;})]});
  expect(f.menu.choose(row)).toBe(true);expect(f.menu.choose(row)).toBe(false);expect(old).toBe(0);expect(current).toBe(1);expect(f.queue).toHaveLength(0);expect(signal?.aborted).toBe(false);
  gate.resolve({status:"ready",tab:panel("terminal","Created","created")});await settle();
  expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("committing");expect(f.state.snapshot.tabs).toContain(f.source);
  const completed=f.flush();expect(completed).toHaveLength(1);expect(f.state.snapshot.tabs.some(tab=>tab.terminalId==="created")).toBe(true);expect(current).toBe(1);f.menu.dispose();
});

test("committed loss and return while preparation waits never attaches the late result or repeats creation",async()=>{
  for(const loss of ["route","settings","connection","hidden"] as const){
    const gate=deferred<TerminalPreparation>();let calls=0,signal:AbortSignal|undefined;
    const f=fixture([action(s=>{calls++;signal=s;return gate.promise;})]),row=f.rows()[0]!;f.menu.choose(row);
    if(loss==="route"){f.commit({owner:{...owner,sessionId:"away"}});f.commit({owner});}
    if(loss==="settings"){f.commit({enabled:false});f.commit({enabled:true});}
    if(loss==="connection"){f.commit({connected:false});f.commit({connected:true});}
    if(loss==="hidden"){
      const original=f.state.snapshot;f.update(previous=>reconcileDockPresentations(previous,{...previous.snapshot,state:{...previous.snapshot.state,right:{...previous.snapshot.state.right,open:false}}},"hide"));
      f.update(previous=>reconcileDockPresentations(previous,original,"show"));
    }
    expect(signal?.aborted).toBe(true);gate.resolve({status:"ready",tab:panel("terminal","Late","late")});await settle();
    expect(f.queue).toHaveLength(0);expect(f.state.snapshot.tabs).toContain(f.source);expect(f.menu.state(row.origin.presentation.instanceId)).toMatchObject({status:"cancelled",creationMayHaveRun:true});
    expect(f.menu.choose(f.rows()[0]!)).toBe(false);expect(calls).toBe(1);f.menu.dispose();
  }
});

test("unknown preparation is retained across commits and cannot be replayed by selecting another action",async()=>{
  let calls=0;const f=fixture([action(async()=>{calls++;return{status:"error",outcome:"unknown",message:"Lost native response"};}),action(async()=>{calls++;return{status:"ready",tab:panel("review","Review")};},{id:"review",label:"Review",icon:"compose",requiresConnection:false})]),row=f.rows()[0]!;
  f.menu.choose(row);await settle();expect(f.menu.state(row.origin.presentation.instanceId)).toMatchObject({status:"unknown",message:"Lost native response"});
  f.commit({enabled:false});f.commit({enabled:true});expect(f.menu.choose(f.rows()[1]!)).toBe(false);expect(calls).toBe(1);expect(f.queue).toHaveLength(0);expect(f.state.snapshot.tabs).toContain(f.source);f.menu.dispose();
});

test("definite no-submit rejection can be deliberately retried, and local descriptor actions remain usable offline",async()=>{
  let calls=0;const f=fixture([action(async()=>{calls++;return calls===1?{status:"error",outcome:"not-submitted",message:"Catalog unavailable"}:{status:"ready",tab:panel("review","Review")};},{id:"review",label:"Review",icon:"compose",requiresConnection:false})]);
  f.commit({connected:false});const row=f.rows()[0]!;f.menu.choose(row);await settle();expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("error");
  expect(f.menu.choose(f.rows()[0]!)).toBe(true);await settle();expect(calls).toBe(2);expect(f.flush()).toHaveLength(1);f.menu.dispose();
});

test("closing and reopening an identical logical tab removes its attempt without attaching the late native result",async()=>{
  const gate=deferred<TerminalPreparation>();let calls=0;
  const f=fixture([action(async()=>{calls++;return gate.promise;})]),row=f.rows()[0]!;f.menu.choose(row);
  f.update(previous=>reconcileDockPresentations(previous,{tabs:previous.snapshot.tabs.filter(tab=>tab.id!==f.source.id),state:closeDockTab(previous.snapshot.state,"right",f.source.id)},"close"));
  f.update(previous=>reconcileDockPresentations(previous,{tabs:[...previous.snapshot.tabs,f.source],state:insertDockTab(previous.snapshot.state,f.source,"right")},"reopen"));
  gate.resolve({status:"ready",tab:panel("terminal","Late","late")});await settle();
  expect(f.state.instances.get(f.source.id)).not.toBe(row.origin.presentation.instanceId);expect(f.queue).toHaveLength(0);expect(f.state.snapshot.tabs).toContain(f.source);expect(calls).toBe(1);f.menu.dispose();
});

test("a queued synchronous selection is invalidated by a committed away-and-back transition before admission",()=>{
  const f=fixture(),row=f.rows("Shell")[0]!;expect(f.menu.choose(row)).toBe(true);
  f.commit({enabled:false});f.commit({enabled:true});expect(f.flush()).toEqual([]);expect(f.state.snapshot.tabs).toContain(f.source);f.menu.dispose();
});

test("an action can commit without stealing focus from a control chosen while waiting",async()=>{
  const gate=deferred<TerminalPreparation>(),f=fixture([action(()=>gate.promise)]);let ownsFocus=true;
  expect(f.menu.choose(f.rows()[0]!,()=>ownsFocus)).toBe(true);ownsFocus=false;
  gate.resolve({status:"ready",tab:panel("terminal","Created","created")});await settle();
  expect(f.flush()).toEqual([]);expect(f.state.snapshot.tabs.some(tab=>tab.terminalId==="created")).toBe(true);f.menu.dispose();
});

test("explicit Cancel retains the source, aborts once and waits for a sent action's result",async()=>{
  const gate=deferred<TerminalPreparation>();let aborted=0,calls=0;
  const f=fixture([action(signal=>{calls++;signal.addEventListener("abort",()=>aborted++);return gate.promise;})]),row=f.rows()[0]!;
  f.menu.choose(row);f.menu.cancel(row.origin.presentation.instanceId);f.menu.cancel(row.origin.presentation.instanceId);
  expect(aborted).toBe(1);expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("preparing");
  gate.resolve({status:"cancelled",creationMayHaveRun:true});await settle();
  expect(f.menu.state(row.origin.presentation.instanceId)).toEqual({status:"cancelled",creationMayHaveRun:true});expect(f.queue).toHaveLength(0);expect(f.state.snapshot.tabs).toContain(f.source);expect(calls).toBe(1);f.menu.dispose();
});

test("action receives exact browser origin and confirmed-negative recovery releases only its unknown UI fence",async()=>{
  let calls=0,captured:unknown;
  const f=fixture([action(async(_signal,origin)=>{calls++;captured=origin;return{status:"error",outcome:"unknown",message:"lost result"};})]),row=f.rows()[0]!;
  expect(f.menu.choose(row)).toBe(true);expect(f.menu.releaseNotSubmitted(row.origin)).toBe(false);await settle();
  expect(captured).toBe(row.origin);expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("unknown");
  f.commit({enabled:false});expect(f.menu.releaseNotSubmitted(row.origin)).toBe(false);f.commit({enabled:true});
  expect(f.menu.releaseNotSubmitted(row.origin)).toBe(true);expect(f.menu.state(row.origin.presentation.instanceId)).toBeUndefined();
  expect(calls).toBe(1);expect(f.queue).toHaveLength(0);expect(f.state.snapshot.tabs).toContain(f.source);f.menu.dispose();
});

test("explicit observed-result adoption uses original queued admission without invoking the action",()=>{
  let calls=0;const f=fixture([action(async()=>{calls++;return{status:"busy"};})]),row=f.rows()[0]!;
  expect(f.menu.adopt(row.origin,panel("terminal","Recovered","recovered"))).toBe(true);
  expect(f.state.snapshot.tabs).toContain(f.source);expect(calls).toBe(0);
  const completed=f.flush();expect(completed).toHaveLength(1);expect(f.state.snapshot.tabs.some(tab=>tab.terminalId==="recovered")).toBe(true);
  expect(f.state.snapshot.tabs).not.toContain(f.source);expect(calls).toBe(0);f.menu.dispose();
});

for (const transition of ["connection-return", "action-return", "binding-return", "cancel", "connected-repeat", "local-offline"] as const) {
  test(`prepared action queued admission retains controller eligibility across ${transition}`, async () => {
    const gate=deferred<TerminalPreparation>();let calls=0,focus=0;
    const prepared=panel("terminal","Prepared result","prepared-result");
    const shared=action(()=>{calls++;return gate.promise;},transition==="local-offline"?{requiresConnection:false}:{});
    const f=fixture([shared]),row=f.rows()[0]!;
    try {
      expect(f.menu.choose(row,()=>{focus++;return true;})).toBe(true);
      gate.resolve({status:"ready",tab:prepared});await f.queued;
      expect(f.queue).toHaveLength(1);expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("committing");
      // Source identity/owner stay current throughout. Only the prepared action
      // loses eligibility after enqueue, which source-only admission cannot see.
      if(transition==="connection-return"){f.commit({connected:false});f.commit({connected:true});}
      if(transition==="action-return"){f.commit({actions:[]});f.commit({actions:[shared]});}
      if(transition==="binding-return"){
        f.commit({actions:[{...shared,preparationTarget:{hostId:"other",target:"session:session"}}]});f.commit({actions:[shared]});
      }
      if(transition==="cancel")f.menu.cancel(row.origin.presentation.instanceId);
      if(transition==="connected-repeat"){f.commit({connected:true});f.commit({connected:true});}
      if(transition==="local-offline")f.commit({connected:false});
      const accepted=transition==="connected-repeat" || transition==="local-offline";
      const admissions=f.flush();
      expect(admissions).toHaveLength(accepted?1:0);expect(focus).toBe(accepted?1:0);
      expect(f.state.snapshot.tabs.includes(f.source)).toBe(!accepted);
      expect(f.state.snapshot.tabs.some(tab=>tab.id===prepared.id)).toBe(accepted);
      expect(calls).toBe(1);expect(f.queue).toHaveLength(0);
      if(!accepted){
        expect(f.source.browserNewTab).toEqual({status:"idle",draft:""});
        expect(f.menu.state(row.origin.presentation.instanceId)).toEqual({status:"cancelled",creationMayHaveRun:true,tab:prepared});
        expect(f.menu.choose(f.rows()[0]!)).toBe(false);expect(calls).toBe(1);
      }
    } finally {f.menu.dispose();}
  });
}
