import React from "react";
import {expect,test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {useTaskPaneDrag} from "./use-task-pane-drag";

// Exercise the actual hook's pointer callbacks with controlled event shapes.
// SSR does not run effects: this is not DOM capture, Escape/window-blur or native proof.
function fixture() {
  const calls:{moves:string[];drops:string[];ends:number;releases:number}={moves:[],drops:[],ends:0,releases:0};
  const options={owner:"session:a",enabled:true,onMove:(task:string)=>{calls.moves.push(task);},onDrop:(task:string)=>{calls.drops.push(task);},onEnd:()=>{calls.ends++;}};
  let api:ReturnType<typeof useTaskPaneDrag<string>>;
  function Mount(){api=useTaskPaneDrag(options);return null;}
  renderToStaticMarkup(<Mount/>);
  const element={hasPointerCapture:()=>true,setPointerCapture:()=>{},releasePointerCapture:()=>{calls.releases++;}};
  let prevented=0;
  const event=(x:number,id=1)=>({button:0,pointerId:id,clientX:x,clientY:0,currentTarget:element,target:element,preventDefault:()=>{prevented++;}} as unknown as React.PointerEvent<HTMLElement>);
  return {api:api!,calls,options,event,prevented:()=>prevented};
}
test("drag applies exactly once after threshold; plain click and wrong pointer never drop",()=>{
 const f=fixture(),handlers=f.api.handlers("owned-tab");
 handlers.onPointerDown(f.event(10));handlers.onPointerMove(f.event(12));handlers.onPointerUp(f.event(12));expect(f.calls.drops).toEqual([]);expect(f.calls.moves).toEqual([]);
 handlers.onPointerDown(f.event(10));handlers.onPointerMove(f.event(20,2));expect(f.calls.moves).toEqual([]);
 handlers.onPointerMove(f.event(20));handlers.onPointerUp(f.event(20));handlers.onPointerUp(f.event(20));expect(f.calls.moves).toEqual(["owned-tab"]);expect(f.calls.drops).toEqual(["owned-tab"]);expect(f.prevented()).toBe(1);
 expect(f.api.consumeClick({detail:1} as React.MouseEvent)).toBe(true);expect(f.api.consumeClick({detail:1} as React.MouseEvent)).toBe(false);
});
test("lost capture/cancel and changed route/disabled scope cannot apply a pending drag",()=>{
 for(const reason of ["lost","cancel","owner","disabled"] as const) {
  const f=fixture(),handlers=f.api.handlers("owned-tab");handlers.onPointerDown(f.event(10));handlers.onPointerMove(f.event(20));
  if(reason==="lost") handlers.onLostPointerCapture(f.event(20));
  if(reason==="cancel") handlers.onPointerCancel(f.event(20));
  if(reason==="owner") f.options.owner="session:b";
  if(reason==="disabled") f.options.enabled=false;
  handlers.onPointerUp(f.event(20));expect(f.calls.drops).toEqual([]);expect(f.calls.ends).toBe(1);expect(f.calls.releases).toBe(1);
 }
});
test("keyboard activation is not swallowed after drag and close controls do not initiate it",()=>{
 const f=fixture(),handlers=f.api.handlers("owned-tab");handlers.onPointerDown(f.event(10));handlers.onPointerUp(f.event(20));
 expect(f.api.consumeClick({detail:0} as React.MouseEvent)).toBe(false);
 const g=fixture(),h=g.api.handlers("owned-tab"),start=g.event(10);
 Object.assign(start,{target:{closest:()=>({getAttribute:()=>null})}});h.onPointerDown(start);h.onPointerUp(g.event(20));expect(g.calls.drops).toEqual([]);
});
