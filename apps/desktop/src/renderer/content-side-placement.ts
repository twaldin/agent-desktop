import { activateDockTab, dockTabId, moveDockTab, setRightDockFullWidth, resizeDock, type ContentSide, type DockDestination, type DockState, type DockViewport, type DockTabKind } from "./dock-state";
import { mainTaskTargets, sameMainTask, type MainTaskTarget, type MainChatTarget, type MainTaskSnapshot } from "./main-task-targets";

/** Main-process storage retains legacy absence; only the renderer owns direction. */
export function resolveContentSide(state: Pick<DockState,"contentSide"> | undefined, direction: "ltr" | "rtl" = "ltr"): ContentSide {
  return state?.contentSide ?? (direction === "rtl" ? "left" : "right");
}

/** Placement does not transfer tabs, replace controllers, or change full/restore state. */
export function setContentSide(state: DockState, side: ContentSide): DockState {
  return state.contentSide === side ? state : {...state,contentSide:side};
}

export function resizeDockFromPointer(state: DockState, destination: DockDestination, viewport: DockViewport, point: {clientX:number;clientY:number}): DockState {
  const size=destination === "bottom" ? (viewport.top ?? 0)+viewport.height-point.clientY
    : resolveContentSide(state) === "left" ? point.clientX-(viewport.left ?? 0)
    : (viewport.left ?? 0)+viewport.width-point.clientX;
  return resizeDock(state,destination,size,viewport);
}

/** Arrows move the physical divider, independently of document direction. */
export function resizeDockFromKey(state: DockState, destination: DockDestination, viewport: DockViewport, key:string): DockState | undefined {
  if(key === "Home" || key === "End") return resizeDock(state,destination,key === "Home" ? 0 : Number.MAX_SAFE_INTEGER,viewport);
  const current=destination === "bottom" ? state.bottomHeight : state.rightWidthRatio*viewport.width;
  const delta=destination === "bottom" ? key === "ArrowUp" ? 16 : key === "ArrowDown" ? -16 : undefined
    : key === "ArrowLeft" ? -16 : key === "ArrowRight" ? 16 : undefined;
  if(delta === undefined) return;
  return resizeDock(state,destination,current+delta*(destination === "right" && resolveContentSide(state) === "right" ? -1 : 1),viewport);
}


export type PhysicalPane = ContentSide | "bottom";
export interface TaskPlacementItem {id:string;label:string;enabled:boolean}
// App tab registry: core terminal supports Bottom. The app's goal/worktrees/skill
// adaptations retain the horizontal default; Sources/writing-block are not these kinds.
const horizontal:readonly PhysicalPane[]=["left","right"];
const destinations:Record<DockTabKind,readonly PhysicalPane[]>={
  "terminal":["left","right","bottom"],"browser":horizontal,"review":horizontal,
  "file":horizontal,"files":horizontal,"skill-file":horizontal,"side-chat":horizontal,
  "goal":horizontal,"worktrees":horizontal,"mcp-app":horizontal,
};
export function taskDropDestinations(snapshot:MainTaskSnapshot,chat:MainChatTarget,target:MainTaskTarget):readonly PhysicalPane[] {
  if(target.kind === "chat") return sameMainTask(chat,target) && mainTaskTargets(snapshot,chat).length>1 ? horizontal : [];
  const tab=ownedContent(snapshot,target);return tab ? destinations[tab.kind] : [];
}

function ownedContent(snapshot: MainTaskSnapshot, target: MainTaskTarget) {
  if(target.kind !== "content") return;
  const tab=snapshot.tabs.find(tab=>tab.id===target.tabId && tab.hostId===target.hostId && tab.target===target.target && tab.id===dockTabId(tab));
  return tab && (snapshot.state.right.tabIds.includes(tab.id) || snapshot.state.bottom.tabIds.includes(tab.id)) ? tab : undefined;
}
export function taskPlacementItems(snapshot: MainTaskSnapshot, chat: MainChatTarget, target: MainTaskTarget): TaskPlacementItem[] {
  if(target.kind === "chat" ? !sameMainTask(chat,target) : !ownedContent(snapshot,target)) return [];
  const fromBottom=target.kind === "content" && snapshot.state.bottom.tabIds.includes(target.tabId);
  const split=snapshot.state.right.open && snapshot.state.rightLayout !== "full";
  const side=resolveContentSide(snapshot.state);
  const current:PhysicalPane | undefined=fromBottom ? "bottom" : split ? target.kind === "chat" ? side === "left" ? "right" : "left" : snapshot.state.right.activeTabId===target.tabId ? side : undefined : undefined;
  const movable=target.kind === "content" || mainTaskTargets(snapshot,chat).length>1;
  const allowed=taskDropDestinations(snapshot,chat,target);
  const items:TaskPlacementItem[]=(["left","right"] as const).map(to=>({id:`unified-workspace-move-${to}`,label:`Move to ${to} pane`,enabled:movable && current!==to && allowed.includes(to)}));
  if(!fromBottom && allowed.includes("bottom")) items.push({id:"unified-workspace-move-bottom",label:"Move to bottom pane",enabled:true});
  return items;
}

/** Revalidate the full tab owner against current state after any async menu/drag. */
export function placeTask(snapshot: MainTaskSnapshot, chat: MainChatTarget, target: MainTaskTarget, to: PhysicalPane): {state:DockState;focusTarget:MainTaskTarget} | undefined {
  if(!taskDropDestinations(snapshot,chat,target).includes(to)) return;
  if(target.kind === "chat") {
    if(to === "bottom" || !sameMainTask(chat,target)) return;
    const targets=mainTaskTargets(snapshot,chat);
    const content=targets.find(target=>target.kind==="content" && target.tabId===snapshot.state.right.activeTabId) ?? targets[1];
    if(!content || content.kind!=="content") return;
    const next=activateDockTab(snapshot.state,"right",content.tabId);
    return {state:setContentSide(setRightDockFullWidth(next,false),to === "left" ? "right" : "left"),focusTarget:chat};
  }
  if(!ownedContent(snapshot,target)) return;
  const destination=to === "bottom" ? "bottom" : "right";
  // Same-controller placement activates without a reorder; transfer retains owner identity.
  const next=snapshot.state[destination].tabIds.includes(target.tabId) ? activateDockTab(snapshot.state,destination,target.tabId) : moveDockTab(snapshot.state,target.tabId,destination);
  if(to === "bottom" && snapshot.state.rightLayout === "full" && !next.right.open) next.rightLayout="restore-full";
  return {state:to === "bottom" ? next : setContentSide(setRightDockFullWidth(next,false),to),focusTarget:target};
}

export interface PaneRectangle {left:number;top:number;width:number;height:number}
export interface PaneDropGeometry {side:PhysicalPane;target:PaneRectangle;preview:PaneRectangle;fraction:number}
/** Pinned edge targets are the outer quarters; previews use the resulting pane size. */
export function taskDropGeometry(snapshot:MainTaskSnapshot,chat:MainChatTarget,target:MainTaskTarget,viewport:DockViewport):PaneDropGeometry[] {
  const allowed=taskDropDestinations(snapshot,chat,target),width=Math.max(0,viewport.width),height=Math.max(0,viewport.height);
  if(!width || !height) return [];
  const left=viewport.left ?? 0,top=viewport.top ?? 0;
  const bottomHeight=snapshot.state.bottom.open ? Math.min(height/2,snapshot.state.bottomHeight) : height/4;
  const bottomTarget=allowed.includes("bottom") ? bottomHeight : 0;
  const leavingLastBottom=target.kind==="content" && snapshot.state.bottom.tabIds.length===1 && snapshot.state.bottom.tabIds[0]===target.tabId;
  const bottomInset=snapshot.state.bottom.open && !leavingLastBottom ? Math.min(height/2,snapshot.state.bottomHeight) : 0;
  // The existing app width contract leaves 352px to Chat; all preview/layout consumers share it.
  const contentWidth=Math.min(width,Math.max(320,Math.min(width-352,snapshot.state.rightWidthRatio*width)));
  const paneWidth=target.kind==="chat" ? width-contentWidth : contentWidth;
  return allowed.map(side=>{
    const targetRect=side==="bottom" ? {left,top:top+height-bottomHeight,width,height:bottomHeight} : {left:left+(side==="left"?0:width*.75),top,width:width/4,height:height-bottomTarget};
    const preview=side==="bottom" ? targetRect : {left:left+(side==="left"?0:width-paneWidth),top,width:paneWidth,height:height-bottomInset};
    return {side,target:targetRect,preview,fraction:Math.min(1,side==="bottom" ? preview.height/height : paneWidth/width)};
  });
}
export function paneDropAt(geometry:readonly PaneDropGeometry[],point:{clientX:number;clientY:number}):PhysicalPane|undefined {
  return geometry.find(({target:r})=>point.clientX>=r.left && point.clientX<r.left+r.width && point.clientY>=r.top && point.clientY<r.top+r.height)?.side;
}
