import React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
// The selected-source override runs this same fixture against a preserved old component.
const { DockPanel }: typeof import("./DockPanel") = await import(process.env.AGENT_DESKTOP_STRIP_SOURCE ?? "./DockPanel");
import { createDockState, dockTabId, insertDockTab, hideDock, type DockTab } from "./dock-state";

const a: DockTab = (() => { const t = {hostId:"home",target:"session:chat" as const,kind:"review" as const,title:"Review"};return {...t,id:dockTabId(t)}; })();
const b: DockTab = (() => { const t = {hostId:"home",target:"session:chat" as const,kind:"files" as const,title:"Open file"};return {...t,id:dockTabId(t)}; })();
function render(selected: "chat" | "content", unified=true, destination: "right" | "bottom"="right") {
  let state = insertDockTab(insertDockTab(createDockState(),a,destination),b,destination);
  if(destination==="right") { state.rightLayout="full"; if(selected==="chat") state=hideDock(state,"right",true); }
  const rendered: DockTab[]=[];
  const markup=renderToStaticMarkup(<DockPanel destination={destination} state={state} tabs={[a,b]} viewport={{width:1440,height:1000}}
    leadingTab={unified?{id:"chat-tab",panelId:"chat-panel",title:"Current conversation",selected:selected==="chat",onSelect:()=>{throw Error("SSR dispatched Chat");}}:undefined}
    stripActions={<button aria-label="Conversation actions"/>} closeable={destination==="bottom"}
    onChange={()=>{throw Error("SSR dispatched a dock change");}}
    renderTab={tab=>{rendered.push(tab);return <span>{tab.title} content</span>;}}/>);
  const tabs=[...markup.matchAll(/<button\b[^>]*\brole="tab"[^>]*>/g)].map(match=>match[0]);
  return {markup,tabs,rendered};
}
// Static markup only: no portal mount, DOM events, focus effects or native appearance proof.
test("closed right retains one Chat+content group with Chat as its sole tab stop", () => {
  const {markup,tabs,rendered}=render("chat");
  expect(markup.match(/role="tablist"/g)).toHaveLength(1);
  expect(tabs).toHaveLength(3);
  expect(tabs[0]).toContain('id="chat-tab"');
  expect(tabs[0]).toContain('aria-controls="chat-panel"');
  expect(tabs.filter(t=>t.includes('aria-selected="true"'))).toEqual([tabs[0]!]);
  expect(tabs.filter(t=>t.includes('tabindex="0"'))).toEqual([tabs[0]!]);
  expect(markup).not.toContain('aria-label="Close Current conversation tab"');
  expect(markup.match(/aria-label="Conversation actions"/g)).toHaveLength(1);
  expect(rendered).toEqual([a,b]);
  expect(rendered[0]).toBe(a); expect(rendered[1]).toBe(b);
});
test("full right selects content and keeps Chat first without duplicating content panels", () => {
  const {markup,tabs,rendered}=render("content");
  expect(tabs[0]).toContain('aria-selected="false"');
  expect(tabs.filter(t=>t.includes('tabindex="0"'))).toEqual([tabs[2]!]);
  expect(tabs[2]).toContain('data-dock-content-tab="true"');
  expect(markup.match(/role="tabpanel"/g)).toHaveLength(2);
  expect(markup.match(/role="separator"/g)).toBeNull();
  expect(rendered).toEqual([a,b]);
});
test("ordinary content and bottom strips receive no Chat tab", () => {
  for(const destination of ["right","bottom"] as const) {
    const {markup,tabs}=render("content",false,destination);
    expect(tabs).toHaveLength(2);
    expect(markup).not.toContain('data-main-task-chat-tab');
    expect(markup).toContain(`aria-label="${destination} dock tabs"`);
  }
});
