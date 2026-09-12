import { expect, test } from "bun:test";
import { BrowserWorkspaceActionController, type BrowserWorkspaceActionContext } from "./browser-workspace-action";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab, dockTabId, moveDockTab, closeDockTab } from "./dock-state";
import { reconcileDockPresentations } from "./dock-presentations";
import { captureBrowserReplacement, replaceBrowserWorkspaceDestination } from "./browser-workspace-replacement";
import type { TerminalPreparation } from "./use-workbench-dock";
function deferred<T>() { let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject}; }
function fixture() {
  const tab=createBrowserNewTab("host","session","launcher");tab.browserNewTab={status:"idle",draft:"Terminal"};
  const owner={kind:"chat" as const,hostId:"host",sessionId:"session"};
  let context:BrowserWorkspaceActionContext={owner,enabled:true,connected:true,presentations:reconcileDockPresentations(undefined,{state:insertDockTab(createDockState(),tab,"right"),tabs:[tab]},"initial")};
  const origin=captureBrowserReplacement(context.presentations,tab.id,owner)!;
  const descriptor={kind:"terminal" as const,hostId:"host",target:"session:session" as const,title:"Terminal",terminalId:"native-shell"};
  const destination={...descriptor,id:dockTabId(descriptor)};
  const gate=deferred<TerminalPreparation>(),signals:AbortSignal[]=[],states:string[]=[];
  const controller=new BrowserWorkspaceActionController(origin,()=>context,signal=>{signals.push(signal);return gate.promise;},()=>states.push(controller.state.status));
  return{tab,owner,origin,destination,gate,signals,states,controller,get context(){return context;},set context(value){context=value;}};
}

test("one preparation yields an uncommitted intent; only real dock admission removes its source",async()=>{
  const f=fixture(),before=f.context.presentations;const pending=f.controller.start();await f.controller.start();expect(f.signals).toHaveLength(1);
  expect(f.controller.state.status).toBe("preparing");expect(f.controller.replacement()).toBeUndefined();
  f.gate.resolve({status:"ready",tab:f.destination});await pending;
  expect(f.controller.state).toEqual({status:"ready",tab:f.destination});expect(f.context.presentations).toBe(before);
  const intent=f.controller.replacement()!;expect(intent.origin).toBe(f.origin);
  const result=replaceBrowserWorkspaceDestination(f.context.presentations,intent.origin,intent.destination,f.owner,"commit")!;
  expect(result.presentations.snapshot.tabs).toEqual([f.destination]);expect(before.snapshot.tabs).toEqual([f.tab]);
  await f.controller.start();expect(f.signals).toHaveLength(1);
});

test("already stale or disconnected selection performs no acquisition",async()=>{
  for(const changed of [{connected:false},{enabled:false},{owner:undefined},{owner:{kind:"chat" as const,hostId:"other",sessionId:"session"}}]) {
    const f=fixture();f.context={...f.context,...changed};await f.controller.start();expect(f.signals).toEqual([]);expect(f.controller.state).toEqual({status:"cancelled",creationMayHaveRun:false});
  }
});

test("committed loss and restoration of eligibility never revives an awaiting action",async()=>{
  for(const reason of ["connection","visibility","route","draft","title","move","close"] as const) {
    const f=fixture(),original=f.context,pending=f.controller.start();
    if(reason==="connection")f.context={...original,connected:false};
    else if(reason==="visibility")f.context={...original,enabled:false};
    else if(reason==="route")f.context={...original,owner:{...f.owner,sessionId:"other"}};
    else {
      let snapshot=original.presentations.snapshot;
      if(reason==="draft")snapshot={...snapshot,tabs:[{...f.tab,browserNewTab:{status:"idle",draft:"edited"}}]};
      if(reason==="title")snapshot={...snapshot,tabs:[{...f.tab,title:"renamed"}]};
      if(reason==="move")snapshot={...snapshot,state:moveDockTab(snapshot.state,f.tab.id,"bottom")};
      if(reason==="close")snapshot={...snapshot,state:closeDockTab(snapshot.state,"right",f.tab.id)};
      f.context={...original,presentations:reconcileDockPresentations(original.presentations,snapshot,"change")};
    }
    f.controller.observe();expect(f.signals[0]?.aborted).toBe(true);f.context=original;f.controller.observe();
    f.gate.resolve({status:"ready",tab:f.destination});await pending;
    expect(f.controller.state).toEqual({status:"cancelled",creationMayHaveRun:true,tab:f.destination});expect(f.controller.replacement()).toBeUndefined();
    await f.controller.start();expect(f.signals).toHaveLength(1);expect(f.context.presentations.snapshot.tabs).toEqual([f.tab]);
  }
});

test("unobserved current loss is still caught after await, with repeated healthy observation allowed",async()=>{
  const f=fixture(),pending=f.controller.start();f.controller.observe();f.controller.observe();f.context={...f.context,connected:false};
  f.gate.resolve({status:"ready",tab:f.destination});await pending;expect(f.controller.state.status).toBe("cancelled");expect(f.controller.replacement()).toBeUndefined();
  const healthy=fixture(),normal=healthy.controller.start();healthy.controller.observe();healthy.controller.observe();healthy.gate.resolve({status:"ready",tab:healthy.destination});await normal;expect(healthy.controller.state.status).toBe("ready");
});

test("unknown, thrown, busy and known failure never restart or publish",async()=>{
  const cases:TerminalPreparation[]=[{status:"error",outcome:"unknown",message:"lost ack"},{status:"error",outcome:"not-submitted",message:"offline"},{status:"busy"}];
  for(const value of cases) {
    const f=fixture(),pending=f.controller.start();f.gate.resolve(value);await pending;
    expect(f.controller.state.status).toBe(value.status==="error"&&value.outcome==="unknown"?"unknown":"error");expect(f.controller.replacement()).toBeUndefined();await f.controller.start();expect(f.signals).toHaveLength(1);
  }
  const thrown=fixture(),pending=thrown.controller.start();thrown.gate.reject(new Error("unclassified"));await pending;expect(thrown.controller.state).toEqual({status:"unknown",message:"unclassified"});await thrown.controller.start();expect(thrown.signals).toHaveLength(1);
});

test("late failure after cancellation preserves uncertainty without reviving or notifying a disposed owner",async()=>{
  for(const dispose of [false,true]) {
    const f=fixture(),pending=f.controller.start();if(dispose)f.controller.dispose();else f.controller.cancel();const notifications=f.states.length;
    f.gate.reject(new Error("lost response"));await pending;
    expect(f.controller.state).toEqual({status:"cancelled",creationMayHaveRun:true});expect(f.controller.replacement()).toBeUndefined();await f.controller.start();expect(f.signals).toHaveLength(1);
    if(dispose)expect(f.states).toHaveLength(notifications);
  }
});

test("underlying cancellation with a confirmed result cannot become a ready replacement",async()=>{
  const f=fixture(),pending=f.controller.start();f.gate.resolve({status:"cancelled",creationMayHaveRun:true,tab:f.destination});await pending;
  expect(f.controller.state).toEqual({status:"cancelled",creationMayHaveRun:true,tab:f.destination});expect(f.signals[0]?.aborted).toBe(true);expect(f.controller.replacement()).toBeUndefined();
});

test("wrong-owner or malformed prepared destinations remain unknown without changing the launcher",async()=>{
  for(const tab of [{...fixture().destination,hostId:"foreign"},{...fixture().destination,id:"not-canonical"}]) {
    const f=fixture(),pending=f.controller.start();f.gate.resolve({status:"ready",tab});await pending;
    expect(f.controller.state.status).toBe("unknown");expect(f.controller.replacement()).toBeUndefined();expect(f.context.presentations.snapshot.tabs).toEqual([f.tab]);
  }
});

test("source loss after readiness invalidates intent before dock admission",async()=>{
  const f=fixture(),pending=f.controller.start();f.gate.resolve({status:"ready",tab:f.destination});await pending;
  f.context={...f.context,enabled:false};expect(f.controller.replacement()).toBeUndefined();f.context={...f.context,enabled:true};expect(f.controller.replacement()).toBeUndefined();expect(f.controller.state.status).toBe("cancelled");
});

test("synchronous preparing observer can invalidate before the preparation function is called",async()=>{
  const f=fixture();let calls=0;const controller=new BrowserWorkspaceActionController(f.origin,()=>f.context,async()=>{calls++;return{status:"ready",tab:f.destination};},()=>{f.context={...f.context,enabled:false};});
  await controller.start();expect(calls).toBe(0);expect(controller.state).toEqual({status:"cancelled",creationMayHaveRun:false});
});
