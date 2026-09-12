import React,{useEffect,useMemo,useReducer,useState} from "react";
import {createRoot} from "react-dom/client";
import type {CommandEnvelope,DesktopBridge,DesktopEvent,WorkspaceQuery,WorkspaceTarget} from "@agent-desktop/shared";
import {WorkspaceFileTree} from "../../apps/desktop/src/renderer/WorkspaceFileTree";
import {WorkspaceState} from "../../apps/desktop/src/renderer/workspace-state";
import {offlineCache} from "../../apps/desktop/src/renderer/offline-cache";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const params=new URLSearchParams(location.search),endpoint=params.get("endpoint")!,target=JSON.parse(params.get("target")!) as WorkspaceTarget,hostId=params.get("hostId")!,cwd=params.get("cwd")!;
const request=async(path:string,body:unknown)=>{const response=await fetch(endpoint+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),value=await response.json();if(!response.ok)throw new Error((value as any).error?.message??`Request failed (${response.status})`);return value as any};
const listeners=new Set<(event:DesktopEvent)=>void>(),opened:string[]=[],runtimeErrors:string[]=[];
addEventListener("error",event=>runtimeErrors.push(event.message));addEventListener("unhandledrejection",event=>runtimeErrors.push(String(event.reason)));
const bridge={workspaceQuery:(owner:WorkspaceTarget,query:WorkspaceQuery,ownerHost?:string)=>request("/workspace",{owner,query,hostId:ownerHost}),command:(envelope:CommandEnvelope,ownerHost?:string)=>request("/command",{envelope,hostId:ownerHost}),subscribe:(listener:(event:DesktopEvent)=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}} satisfies Pick<DesktopBridge,"workspaceQuery"|"command"|"subscribe">;
let data:WorkspaceState,setConnected:(value:boolean)=>void;
function Fixture(){const [connected,connection]=useState(true),[,redraw]=useReducer(value=>value+1,0);setConnected=connection;data=useMemo(()=>new WorkspaceState(bridge,hostId,target,offlineCache,hostId),[]);useEffect(()=>data.subscribe(redraw),[]);useEffect(()=>{data.setConnected(connected);if(connected)void data.restore()},[connected]);useEffect(()=>()=>data.stop(),[]);return <main style={{height:"100vh",width:360,display:"flex",background:"var(--background)",color:"var(--text)"}}><WorkspaceFileTree data={data} active cwd={cwd} onOpenFile={path=>opened.push(path)}/></main>}
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window,{connection:(value:boolean)=>setConnected(value),request,state:()=>({connected:data?.connected,restored:data?.restored,pending:data?.pending,busy:data?.busy,notice:data?.notice,errors:data?.errors,opened:[...opened],rows:[...document.querySelectorAll<HTMLElement>(".workspace-file-tree-row")].map(node=>node.title),menu:[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(node=>({text:node.textContent,disabled:(node as HTMLButtonElement).disabled})),dialog:document.querySelector("dialog")?.textContent??null,active:(document.activeElement as HTMLElement)?.getAttribute("aria-label")??(document.activeElement as HTMLInputElement)?.value,runtimeErrors}),target:(selector:string,text?:string)=>{const nodes=[...document.querySelectorAll<HTMLElement>(selector)],node=text?nodes.find(item=>item.textContent?.trim()===text):nodes[0];if(!node)throw new Error(`Missing ${selector} ${text??""}`);const rect=node.getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}}});
