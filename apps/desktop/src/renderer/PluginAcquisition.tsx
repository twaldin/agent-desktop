import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {DesktopBridge,NativeMarketplaceCatalog,NativePluginAcquisition,NativePluginAcquisitionReceipt,WorkspaceTarget} from '@agent-desktop/shared';
import {Icon} from './Icons';
import {InstalledPluginActions} from './InstalledPluginActions';
import {assertMarketplaceGitSource,parseMarketplaceSourceOptions} from '../../../../packages/shared/src/plugin-acquisition';
import {clearAcquisitionIntent,readAcquisitionIntents,saveAcquisitionIntent,type AcquisitionIntent} from './plugin-acquisition-intents';
import './plugin-acquisition.css';

type Props={initialMarketplace?:string;initialAdd?:boolean;bridge:DesktopBridge;hostId:string;target?:WorkspaceTarget;connected:boolean;visible:boolean;query:string;actionsRoot:HTMLElement|null;onMcp():void;onInstalledChanged():void;children:ReactNode};
const label=(op:NativePluginAcquisition['operation'])=>({'marketplace.add':'Add marketplace','marketplace.update':'Upgrade marketplace','marketplace.remove':'Remove marketplace','plugin.install':'Install plugin','plugin.upgrade':'Upgrade plugin','plugin.uninstall':'Uninstall plugin'}[op]);
const owner=(target?:WorkspaceTarget)=>target?('projectId'in target?target.projectId:target.sessionId):'Host defaults';
export function PluginAcquisition({initialMarketplace,initialAdd=false,bridge,hostId,target,connected,visible,query,actionsRoot,onMcp,onInstalledChanged,children}:Props){
 const [catalog,setCatalog]=useState<NativeMarketplaceCatalog|null>(null),[receipts,setReceipts]=useState<NativePluginAcquisitionReceipt[]>([]),[intents,setIntents]=useState<AcquisitionIntent[]>(()=>readAcquisitionIntents(localStorage,hostId));
 const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null),[menu,setMenu]=useState(false),[adding,setAdding]=useState(initialAdd),[source,setSource]=useState('');
 const [gitRef,setGitRef]=useState(''),[sparsePaths,setSparsePaths]=useState(''),[sourceHelp,setSourceHelp]=useState(false);
 const formValues=useRef({source,gitRef,sparsePaths});formValues.current={source,gitRef,sparsePaths};
 const [selected,setSelected]=useState<string|null>(initialMarketplace??null),[scope,setScope]=useState<'user'|'project'>('user');
 const [review,setReview]=useState<{receipt:NativePluginAcquisitionReceipt;catalog:NativeMarketplaceCatalog}|null>(null),[confirmation,setConfirmation]=useState<NativePluginAcquisition|null>(null);
 const addRef=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLDialogElement>(null),menuRef=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null);
 const epoch=useRef(0),busyRef=useRef(false),polling=useRef<number|null>(null),pollSerial=useRef(0),forceQueued=useRef(false),mounted=useRef(true);
 const targetKey=JSON.stringify(target);
 const unknown=intents.filter(intent=>!receipts.some(receipt=>receipt.id===intent.id));
 const active=receipts.filter(item=>item.state==='running'||item.state==='needs-review');
 const blocked=!connected||loading||active.length>0||unknown.length>0;
 const rememberError=()=>setError('The request could not be confirmed. Refresh status before another action.');
 const uncertainId=useRef<string|null>(null);
 const lastCatalogRows=useRef<string|null>(null);
 const refresh=async(force=false)=>{
  if(!connected)return;if(polling.current!==null){if(force)forceQueued.current=true;return;}
  const poll=++pollSerial.current;polling.current=poll;const ticket=epoch.current;
  try{
   const rows=await bridge.getPluginAcquisitionOperations(hostId);
   if(!mounted.current||ticket!==epoch.current)return;
   setReceipts(rows);
   if(uncertainId.current&&rows.some(row=>row.id===uncertainId.current)){uncertainId.current=null;setError(null);}
   for(const row of rows)clearAcquisitionIntent(localStorage,hostId,row.id);
   setIntents(readAcquisitionIntents(localStorage,hostId));
   // Receipt reads remain available during a long native fetch. Do not queue a catalog behind it.
   const signature=JSON.stringify(rows.map(row=>[row.id,row.state,row.updatedAt]));
   if(!rows.some(row=>row.state==='running')&&(force||lastCatalogRows.current!==signature)){
    const value=await bridge.getMarketplaceCatalog(target,hostId);
    if(mounted.current&&ticket===epoch.current){setCatalog(value);lastCatalogRows.current=signature;}
   }
   if(mounted.current&&ticket===epoch.current)setError(current=>current==='Plugin status is unavailable. Reconnect or refresh status.'?null:current);
  }catch{if(mounted.current&&ticket===epoch.current)setError('Plugin status is unavailable. Reconnect or refresh status.');}
  finally{if(polling.current===poll){polling.current=null;if(forceQueued.current){forceQueued.current=false;queueMicrotask(()=>void refresh(true));}}}
 };
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
 useEffect(()=>{
  epoch.current++;polling.current=null;forceQueued.current=false;lastCatalogRows.current=null;busyRef.current=false;setLoading(false);
  void refresh(true);
  const timer=setInterval(()=>void refresh(),1500);
  const storage=()=>setIntents(readAcquisitionIntents(localStorage,hostId));window.addEventListener('storage',storage);
  return()=>{clearInterval(timer);window.removeEventListener('storage',storage);epoch.current++;};
 },[connected,hostId,targetKey]);
 useEffect(()=>bridge.subscribe(event=>{if((event.hostId??hostId)===hostId&&(event.type==='settings'||event.type==='state'))void refresh(true);}),[bridge,hostId,targetKey,connected]);
 const closeDialog=()=>{setAdding(false);setConfirmation(null);setReview(null);requestAnimationFrame(()=>opener.current?.isConnected?opener.current.focus():addRef.current?.focus());};
 const dialogOpen=adding||!!confirmation||!!review;
 useEffect(()=>{
  if(!dialogOpen||!dialog.current)return;const element=dialog.current;element.showModal();
  const frame=requestAnimationFrame(()=>{if(adding)element.querySelector<HTMLInputElement>('input')?.focus();});
  return()=>{cancelAnimationFrame(frame);if(element.open)element.close();};
 },[dialogOpen]);
 useEffect(()=>{
  if(!menu)return;menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  const outside=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node)&&!addRef.current?.contains(event.target as Node))setMenu(false);};
  document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
 },[menu]);
 const start=async(action:NativePluginAcquisition)=>{
  if(blocked||busyRef.current||!catalog)return;
  const ticket=epoch.current;const id=crypto.randomUUID();const submittedForm=formValues.current;
  try{saveAcquisitionIntent(localStorage,hostId,{id,operation:action.operation,target});}
  catch{setError('This window cannot save the request identity. Nothing was sent.');return;}
  setIntents(readAcquisitionIntents(localStorage,hostId));setLoading(true);busyRef.current=true;setError(null);
  try{
   const receipt=await bridge.startPluginAcquisition(target,{id,expectedRevision:catalog.revision,action},hostId);
   if(!mounted.current||ticket!==epoch.current)return;
   setReceipts(rows=>[receipt,...rows.filter(row=>row.id!==id)]);clearAcquisitionIntent(localStorage,hostId,id);setIntents(readAcquisitionIntents(localStorage,hostId));
   if(action.operation==='marketplace.add'&&JSON.stringify(formValues.current)===JSON.stringify(submittedForm)){setSource('');setGitRef('');setSparsePaths('');}closeDialog();
  }catch{if(mounted.current&&ticket===epoch.current){uncertainId.current=id;rememberError();}}
  finally{if(mounted.current&&ticket===epoch.current){busyRef.current=false;setLoading(false);void refresh();}}
 };
 useEffect(()=>{if(!connected)setLoading(false);},[connected]);
 const latest=receipts[0];
 const observed=useRef<string>('');
 useEffect(()=>{const value=receipts.filter(x=>x.state==='succeeded').map(x=>x.id).join();if(value!==observed.current){observed.current=value;onInstalledChanged();}},[receipts]);
 const inspect=async(receipt:NativePluginAcquisitionReceipt,button:HTMLElement)=>{
  opener.current=button;setError(null);const ticket=epoch.current;
  try{const current=await bridge.getMarketplaceCatalog(receipt.target,hostId);if(mounted.current&&ticket===epoch.current)setReview({receipt,catalog:current});}
  catch{if(mounted.current&&ticket===epoch.current)rememberError();}
 };
 const confirmReview=async()=>{
  if(!review||!connected||busyRef.current)return;const ticket=epoch.current;busyRef.current=true;setLoading(true);
  try{await bridge.reviewPluginAcquisition(review.receipt.target,review.receipt.id,review.catalog.revision,hostId);if(ticket===epoch.current){closeDialog();setError(null);}}
  catch{if(ticket===epoch.current)setError('Configuration changed or review could not be recorded. Close and inspect it again.');}
  finally{if(mounted.current&&ticket===epoch.current){busyRef.current=false;setLoading(false);void refresh();}}
 };
 const closeUnknown=async(intent:AcquisitionIntent)=>{
  if(!connected||busyRef.current)return;const ticket=epoch.current;busyRef.current=true;setLoading(true);
  try{await bridge.closePluginAcquisitionRequest(intent.target,{id:intent.id,operation:intent.operation},hostId);if(ticket===epoch.current)setError(null);}
  catch{if(ticket===epoch.current)rememberError();}
  finally{if(mounted.current&&ticket===epoch.current){busyRef.current=false;setLoading(false);void refresh();}}
 };
 const market=catalog?.marketplaces.find(x=>x.name===selected);
 const askRemove=(action:NativePluginAcquisition,button:HTMLElement)=>{opener.current=button;setConfirmation(action);};
 return <>
 {actionsRoot&&createPortal(<div className="acquisition-actions"><button ref={addRef} className="primary-button" aria-haspopup="menu" aria-expanded={menu} disabled={!connected} onClick={()=>setMenu(!menu)}>Add <Icon name="chevron"/></button>{menu&&<div ref={menuRef} role="menu" aria-label="Add integration" className="acquisition-menu" onKeyDown={event=>{
  const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  if(event.key==='Escape'){event.preventDefault();setMenu(false);addRef.current?.focus();}
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}
 }}><button role="menuitem" onClick={()=>{opener.current=addRef.current;setMenu(false);setAdding(true);}}>Add a marketplace</button><button role="menuitem" onClick={()=>{setMenu(false);onMcp();}}>Add MCP server</button></div>}</div>,actionsRoot)}
 {error&&!dialogOpen&&<p role="alert" className="inline-error">{error}</p>}
 {(active.length>0||unknown.length>0)&&<section className="acquisition-receipts" aria-label="Plugin operations">
 {active.map(row=><div className="acquisition-receipt" key={row.id}><div><strong>{label(row.operation)}</strong><small>{row.state==='running'?'Running on this host…':'Needs configuration review'}{JSON.stringify(row.target)!==targetKey?` · ${owner(row.target)}`:''}</small></div>{row.state==='needs-review'&&<button className="secondary-button" disabled={!connected||loading} onClick={event=>void inspect(row,event.currentTarget)}>Inspect configuration</button>}</div>)}
 {unknown.map(intent=><div className="acquisition-receipt" key={intent.id}><div><strong>{label(intent.operation)}</strong><small>No host receipt yet. Closing only prevents a request that has not started.</small></div><button className="secondary-button" disabled={!connected||loading} onClick={()=>void closeUnknown(intent)}>Close pending request</button></div>)}
 <button className="native-reset" disabled={!connected} onClick={()=>{setError(null);void refresh();}}>Refresh status</button></section>}
 {latest&&!active.length&&!unknown.length&&<p role="status" className="acquisition-result">{label(latest.operation)} · {latest.state==='succeeded'?'Completed':latest.message??'Reviewed'}</p>}
 {!visible?children:<div className="marketplace-list" aria-label="Marketplaces"><div className="marketplace-refresh"><button className="icon-button" aria-label="Refresh marketplaces" title="Refresh marketplaces" disabled={!connected} onClick={()=>{setError(null);void refresh(true);}}><Icon name="refresh"/></button></div>
 {selected&&<button className="integration-back" onClick={()=>setSelected(null)}><Icon name="browserBack"/> Marketplaces</button>}
 {!catalog&&<p role="status">{connected?'Loading marketplaces…':'Marketplace catalog unavailable offline.'}</p>}
 {catalog&&!selected&&!catalog.marketplaces.length&&<p className="integration-placeholder">No marketplaces added.</p>}
 {!selected?catalog?.marketplaces.filter(item=>item.name.toLowerCase().includes(query.toLowerCase())).map(item=><article className="marketplace-row" key={item.name}><button className="marketplace-open" onClick={()=>setSelected(item.name)}><Icon name="globe"/><span><strong>{item.name}</strong><small>{item.catalogAvailable?`${item.plugins.length} plugins`:'Catalog unavailable'} · {item.sourceType}</small></span></button><button className="secondary-button" disabled={blocked} onClick={()=>void start({operation:'marketplace.update',name:item.name})}>Upgrade</button><button className="icon-button" aria-label={`Remove marketplace ${item.name}`} title="Remove marketplace" disabled={blocked} onClick={event=>askRemove({operation:'marketplace.remove',name:item.name},event.currentTarget)}><Icon name="trash"/></button></article>):market?<>
 <div className="integration-list-heading"><h2>{market.name}</h2><select className="text-field" aria-label="Plugin installation scope" value={scope} onChange={event=>setScope(event.target.value as 'user'|'project')} disabled={blocked}><option value="user">Personal</option>{catalog?.projectScopeAvailable&&target&&<option value="project">This project</option>}</select></div>
 {market.sourceOptions&&<p className="integration-note">{market.sourceOptions.ref?`Git ref: ${market.sourceOptions.ref}`:'Default branch'}{market.sourceOptions.sparsePaths?.length?` · Sparse paths: ${market.sourceOptions.sparsePaths.join(', ')}`:''}</p>}
 {market.description&&<p className="integration-note">{market.description}</p>}
 {market.plugins.filter(item=>`${item.name} ${item.description??''}`.toLowerCase().includes(query.toLowerCase())).map(item=>{const installed=catalog?.installed.find(row=>row.id===`${item.name}@${market.name}`&&row.scope===scope);return <article className="marketplace-row" key={item.name}><div className="marketplace-plugin-copy"><strong>{item.name}</strong><small>{item.description??item.version??'Native OMP plugin'}</small>{!item.installable&&<small>{item.unavailabilityReason}</small>}</div>{installed?<><small className="installed-plugin-version">{installed.version}</small><InstalledPluginActions key={`${hostId}:${targetKey}:${installed.id}:${scope}`} name={item.name} revision={catalog!.revision} disabled={blocked} canUpgrade={item.installable} onAction={(action,button)=>{opener.current=button;if(action==='uninstall')askRemove({operation:'plugin.uninstall',pluginId:installed.id,scope},button);else void start({operation:'plugin.upgrade',pluginId:installed.id,scope});}}/></>:<button className="primary-button" disabled={blocked||!item.installable} onClick={()=>void start({operation:'plugin.install',name:item.name,marketplace:market.name,scope})}>Install</button>}</article>;})}
 </>:<p className="integration-note">This marketplace is no longer available.</p>}
 </div>}
 {dialogOpen&&createPortal(<dialog ref={dialog} className="marketplace-dialog" aria-labelledby="marketplace-dialog-title" onCancel={event=>{event.preventDefault();closeDialog();}} onClick={event=>{if(event.target!==event.currentTarget)return;const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>=rect.right||event.clientY<rect.top||event.clientY>=rect.bottom)closeDialog();}}>
 <header><h2 id="marketplace-dialog-title">{adding?'Add plugin marketplace':review?'Review plugin configuration':confirmation?label(confirmation.operation):''}</h2><button className="icon-button" aria-label="Close dialog" onClick={closeDialog}><Icon name="close"/></button></header>
 {adding?<form onSubmit={event=>{event.preventDefault();try{const paths=sparsePaths.split('\n').filter(path=>path!=='');const sourceOptions=parseMarketplaceSourceOptions({...gitRef.trim()?{ref:gitRef.trim()}:{},...paths.length?{sparsePaths:paths}:{}});if(Object.keys(sourceOptions).length)assertMarketplaceGitSource(source.trim());void start({operation:'marketplace.add',source:source.trim(),...Object.keys(sourceOptions).length?{sourceOptions}:{}});}catch(error){setError((error as Error).message);}}}><p>Add from a GitHub repo, Git URL, or local folder. <button type="button" className="marketplace-learn-more" aria-expanded={sourceHelp} onClick={()=>setSourceHelp(!sourceHelp)}>Learn more</button></p>{sourceHelp&&<p className="marketplace-source-help">Git ref selects a branch, tag or commit SHA. Sparse paths select literal repository-relative files or folders, one per line; the marketplace catalog folders are always included. Leave both blank for the full default checkout. These options are saved on this host and reused by Upgrade. Local folders and JSON catalogs do not use Git options.</p>}<label>Source<input autoFocus aria-label="Marketplace source" value={source} disabled={blocked} maxLength={8192} placeholder="owner/repo or git@github.com:org/repo.git" onChange={event=>setSource(event.target.value)}/></label><label>Git ref<input aria-label="Marketplace Git ref" value={gitRef} disabled={blocked} maxLength={256} placeholder="main" onChange={event=>setGitRef(event.target.value)}/></label><label>Sparse paths<textarea aria-label="Marketplace sparse paths" value={sparsePaths} disabled={blocked} maxLength={32768} rows={3} placeholder="One file or folder path per line" onChange={event=>setSparsePaths(event.target.value)}/></label><footer><button type="button" className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" type="submit" disabled={blocked||!catalog||!source.trim()}>Add marketplace</button></footer></form>:review?<><p>Inspect the current configuration before allowing another plugin operation. The original request will not run again.</p><div className="acquisition-review-summary"><strong>Marketplaces</strong>{review.catalog.marketplaces.map(item=><div key={item.name}>{item.name} · {item.plugins.length} plugins</div>)}<strong>Installed plugins</strong>{review.catalog.installed.map(item=><div key={item.id+item.scope}>{item.id} · {item.scope} · {item.version}</div>)}{!review.catalog.installed.length&&<div>No installed plugins in this configuration.</div>}</div><footer><button className="secondary-button" onClick={closeDialog}>Close</button><button className="primary-button" disabled={!connected||loading} onClick={()=>void confirmReview()}>Confirm review</button></footer></>:confirmation?<><p>{confirmation.operation==='marketplace.remove'?'Remove this marketplace from the host? Installed plugins keep their independently copied files.':'Uninstall this plugin from the selected scope? Other installations and shared cache files are preserved.'}</p><footer><button className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" disabled={blocked} onClick={()=>void start(confirmation)}>{label(confirmation.operation)}</button></footer></>:null}
 {error&&<p role="alert" className="inline-error">{error}</p>}
 </dialog>,document.body)}
 </>;
}
