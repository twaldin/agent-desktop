import type { DesktopBridge, DapValues, NativeDapCatalog, NativeDapMutation, NativeDapSource, WorkspaceTarget } from '@agent-desktop/shared';
type Bridge=Pick<DesktopBridge,'getDapConfiguration'|'mutateDapConfiguration'|'subscribe'>;
export interface DapDraft { sourceId:string; name:string; originalName?:string; values:DapValues; original:DapValues; revision:string; remove:boolean }
export const dapObject=(value:unknown):value is DapValues=>!!value&&typeof value==='object'&&!Array.isArray(value);
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
/** Original owner + connection generation; failed or stale results never replace edits. */
export class DapSettingsState {
  catalog:NativeDapCatalog|null=null;draft:DapDraft|null=null;error:string|null=null;saving=false;loading=false;connected=false;
  private epoch=0;private sequence=0;private listeners=new Set<()=>void>();
  constructor(readonly bridge:Bridge,readonly hostId:string,readonly target?:WorkspaceTarget){}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  notify=()=>{for(const listener of this.listeners)listener();};
  disconnect(){this.epoch++;this.sequence++;this.connected=false;this.loading=false;if(this.saving)this.error='Connection changed while saving. The outcome is unknown. Reload and review the original source before trying again.';this.saving=false;this.notify();}
  dispose(){this.disconnect();this.listeners.clear();}
  async refresh(){if(!this.connected||this.saving)return;const epoch=this.epoch,sequence=++this.sequence;this.loading=true;this.notify();try{const next=await this.bridge.getDapConfiguration(this.target,this.hostId);if(epoch!==this.epoch||sequence!==this.sequence)return;this.catalog=next;if(!this.draft)this.error=null;}catch(error){if(epoch===this.epoch&&sequence===this.sequence)this.error=message(error);}finally{if(epoch===this.epoch&&sequence===this.sequence){this.loading=false;this.notify();}}}
  edit(source:NativeDapSource,name:string,adding=false){if(!this.catalog||this.saving)return;const saved=source.adapters[name];if(saved!==undefined&&!dapObject(saved)){this.error='This adapter entry has an unsupported structure. Repair the original source before editing it.';this.notify();return;}const original=structuredClone(saved??{});this.draft={sourceId:source.id,name,originalName:adding?undefined:name,values:structuredClone(original),original,revision:this.catalog.revision,remove:false};this.error=null;this.notify();}
  change(draft:DapDraft){this.draft=draft;this.notify();}
  close(){if(this.saving)return;this.draft=null;this.error=null;this.notify();}
  get stale(){return !!this.draft&&this.draft.revision!==this.catalog?.revision;}
  reviewLatest(){const draft=this.draft,source=this.catalog?.sources.find(s=>s.id===draft?.sourceId);if(!draft||!source||!this.catalog||this.saving)return;const current=source.adapters[draft.name]??{};if(!dapObject(current)){this.error='The saved adapter is no longer an object. Your draft is preserved.';this.notify();return;}const changed=Object.keys(draft.values).filter(k=>JSON.stringify(draft.values[k])!==JSON.stringify(draft.original[k]));const removed=Object.keys(draft.original).filter(k=>!Object.hasOwn(draft.values,k));const values={...current};for(const key of changed)values[key]=draft.values[key]!;for(const key of removed)delete values[key];this.draft={...draft,values,original:structuredClone(current),revision:this.catalog.revision};this.error=null;this.notify();}
  async save(){const draft=this.draft;if(!draft||!this.connected||this.saving||this.stale)return;const source=this.catalog?.sources.find(s=>s.id===draft.sourceId);if(!source?.writable)return;if(!draft.originalName&&Object.hasOwn(source.adapters,draft.name)){this.error='An override with this name already exists. Edit its original row instead.';this.notify();return;}const epoch=this.epoch;this.saving=true;this.sequence++;this.loading=false;this.error=null;this.notify();
    const base={sourceId:draft.sourceId,expectedRevision:draft.revision,name:draft.name};
    const mutation:NativeDapMutation=draft.remove?{...base,operation:'remove'}:{...base,operation:'save',changes:Object.fromEntries(Object.entries(draft.values).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(draft.original[key]))),removeFields:Object.keys(draft.original).filter(key=>!Object.hasOwn(draft.values,key))};
    try{const next=await this.bridge.mutateDapConfiguration(this.target,mutation,this.hostId);if(epoch!==this.epoch)return;this.catalog=next;this.draft=null;}
    catch(error){if(epoch===this.epoch)this.error=message(error)+' Your draft is preserved. Reload saved sources to check whether the write completed before retrying.';}
    finally{if(epoch===this.epoch){this.saving=false;this.notify();}}
  }
}
// Keep unsaved drafts when Settings changes owner/category, without saving them to disk.
const owners=new WeakMap<Bridge,Map<string,DapSettingsState>>();
export function dapSettingsOwner(bridge:Bridge,hostId:string,target?:WorkspaceTarget):DapSettingsState {
  let states=owners.get(bridge);if(!states){states=new Map();owners.set(bridge,states);}const key=JSON.stringify([hostId,target??null]);let state=states.get(key);if(!state){state=new DapSettingsState(bridge,hostId,target);states.set(key,state);}return state;
}
