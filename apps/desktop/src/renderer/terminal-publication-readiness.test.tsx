import { expect, test } from "bun:test";
import React from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import { defaultWindowView } from "../window-state";
import { dockTabId, type DockTab } from "./dock-state";
const { useWorkbenchDock }: typeof import("./use-workbench-dock") = await import(process.env.TERMINAL_PUBLICATION_HOOK_SOURCE ?? "./use-workbench-dock");

/** Actual hook with deferred state updates and intentionally undelivered effects.
 * This isolates publication before legacy initialization, not native scheduling. */
function fixture() {
  const slots:any[]=[],queue:Array<()=>void>=[];let cursor=0;
  const dispatcher={useState(init:any){const i=cursor++;if(!(i in slots))slots[i]=typeof init==="function"?init():init;
    return[slots[i],(value:any)=>queue.push(()=>{slots[i]=typeof value==="function"?value(slots[i]):value;})];},
    useRef(init:any){const i=cursor++;return slots[i]??(slots[i]={current:init});},useEffect(){cursor++;}};
  const internal=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const initial={...defaultWindowView(),workspaceOpen:true,terminalOpen:false,dock:undefined};
  const bridge=new Proxy({}, {get(){throw new Error("Publication must not call the bridge");}}) as DesktopBridge;
  function render(){cursor=0;const prior=internal.H;internal.H=dispatcher;
    try{return useWorkbenchDock(bridge,initial,"host",{sessionId:"session"},true,message=>{throw new Error(message);});}
    finally{internal.H=prior;}}
  return {render,flush(){while(queue.length)queue.shift()!();return render();},queue};
}
function terminal(title="Shell"):DockTab {
  const tab={kind:"terminal" as const,hostId:"host",target:"session:session" as const,terminalId:"native-terminal",title};
  return{...tab,id:dockTabId(tab)};
}

for(const destination of ["right","bottom"] as const){
  test(`guarded terminal publication enters saved ${destination} layout before legacy initialization`,()=>{
    const f=fixture(),before=f.render(),tab=terminal();expect(before.persisted).toBeUndefined();
    before.publishTerminal(tab,destination,()=>true);
    expect(f.render().persisted).toBeUndefined();
    const after=f.flush();expect(after.persisted?.tabs).toEqual([tab]);
    expect(after.persisted?.state[destination]).toMatchObject({open:true,activeTabId:tab.id,tabIds:[tab.id]});
    after.publishTerminal({...tab,title:"Replacement must not overwrite the existing title"},destination,()=>true);
    expect(f.flush().persisted?.tabs).toEqual([tab]);
  });
}

test("a publication guard revoked before queued updates preserves an uninitialized legacy layout",()=>{
  const f=fixture();let allowed=true;
  f.render().publishTerminal(terminal(),"bottom",()=>allowed);allowed=false;
  const after=f.flush();expect(after.persisted).toBeUndefined();expect(after.presentations.snapshot.tabs).toEqual([]);
  expect(after.presentations.snapshot.state.bottom.open).toBe(false);
  allowed=true;after.publishTerminal(terminal(),"bottom",()=>allowed);
  expect(f.flush().persisted?.tabs).toEqual([terminal()]);
});

test("failed guard preserves an already-ready dock and ordinary add still saves",()=>{
  const f=fixture();f.render().open("files","right");const ready=f.flush(),saved=ready.persisted;
  expect(saved?.tabs).toHaveLength(1);expect(saved?.tabs[0]?.kind).toBe("files");
  ready.publishTerminal(terminal(),"bottom",()=>false);
  expect(f.flush().persisted).toEqual(saved);
});
