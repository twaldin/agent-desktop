import {useEffect,useRef,type PointerEvent,type MouseEvent} from "react";
export interface TaskDragPoint {clientX:number;clientY:number}
/** Shared pointer lifetime for split Chat and content strips; placement occurs only on drop. */
export function useTaskPaneDrag<T>(options:{owner:string;enabled:boolean;onMove(task:T,point:TaskDragPoint):void;onDrop(task:T,point:TaskDragPoint,element:HTMLElement):void;onEnd():void}) {
  const latest=useRef(options);latest.current=options;
  const drag=useRef<{task:T;pointer:number;x:number;y:number;owner:string;captured:HTMLElement}|undefined>(undefined);
  const suppressClick=useRef(false);
  const cancel=()=>{
    const current=drag.current;drag.current=undefined;
    if(current) {
      try {if(current.captured.hasPointerCapture(current.pointer)) current.captured.releasePointerCapture(current.pointer);} catch {}
      latest.current.onEnd();
    }
  };
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape") cancel();};
    window.addEventListener("keydown",key);window.addEventListener("blur",cancel);
    return()=>{window.removeEventListener("keydown",key);window.removeEventListener("blur",cancel);cancel();};
  },[]);
  useEffect(()=>{cancel();},[options.owner,options.enabled]);
  return {
    consumeClick(event:MouseEvent) {const consume=suppressClick.current && event.detail!==0;suppressClick.current=false;return consume;},
    handlers(task:T,enabled=true) {return {
      onPointerDown(event:PointerEvent<HTMLElement>) {
        if(event.button!==0 || !enabled || !latest.current.enabled) return;
        const nestedControl=(event.target as Element).closest?.("button,input,select,textarea,summary,a");
        if(nestedControl && nestedControl!==event.currentTarget && nestedControl.getAttribute("role")!=="tab") return;
        cancel();suppressClick.current=false;
        drag.current={task,pointer:event.pointerId,x:event.clientX,y:event.clientY,owner:latest.current.owner,captured:event.currentTarget};
        try {event.currentTarget.setPointerCapture(event.pointerId);} catch {}
      },
      onPointerMove(event:PointerEvent<HTMLElement>) {
        const current=drag.current;if(current?.pointer!==event.pointerId) return;
        if(current.owner!==latest.current.owner || !latest.current.enabled){cancel();return;}
        if(Math.hypot(event.clientX-current.x,event.clientY-current.y)>=4) latest.current.onMove(current.task,{clientX:event.clientX,clientY:event.clientY});
      },
      onPointerUp(event:PointerEvent<HTMLElement>) {
        const current=drag.current;if(current?.pointer!==event.pointerId) return;
        try {
          if(current.owner===latest.current.owner && latest.current.enabled && Math.hypot(event.clientX-current.x,event.clientY-current.y)>=4) {
            suppressClick.current=true;event.preventDefault();
            latest.current.onDrop(current.task,{clientX:event.clientX,clientY:event.clientY},event.currentTarget);
          }
        } finally {cancel();}
      },
      onPointerCancel(event:PointerEvent<HTMLElement>) {if(drag.current?.pointer===event.pointerId) cancel();},
      onLostPointerCapture(event:PointerEvent<HTMLElement>) {if(drag.current?.pointer===event.pointerId) cancel();},
    };},
  };
}
