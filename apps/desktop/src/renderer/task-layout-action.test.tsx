import React from "react";
import { expect,test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DockPanel } from "./DockPanel";
import { mainTaskLayoutChange } from "./main-task-targets";
import { createDockState,dockTabId,insertDockTab } from "./dock-state";

// Optional preserved source-expression adapter isolates the old App action and label.
const resolve: typeof mainTaskLayoutChange = process.env.AGENT_DESKTOP_LAYOUT_ACTION_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_LAYOUT_ACTION_SOURCE)).mainTaskLayoutChange : mainTaskLayoutChange;

test("closed-retained menu offers an effective Restore split, with a real state transition",()=>{
  const d={hostId:'work',target:'session:test' as const,kind:'review' as const,title:'Review'},tab={...d,id:dockTabId(d)};
  const state=insertDockTab(createDockState(),tab,'right');state.right.open=false;state.rightLayout='restore-full';
  const before=structuredClone(state), chat={kind:'chat' as const,hostId:'home',sessionId:'chat'};
  const change=resolve({state,tabs:[tab]},chat)!;
  // Assert the actual next-state contract before rendering; an enabled unchanged action fails.
  expect(change.state.right.open).toBe(true);expect(change.state.rightLayout).toBeUndefined();
  expect(change.state.right.activeTabId).toBe(tab.id);expect(change.label).toBe('Restore split');expect(state).toEqual(before);
  const markup=renderToStaticMarkup(<DockPanel destination="right" state={state} tabs={[tab]} viewport={{width:1440,height:1000}} onChange={()=>{throw Error('SSR mutation');}} renderTab={()=>null}
    leadingTab={{id:'chat',panelId:'chat-panel',title:'Chat',selected:true,onSelect:()=>{}}}
    layoutAction={{label:change.label,onSelect:()=>{throw Error('SSR action');}}}/>);
  expect(markup).toContain('>Restore split</button>');expect(markup).not.toContain('>Fullscreen</button>');
});
test("no content exposes no layout control",()=>{
  const state=createDockState(),action=mainTaskLayoutChange({state,tabs:[]},{kind:'chat',hostId:'home',sessionId:null});
  expect(action).toBeUndefined();
  const markup=renderToStaticMarkup(<DockPanel destination="right" state={state} tabs={[]} viewport={{width:1440,height:1000}} onChange={()=>{}} renderTab={()=>null}/>);
  expect(markup).not.toContain('Fullscreen');expect(markup).not.toContain('Restore split');
});
