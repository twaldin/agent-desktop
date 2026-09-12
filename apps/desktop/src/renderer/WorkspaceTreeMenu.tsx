import type {DesktopMenuItem} from "../../../../packages/shared/src/context-menu";
import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import type {WorkspacePathContext,WorkspaceQueryResult} from "@agent-desktop/shared";
import type {WorkspaceState} from "./workspace-state";
import {transcriptHostFileActions} from "./transcript-file-actions";
import {FileTargetSubmenu} from "./TranscriptFileReference";
import {Icon} from "./Icons";
import {WorkspacePathDialog,type WorkspacePathOperation} from "./WorkspacePathDialog";
import "./workspace-file-open.css";
import "./transcript-file-reference.css";

type Options=Extract<WorkspaceQueryResult,{type:"file.open-options"}>;
export interface TreeMenuTarget {path:string;kind:"root"|"file"|"directory"|"symlink";anchor:HTMLElement;x:number;y:number}

/** Preserves the pinned file actions, then adds bounded workspace operations owned by the clicked path. */
export function WorkspaceTreeMenu({data,cwd,target,onClose,onAddFile,onOpenFile}:{data:WorkspaceState;cwd:string;target:TreeMenuTarget;onClose(restore?:boolean):void;onAddFile?(path:string):void;onOpenFile(path:string,options?:{preview?:boolean}):void}) {
 const native=window.agentDesktop?.showContextMenu,nativeOpened=useRef(false),menu=useRef<HTMLDivElement>(null),alive=useRef(true),pending=useRef(false);
 const [options,setOptions]=useState<Options>(),[context,setContext]=useState<WorkspacePathContext>(),[operations,setOperations]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState<string>(),[operationError,setOperationError]=useState<string>(),[retry,setRetry]=useState(0),[busy,setBusy]=useState(false),[submenu,setSubmenu]=useState(false),[operation,setOperation]=useState<WorkspacePathOperation>();
 const [position,setPosition]=useState({left:Math.max(8,Math.min(target.x,innerWidth-248)),top:Math.max(8,target.y)});
 const isFile=target.kind==="file"||target.kind==="symlink",blocked=target.kind!=="root"&&data.hasOpenPath(target.path);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>{
  let current=true;nativeOpened.current=false;setLoading(true);setError(undefined);setOperationError(undefined);setOptions(undefined);setContext(undefined);setOperations(false);
  const reads:Promise<void>[]=[];
  const report=(cause:unknown)=>{if(current)setOperationError(cause instanceof Error?cause.message:String(cause))};
  reads.push(data.query({type:"file.operations"}).then(value=>{if(value.type!=="file.operations"||value.version!==1)throw new Error("This host does not support workspace file operations.");if(current)setOperations(true)}).catch(report));
  if(isFile)reads.push(transcriptHostFileActions(data).fileOpenOptions!({path:target.path}).then(value=>{if(current)setOptions(value)}).catch(cause=>{if(current)setError(cause instanceof Error?cause.message:String(cause))}));
  if(target.kind!=="root")reads.push(data.fileOperationContext(target.path).then(value=>{if(current)setContext(value)}).catch(report));
  void Promise.allSettled(reads).finally(()=>{if(current)setLoading(false)});
  return()=>{current=false};
 },[data,target.path,target.kind,data.connected,retry,isFile]);
 useLayoutEffect(()=>{const node=menu.current;if(!node||operation)return;const rect=node.getBoundingClientRect();if(rect.bottom>innerHeight-8)setPosition(value=>({...value,top:Math.max(8,innerHeight-rect.height-8)}));if(!node.contains(document.activeElement))(node.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')??node).focus({preventScroll:true})},[position,loading,options,operation]);
 useEffect(()=>{if(native&&!error||operation)return;const outside=(event:Event)=>{if(!menu.current?.contains(event.target as Node))onClose(false)},dismiss=()=>onClose(false);addEventListener("pointerdown",outside);addEventListener("focusin",outside);addEventListener("resize",dismiss);return()=>{removeEventListener("pointerdown",outside);removeEventListener("focusin",outside);removeEventListener("resize",dismiss)}},[onClose,native,error,operation]);
 const run=async(action:()=>unknown|Promise<unknown>,restore=true)=>{if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);try{await action();if(alive.current)onClose(restore)}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause))}finally{pending.current=false;if(alive.current)setBusy(false)}};
 const open=(id:string)=>run(()=>transcriptHostFileActions(data).openFileOnHost!({path:target.path},id));
 const preferred=options?.targets.find(item=>item.id===options.preferredTargetId)??options?.targets[0],reveal=options?.targets.find(item=>item.kind==="file-manager");
 const begin=(value:WorkspacePathOperation)=>{nativeOpened.current=true;setOperation(value)};
 const nativeSelect=useRef<(id:string)=>void>(()=>{});
 nativeSelect.current=id=>{
  if(id.startsWith("open:")){void open(id.slice(5));return}
  const handlers:Record<string,()=>void>={copy:()=>void run(()=>navigator.clipboard.writeText(`${cwd.replace(/\/$/,"")}/${target.path}`)),save:()=>void run(()=>data.saveCopy(target.path)),add:()=>void run(()=>onAddFile?.(target.path),false),refresh:()=>void run(()=>data.readDirectory(target.kind==="directory"?target.path:".")),reveal:()=>{if(reveal)void open(reveal.id)},"create-file":()=>begin("create-file"),"create-directory":()=>begin("create-directory"),rename:()=>begin("rename"),delete:()=>begin("delete")};
  handlers[id]?.();
 };
 useEffect(()=>{
  if(!native||loading||nativeOpened.current||operation)return;nativeOpened.current=true;
  const items:DesktopMenuItem[]=[],actions=new Map<string,string>(),enabled=data.connected&&!data.busy&&!data.pending,operationEnabled=enabled&&operations;
  if(isFile&&preferred){actions.set("primary",`open:${preferred.id}`);items.push({id:"primary",label:`Open in ${preferred.label}`,enabled})}
  if(isFile&&options?.targets.length)items.push({id:"open-with",label:"Open with",enabled,submenu:options.targets.map((item,index)=>{const id=`target-${index}`;actions.set(id,`open:${item.id}`);return{id,label:item.label}})});
  if(isFile){if(items.length)items.push({type:"separator"});if(data.canSaveCopy)items.push({id:"save",label:"Save as…",enabled});items.push({id:"copy",label:"Copy path",enabled:cwd.startsWith("/")});if(onAddFile)items.push({id:"add",label:"Add to chat"});}
  if(isFile&&reveal)items.push({type:"separator"},{id:"reveal",label:`Reveal in ${reveal.label}`,enabled});
  if(target.kind==="root"||target.kind==="directory")items.push({id:"create-file",label:"New file…",enabled:operationEnabled},{id:"create-directory",label:"New folder…",enabled:operationEnabled});
  if(target.kind!=="root")items.push({id:"rename",label:"Rename…",enabled:operationEnabled&&!blocked&&Boolean(context)},{id:"delete",label:"Delete…",enabled:operationEnabled&&!blocked&&Boolean(context)});
  if(operationError)items.push({id:"operations-unavailable",label:"Workspace changes unavailable",enabled:false});
  items.push({type:"separator"},{id:"refresh",label:"Refresh",enabled:data.connected});
  void native(items).then(id=>{if(!alive.current)return;if(id===null)onClose();else nativeSelect.current(actions.get(id)??id)}).catch(cause=>{nativeOpened.current=false;if(alive.current)setError(cause instanceof Error?cause.message:String(cause))});
 },[native,loading,operation]);
 if(operation)return <WorkspacePathDialog data={data} operation={operation} target={target} context={context} onCreated={path=>onOpenFile(path,{preview:false})} onClose={restore=>{setOperation(undefined);onClose(restore)}}/>;
 if(native&&!error)return null;
 const enabled=!busy&&data.connected&&!data.busy&&!data.pending,operationEnabled=enabled&&operations;
 return createPortal(<div data-tab-preview-pin-exempt ref={menu} className="workspace-file-open-menu transcript-file-reference-menu workspace-tree-menu" style={{...position,maxHeight:Math.max(80,innerHeight-position.top-8)}} role="menu" aria-label={target.kind==="root"?"Workspace file actions":"File actions"} tabIndex={-1} onContextMenu={event=>{event.preventDefault();event.stopPropagation()}} onKeyDown={event=>{
  event.stopPropagation();if(event.key==="Escape"){event.preventDefault();onClose();return}if(event.key==="Tab"){onClose(false);return}if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
  event.preventDefault();const items=[...menu.current!.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled), :scope > .transcript-file-open-with > [role="menuitem"]:not(:disabled)')],index=items.indexOf(document.activeElement as HTMLButtonElement);items[event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:items.length-1))%items.length]?.focus();
 }}>
  {loading&&<button role="menuitem" disabled>Loading file actions…</button>}
  {isFile&&preferred&&<button role="menuitem" disabled={!enabled} onClick={()=>void open(preferred.id)}>Open in {preferred.label}</button>}
  {isFile&&options&&options.targets.length>0&&<div className="transcript-file-open-with" onPointerEnter={()=>setSubmenu(true)} onPointerLeave={()=>setSubmenu(false)}><button role="menuitem" aria-haspopup="menu" aria-expanded={submenu} disabled={!enabled} onClick={()=>setSubmenu(true)}>Open with <Icon name="chevron"/></button>{submenu&&<FileTargetSubmenu targets={options.targets} disabled={!enabled} onOpen={id=>void open(id)} onClose={()=>setSubmenu(false)}/>}</div>}
  {isFile&&<><div role="separator"/>{data.canSaveCopy&&<button role="menuitem" disabled={!enabled} onClick={()=>void run(()=>data.saveCopy(target.path))}>Save as…</button>}<button role="menuitem" disabled={!cwd.startsWith("/")} onClick={()=>void run(()=>navigator.clipboard.writeText(`${cwd.replace(/\/$/,"")}/${target.path}`))}>Copy path</button>{onAddFile&&<button role="menuitem" disabled={busy} onClick={()=>void run(()=>onAddFile(target.path),false)}>Add to chat</button>}</>}
  {isFile&&reveal&&<><div role="separator"/><button role="menuitem" disabled={!enabled} onClick={()=>void open(reveal.id)}>Reveal in {reveal.label}</button></>}
  {(target.kind==="root"||target.kind==="directory")&&<><button role="menuitem" disabled={!operationEnabled} onClick={()=>begin("create-file")}>New file…</button><button role="menuitem" disabled={!operationEnabled} onClick={()=>begin("create-directory")}>New folder…</button></>}
  {target.kind!=="root"&&<><button role="menuitem" disabled={!operationEnabled||blocked||!context} title={blocked?"Close this file before renaming it.":undefined} onClick={()=>begin("rename")}>Rename…</button><button role="menuitem" disabled={!operationEnabled||blocked||!context} title={blocked?"Close this file before deleting it.":undefined} onClick={()=>begin("delete")}>Delete…</button></>}
  <div role="separator"/><button role="menuitem" disabled={!data.connected} onClick={()=>void run(()=>data.readDirectory(target.kind==="directory"?target.path:"."))}>Refresh</button>
  {blocked&&<p role="status">Close this file before renaming or deleting it.</p>}{operationError&&<p role="alert">Workspace changes are unavailable. {operationError}</p>}{error&&<p role="alert">{error}</p>}{!loading&&(error||operationError)&&data.connected&&<button role="menuitem" disabled={busy} onClick={()=>setRetry(value=>value+1)}>Try again</button>}
 </div>,document.body);
}
