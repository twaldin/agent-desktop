import {useEffect,useReducer,useRef,useState} from "react";
import type {WorkspacePathContext} from "@agent-desktop/shared";
import type {WorkspaceState} from "./workspace-state";
import "./workspace-path-dialog.css";

export type WorkspacePathOperation="create-file"|"create-directory"|"rename"|"delete";
const presentation:Record<WorkspacePathOperation,{title:(name:string)=>string;field?:string;action:string}>={
 "create-file":{title:()=>"New file",field:"File name",action:"Create file"},
 "create-directory":{title:()=>"New folder",field:"Folder name",action:"Create folder"},
 rename:{title:name=>`Rename ${name}`,field:"Name",action:"Rename"},
 delete:{title:name=>`Delete ${name}?`,action:"Delete"},
};

const parent=(path:string)=>path.includes("/")?path.slice(0,path.lastIndexOf("/")):".";
const join=(directory:string,name:string)=>directory==="."?name:`${directory}/${name}`;
const validName=(name:string)=>Boolean(name&&name!=="."&&name!==".."&&!name.includes("/")&&!/[\0-\x1f]/.test(name));

export function WorkspacePathDialog({data,operation,target,context,onClose,onCreated}:{
 data:WorkspaceState;operation:WorkspacePathOperation;target:{path:string;kind:"root"|"file"|"directory"|"symlink"};context?:WorkspacePathContext;
 onClose(restore?:boolean):void;onCreated?(path:string):void;
}){
 const dialog=useRef<HTMLDialogElement>(null),running=useRef(false),[revision,redraw]=useReducer(n=>n+1,0);
 const originalName=target.path.split("/").at(-1)??"";
 const [name,setName]=useState(operation==="rename"?originalName:"");
 useEffect(()=>data.subscribe(redraw),[data]);
 useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close()},[]);
 const directory=target.kind==="directory"?target.path:target.kind==="root"?".":parent(target.path);
 const destination=join(directory,name.trim());
 const invalid=operation!=="delete"&&!validName(name.trim());
 const view=presentation[operation],title=view.title(originalName),action=view.action;
 const pending=data.busy||Boolean(data.pending),error=data.errors.action;
 const dismiss=(restore=true)=>{dialog.current?.close();requestAnimationFrame(()=>onClose(restore))};
 const submit=async()=>{
  if(running.current||pending||invalid)return;
  running.current=true;redraw();
  let ok=false;
  try{
   if(operation==="create-file"||operation==="create-directory")ok=await data.createPath(destination,operation==="create-file"?"file":"directory");
   else if(operation==="rename"&&context)ok=await data.renamePath(target.path,destination,context.revision);
   else if(operation==="delete"&&context)ok=await data.deletePath(target.path,context.revision);
   if(ok){if(operation==="create-file")onCreated?.(destination);dismiss(false)}
  }finally{running.current=false;redraw()}
 };
 return <dialog ref={dialog} className="app-dialog workspace-path-dialog" aria-labelledby="workspace-path-title" onCancel={event=>{event.preventDefault();if(!pending&&!running.current)dismiss()}}>
  <div className="dialog-header"><h2 id="workspace-path-title">{title}</h2></div>
  {operation==="delete"?<p>This permanently deletes <strong>{target.path}</strong>. Folders must be empty.</p>:<label className="workspace-path-field"><span>{view.field}</span><input autoFocus value={name} maxLength={255} disabled={pending||running.current} aria-invalid={invalid||undefined} onChange={event=>setName(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.nativeEvent.isComposing){event.preventDefault();void submit()}}}/></label>}
  {invalid&&<p role="alert">Use one name without slashes or control characters.</p>}
  {error&&<p role="alert">{error}</p>}
  {data.pending?.uncertain&&<button type="button" className="secondary-button" disabled={data.busy} onClick={async()=>{await data.retry();if(!data.pending&&!data.errors.action)dismiss(false)}}>Check original operation</button>}
  <div className="dialog-footer"><button type="button" className="secondary-button" disabled={pending||running.current} onClick={()=>dismiss()}>Cancel</button><button type="button" className={operation==="delete"?"danger-button":"primary-button"} disabled={pending||running.current||invalid||((operation==="rename"||operation==="delete")&&!context)} onClick={()=>void submit()}>{running.current||data.busy?`${action}…`:action}</button></div>
 </dialog>;
}
