import { expect, test } from "bun:test";
import React from "react";
import { BrowserNewTabPanel } from "./BrowserNewTabPanel";
import { BrowserAddressInput } from "./BrowserAddressInput";
import { BrowserNewTabController } from "./browser-new-tab";
import type { BrowserWorkspaceMenuState } from "./browser-workspace-menu";
import type { DesktopBridge } from "@agent-desktop/shared";
import { useWorkbenchDock as CurrentWorkbenchDock } from "./use-workbench-dock";
const useWorkbenchDock:typeof CurrentWorkbenchDock=process.env.AGENT_DESKTOP_BROWSER_ADMISSION_HOOK
  ? (await import(process.env.AGENT_DESKTOP_BROWSER_ADMISSION_HOOK)).useWorkbenchDock : CurrentWorkbenchDock;
import { defaultWindowView } from "../window-state";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab, dockTabId, type DockTab } from "./dock-state";
import { captureBrowserReplacement } from "./browser-workspace-replacement";
import { admitBrowserReplacement, acknowledgeBrowserAdmissions, prepareBrowserReplacementFocus, rememberBrowserAddressFocus, type BrowserReplacementPresentations } from "./browser-replacement-admission";
import { reconcileDockPresentations, captureDockPresentation } from "./dock-presentations";
const owner={kind:"chat" as const,hostId:"owner",sessionId:"session"};
const descriptor={kind:"files" as const,hostId:"owner",target:"session:session" as const,title:"Open file"};
const files:DockTab={...descriptor,id:dockTabId(descriptor)};
function sourceState(){const source=createBrowserNewTab("owner","session","one");return{source,presentations:reconcileDockPresentations(undefined,{tabs:[source],state:insertDockTab(createDockState(),source,"right")},"initial")};}

test("actual hook exposes a committed result after replacement and preserves it across unrelated queued updates until acknowledged",()=>{
  const {source,presentations}=sourceState(),initial={...defaultWindowView(),dock:presentations.snapshot};
  const slots:any[]=[],queue:Array<()=>void>=[];let cursor=0;
  const internals=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher={useState(init:any){const i=cursor++;if(!(i in slots))slots[i]=typeof init==="function"?init():init;return[slots[i],(next:any)=>queue.push(()=>slots[i]=typeof next==="function"?next(slots[i]):next)];},useRef(init:any){const i=cursor++;return slots[i]??(slots[i]={current:init});},useEffect(){}};
  const forbidden=new Proxy({},{get(_target,key){return()=>{throw new Error(`unexpected bridge ${String(key)}`);};}}) as DesktopBridge;
  const render=()=>{cursor=0;const old=internals.H;internals.H=dispatcher;try{return useWorkbenchDock(forbidden,initial,"owner",{sessionId:"session"},true,()=>{});}finally{internals.H=old;}};
  let dock=render();const origin=captureBrowserReplacement(dock.presentations,source.id,owner)!;
  const request=dock.replaceBrowserDestination(origin,{kind:"opened",tab:files},()=>owner);
  dock.updateTitle(source.id,"unrelated queued title update after replacement");
  expect(dock.presentations.browserAdmissions).toBeUndefined();expect(dock.snapshot.tabs).toEqual([source]);
  while(queue.length)queue.shift()!();dock=render();
  expect(dock.snapshot.tabs).toEqual([files]);expect(dock.presentations.browserAdmissions?.get(request)).toMatchObject({id:request,owner,focus:{tabId:files.id}});
  expect((dock.persisted as any).browserAdmissions).toBeUndefined();
  dock.acknowledgeBrowserReplacements([request]);while(queue.length)queue.shift()!();expect(render().presentations.browserAdmissions?.size).toBe(0);
});

test("queued rejection produces a failed result with unchanged source, and acknowledgement cannot erase another result",()=>{
  const {source,presentations}=sourceState(),origin=captureBrowserReplacement(presentations,source.id,owner)!;
  let current=admitBrowserReplacement(presentations,origin,{kind:"chat",target:owner},undefined,"one");
  expect(current.snapshot.tabs).toEqual([source]);expect(current.browserAdmissions?.get("one")?.focus).toBeUndefined();
  current=admitBrowserReplacement(current,origin,{kind:"opened",tab:files},owner,"two");expect(current.snapshot.tabs).toEqual([files]);
  expect([...current.browserAdmissions!.keys()]).toEqual(["one","two"]);
  const replay=admitBrowserReplacement(current,origin,{kind:"chat",target:owner},owner,"two");expect(replay).toBe(current);
  current=acknowledgeBrowserAdmissions(current,["one"]);expect([...current.browserAdmissions!.keys()]).toEqual(["two"]);
});

test("post-commit focus covers Chat/right/Bottom and refuses route, incarnation, node replacement or intervening focus",()=>{
  const css=Object.getOwnPropertyDescriptor(globalThis,"CSS");Object.defineProperty(globalThis,"CSS",{configurable:true,value:{escape:(text:string)=>text}});
  try {for(const destination of ["chat","right","bottom"] as const){
    const f=sourceState();let context:{presentations:BrowserReplacementPresentations;owner?:typeof owner}={presentations:f.presentations,owner};
    if(destination!=="chat")context.presentations=reconcileDockPresentations(f.presentations,{tabs:[files],state:insertDockTab(createDockState(),files,destination)},"opened");
    const focus=destination==="chat"?owner:captureDockPresentation(context.presentations,files.id)!;
    const admission={id:"one",owner,focus};let focused=0,currentNode:any;
    const doc={activeElement:{} as object},node={isConnected:true,closest:()=>null,getClientRects:()=>[{}],contains:(item:object)=>item===node,focus(){focused++;doc.activeElement=node;}};
    currentNode=node;const root={isConnected:true,dataset:{browserCurrentOwner:JSON.stringify([owner.hostId,owner.sessionId])},ownerDocument:doc,querySelector:()=>currentNode} as unknown as HTMLElement;
    let run=prepareBrowserReplacementFocus(root,admission,()=>context)!;expect(run()).toBe(true);expect(focused).toBe(1);
    doc.activeElement={};run=prepareBrowserReplacementFocus(root,admission,()=>context)!;context={...context,owner:undefined};expect(run()).toBe(false);context={...context,owner};
    run=prepareBrowserReplacementFocus(root,admission,()=>context)!;currentNode={...node};expect(run()).toBe(false);currentNode=node;
    run=prepareBrowserReplacementFocus(root,admission,()=>context)!;doc.activeElement={};expect(run()).toBe(false);
    if(destination!=="chat"){
      run=prepareBrowserReplacementFocus(root,admission,()=>context)!;
      context={...context,presentations:{...context.presentations,instances:new Map([[files.id,"new-instance"]])}};expect(run()).toBe(false);
    }
    expect(focused).toBe(1);
  }}finally{if(css)Object.defineProperty(globalThis,"CSS",css);else Reflect.deleteProperty(globalThis,"CSS");}
});

test("focus permission remembers the original address field before a slow preparation",()=>{
  const css=Object.getOwnPropertyDescriptor(globalThis,"CSS");Object.defineProperty(globalThis,"CSS",{configurable:true,value:{escape:(text:string)=>text}});
  try{
    const {source,presentations}=sourceState(),origin=captureBrowserReplacement(presentations,source.id,owner)!;
    const input={isConnected:true,dataset:{browserAddressOwner:JSON.stringify([owner.hostId,owner.sessionId])}},body={};
    const document={activeElement:input as object,body};
    const root={isConnected:true,ownerDocument:document,querySelector:()=>input} as unknown as HTMLElement;
    const allowed=rememberBrowserAddressFocus(root,origin);expect(allowed()).toBe(true);
    document.activeElement={};expect(allowed()).toBe(false);
    document.activeElement=body;expect(allowed()).toBe(false);input.isConnected=false;expect(allowed()).toBe(true);
    document.activeElement={};expect(allowed()).toBe(false);
    expect(rememberBrowserAddressFocus(root,origin)()).toBe(false);
  }finally{if(css)Object.defineProperty(globalThis,"CSS",css);else Reflect.deleteProperty(globalThis,"CSS");}
});

test("actual launcher consumer fences URL submit and draft cancellation while a workspace action is unresolved",async()=>{
  for(const workspaceState of [{status:"preparing"},{status:"committing"},{status:"ready",tab:files},{status:"unknown",message:"Lost result"},{status:"cancelled",creationMayHaveRun:true}] satisfies BrowserWorkspaceMenuState[]){
    const source=createBrowserNewTab("owner","session","input");let calls=0;
    const bridge={getBrowserMetadata:async()=>{calls++;throw new Error("controlled refusal");}} as unknown as DesktopBridge;
    const controller=new BrowserNewTabController(bridge,source,()=>{},()=>{},async()=>{});controller.connected=true;controller.edit("retained draft");
    const internals=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,old=internals.H;
    internals.H={useRef:(value:unknown)=>({current:value}),useLayoutEffect(){},useEffect(){}};
    let tree:any;try{tree=BrowserNewTabPanel({controller,active:true,workspaceState});}finally{internals.H=old;}
    const find=(node:any,type:unknown):any=>{if(!node||typeof node!=="object")return undefined;if(Array.isArray(node))return node.map(child=>find(child,type)).find(Boolean);return node.type===type?node:find(node.props?.children,type);};
    const field=find(tree,BrowserAddressInput);expect(field.props.readOnly).toBe(true);field.props.onSubmit();field.props.onChange("discarded");field.props.onCancel();
    find(tree,"form").props.onSubmit({preventDefault(){}});await Promise.resolve();
    expect(calls).toBe(0);expect(controller.state.draft).toBe("retained draft");controller.dispose();
  }
});
