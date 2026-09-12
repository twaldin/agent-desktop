import React from "react";
import { expect,test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DockPanel } from "./DockPanel";
import { createDockState,dockTabId,insertDockTab } from "./dock-state";

test("actual task strip renders supplied hints as presentation-only and omits absent hints",()=>{
  const descriptor={hostId:'home',target:'session:test' as const,kind:'review' as const,title:'Review'};
  const tab={...descriptor,id:dockTabId(descriptor)};
  const state=insertDockTab(createDockState(),tab,'right');state.rightLayout='full';
  const render=(shown:boolean)=>renderToStaticMarkup(<DockPanel destination="right" state={state} tabs={[tab]} viewport={{width:1440,height:1000}} onChange={()=>{throw Error('SSR action');}} renderTab={()=>null}
    leadingTab={{id:'chat-tab',panelId:'chat-panel',title:'Chat',selected:false,shortcutHint:shown?'⌘1':undefined,onSelect:()=>{throw Error('SSR Chat');}}}
    shortcutHints={shown?new Map([[tab.id,'⌘2']]):undefined}/>);
  const shown=render(true),hidden=render(false);
  expect(shown.match(/data-tab-shortcut-hint="true" aria-hidden="true"/g)).toHaveLength(2);
  expect(shown).toContain('>⌘1</kbd>');expect(shown).toContain('>⌘2</kbd>');
  expect(shown.match(/<kbd>/g)).toHaveLength(2);
  expect(hidden).not.toContain('data-tab-shortcut-hint');
  expect(shown.match(/role="tab"/g)).toHaveLength(2);expect(hidden.match(/role="tab"/g)).toHaveLength(2);
});
