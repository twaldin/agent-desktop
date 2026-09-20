import { lspServerFields, type DesktopBridge, type LspValues, type NativeLspCatalog, type NativeLspMutation, type NativeLspServer, type NativeLspSource, type SettingJson, type WorkspaceTarget } from '@agent-desktop/shared';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { NativeValueField, nativeSettingSeed } from './NativeSettings';
import { Icon } from './Icons';
import './lsp-settings.css';
type Bridge=Pick<DesktopBridge,'getLspConfiguration'|'mutateLspConfiguration'|'subscribe'>;
export type LspDraft={kind:'server';sourceId:string;name:string;originalName?:string;values:LspValues;original:LspValues;revision:string;remove:boolean}|{kind:'idle';sourceId:string;value:number|null;revision:string};
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
/** One owner and connection epoch; conflict reads never replace the open draft. */
export class LspSettingsState {
  catalog:NativeLspCatalog|null=null; draft:LspDraft|null=null; error:string|null=null; saving=false; loading=false; connected=false;
  private epoch=0;private sequence=0; private listeners=new Set<()=>void>();
  constructor(readonly bridge:Bridge,readonly hostId:string,readonly target?:WorkspaceTarget){}
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  notify=()=>{for(const fn of this.listeners)fn();};
  disconnect(){this.epoch++;this.sequence++;this.connected=false;this.loading=false;if(this.saving)this.error='Connection changed while saving. The outcome is unknown. Reload and review the original source before trying again.';this.saving=false;this.notify();}
  dispose(){this.disconnect();this.listeners.clear();}
  async refresh(){if(!this.connected||this.saving)return;const epoch=this.epoch,sequence=++this.sequence;this.loading=true;this.notify();try{const next=await this.bridge.getLspConfiguration(this.target,this.hostId);if(epoch!==this.epoch||sequence!==this.sequence)return;this.catalog=next;if(!this.draft)this.error=null;}catch(error){if(epoch===this.epoch&&sequence===this.sequence)this.error=message(error);}finally{if(epoch===this.epoch&&sequence===this.sequence){this.loading=false;this.notify();}}}
  edit(source:NativeLspSource,name:string,newName=false){if(!this.catalog||this.saving)return;const original=structuredClone(source.servers[name]??{});this.draft={kind:'server',sourceId:source.id,name,originalName:newName?undefined:name,values:structuredClone(original),original,revision:this.catalog.revision,remove:false};this.error=null;this.notify();}
  idle(source:NativeLspSource){if(!this.catalog||this.saving)return;this.draft={kind:'idle',sourceId:source.id,value:source.idleTimeoutMs??null,revision:this.catalog.revision};this.error=null;this.notify();}
  change(draft:LspDraft){this.draft=draft;this.notify();}
  close(){if(this.saving)return;this.draft=null;this.error=null;this.notify();}
  get stale(){return !!this.draft&&this.draft.revision!==this.catalog?.revision;}
  reviewLatest(){const draft=this.draft,source=this.catalog?.sources.find(s=>s.id===draft?.sourceId);if(!draft||!source||!this.catalog||this.saving)return;
    // Keep draft edits. Only the explicit review action adopts the new baseline.
    if(draft.kind==='server') {const current=source.servers[draft.name]??{};const changed=Object.keys(draft.values).filter(k=>JSON.stringify(draft.values[k])!==JSON.stringify(draft.original[k]));const removed=Object.keys(draft.original).filter(k=>!Object.hasOwn(draft.values,k));const values={...current};for(const key of changed)values[key]=draft.values[key]!;for(const key of removed)delete values[key];this.draft={...draft,values,original:structuredClone(current),revision:this.catalog.revision};}
    else this.draft={...draft,revision:this.catalog.revision};this.error=null;this.notify();}
  async save(){const draft=this.draft;if(!draft||!this.connected||this.saving||this.stale)return;const epoch=this.epoch;this.saving=true;this.sequence++;this.loading=false;this.error=null;this.notify();
    const base={sourceId:draft.sourceId,expectedRevision:draft.revision};
    const mutation:NativeLspMutation=draft.kind==='idle'?{...base,operation:'idle-timeout',value:draft.value}:draft.remove?{...base,operation:'remove',name:draft.name}:{...base,operation:'save',name:draft.name,changes:Object.fromEntries(Object.entries(draft.values).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(draft.original[key]))),removeFields:Object.keys(draft.original).filter(key=>!Object.hasOwn(draft.values,key))};
    try{const next=await this.bridge.mutateLspConfiguration(this.target,mutation,this.hostId);if(epoch!==this.epoch)return;this.catalog=next;this.draft=null;}
    catch(error){if(epoch===this.epoch)this.error=message(error);}
    finally{if(epoch===this.epoch){this.saving=false;this.notify();}}
  }
}
const status:Record<NativeLspServer['applicability'],string>={ready:'Available for new sessions',disabled:'Disabled','missing-root':'No matching project marker','missing-binary':'Command not found','typescript-alternative':'Other TypeScript server selected',invalid:'Invalid server definition'};
export function LspSettings({bridge,hostId,hostName,target,connected,localHostId}:{bridge:Bridge;hostId:string;hostName:string;target?:WorkspaceTarget;connected:boolean;localHostId?:string}){
  const key=JSON.stringify(target),data=useMemo(()=>new LspSettingsState(bridge,hostId,target),[bridge,hostId,key]);
  const [,redraw]=useReducer(x=>x+1,0);
  useEffect(()=>data.subscribe(redraw),[data]);
  useEffect(()=>()=>data.dispose(),[data]);
  useEffect(()=>{if(!connected){data.disconnect();return;}data.connected=true;void data.refresh();},[data,connected]);
  useEffect(()=>bridge.subscribe(event=>{if(event.type==='settings'&&(event.hostId??localHostId)===hostId&&(event.target===undefined||JSON.stringify(event.target)===key))void data.refresh();}),[bridge,data,hostId,key,localHostId]);
  const catalog=data.catalog;
  const sourceLabel=(source:NativeLspSource)=>`${source.scope==='project'?'Project':source.scope==='user'?'User':'Plugin'} · ${source.path}`;
  const override=(name:string,scope:'user'|'project',newName=false)=>{const source=catalog?.sources.find(s=>s.id===catalog.overrideTargets[scope]);if(source)data.edit(source,name,newName);};
  return <section className="lsp-settings" aria-label="Language servers">
    <div className="native-section-heading lsp-heading"><div><h2>Language servers</h2><p>Native OMP configuration on {hostName}. Changes apply when new sessions load LSP. Existing sessions keep their current configuration. Inspection does not start servers.</p></div><button className="icon-button" aria-label="Reload language servers" disabled={!connected||data.loading||data.saving} onClick={()=>void data.refresh()}><Icon name="refresh"/></button></div>
    {!connected&&<p className="connection-banner" role="status">This machine is disconnected. Draft edits are retained.</p>}
    {data.error&&!data.draft&&<p className="inline-error" role="alert">{data.error}</p>}
    {!catalog&&<p role="status">{data.loading?'Loading native language server configuration…':'Reload to read language servers.'}</p>}
    {catalog&&<>
      <div className="lsp-actions"><button className="secondary-button" disabled={!connected||data.saving} onClick={()=>override('',target?'project':'user',true)}><Icon name="plus"/>Add server</button><span>Idle timeout: {catalog.idleTimeoutMs===undefined?'Disabled by default':`${catalog.idleTimeoutMs} ms`}</span></div>
      {catalog.warnings.map((warning,index)=><p className="inline-error" role="status" key={index}>{warning}</p>)}
      <div className="native-settings-card lsp-list">{catalog.servers.map(server=><details className="lsp-server" key={server.name}><summary><span><strong>{server.name}</strong><small>{server.builtin?'Built in':''}{server.builtin&&server.configured?' · ':''}{server.configured?'Configured override':''}</small></span><span className="lsp-status">{status[server.applicability]}</span></summary>
        <dl className="lsp-derived"><div><dt>Command</dt><dd>{String(server.effective.command??'Invalid')}</dd></div><div><dt>Resolved binary</dt><dd>{server.resolvedCommand??'Not found'}</dd></div><div><dt>Root markers</dt><dd>{server.rootMarkersMatch?'Matched':'Not matched'} · {JSON.stringify(server.effective.rootMarkers??[])}</dd></div><div><dt>File types</dt><dd>{JSON.stringify(server.effective.fileTypes??[])}</dd></div>{server.runtimeClient&&<div><dt>Native client</dt><dd>{server.runtimeClient} custom client factory</dd></div>}{server.runtimePidArguments&&<div><dt>Runtime argument</dt><dd>$PID is replaced with the owning LSP process ID at runtime.</dd></div>}</dl>
        <details className="lsp-effective"><summary>Effective native fields and provenance</summary><dl>{Object.entries(server.effective).map(([field,value])=><div key={field}><dt>{field}</dt><dd><code>{JSON.stringify(value)}</code><small>{catalog.sources.find(s=>s.id===server.fieldSources[field])?.path??'Native built-in default'}</small></dd></div>)}</dl></details>
        {server.sources.map(sourceId=>{const source=catalog.sources.find(s=>s.id===sourceId)!;return <div className="lsp-source-row" key={sourceId}><span>{sourceLabel(source)}{!source.writable?' · Read only':''}</span><button className="secondary-button" disabled={!connected||!source.writable||data.saving} onClick={()=>data.edit(source,server.name)}>Edit override</button></div>;})}
        <div className="lsp-actions"><span>Override in</span><button className="secondary-button" disabled={!connected||data.saving} onClick={()=>override(server.name,'user')}>User configuration</button><button className="secondary-button" disabled={!connected||!target||data.saving} onClick={()=>override(server.name,'project')}>This project</button></div>
      </details>)}</div>
      <details className="lsp-sources"><summary>Configuration sources and idle timeout</summary><p>Highest priority first. Overrides merge per server. Removing an override reveals lower sources; disabling keeps the override with Disabled turned on.</p>{catalog.sources.filter(s=>s.exists||Object.values(catalog.overrideTargets).includes(s.id)).map(source=><div className="lsp-source-row" key={source.id}><span>{sourceLabel(source)}{source.exists?'':' · Not created'}{!source.writable?' · Read only':''}<small>{source.idleTimeoutMs===undefined?'No idle timeout override':`Idle timeout ${source.idleTimeoutMs} ms`}</small></span><button className="secondary-button" disabled={!connected||!source.writable||source.scope==='project'&&!target||data.saving} onClick={()=>data.idle(source)}>Edit idle timeout</button></div>)}</details>
    </>}
    {data.draft&&catalog&&<LspEditor data={data} catalog={catalog} hasProject={!!target}/>}
  </section>;
}
function LspEditor({data,catalog,hasProject}:{data:LspSettingsState;catalog:NativeLspCatalog;hasProject:boolean}){
  const dialog=useRef<HTMLDialogElement>(null),draft=data.draft!,source=catalog.sources.find(s=>s.id===draft.sourceId),server=draft.kind==='server'?catalog.servers.find(s=>s.name===draft.name):undefined;
  useEffect(()=>{const element=dialog.current!,opener=document.activeElement as HTMLElement|null;element.showModal();return()=>{element.close();if(opener?.isConnected)opener.focus();};},[]);
  const enabled=data.connected&&!data.saving&&!data.stale&&source?.writable;
  const updateField=(key:string,value:SettingJson|undefined)=>{if(draft.kind!=='server')return;const values={...draft.values};if(value===undefined)delete values[key];else values[key]=value;data.change({...draft,values});};
  const fields=(advanced:boolean)=>Object.entries(lspServerFields).filter(([,field])=>!!field.advanced===advanced).map(([key,field])=>{
    if(draft.kind!=='server')return null;const overridden=Object.hasOwn(draft.values,key),effective=server?.effective[key];
    return <div className="lsp-field" key={key}><label className="lsp-override"><input type="checkbox" checked={overridden} disabled={data.saving} onChange={event=>updateField(key,event.target.checked?effective??nativeSettingSeed(field.schema):undefined)}/><span>Override {field.label.toLowerCase()}</span></label>{overridden?<NativeValueField label={field.label} value={draft.values[key]!} schema={field.schema} onChange={value=>updateField(key,value)} disabled={data.saving}/>:<p className="native-note">Inherited: {effective===undefined?'Native default / unset':JSON.stringify(effective)}</p>}</div>;
  });
  return <dialog ref={dialog} className="lsp-dialog" aria-labelledby="lsp-title" onCancel={event=>{event.preventDefault();data.close();}}>
    <div className="lsp-heading"><h2 id="lsp-title">{draft.kind==='idle'?'Idle timeout':draft.remove?'Remove override?':draft.originalName?`Configure ${draft.name}`:'Add language server'}</h2><button className="icon-button" aria-label="Close language server editor" disabled={data.saving} onClick={()=>data.close()}><Icon name="close"/></button></div>
    <p className="lsp-path">{source?.path??'Original source no longer available'}</p>
    {data.error&&<p className="inline-error" role="alert">{data.error}</p>}
    {!data.connected&&<p role="status">Disconnected. Your draft is preserved.</p>}
    <button className="secondary-button" disabled={!data.connected||data.loading||data.saving} onClick={()=>void data.refresh()}>Reload saved sources</button>
    {data.stale&&<div className="lsp-conflict" role="alert"><p>Saved configuration changed. Your edits are preserved. Review current source values before adopting the new revision.</p><pre>{JSON.stringify(draft.kind==='server'?source?.servers[draft.name]??{}:{idleTimeoutMs:source?.idleTimeoutMs},null,2)}</pre><button className="secondary-button" disabled={data.saving||!source||!data.connected} onClick={()=>data.reviewLatest()}>Keep edits and use reviewed revision</button></div>}
    <form onSubmit={event=>{event.preventDefault();void data.save();}}><fieldset disabled={data.saving}>
      {draft.kind==='idle'?<><label className="lsp-override"><input type="checkbox" checked={draft.value!==null} onChange={event=>data.change({...draft,value:event.target.checked?catalog.idleTimeoutMs??0:null})}/>Override idle timeout</label>{draft.value!==null&&<NativeValueField label="Idle timeout (ms)" value={draft.value} schema={{kind:'number',minimum:0}} onChange={value=>data.change({...draft,value:value as number})}/>}<p className="native-note">Unset removes this source’s value and reveals a lower timeout. Native default is disabled.</p></>:draft.remove?<p>Remove {draft.name} from this source. A lower configuration or built-in server can become active. This does not disable the server.</p>:<>
        {!draft.originalName&&<><label className="lsp-name">Server name<input className="text-field" autoFocus required value={draft.name} onChange={event=>data.change({...draft,name:event.target.value})}/></label><label className="lsp-name">Scope<select value={source?.scope} onChange={event=>{const next=catalog.sources.find(s=>s.id===catalog.overrideTargets[event.target.value as 'project'|'user']);if(next)data.change({...draft,sourceId:next.id,original:structuredClone(next.servers[draft.name]??{})});}}><option value="user">User configuration</option><option value="project" disabled={!hasProject}>This project</option></select></label></>}
        {fields(false)}<details className="native-advanced"><summary>Advanced native configuration</summary>{fields(true)}<p className="native-note">Unknown saved fields are preserved. Native aliases remain saved unless explicitly edited. Derived binary paths and client factories are read only.</p></details>
      </>}
      <div className="lsp-actions lsp-footer"><button className="secondary-button" type="button" onClick={()=>data.close()}>Cancel</button>{draft.kind==='server'&&!draft.remove&&Object.hasOwn(source?.servers??{},draft.name)&&<button className="danger-link" type="button" onClick={()=>data.change({...draft,remove:true})}>Remove override…</button>}<button className="primary-button" type="submit" disabled={!enabled||draft.kind==='server'&&!draft.name.trim()}>{data.saving?'Saving…':draft.kind==='server'&&draft.remove?'Remove override':'Save for new sessions'}</button></div>
    </fieldset></form>
  </dialog>;
}
