import React,{useEffect,useMemo,useState} from "react";
import {createRoot} from "react-dom/client";
import type {DesktopBridge,WorkspaceQuery,WorkspaceQueryResult,WorkspaceTarget} from "../../packages/shared/src/protocol";
import {TranscriptMarkdownContext} from "../../apps/desktop/src/renderer/MarkdownText";
import {FileReferenceControl} from "../../apps/desktop/src/renderer/TranscriptFileReference";
import {DockPanel} from "../../apps/desktop/src/renderer/DockPanel";
import {WorkspacePanel} from "../../apps/desktop/src/renderer/WorkspacePanel";
import {WorkspaceState} from "../../apps/desktop/src/renderer/workspace-state";
import {useWorkbenchDock} from "../../apps/desktop/src/renderer/use-workbench-dock";
import {defaultWindowView,parseDockSnapshot} from "../../apps/desktop/src/window-state";
import {canReplaceFilePreview} from "../../apps/desktop/src/renderer/file-preview-tabs";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const target:WorkspaceTarget={sessionId:"preview"}, host="preview-host";
const text:Record<string,string>={"a.md":"# A\n\ninitial A\n","b.md":"# B\n\ninitial B\n","nested/c.md":"# C\n\ninitial C\n","nested/d.md":"# D\n\ninitial D\n","e.md":"# E\n\ntransient E\n"};
const revisions=new Map(Object.keys(text).map((path,index)=>[path,`r${index+1}`]));
const cache = new Map<string,string>();
let mountedGeneration = 0, revisionCounter = 5;
const calls:unknown[] = [];
function content(path:string) {
  if (!(path in text)) throw new Error(`Missing controlled file ${path}`);
  return {path,kind:"text" as const,text:text[path]!,revision:revisions.get(path)!,bom:false,encoding:"utf8" as const,size:new TextEncoder().encode(text[path]).length,modifiedAt:1,mode:0o644};
}
const bridge = {
 subscribe: () => () => {},
 workspaceQuery:async (owner:WorkspaceTarget,query:WorkspaceQuery,hostId?:string):Promise<WorkspaceQueryResult>=>{
  if(hostId!==host || JSON.stringify(owner)!==JSON.stringify(target))throw new Error("Wrong fixture owner");
  calls.push({query,hostId,target:owner});
  if(query.type==="file.read")return{type:"file.read",content:content(query.path)};
  if(query.type==="files.list") {
    const paths=query.path==="nested"?["nested/c.md","nested/d.md"]:["a.md","b.md","e.md","nested"];
    return{type:"files.list",entries:paths.map(path=>({path,name:path.split("/").at(-1)!,kind:path==="nested"?"directory" as const:"file" as const,size:path==="nested"?0:content(path).size,modifiedAt:1,mode:path==="nested"?0o755:0o644}))};
  }
  if(query.type==="git.status")return{type:"git.status",status:{revision:"fixture",branch:null,head:null,upstream:null,ahead:0,behind:0,entries:[]}};
  if(query.type==="file.open-options")return{type:"file.open-options",path:query.path,targets:[]};
  throw new Error(`Unexpected query ${query.type}`);
 },
 command:async (envelope,hostId)=>{
  if(hostId!==host || envelope.command.type!=="workspace.mutate" || JSON.stringify(envelope.command.target)!==JSON.stringify(target))throw new Error("Unexpected mutation owner");
  const action=envelope.command.action;
  if(action.type!=="file.write")throw new Error("Unexpected mutation");
  calls.push({action,commandId:envelope.id});
  if(action.expectedRevision!==revisions.get(action.path))return{ok:true,commandId:envelope.id,value:{type:"file.write",result:{ok:false,code:"REVISION_CONFLICT",current:content(action.path)}}};
  text[action.path]=action.text;revisions.set(action.path,`r${++revisionCounter}`);
  return{ok:true,commandId:envelope.id,value:{type:"file.write",result:{ok:true,document:content(action.path)}}};
 },
} satisfies Pick<DesktopBridge,"subscribe"|"workspaceQuery"|"command">;
let dockApi:any, data:WorkspaceState, reopen:()=>void, reactRoot:ReturnType<typeof createRoot>;
const runtimeErrors:string[]=[];
window.addEventListener("error",event=>runtimeErrors.push(String(event.error?.stack??event.message)));
window.addEventListener("unhandledrejection",event=>runtimeErrors.push(String(event.reason?.stack??event.reason)));
function Fixture({initial=defaultWindowView()}:{initial?:ReturnType<typeof defaultWindowView>}){
 const [tree,setTree]=useState({open:true,width:250});
 const dock=useWorkbenchDock(bridge as unknown as DesktopBridge,initial,host,target,true,()=>{},tab=>Boolean(tab.filePath) && canReplaceFilePreview(data,tab.filePath!)); dockApi=dock;
 const state=useMemo(()=>new WorkspaceState(bridge,host,target,{read:async key=>cache.get(key)??null,write:async(key,value)=>{cache.set(key,value);}},host),[]); data=state; useEffect(()=>{mountedGeneration++;return()=>state.stop();},[state]);
 reopen=()=>{
   const saved=parseDockSnapshot(JSON.parse(JSON.stringify(dock.persisted)));
   if(!saved)throw new Error("Persisted snapshot did not validate");
   reactRoot.unmount(); dockApi=undefined;
   queueMicrotask(()=>{reactRoot=createRoot(document.getElementById("root")!);reactRoot.render(<Fixture initial={{...defaultWindowView(),dock:saved}}/>);});
 };
 const open=(path:string,preview=true)=>dock.openFile(path,host,target,"right",preview);
 const render=(tab:any,active:boolean)=> <WorkspacePanel embedded active={active} connected data={state} name="Preview fixture" path="/fixture" filePath={tab.filePath} fileTree={tree} onFileTreeChange={setTree} onFileEdit={()=>dock.pinFile(tab.id)} onOpenFile={(path,_location,options)=>open(path,options?.preview??true)} onClose={()=>{}} onOpenProject={async()=>{}}/>;
 return <main className="preview-fixture"><TranscriptMarkdownContext value={{actions:{cwd:"/fixture",openFile:async(file,options)=>open(file.path,options?.preview??true)}}}><div className="preview-reference"><FileReferenceControl file={{path:"a.md"}} title="a.md">Open A</FileReferenceControl><FileReferenceControl file={{path:"b.md"}} title="b.md">Open B</FileReferenceControl></div></TranscriptMarkdownContext><button className="fixture-open-a" onClick={()=>open("a.md",true)}>Preview A</button><button className="fixture-open-b" onClick={()=>open("b.md",true)}>Preview B</button><button className="fixture-open-c" onClick={()=>open("nested/c.md",true)}>Preview C</button><button className="fixture-open-e" onClick={()=>open("e.md",true)}>Preview E</button><DockPanel destination="right" state={dock.snapshot.state} tabs={dock.snapshot.tabs} viewport={{width:1100,height:760}} onChange={dock.change} onPinTab={dock.pinFile} renderTab={render}/></main>;
}
document.documentElement.dataset.theme="dark";reactRoot=createRoot(document.getElementById("root")!);reactRoot.render(<Fixture/>);
Object.assign(window,{target(selector:string,index=0){const node=[...document.querySelectorAll<HTMLElement>(selector)].filter(node=>node.getClientRects().length)[index];if(!node)throw Error(`Missing ${selector}[${index}]`);const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},state(){const snap=dockApi?.snapshot;const tabs=snap?.tabs.map((tab:any)=>({id:tab.id,path:tab.filePath,preview:tab.preview===true}));const persisted=dockApi?.persisted;return{mountedGeneration,calls:[...calls],viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},theme:document.documentElement.dataset.theme,labelStyles:[...document.querySelectorAll<HTMLElement>('.dock-pill > [role="tab"] > span')].map(node=>({text:node.textContent,fontStyle:getComputedStyle(node).fontStyle,fontFamily:getComputedStyle(node).fontFamily,fontSize:getComputedStyle(node).fontSize})),tabs,right:snap?.state.right,previewPills:[...document.querySelectorAll(".dock-pill.preview")].map(node=>node.textContent),documents:[...data?.documents].map(([path,value])=>({path,text:value.text,dirty:value.dirty})),persistedTabs:persisted?.tabs.map((tab:any)=>({path:tab.filePath,preview:tab.preview===true})),parsed:parseDockSnapshot(persisted),runtimeErrors:[...runtimeErrors]};},reopen:()=>reopen()});
