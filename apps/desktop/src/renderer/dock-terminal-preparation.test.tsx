import { expect, test } from "bun:test";
import React from "react";
import type { DesktopBridge, NativeTerminalInfo, TerminalCreationRequest, TerminalCreationResponse, NativeTerminalResult } from "@agent-desktop/shared";
import { defaultWindowView } from "../window-state";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";
import { useWorkbenchDock } from "./use-workbench-dock";
import { TerminalWindowOwner } from "./terminal-window-owner";

const hostId="10000000-0000-4000-8000-000000000001",sessionId="20000000-0000-4000-8000-000000000002";
const epoch="30000000-0000-4000-8000-000000000003",terminalId="40000000-0000-4000-8000-000000000004";
const pane=(id=terminalId,target=sessionId):NativeTerminalInfo=>({id,target:{sessionId:target},cwd:"/fixture/workspace",shell:"fixture",pid:null,cols:120,rows:30,status:"running",createdAt:1,protocol:"tmux-v1",serverGeneration:epoch,geometryRevision:0,inputEpoch:epoch,attachable:true});
const ok=<T,>(value:T):NativeTerminalResult<T>=>({ok:true,value});
function deferred<T>() { let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
const drain=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
/** Real hook and retained owner, controlled React slots and save acknowledgements.
 * No React root, disk/IPC acknowledgement, native manager or terminal process. */
function fixture(options:{query?():Promise<NativeTerminalInfo[]>;create?(request:TerminalCreationRequest):Promise<TerminalCreationResponse>;connected?:boolean}={}) {
  const calls:string[]=[],errors:string[]=[],requests:TerminalCreationRequest[]=[];
  let connected=options.connected??true,enabled=true,host=hostId;
  const entered=deferred<void>();
  const bridge={
    nativeTerminalQuery:async()=>{calls.push("query");return ok({type:"list",terminals:options.query?await options.query():[pane()]});},
    nativeTerminalAction:async()=>{calls.push("unkeyed");throw new Error("Unkeyed create is forbidden");},
    getNativeTerminalCapabilities:async()=>{throw new Error("Not part of acquisition");},
    writeNativeTerminal:async()=>{throw new Error("No terminal input permitted");},
    subscribeNativeTerminals:()=>()=>{},
    getTerminalCreationCapabilities:async()=>{calls.push("capabilities");return ok({version:1,hostId,controlEpoch:epoch});},
    createNativeTerminal:async(request:TerminalCreationRequest)=>{calls.push("create");requests.push(request);entered.resolve();return ok(options.create?await options.create(request):{version:1,hostId,requestId:request.requestId,status:"settled",receipt:{outcome:"completed",terminalId}});},
    observeTerminalCreation:async(request:TerminalCreationRequest)=>{calls.push("inspect");return ok({version:1,hostId,requestId:request.requestId,status:"settled",receipt:{outcome:"completed",terminalId},terminal:pane()});},
  } as unknown as DesktopBridge;
  const source=createBrowserNewTab(hostId,sessionId,"source");source.browserNewTab={status:"idle",draft:"Terminal"};
  const initial={...defaultWindowView(),route:{hostId,sessionId},dock:{state:insertDockTab(createDockState(),source,"right"),tabs:[source]}};
  const slots:any[]=[],queue:Array<()=>void>=[];let cursor=0,disposed=false;
  const internals=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher={useState(init:any){const i=cursor++;if(!(i in slots))slots[i]=typeof init==="function"?init():init;return[slots[i],(next:any)=>queue.push(()=>slots[i]=typeof next==="function"?next(slots[i]):next)];},useRef(init:any){const i=cursor++;return slots[i]??(slots[i]={current:init});},useEffect(){}};
  const owner=new TerminalWindowOwner(bridge,[],()=>queueMicrotask(()=>{if(!disposed)commitSave();}));
  function render(){cursor=0;const previous=internals.H;internals.H=dispatcher;try{return useWorkbenchDock(bridge,initial,host,{sessionId},connected,message=>errors.push(message),undefined,undefined,undefined,undefined,owner);}finally{internals.H=previous;}}
  function commitSave(){const dock=render();owner.commit({hostId:host,target:{sessionId},connected,enabled,presentations:dock.presentations});const value={...initial,dock:dock.persisted,terminalCreations:owner.intents};owner.committed(value);owner.saved(value);}
  commitSave();
  return {render,owner,calls,errors,requests,entered,source,
    commit(change:{connected?:boolean;enabled?:boolean;hostId?:string}){connected=change.connected??connected;enabled=change.enabled??enabled;host=change.hostId??host;commitSave();},
    flush(){while(queue.length)queue.shift()!();commitSave();},dispose(){disposed=true;owner.dispose();}};
}

test("actual hook reuses validated native terminal without create, persistence or source replacement",async()=>{
  const f=fixture();try{const before=JSON.stringify(f.render().snapshot);expect(await f.render().prepareTerminal()).toMatchObject({status:"ready",tab:{terminalId,hostId,target:`session:${sessionId}`}});f.flush();expect(JSON.stringify(f.render().snapshot)).toBe(before);expect(f.calls).toEqual(["query"]);expect(f.owner.intents).toEqual([]);}finally{f.dispose();}
});
test("ordinary Terminal uses keyed preparation and committed dock publication",async()=>{
  const f=fixture({query:async()=>[]});try{await f.render().terminal("bottom");expect(f.render().snapshot.tabs).toEqual([f.source]);expect(f.owner.intents).toHaveLength(1);f.flush();const dock=f.render().snapshot;expect(dock.tabs[1]?.terminalId).toBe(terminalId);expect(dock.state.bottom.tabIds).toHaveLength(1);expect(f.calls).toEqual(["query","capabilities","create","inspect"]);expect(f.requests).toHaveLength(1);expect(f.owner.intents).toEqual([]);}finally{f.dispose();}
});
test("aborted or disconnected hook calls do not query or create",async()=>{
  const f=fixture(),g=fixture({connected:false});try{const abort=new AbortController();abort.abort();expect(await f.render().prepareTerminal(false,abort.signal)).toEqual({status:"cancelled",creationMayHaveRun:false});expect(await g.render().prepareTerminal()).toEqual({status:"cancelled",creationMayHaveRun:false});expect(f.calls).toEqual([]);expect(g.calls).toEqual([]);}finally{f.dispose();g.dispose();}
});
test("query loss and return is latched before either reuse or creation",async()=>{
  for(const values of [[],[pane()]]){const gate=deferred<NativeTerminalInfo[]>(),f=fixture({query:()=>gate.promise});try{const result=f.render().prepareTerminal();f.commit({connected:false});f.commit({connected:true});gate.resolve(values);expect(await result).toEqual({status:"cancelled",creationMayHaveRun:false});expect(f.calls).toEqual(["query"]);expect(f.owner.intents).toEqual([]);}finally{f.dispose();}}
});
test("lost keyed reply remains unknown and blocks subsequent catalogue fallback",async()=>{
  const f=fixture({query:async()=>[],create:async()=>{throw new Error("lost reply");}});try{expect(await f.render().prepareTerminal()).toMatchObject({status:"error",outcome:"unknown"});const intent=f.owner.intents[0]!;expect(intent).toBeDefined();expect(await f.render().prepareTerminal()).toMatchObject({status:"error",outcome:"not-submitted"});expect(f.calls).toEqual(["query","capabilities","create"]);expect(f.owner.intents).toEqual([intent]);expect(f.render().snapshot.tabs).toEqual([f.source]);}finally{f.dispose();}
});
test("late cancelled create yields no untrusted tab or replay, preserving its saved request",async()=>{
  const gate=deferred<TerminalCreationResponse>(),f=fixture({query:async()=>[],create:()=>gate.promise}),abort=new AbortController();try{const result=f.render().prepareTerminal(false,abort.signal);await f.entered.promise;abort.abort();gate.resolve({version:1,hostId,requestId:f.requests[0]!.requestId,status:"settled",receipt:{outcome:"completed",terminalId}});expect(await result).toEqual({status:"cancelled",creationMayHaveRun:true});expect(f.owner.intents).toHaveLength(1);expect(f.calls).toEqual(["query","capabilities","create"]);expect(f.render().snapshot.tabs).toEqual([f.source]);}finally{f.dispose();}
});
test("malformed catalog identities including foreign rows block both reuse and explicit create",async()=>{
  for(const id of [undefined,null,"",42,"contains space","slash/id","colon:id","bad\0id","x".repeat(201)])for(const create of [false,true]){const f=fixture({query:async()=>[{...pane(),id} as NativeTerminalInfo]});try{expect(await f.render().prepareTerminal(create)).toMatchObject({status:"error",outcome:"not-submitted"});expect(f.calls).toEqual(["query"]);expect(f.owner.intents).toEqual([]);}finally{f.dispose();}}
  const f=fixture({query:async()=>[pane("bad id",epoch)]});try{expect(await f.render().prepareTerminal()).toMatchObject({status:"error",outcome:"not-submitted"});expect(f.calls).toEqual(["query"]);}finally{f.dispose();}
});
test("invalid sent receipt is unknown while valid legacy IDs remain reusable",async()=>{
  for(const id of [undefined,null,"",42,"bad id"]){const f=fixture({query:async()=>[],create:async request=>({version:1,hostId,requestId:request.requestId,status:"settled",receipt:{outcome:"completed",terminalId:id}} as TerminalCreationResponse)});try{expect(await f.render().prepareTerminal()).toMatchObject({status:"error",outcome:"unknown"});expect(f.owner.intents).toHaveLength(1);expect(f.calls).toEqual(["query","capabilities","create"]);}finally{f.dispose();}}
  for(const id of ["a","ABC_123-valid","x".repeat(200)]){const f=fixture({query:async()=>[pane(id)]});try{expect(await f.render().prepareTerminal()).toMatchObject({status:"ready",tab:{terminalId:id}});expect(f.calls).toEqual(["query"]);}finally{f.dispose();}}
});
test("queued ordinary publication rejects route loss and return after ready",async()=>{
  const f=fixture();try{await f.render().terminal("right");f.commit({hostId:epoch});f.commit({hostId});f.flush();expect(f.render().snapshot.tabs).toEqual([f.source]);expect(f.calls).toEqual(["query"]);}finally{f.dispose();}
});
test("query failure is not-submitted and concurrent preparations serialize before query reply",async()=>{
  const gate=deferred<NativeTerminalInfo[]>(),f=fixture({query:()=>gate.promise});try{const result=f.render().prepareTerminal();expect(await f.render().prepareTerminal()).toEqual({status:"busy"});gate.reject(new Error("catalog unavailable"));expect(await result).toEqual({status:"error",outcome:"not-submitted",message:"catalog unavailable"});expect(f.calls).toEqual(["query"]);expect(f.owner.intents).toEqual([]);}finally{f.dispose();}
});
test("explicit New terminal validates catalogue then creates once despite an existing shell",async()=>{
  const f=fixture();try{expect((await f.render().prepareTerminal(true)).status).toBe("ready");expect(f.calls).toEqual(["query","capabilities","create","inspect"]);expect(f.requests).toHaveLength(1);}finally{f.dispose();}
});
