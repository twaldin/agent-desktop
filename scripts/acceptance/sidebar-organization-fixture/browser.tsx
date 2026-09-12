import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { OrganizedSidebar } from "../../../apps/desktop/src/renderer/OrganizedSidebar";
import { sidebarLayout } from "../../../apps/desktop/src/renderer/sidebar-layout";
import { SidebarNavigationIcon } from "../../../apps/desktop/src/renderer/SidebarNavigationIcon";
import { PreferencesState } from "../../../apps/desktop/src/renderer/preferences-state";
import type { HostOption } from "../../../apps/desktop/src/renderer/host-catalog";
import type { CommandEnvelope, CommandResult, HostState, Project } from "../../../packages/shared/src/protocol";
import type { PreferencesSnapshot } from "../../../packages/shared/src/preferences";
import type { SidebarSectionKey, WindowViewState } from "../../../apps/desktop/src/window-state";
import "../../../apps/desktop/src/renderer/styles.css";
const api = (window as unknown as { sidebarFixture: { invoke(method: string, args: unknown[]): Promise<any> } }).sidebarFixture;
const bootstrap = await api.invoke("bootstrap", []) as { groups: { state: HostState; name: string }[]; view: WindowViewState };
const localHost = bootstrap.groups[0]!.state.host.id;
const bridge = { getPreferences: (host?: string) => api.invoke("preferences", [host ?? localHost]) as Promise<PreferencesSnapshot>, command: (envelope: CommandEnvelope, host?: string) => api.invoke("command", [envelope, host ?? localHost]) as Promise<CommandResult>, subscribe: () => () => {} };
const cache = { read: async (key: string) => localStorage.getItem(key), write: async (key: string, value: string) => { localStorage.setItem(key,value); } };
const receipts = { read: (key: string) => localStorage.getItem(key), write: (key: string, value: string) => localStorage.setItem(key,value) };
const preferences = new PreferencesState(bridge, cache, receipts);
preferences.setConnection(localHost,true); await preferences.refresh();
function App() {
  const [, redraw] = useState(0);
  const [states, setStates] = useState(bootstrap.groups);
  const [view, setView] = useState(bootstrap.view);
  const [offline, setOffline] = useState(false);
  const [showArchived, setArchived] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => preferences.subscribe(() => redraw(n=>n+1)), []);
  useEffect(() => { void api.invoke("saveView",[view]).then(result=>{if(result.error)setError(result.error)}); },[view]);
  const groups = useMemo(() => states.map(({state,name},index) => ({ host: { key: state.host.id, hostId:state.host.id, name, availability: offline && index===1 ? "offline" : "available", local:index===0 } as HostOption, hostState:state })),[states,offline]);
  const expanded = new Set(view.expandedProjects);
  const collapsed = new Set(view.collapsedSidebarSections);
  const layout = sidebarLayout(preferences,groups,"",showArchived,expanded);
  const refresh = async () => setStates((await api.invoke("bootstrap",[])).groups);
  async function archive(sessionId:string,host:string,archived:boolean) {
    try {
      if(groups.find(group=>group.host.hostId===host)?.host.availability!=="available")throw Error("Reconnect to host");
      const result = await bridge.command({id:crypto.randomUUID(),command:{type:"session.archive",sessionId,archived}},host);
      if(!result.ok)throw Error(result.error.message);await refresh();setError("");return true;
    } catch(cause){setError(String(cause));return false;}
  }
  const projectAction = async (project:Project,type:"project.rename"|"project.remove",name?:string) => {
    const result=await bridge.command({id:crypto.randomUUID(),command:type==="project.rename"?{type,projectId:project.id,name:name!}:{type,projectId:project.id}},project.hostId);
    if(!result.ok)throw Error(result.error.message);await refresh();
  };
  return <div style={{display:"flex",height:"100vh"}}><aside className="sidebar" style={{width:280,flex:"none"}}><div className="sidebar-titlebar"/><div className="sidebar-brand"><strong>Agent Desktop</strong><SidebarNavigationIcon name="search"/></div><nav className="sidebar-actions"><button className="nav-action"><SidebarNavigationIcon name="new-chat"/>New chat</button><button className="nav-action"><SidebarNavigationIcon name="plugins"/>Plugins</button></nav><div className="sidebar-scroll"><OrganizedSidebar layout={layout} preferences={preferences} groups={groups} activeHostId={view.route.hostId??localHost} selectedId={view.route.sessionId} query="" showArchived={showArchived} collapsedSections={collapsed} onToggleSection={key=>setView(v=>({...v,collapsedSidebarSections:collapsed.has(key)?[...collapsed].filter(x=>x!==key):[...collapsed,key]}))} expandedProjects={expanded} onToggleProject={key=>setView(v=>({...v,expandedProjects:expanded.has(key)?[...expanded].filter(x=>x!==key):[...expanded,key]}))} onNavigate={(sessionId,hostId)=>setView(v=>({...v,route:{sessionId,hostId}}))} onNew={(projectId,hostId)=>setView(v=>({...v,route:{sessionId:null,hostId},selectedProjectId:projectId}))} onArchive={archive} onAddProject={()=>{}} addingProject={false} connected localHostId={localHost} onToggleArchived={()=>setArchived(v=>!v)} onRenameProject={(p,n)=>projectAction(p,"project.rename",n)} onRemoveProject={p=>projectAction(p,"project.remove")} onRevealProject={async()=>{}}/></div></aside><main style={{padding:32}}><h1>Sidebar organization fixture</h1><p>Production sidebar with disposable authenticated host APIs and window store.</p><button id="offline" onClick={()=>setOffline(v=>!v)}>{offline?"Reconnect Work":"Disconnect Work"}</button><button id="fail-archive" onClick={()=>void api.invoke("failNextArchive",[states[1]!.state.host.id])}>Refuse next Work archive</button><output id="route">{JSON.stringify(view.route)}</output><output id="organization">{JSON.stringify(layout.organization)}</output><output id="error">{error}</output><button id="reload" onClick={()=>location.reload()}>Reopen window</button></main></div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
