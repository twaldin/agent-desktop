import { useEffect, useRef, type MouseEvent } from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import { taskPlacementItems, placeTask, type PhysicalPane } from "./content-side-placement";
import { sameMainTask, type MainTaskSnapshot, type MainTaskTarget, type MainChatTarget } from "./main-task-targets";

/** Native menu completion is asynchronous; its source tab and current route must still be owned. */
export function useTaskPlacementMenu(bridge:DesktopBridge,snapshot:MainTaskSnapshot,chat:MainChatTarget,active:boolean,onPlace:(change:NonNullable<ReturnType<typeof placeTask>>)=>void,onError:(message:string)=>void) {
  const latest=useRef({bridge,snapshot,chat,active,onPlace,onError});latest.current={bridge,snapshot,chat,active,onPlace,onError};
  const epoch=useRef(0);
  useEffect(()=>()=>{epoch.current++;},[bridge,chat.hostId,chat.sessionId,active]);
  return async(event:MouseEvent,target:MainTaskTarget)=>{
    if(!active || !bridge.showContextMenu) return;
    event.preventDefault();event.stopPropagation();
    const items=taskPlacementItems(snapshot,chat,target);if(!items.length) return;
    const token=++epoch.current;
    const owned=()=> token===epoch.current && latest.current.active && latest.current.bridge===bridge && sameMainTask(latest.current.chat,chat);
    try {
      const id=await bridge.showContextMenu(items);
      if(!owned() || !items.some(item=>item.id===id && item.enabled)) return;
      const current=latest.current;
      if(!taskPlacementItems(current.snapshot,current.chat,target).some(item=>item.id===id && item.enabled)) return;
      const to=id!.slice("unified-workspace-move-".length) as PhysicalPane;
      const change=placeTask(current.snapshot,current.chat,target,to);if(change) current.onPlace(change);
    } catch(cause) {if(owned()) latest.current.onError(cause instanceof Error ? cause.message : String(cause));}
  };
}
