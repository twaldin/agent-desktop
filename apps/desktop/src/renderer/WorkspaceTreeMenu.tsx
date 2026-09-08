import type {DesktopMenuItem} from "../../../../packages/shared/src/context-menu";
import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import type {WorkspaceQueryResult} from "@agent-desktop/shared";
import type {WorkspaceState} from "./workspace-state";
import {transcriptHostFileActions} from "./transcript-file-actions";
import {FileTargetSubmenu} from "./TranscriptFileReference";
import {Icon} from "./Icons";
import "./workspace-file-open.css";
import "./transcript-file-reference.css";

type Options=Extract<WorkspaceQueryResult,{type:"file.open-options"}>;
export interface TreeMenuTarget {path:string;anchor:HTMLElement;x:number;y:number}
/** File actions use the clicked row's owner, never the currently selected editor file. */
export function WorkspaceTreeMenu({data,cwd,target,onClose,onAddFile}:{data:WorkspaceState;cwd:string;target:TreeMenuTarget;onClose(restore?:boolean):void;onAddFile?(path:string):void}) {
 const native=window.agentDesktop?.showContextMenu,nativeOpened=useRef(false);
 const menu=useRef<HTMLDivElement>(null),alive=useRef(true),pending=useRef(false);
 const [options,setOptions]=useState<Options>(),[loading,setLoading]=useState(true),[error,setError]=useState<string>(),[retry,setRetry]=useState(0),[busy,setBusy]=useState(false),[submenu,setSubmenu]=useState(false);
 const [position,setPosition]=useState({left:Math.max(8,Math.min(target.x,innerWidth-248)),top:Math.max(8,target.y)});
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>{
  let current=true;nativeOpened.current=false;setLoading(true);setError(undefined);setOptions(undefined);
  void transcriptHostFileActions(data).fileOpenOptions!({path:target.path}).then(value=>{if(current)setOptions(value)}).catch(cause=>{if(current)setError(cause instanceof Error?cause.message:String(cause))}).finally(()=>{if(current)setLoading(false)});
  return()=>{current=false};
 },[data,target.path,data.connected,retry]);
 useLayoutEffect(()=>{
  const node=menu.current;if(!node)return;const r=node.getBoundingClientRect();
  if(r.bottom>innerHeight-8)setPosition(p=>({...p,top:Math.max(8,innerHeight-r.height-8)}));
  if(!node.contains(document.activeElement))(node.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')??node).focus({preventScroll:true});
 },[position,loading,options]);
 useEffect(()=>{
  if(native&&!error)return;
  const outside=(event:Event)=>{if(!menu.current?.contains(event.target as Node))onClose(false)};
  const dismiss=()=>onClose(false);
  addEventListener('pointerdown',outside);addEventListener('focusin',outside);addEventListener('resize',dismiss);
  return()=>{removeEventListener('pointerdown',outside);removeEventListener('focusin',outside);removeEventListener('resize',dismiss)};
 },[onClose,native,error]);
 const run=async(action:()=>unknown|Promise<unknown>,restore=true)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);
  try{await action();if(alive.current)onClose(restore)}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause))}finally{pending.current=false;if(alive.current)setBusy(false)}
 };
 const open=(id:string)=>run(()=>transcriptHostFileActions(data).openFileOnHost!({path:target.path},id));
 const preferred=options?.targets.find(item=>item.id===options.preferredTargetId)??options?.targets[0];
 const nativeSelect=useRef<(id:string)=>void>(()=>{});
 nativeSelect.current=id=>{if(id.startsWith('open:'))void open(id.slice(5));else if(id==='copy')void run(()=>navigator.clipboard.writeText(`${cwd.replace(/\/$/,'')}/${target.path}`));else if(id==='save')void run(()=>data.saveCopy(target.path));else if(id==='add')void run(()=>onAddFile?.(target.path),false)};
 useEffect(()=>{
  if(!native||loading||nativeOpened.current)return;
  nativeOpened.current=true;
  const items:DesktopMenuItem[]=[],actions=new Map<string,string>();
  if(preferred){actions.set('primary',`open:${preferred.id}`);items.push({id:'primary',label:`Open in ${preferred.label}`,enabled:data.connected})}
  if(options?.targets.length)items.push({id:'open-with',label:'Open with',enabled:data.connected,submenu:options.targets.map((t,i)=>{const id=`target-${i}`;actions.set(id,`open:${t.id}`);return{id,label:t.label}})});
  if(items.length)items.push({type:'separator'});
  if(data.canSaveCopy)items.push({id:'save',label:'Save as…',enabled:data.connected});
  items.push({id:'copy',label:'Copy path',enabled:cwd.startsWith('/')});
  if(onAddFile)items.push({id:'add',label:'Add to chat'});
  void native(items).then(id=>{if(!alive.current)return;if(id===null)onClose();else nativeSelect.current(actions.get(id)??id)}).catch(cause=>{if(alive.current)setError(cause instanceof Error?cause.message:String(cause))});
 },[native,loading]);
 if(native&&!error)return null;
 return createPortal(<div data-tab-preview-pin-exempt ref={menu} className="workspace-file-open-menu transcript-file-reference-menu workspace-tree-menu" style={{...position,maxHeight:innerHeight-16}} role="menu" aria-label="File actions" tabIndex={-1} onContextMenu={e=>{e.preventDefault();e.stopPropagation()}} onKeyDown={event=>{
  event.stopPropagation();
  if(event.key==='Escape'){event.preventDefault();onClose();return}
  if(event.key==='Tab'){onClose(false);return}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();const items=[...menu.current!.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled), :scope > .transcript-file-open-with > [role="menuitem"]:not(:disabled)')];const i=items.indexOf(document.activeElement as HTMLButtonElement);
  items[event.key==='Home'?0:event.key==='End'?items.length-1:(i+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();
 }}>
 {loading&&<button role="menuitem" disabled>Loading available apps…</button>}
 {preferred&&<button role="menuitem" disabled={busy||!data.connected} onClick={()=>void open(preferred.id)}>Open in {preferred.label}</button>}
 {options&&options.targets.length>0&&<div className="transcript-file-open-with" onPointerEnter={()=>setSubmenu(true)} onPointerLeave={()=>setSubmenu(false)}>
  <button role="menuitem" aria-haspopup="menu" aria-expanded={submenu} disabled={busy||!data.connected} onClick={()=>setSubmenu(true)} onKeyDown={e=>{if(e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();setSubmenu(true)}}}>Open with <Icon name="chevron"/></button>
  {submenu&&<FileTargetSubmenu targets={options.targets} disabled={busy||!data.connected} onOpen={id=>void open(id)} onClose={()=>{setSubmenu(false);menu.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus()}}/>}
 </div>}
 {Boolean(preferred||loading)&&<div role="separator"/>}
 {data.canSaveCopy&&<button role="menuitem" disabled={busy||!data.connected} onClick={()=>void run(()=>data.saveCopy(target.path))}>Save as…</button>}
 <button role="menuitem" disabled={busy||!cwd.startsWith('/')} onClick={()=>void run(()=>navigator.clipboard.writeText(`${cwd.replace(/\/$/,'')}/${target.path}`))}>Copy path</button>
 {onAddFile&&<button role="menuitem" disabled={busy} onClick={()=>void run(()=>onAddFile(target.path),false)}>Add to chat</button>}
 {options&&!options.targets.length&&<p role="status">{options.availabilityReason??"No supported applications are available on this host."}</p>}
 {error&&<p role="alert">{error}</p>}
 {!loading&&!options&&data.connected&&<button role="menuitem" disabled={busy} onClick={()=>setRetry(n=>n+1)}>Try again</button>}
 </div>,document.body);
}
