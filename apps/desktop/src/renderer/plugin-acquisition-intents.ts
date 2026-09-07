import type {NativePluginAcquisition, WorkspaceTarget} from '@agent-desktop/shared';
export interface AcquisitionIntent {id:string;operation:NativePluginAcquisition['operation'];target?:WorkspaceTarget}
const prefix=(host:string)=>`agent-desktop.plugin-acquisition.${encodeURIComponent(host)}.`;
export function readAcquisitionIntents(storage:Storage,host:string):AcquisitionIntent[]{
 const values:AcquisitionIntent[]=[];
 for(let i=0;i<storage.length;i++){
  const key=storage.key(i);if(!key?.startsWith(prefix(host)))continue;
  try{const value=JSON.parse(storage.getItem(key)!);
   if(typeof value.id!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.id)||key!==prefix(host)+value.id||!['marketplace.add','marketplace.update','marketplace.remove','plugin.install','plugin.uninstall'].includes(value.operation))continue;
   const target=value.target;
   if(target!==undefined&&(!target||typeof target!=='object'||Object.keys(target).length!==1||!Object.entries(target).every(([key,id])=>(key==='projectId'||key==='sessionId')&&typeof id==='string'&&id.length>0&&id.length<=200&&!id.includes('\0'))))continue;
   values.push({id:value.id,operation:value.operation,...(target?{target}: {})});
  }catch{}
 }return values;
}
export function saveAcquisitionIntent(storage:Storage,host:string,intent:AcquisitionIntent):void{
 // Never persist the source URL, revision or full request body.
 storage.setItem(prefix(host)+intent.id,JSON.stringify({id:intent.id,operation:intent.operation,...(intent.target?{target:intent.target}:{})}));
}
export function clearAcquisitionIntent(storage:Storage,host:string,id:string):void{storage.removeItem(prefix(host)+id);}
