import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { OrganizedSidebar } from "../../../apps/desktop/src/renderer/OrganizedSidebar";
import { sidebarLayout } from "../../../apps/desktop/src/renderer/sidebar-layout";
import { SidebarNavigationIcon } from "../../../apps/desktop/src/renderer/SidebarNavigationIcon";
import { PreferencesState } from "../../../apps/desktop/src/renderer/preferences-state";
import { useTranscript } from "../../../apps/desktop/src/renderer/desktop-state";
import { useSessionReadState } from "../../../apps/desktop/src/renderer/use-session-read-state";
import { HostCatalog } from "../../../apps/desktop/src/renderer/host-catalog";
import type { HostOption } from "../../../apps/desktop/src/renderer/host-catalog";
import type { CommandEnvelope, CommandResult, DesktopEvent, HostState, Project, TranscriptMessage } from "../../../packages/shared/src/protocol";
import type { PreferencesSnapshot } from "../../../packages/shared/src/preferences";
import type { SidebarSectionKey, WindowViewState } from "../../../apps/desktop/src/window-state";
import "../../../apps/desktop/src/renderer/styles.css";
const api = (window as unknown as { sidebarFixture: { invoke(method: string, args: unknown[]): Promise<any> } }).sidebarFixture;
const bootstrap = await api.invoke("bootstrap", []) as { groups: { state: HostState; name: string }[]; view: WindowViewState };
const localHost = bootstrap.groups[0]!.state.host.id;
const subscribers=new Set<(event:DesktopEvent)=>void>();
const pendingReads:{sessionId:string;hostId?:string;resolve:(messages:TranscriptMessage[])=>void}[]=[];
const bridge = {getMessages:(sessionId:string,hostId?:string)=>new Promise<TranscriptMessage[]>(resolve=>pendingReads.push({sessionId,hostId,resolve})), getPreferences: (host?: string) => api.invoke("preferences", [host ?? localHost]) as Promise<PreferencesSnapshot>, getPreferencesV2: () => api.invoke("preferencesV2", [localHost]), command: (envelope: CommandEnvelope, host?: string) => api.invoke("command", [envelope, host ?? localHost]) as Promise<CommandResult>, subscribe: (listener:(event:DesktopEvent)=>void) => {subscribers.add(listener);return ()=>{subscribers.delete(listener);};} };
const cache = { read: async (key: string) => localStorage.getItem(key), write: async (key: string, value: string) => { localStorage.setItem(key,value); } };
const receipts = { read: (key: string) => localStorage.getItem(key), write: (key: string, value: string) => localStorage.setItem(key,value) };
const preferences = new PreferencesState(bridge, cache, receipts);
preferences.setConnection(localHost,true); preferences.start(); await preferences.refresh();
const catalog=new HostCatalog(undefined);
for(const {state} of bootstrap.groups)catalog.ingest({type:"state",hostId:state.host.id,state});
function App() {
  const [, redraw] = useState(0);
  const [states, setStates] = useState(bootstrap.groups);
  const [transcriptVisible,setTranscriptVisible]=useState(true);
  const [view, setView] = useState(bootstrap.view);
  const [offline, setOffline] = useState(false);
  const [showArchived, setArchived] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => preferences.subscribe(() => redraw(n=>n+1)), []);
  useEffect(() => { void api.invoke("saveView",[view]).then(result=>{if(result.error)setError(result.error)}); },[view]);
  const groups = useMemo(() => states.map(({state,name},index) => ({ host: { key: state.host.id, hostId:state.host.id, name, availability: offline && index===1 ? "offline" : "available", local:index===0 } as HostOption, hostState:state })),[states,offline]);
  const selected=groups.find(group=>group.host.hostId===view.route.hostId)?.hostState.sessions.find(session=>session.id===view.route.sessionId);
  const transcript=useTranscript(bridge,view.route.sessionId,view.route.hostId??undefined,!offline||view.route.hostId===localHost,localHost,selected?.activitySequence??0);
  const readOwner=useSessionReadState(preferences,selected,transcriptVisible,transcript.loaded&&(transcript.readSequence??-1)>=(selected?.activitySequence??0));
  const unread=readOwner.unreadKeys(groups.flatMap(group=>group.hostState.sessions));
  useEffect(()=>catalog.subscribe(()=>setStates(bootstrap.groups.map(({state,name})=>({name,state:catalog.records.get(state.host.id)!.state!})))),[]);
  const applyEvent=async(method:string,args:unknown[])=>{const event=await api.invoke(method,args);catalog.ingest(event);for(const listener of subscribers)listener(event);};
  const expanded = new Set(view.expandedProjects);
  const collapsed = new Set(view.collapsedSidebarSections);
  const layout = sidebarLayout(preferences,groups,"",showArchived,expanded,unread);
  const refresh = async () => {for(const {state} of (await api.invoke("bootstrap",[])).groups)catalog.ingest({type:"state",hostId:state.host.id,state});};
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
  return <div style={{display:"flex",height:"100vh"}}><aside className="sidebar" style={{width:280,flex:"none"}}><div className="sidebar-titlebar"/><div className="sidebar-brand"><strong>Agent Desktop</strong><SidebarNavigationIcon name="search"/></div><nav className="sidebar-actions"><button className="nav-action"><SidebarNavigationIcon name="new-chat"/>New chat</button><button className="nav-action"><SidebarNavigationIcon name="plugins"/>Plugins</button></nav><div className="sidebar-scroll"><OrganizedSidebar layout={layout} preferences={preferences} groups={groups} activeHostId={view.route.hostId??localHost} selectedId={view.route.sessionId} query="" showArchived={showArchived} collapsedSections={collapsed} onToggleSection={key=>setView(v=>({...v,collapsedSidebarSections:collapsed.has(key)?[...collapsed].filter(x=>x!==key):[...collapsed,key]}))} expandedProjects={expanded} onToggleProject={key=>setView(v=>({...v,expandedProjects:expanded.has(key)?[...expanded].filter(x=>x!==key):[...expanded,key]}))} onNavigate={(sessionId,hostId)=>{setView(v=>({...v,route:{sessionId,hostId}}));}} onNew={(projectId,hostId)=>setView(v=>({...v,route:{sessionId:null,hostId},selectedProjectId:projectId}))} onArchive={archive} onMarkRead={(target,value)=>{const session=groups.find(group=>group.host.hostId===target.hostId)?.hostState.sessions.find(session=>session.id===target.id);return session?readOwner.mark(session,value):Promise.resolve(false);}} onAddProject={()=>{}} addingProject={false} connected localHostId={localHost} onToggleArchived={()=>setArchived(v=>!v)} onRenameProject={(p,n)=>projectAction(p,"project.rename",n)} onRemoveProject={p=>projectAction(p,"project.remove")} onRevealProject={async()=>{}}/></div></aside><main style={{padding:32,minWidth:0,overflowWrap:"anywhere",overflow:"auto"}}><h1>Sidebar organization fixture</h1><p>Production sidebar with disposable authenticated host APIs and window store.</p><button id="offline" onClick={()=>setOffline(v=>!v)}>{offline?"Reconnect Work":"Disconnect Work"}</button><button id="fail-archive" onClick={()=>void api.invoke("failNextArchive",[states[1]!.state.host.id])}>Refuse next Work archive</button><output style={{display:"block"}} id="route">{JSON.stringify(view.route)}</output><output style={{display:"block"}} id="preference-status">{JSON.stringify({busy:preferences.busy,pending:preferences.pending.length})}</output><output style={{display:"block"}} id="organization">{JSON.stringify(layout.organization)}</output><output style={{display:"block"}} id="error">{error}</output><button id="activity" onClick={()=>void applyEvent("activity",["Work","Work older"])}>Native Work activity</button><button id="attention" onClick={()=>void applyEvent("attention",["Home","Home older",true])}>Home needs answer</button><button id="clear-attention" onClick={()=>void applyEvent("attention",["Home","Home older",false])}>Resolve Home answer</button><button id="remote-read" onClick={()=>void applyEvent("remoteReadMark",[false])}>Other device marks read</button><button id="remote-unread" onClick={()=>void applyEvent("remoteReadMark",[true])}>Other device marks unread</button><button id="running" onClick={()=>void applyEvent("running",["Home","Home newer",true])}>Home running</button><button id="load-transcript" onClick={()=>{pendingReads.shift()?.resolve([]);redraw(n=>n+1);}}>Transcript loaded</button><button id="hide-transcript" onClick={()=>setTranscriptVisible(value=>!value)}>{transcriptVisible?"Hide transcript":"Show transcript"}</button><output style={{display:"block"}} id="transcript-sequence">{JSON.stringify({read:transcript.readSequence??null,current:selected?.activitySequence??0,pending:pendingReads.length})}</output><output style={{display:"block"}} id="unread">{JSON.stringify([...unread])}</output><output style={{display:"block"}} id="read-error">{readOwner.error}</output><button id="reload" onClick={()=>location.reload()}>Reopen window</button></main></div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
