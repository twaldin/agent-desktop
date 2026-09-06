import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStore } from './store';
import { BtwService } from './btw';
import type { NativeBtwSnapshot, NativeBtwStart } from '@agent-desktop/shared';
const cleanup:Array<()=>void>=[];afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
const snap=(runId='old'):NativeBtwSnapshot=>({runId,sessionId:'s',question:'q',status:'running',answer:'',startedAt:1,updatedAt:1});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'btw-recovery-'));let store=new HostStore(root);const db=new Database(join(root,'state.sqlite'));
 cleanup.push(()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});});
 let archived=false,starts=0,opens=0,live:NativeBtwSnapshot|null=null;
 const handle={getBtw:async()=>live,startBtw:async(input:NativeBtwStart)=>{starts++;return live={...snap(input.runId),question:input.question};},cancelBtw:async(id:string)=>live&&live.runId===id?(live={...live,status:'cancelled'}):null};
 let existing:typeof handle|undefined=handle;
 const read=()=>store.readMetadata<NativeBtwSnapshot>('btw:s')??null;
 const options={session:(id:string)=>id==='s'?{id,archived,status:'running'}:undefined,read,write:(_id:string,value:NativeBtwSnapshot|null)=>store.writeMetadata('btw:s',value),getHandle:async()=>{opens++;return handle;},getExistingHandle:async()=>existing};
 return {db,handle,options,read,service:new BtwService(options),reopen(){store.close();store=new HostStore(root);},get starts(){return starts;},get opens(){return opens;},set existing(v:typeof handle|undefined){existing=v;},set live(v:NativeBtwSnapshot|null){live=v;},set archived(v:boolean){archived=v;}};
}
test('SQLite intent failure prevents native admission entirely',async()=>{
 const f=fixture();f.db.run("CREATE TRIGGER deny_btw BEFORE INSERT ON metadata WHEN new.key='btw:s' BEGIN SELECT RAISE(ABORT,'disk failure'); END");
 await expect(f.service.start('s',{runId:'first',question:'q'})).rejects.toThrow('disk failure');expect(f.starts).toBe(0);expect(f.read()).toBeNull();
});
test('lost receipt retains exact native identity and GET observes completion without dispatching',async()=>{
 const f=fixture();f.handle.startBtw=async input=>{f.live={...snap(input.runId),status:'complete',answer:'actual answer',updatedAt:2};throw Error('IPC ack lost');};
 await expect(f.service.start('s',{runId:'first',question:'q'})).rejects.toMatchObject({code:'OUTCOME_UNKNOWN'});
 expect(f.read()?.runId).toBe('first');expect((await f.service.snapshot('s'))?.answer).toBe('actual answer');expect(f.opens).toBe(1);
});
test('receipt persistence failure remains unknown; reopened SQLite and dead worker never replay it',async()=>{
 const f=fixture();f.handle.startBtw=async input=>{f.live={...snap(input.runId),status:'complete',answer:'native result',updatedAt:2};f.db.run("CREATE TRIGGER deny_update BEFORE UPDATE ON metadata WHEN new.key='btw:s' BEGIN SELECT RAISE(ABORT,'receipt failure'); END");return {...snap(input.runId),status:'complete',answer:'native result',updatedAt:2};};
 await expect(f.service.start('s',{runId:'first',question:'q'})).rejects.toMatchObject({code:'OUTCOME_UNKNOWN'});expect(f.read()?.status).toBe('running');
 f.db.run('DROP TRIGGER deny_update');f.existing=undefined;f.reopen();const restarted=new BtwService(f.options);expect((await restarted.snapshot('s'))?.status).toBe('failed');expect(f.opens).toBe(1);
 await restarted.start('s',{runId:'first',question:'q'});expect(f.opens).toBe(1);
});
test('late read is serialized before new admission and cannot overwrite newer state',async()=>{
 const f=fixture();await f.service.start('s',{runId:'old',question:'q'});let release!:(v:NativeBtwSnapshot)=>void;let begun=false;
 f.handle.getBtw=()=>{begun=true;return new Promise(r=>{release=r;});};const oldRead=f.service.snapshot('s');while(!begun)await Bun.sleep(1);
 const next=f.service.start('s',{runId:'new',question:'next'});release({...snap(),status:'complete',answer:'old answer',updatedAt:2});await oldRead;await next;expect(f.read()?.runId).toBe('new');expect(f.starts).toBe(2);
});
test('live worker with no native side run cannot leave cached running state forever',async()=>{
 const f=fixture();await f.service.start('s',{runId:'first',question:'q'});f.live=null;expect((await f.service.snapshot('s'))?.status).toBe('failed');expect(f.starts).toBe(1);expect(f.opens).toBe(1);
});
test('archive and owner changes across worker lookup reject before any side prompt',async()=>{
 const f=fixture();f.options.getHandle=async()=>{f.archived=true;return f.handle;};await expect(f.service.start('s',{runId:'first',question:'q'})).rejects.toThrow('Archived');expect(f.starts).toBe(0);expect(f.read()).toBeNull();
});
