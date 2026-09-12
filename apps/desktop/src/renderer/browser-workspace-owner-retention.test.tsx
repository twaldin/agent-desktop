import { expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import type { DesktopBridge, WorkspaceTarget } from "@agent-desktop/shared";
import { BrowserWorkspaceMenu as CurrentMenu, browserWorkspaceRows } from "./browser-workspace-menu";
import { useWorkbenchDock as CurrentHook, type TerminalPreparation } from "./use-workbench-dock";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab, dockTabId, type DockTab } from "./dock-state";
import { defaultWindowView } from "../window-state";
import type { DockAddAction } from "./DockPanel";
const Menu: typeof CurrentMenu = process.env.AGENT_DESKTOP_WORKSPACE_CORRECTION_MENU
  ? (await import(process.env.AGENT_DESKTOP_WORKSPACE_CORRECTION_MENU)).BrowserWorkspaceMenu : CurrentMenu;
const Hook: typeof CurrentHook = process.env.AGENT_DESKTOP_WORKSPACE_CORRECTION_HOOK
  ? (await import(process.env.AGENT_DESKTOP_WORKSPACE_CORRECTION_HOOK)).useWorkbenchDock : CurrentHook;
const oldOwner = {kind:"chat" as const,hostId:"owner",sessionId:"old"};
const newOwner = {...oldOwner,sessionId:"new"};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
/** Controlled private React dispatcher: queues state and explicitly executes recorded
 * commit effects. It does not create an actual React root, DOM or native view. */
function driver() {
  const slots: any[] = [], queued: Array<() => void> = []; let cursor = 0, effects: Array<() => void> = [];
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const useEffect = (callback: () => void, deps: unknown[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => v !== old[n])) { slots[i] = deps; effects.push(callback); } };
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value: any) => queued.push(() => { slots[i] = typeof value === "function" ? value(slots[i]) : value; })]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useEffect, useLayoutEffect: useEffect,
  };
  return { render<T>(callback: () => T, commit = true): { result: T; commit(): void } {
    while (queued.length) queued.shift()!(); cursor = 0; effects = [];
    const old = internals.H; internals.H = dispatcher;
    try { const result = callback(), pending = effects; const finish = () => { for (const effect of pending) effect(); };
      if (commit) finish(); return { result, commit: finish }; } finally { internals.H = old; }
  } };
}

function fixture(destination: "right"|"bottom" = "right") {
  const source=createBrowserNewTab("owner","old","untouched");
  const initial={...defaultWindowView(),dock:{tabs:[source],state:insertDockTab(createDockState(),source,destination)}};
  const hooks=driver(),menu=new Menu(()=>{}),calls:string[]=[];
  const bridge=new Proxy({}, {get(_object,key){return()=>{calls.push(String(key));throw new Error("Forbidden native dispatch");};}}) as DesktopBridge;
  let owner=oldOwner,target:WorkspaceTarget|undefined={sessionId:"old"}, actions:DockAddAction[]=[];
  const render=()=>{
    const dock=hooks.render(()=>Hook(bridge,initial,"owner",target,true,()=>{},undefined,undefined,undefined,
      (presentations,id)=>menu.retainsSource(presentations,id))).result;
    menu.commit({presentations:dock.presentations,owner,enabled:true,connected:true,actions,chatTitle:"Chat",replace:dock.replaceBrowserDestination});
    return dock;
  };
  let dock=render();dock.browserLauncher(source,true).observePresentation();
  return {source,menu,calls,render,
    setOwner(value:typeof owner){owner=value;},setTarget(value:WorkspaceTarget|undefined){target=value;},
    setActions(value:DockAddAction[]){actions=value;},
    choose(){const context=menu.committedContext!;const row=browserWorkspaceRows(context,source.id,"","en")[0];if(!row)throw new Error("Missing controlled action row");return{row,chosen:menu.choose(row)};},
  };
}
const action=(prepare:NonNullable<DockAddAction["prepare"]>,binding={hostId:"owner",target:"session:old" as DockTab["target"]}):DockAddAction=>({id:"terminal",label:"Terminal",icon:"terminal",preparationTarget:binding,prepare,onSelect:()=>{throw new Error("Wrong dispatch path");}});

for(const destination of ["right","bottom"] as const) test(`sent pristine ${destination} source survives conversation cleanup and retains late unknown without replay`,async()=>{
  const f=fixture(destination),gate=deferred<TerminalPreparation>();let calls=0,signal:AbortSignal|undefined;
  f.setActions([action(s=>{calls++;signal=s;return gate.promise;})]);let dock=f.render();
  const {row,chosen}=f.choose();expect(chosen).toBe(true);expect(calls).toBe(1);
  expect(f.source.browserNewTab).toEqual({status:"idle"});
  dock.leaveBrowserConversation(oldOwner,newOwner);f.setOwner(newOwner);dock=f.render();
  expect(dock.snapshot.tabs.some(tab=>tab.id===f.source.id)).toBe(true);expect(signal?.aborted).toBe(true);
  gate.resolve({status:"error",outcome:"unknown",message:"Sent native reply lost"});await settle();dock=f.render();
  expect(f.menu.state(row.origin.presentation.instanceId)).toMatchObject({status:"cancelled",creationMayHaveRun:true});
  f.setOwner(oldOwner);dock=f.render();dock.leaveBrowserConversation(oldOwner,newOwner);dock=f.render();
  expect(dock.snapshot.tabs.some(tab=>tab.id===f.source.id)).toBe(true);
  expect(f.choose().chosen).toBe(false);expect(calls).toBe(1);expect(f.calls).toEqual([]);f.menu.dispose();
});

test("unknown pristine singleton is hidden by Step workspace layout, never deleted or forgotten",async()=>{
  const f=fixture();let calls=0;f.setActions([action(async()=>{calls++;return{status:"error",outcome:"unknown",message:"Sent reply lost"};})]);
  let dock=f.render();const {row}=f.choose();await settle();dock=f.render();
  expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("unknown");
  dock.stepLayout(oldOwner,false);dock=f.render();
  expect(dock.snapshot.tabs.some(tab=>tab.id===f.source.id)).toBe(true);expect(dock.snapshot.state.right.open).toBe(false);
  expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("unknown");
  dock.toggle("right");dock=f.render();expect(f.choose().chosen).toBe(false);expect(calls).toBe(1);expect(f.calls).toEqual([]);f.menu.dispose();
});

test("ordinary pristine cleanup still removes eligible launchers; definite unsent errors release protection",async()=>{
  for(const path of ["conversation","step"] as const){
    const f=fixture();f.setActions([action(async()=>({status:"error",outcome:"not-submitted",message:"Not sent"}))]);
    let dock=f.render();f.choose();await settle();dock=f.render();
    if(path==="conversation")dock.leaveBrowserConversation(oldOwner,newOwner);else dock.stepLayout(oldOwner,false);
    dock=f.render();expect(dock.snapshot.tabs).toEqual([]);expect(f.calls).toEqual([]);f.menu.dispose();
  }
});

test("queued cleanup rechecks an attempt begun after cleanup was enqueued",async()=>{
  const f=fixture(),gate=deferred<TerminalPreparation>();f.setActions([action(()=>gate.promise)]);
  let dock=f.render();dock.leaveBrowserConversation(oldOwner,newOwner);
  const {row}=f.choose();dock=f.render();expect(dock.snapshot.tabs.some(tab=>tab.id===f.source.id)).toBe(true);
  gate.resolve({status:"error",outcome:"unknown",message:"Unknown"});await settle();dock=f.render();
  expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("unknown");f.menu.dispose();
});

test("a changed shared preparation binding is rejected before actual hook native query or create",()=>{
  for(const binding of [{hostId:"owner",target:"project:project" as const},{hostId:"foreign",target:"session:old" as const}]){
    const f=fixture();f.setActions([action(async()=>({status:"busy"}))]);f.render();
    const row=browserWorkspaceRows(f.menu.committedContext!,f.source.id,"","en")[0]!;
    f.setTarget({projectId:"project"});const dock=f.render();
    f.setActions([action(signal=>dock.prepareTerminal(false,signal),binding)]);f.render();
    expect(f.menu.choose(row)).toBe(false);expect(f.calls).toEqual([]);expect(browserWorkspaceRows(f.menu.committedContext!,f.source.id,"","en")).toEqual([]);f.menu.dispose();
  }
});

test("preparation availability loss between starting notice and dispatch never calls the captured owner",async()=>{
  const f=fixture();let calls=0;f.setActions([action(async()=>{calls++;return{status:"busy"};})]);f.render();
  const context=f.menu.committedContext!,row=browserWorkspaceRows(context,f.source.id,"","en")[0]!;
  let menu!:CurrentMenu;
  menu=new Menu(()=>{if(menu.state(row.origin.presentation.instanceId)?.status==="preparing")menu.commit({...context,actions:[action(async()=>{calls++;return{status:"busy"};},{hostId:"owner",target:"project:project"})]});});
  menu.commit(context);expect(menu.choose(row)).toBe(true);await settle();
  expect(calls).toBe(0);expect(menu.state(row.origin.presentation.instanceId)).toEqual({status:"cancelled",creationMayHaveRun:false});menu.dispose();f.menu.dispose();
});

test("App selected-session metadata gap cannot become a project workspace",()=>{
  const source=readFileSync(process.env.AGENT_DESKTOP_WORKSPACE_CORRECTION_APP??new URL("./App.tsx",import.meta.url),"utf8");
  const expression=source.match(/const workspaceTarget: WorkspaceTarget \| undefined = ([^;]+);/)?.[1];if(!expression)throw new Error("Missing actual App workspace expression");
  const target=new Function("selectedId","selected","project",`return (${expression});`);
  expect(target("old",null,{id:"project"})).toBeUndefined();
  expect(target("old",{id:"old"},{id:"project"})).toEqual({sessionId:"old"});
  expect(target(null,null,{id:"project"})).toEqual({projectId:"project"});expect(target(null,null,undefined)).toBeUndefined();
});
