import {expect,test} from 'bun:test';
import {readAcquisitionIntents,saveAcquisitionIntent,clearAcquisitionIntent,latestLocalAcquisitionResult} from './plugin-acquisition-intents';
import type {NativePluginAcquisitionReceipt} from '@agent-desktop/shared';
function storage(){const map=new Map<string,string>();return{get length(){return map.size;},key:(i:number)=>[...map.keys()][i]??null,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);},clear:()=>map.clear()} satisfies Storage;}
test('recovered host-wide intents display completion only for the exact project/session/default owner',()=>{
 const receipts:NativePluginAcquisitionReceipt[]=[{id:'other',operation:'plugin.install',state:'succeeded',target:{projectId:'other'},createdAt:4,updatedAt:4},{id:'session',operation:'plugin.upgrade',state:'succeeded',target:{sessionId:'same'},createdAt:3,updatedAt:3},{id:'project',operation:'plugin.upgrade',state:'succeeded',target:{projectId:'same'},createdAt:2,updatedAt:2},{id:'default',operation:'marketplace.update',state:'succeeded',createdAt:1,updatedAt:1}];
 const recovered=new Set(receipts.map(row=>row.id));
 expect(latestLocalAcquisitionResult(receipts,recovered,{projectId:'same'})?.id).toBe('project');
 expect(latestLocalAcquisitionResult(receipts,recovered,{sessionId:'same'})?.id).toBe('session');
 expect(latestLocalAcquisitionResult(receipts,recovered)?.id).toBe('default');
 expect(latestLocalAcquisitionResult(receipts,recovered,{projectId:'missing'})).toBeUndefined();
 expect(latestLocalAcquisitionResult(receipts,new Set(['other']),{projectId:'same'})).toBeUndefined();
 expect(receipts.map(row=>row.id)).toEqual(['other','session','project','default']);
});
test('pending acquisition stores only identity/owner metadata and independently retains simultaneous requests',()=>{
 const s=storage(),first={id:crypto.randomUUID(),operation:'marketplace.add' as const,target:{projectId:'project'},source:'private-source',expectedRevision:'private-revision'},second={id:crypto.randomUUID(),operation:'plugin.upgrade' as const};
 saveAcquisitionIntent(s,'one',first);saveAcquisitionIntent(s,'one',second);saveAcquisitionIntent(s,'two',first);
 expect(readAcquisitionIntents(s,'one')).toHaveLength(2);expect(readAcquisitionIntents(s,'two')).toHaveLength(1);
 expect([...Array(s.length)].map((_,i)=>s.getItem(s.key(i)!)).join()).not.toContain('private-');
 clearAcquisitionIntent(s,'one',first.id);expect(readAcquisitionIntents(s,'one')).toEqual([second]);expect(readAcquisitionIntents(s,'two')).toHaveLength(1);
});
test('corrupt persisted metadata cannot become an unclosable pending operation',()=>{
 const s=storage(),id=crypto.randomUUID(),key='agent-desktop.plugin-acquisition.one.';
 for(const value of [{id:'-'.repeat(36),operation:'plugin.install'},{id,operation:'plugin.install',target:{projectId:''}},{id,operation:'plugin.install',target:{sessionId:'a'.repeat(201)}},{id,operation:'plugin.install',target:{projectId:'x',sessionId:'y'}},{id,operation:'plugin.install',target:{projectId:'x\0y'}},{id,operation:'anything'}]){
  s.clear();s.setItem(key+value.id,JSON.stringify(value));expect(readAcquisitionIntents(s,'one')).toEqual([]);
 }
 s.setItem(key+id,'{broken');expect(readAcquisitionIntents(s,'one')).toEqual([]);
});
