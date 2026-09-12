import type {DesktopBridge} from "@agent-desktop/shared";
import {defaultWindowView} from "../window-state";
import {useWorkbenchDock} from "./use-workbench-dock";
import React from "react";
import {expect,test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {DockPanel} from "./DockPanel";
import {createDockState,dockTabId,insertDockTab,setRightDockFullWidth,hideDock} from "./dock-state";
test("swap has the pinned label/canvas and only an open split content divider",()=>{
 const d={kind:"review" as const,title:"Review",hostId:"work",target:"session:a" as const},tab={...d,id:dockTabId(d)},state=insertDockTab(createDockState("left"),tab,"right");
 const render=(value=state,destination:"right"|"bottom"="right")=>renderToStaticMarkup(<DockPanel destination={destination} state={value} tabs={[tab]} viewport={{width:1440,height:1000}} renderTab={()=>null} onChange={()=>{throw Error("SSR mutation");}} onSwapSides={()=>{throw Error("SSR action");}}/>);
 const markup=render();expect(markup).toContain('data-content-side="left"');expect(markup).toContain('aria-label="Swap left and right panes"');expect(markup).toContain('viewBox="0 0 16 16"');expect(markup).toContain('role="separator"');
 expect(render(setRightDockFullWidth(state,true))).not.toContain('dock-swap-sides');expect(render(hideDock(state,"right"))).not.toContain('role="separator"');expect(render(state,"bottom")).not.toContain('dock-swap-sides');
});

test("actual dock hook finalizes legacy side from renderer direction without creating a terminal",()=>{
  let observed:ReturnType<typeof useWorkbenchDock>["snapshot"]|undefined;
  const legacy=createDockState();delete legacy.contentSide;
  function Render({direction,persisted}:{direction:"ltr"|"rtl";persisted?:"left"|"right"}) {
    const state={...legacy,...(persisted?{contentSide:persisted}:{})};
    observed=useWorkbenchDock({} as DesktopBridge,{...defaultWindowView(),dock:{state,tabs:[]}},"home",undefined,false,()=>{throw Error("unexpected error");},()=>false,direction).snapshot;
    return null;
  }
  renderToStaticMarkup(<Render direction="rtl"/>);expect(observed!.state.contentSide).toBe("left");
  renderToStaticMarkup(<Render direction="ltr"/>);expect(observed!.state.contentSide).toBe("right");
  renderToStaticMarkup(<Render direction="rtl" persisted="right"/>);expect(observed!.state.contentSide).toBe("right");
});
