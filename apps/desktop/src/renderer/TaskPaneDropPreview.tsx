import {createPortal} from "react-dom";
import type {CSSProperties} from "react";
import {paneDropAt,type PaneDropGeometry} from "./content-side-placement";
/** Presentation-only portal: hit testing stays in the shared physical geometry model. */
export function TaskPaneDropPreview({geometry,point}:{geometry:readonly PaneDropGeometry[];point:{clientX:number;clientY:number}}) {
  const side=paneDropAt(geometry,point),over=geometry.find(item=>item.side===side);
  return createPortal(<div aria-hidden="true" className="task-pane-drop-layer">
    {geometry.map(({side,target})=><div key={side} data-unified-workspace-drop-target={side} style={{position:"fixed",...target}}/>)}
    {over && <div data-unified-workspace-drop-indicator={over.side} style={{position:"fixed",...over.preview,"--drop-preview-fraction":over.fraction} as CSSProperties}>
      <svg viewBox="0 0 32 32" fill="none" style={{width:"40%",height:over.side==="bottom"?"60%":"40%",transform:over.side==="right"?"scaleX(-1)":undefined}}>
        <rect x="3" y="5" width="26" height="22" rx="5" stroke="currentColor"/>
        <rect x="7" y={over.side==="bottom"?9+14*(1-over.fraction):9} width={over.side==="bottom"?18:18*over.fraction} height={over.side==="bottom"?14*over.fraction:14} rx="1" fill="currentColor"/>
      </svg>
    </div>}
  </div>,document.body);
}
