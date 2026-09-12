import React from "react";
import {test,expect} from "bun:test";
import {readFileSync} from "node:fs";
import {DockPanel as CurrentDockPanel,type DockPanelProps} from "./DockPanel";
import {createDockState,dockTabId,insertDockTab,type DockState,type DockTab} from "./dock-state";

const DockPanel:typeof CurrentDockPanel=process.env.AGENT_DESKTOP_DRAG_PANEL_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_DRAG_PANEL_SOURCE)).DockPanel : CurrentDockPanel;
const appPath=process.env.AGENT_DESKTOP_DRAG_APP_SOURCE ?? new URL("./App.tsx",import.meta.url);
const openings=readFileSync(appPath,"utf8").split("\n").filter(line=>line.trimStart().startsWith("<DockPanel "));
if(openings.length!==1)throw new Error("Actual App DockPanel opening seam was not found.");
const gate=openings[0]!.match(/\bdragEnabled=\{([^}]+)\}/)?.[1];
// Evaluate only the actual App prop expression. This is not an App mount/DOM proof.
const appGate=new Function("settingsOpen","pluginDirectoryOpen",`return ${gate ?? "undefined"};`) as (settings:boolean,plugin:boolean)=>boolean|undefined;

type EffectSlot={deps?:readonly unknown[];cleanup?:()=>void};
/** Controlled hook commits for the real DockPanel and useTaskPaneDrag functions.
 * React private dispatcher is test-only/version-bound. No DOM, renderer or native
 * event loop is launched; capture-directed click routing below is an explicit model. */
function hookCommits() {
  const slots:any[]=[];let cursor=0;let pending:Array<()=>void>=[];
  const internals=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher={
    useRef(value:unknown){const index=cursor++;return slots[index]??(slots[index]={current:value});},
    useState(value:unknown){const index=cursor++;if(!(index in slots))slots[index]=typeof value==="function"?(value as ()=>unknown)():value;return [slots[index],(next:unknown)=>{slots[index]=typeof next==="function"?(next as (old:unknown)=>unknown)(slots[index]):next;}];},
    useId(){const index=cursor++;return `drag-test-${index}`;},
    useEffect(effect:()=>void|(()=>void),deps?:readonly unknown[]){const index=cursor++;const old=slots[index] as EffectSlot|undefined;if(!old || !deps || deps.some((v,i)=>!Object.is(v,old.deps?.[i]))){pending.push(()=>{old?.cleanup?.();slots[index]={deps,cleanup:effect()};});}},
  };
  return {
    render<T>(callback:()=>T){cursor=0;pending=[];const previous=internals.H;internals.H=dispatcher;try{const result=callback();for(const effect of pending)effect();return result;}finally{internals.H=previous;}},
    close(){for(const slot of slots)if(slot?.cleanup)slot.cleanup();},
  };
}
type NodeModel={props:any;parent?:NodeModel;getAttribute(name:string):unknown;closest(selector:string):NodeModel|undefined;setPointerCapture(id:number):void;hasPointerCapture(id:number):boolean;releasePointerCapture(id:number):void;ownerDocument:any};
function fixture(destination:"right"|"bottom"="right") {
  const hooks=hookCommits(),oldWindow=globalThis.window;
  Object.assign(globalThis,{window:{addEventListener(){},removeEventListener(){}}});
  const first:DockTab={kind:"review",hostId:"host",target:"session:a",title:"Review",id:"host:session:a:review"};
  const descriptor={kind:"file" as const,hostId:"host",target:"session:a" as const,title:"one.ts",filePath:"one.ts",preview:true as const};
  const second:DockTab={...descriptor,id:dockTabId(descriptor)};
  let state=insertDockTab(insertDockTab(createDockState(),first,destination),second,destination);
  state={...state,[destination]:{...state[destination],activeTabId:first.id}};
  let capture:NodeModel|undefined;let selected:string[]=[];let pinned:string[]=[];let drops=0;let ends=0;let moves=0;
  let nodes:NodeModel[]=[];
  function render(settings=false,plugin=false,owner="session:a") {
    nodes=[];
    const tree=hooks.render(()=>DockPanel({destination,state,tabs:[first,second],viewport:{width:1200,height:900},dragOwner:owner,
      ...({dragEnabled:appGate(settings,plugin)} as Partial<DockPanelProps>),renderTab:()=>null,
      onChange:(next:DockState)=>{state=next;selected.push(next[destination].activeTabId!);},onPinTab:id=>pinned.push(id),onPaneDrag:()=>moves++,onPaneDragEnd:()=>ends++,onPaneDrop:()=>drops++,
    }));
    function walk(value:any,parent?:NodeModel) {
      if(Array.isArray(value)){value.forEach(v=>walk(v,parent));return;}
      if(!React.isValidElement(value))return;
      const props=value.props as any;
      if(typeof value.type!=="string"){walk(props.children,parent);return;}
      const node:NodeModel={props,parent,getAttribute:name=>props[name],closest:selector=>{
        let n:NodeModel|undefined=node;while(n){if(selector.includes("button")&&n.props.__tag==="button")return n;n=n.parent;}return undefined;
      },setPointerCapture:()=>{capture=node;},hasPointerCapture:()=>capture===node,releasePointerCapture:()=>{if(capture===node)capture=undefined;},ownerDocument:{elementFromPoint:()=>null}};
      node.props={...props,__tag:value.type};nodes.push(node);walk(props.children,node);
    }
    walk(tree);
    return nodes.find(n=>n.props.role==="tab"&&n.props["data-dock-tab-id"]===second.id)!;
  }
  function event(type:string,target:NodeModel,x=0,detail=1) {
    const data:any={target,button:0,pointerId:1,clientX:x,clientY:0,detail,preventDefault(){},stopPropagation(){this.stopped=true;}};
    for(let current:NodeModel|undefined=target;current;current=current.parent){data.currentTarget=current;current.props[type]?.(data);if(data.stopped)break;}
  }
  const down=(node:NodeModel,x=0)=>event("onPointerDown",node,x);
  const move=(node:NodeModel,x=10)=>event("onPointerMove",capture??node,x);
  const up=(node:NodeModel,x=0)=>{const target=capture??node;event("onPointerUp",target,x);return target;};
  return {render,down,move,up,event,get capture(){return capture;},get selected(){return selected;},get pinned(){return pinned;},get drops(){return drops;},get ends(){return ends;},get moves(){return moves;},second,
    close(){hooks.close();Object.assign(globalThis,{window:oldWindow});}};
}

test("capture keeps sub-threshold pointer selection and double-click pin on the actual content tab",()=>{
  for(const destination of ["right","bottom"] as const){const f=fixture(destination);try{
    let button=f.render();f.down(button);const click=f.up(button,2);f.event("onClick",click,2);expect(f.selected).toEqual([f.second.id]);
    button=f.render();f.down(button);const secondClick=f.up(button,1);f.event("onClick",secondClick,1);f.event("onDoubleClick",secondClick,1,2);
    expect(f.pinned).toEqual([f.second.id]);expect(f.drops).toBe(0);expect(f.capture).toBeUndefined();
  }finally{f.close();}}
});
test("actual App Settings/plugin gate cancels a captured content drag before returning to same owner",()=>{
  for(const destination of ["right","bottom"] as const)for(const surface of ["settings","plugin"] as const){const f=fixture(destination);try{
    let button=f.render();f.down(button);f.move(button);expect(f.moves).toBe(1);
    f.render(surface==="settings",surface==="plugin");expect(f.capture).toBeUndefined();expect(f.ends).toBe(1);
    button=f.render();const click=f.up(button,20);f.event("onClick",click,20);expect(f.drops).toBe(0);
    // A fresh gesture in the restored workbench still drags once and suppresses only its pointer click.
    f.down(button);f.move(button);const dragged=f.up(button,20);const before=f.selected.length;f.event("onClick",dragged,20);
    expect(f.drops).toBe(1);expect(f.selected.length).toBe(before);f.event("onClick",button,20,0);expect(f.selected.length).toBe(before+1);
  }finally{f.close();}}
});
