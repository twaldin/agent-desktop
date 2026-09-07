import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginAcquisitionRecords } from './acquisition-records';
import { PluginAcquisitionOperations } from './acquisition-operations';
import { PluginAcquisitionHttp, parsePluginAcquisition } from './acquisition-http';
import type { NativeMarketplaceCatalog, NativePluginAcquisitionRequest } from '../../../../packages/shared/src/plugin-acquisition';

const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const catalog:NativeMarketplaceCatalog={revision:'catalog-r1',projectScopeAvailable:true,marketplaces:[],installed:[]};
const request=():NativePluginAcquisitionRequest=>({id:crypto.randomUUID(),expectedRevision:catalog.revision,action:{operation:'marketplace.add',source:'https://private-user:private-secret@example.test/catalog.json?secret=private-query'}});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'acquisition-records-'));cleanups.push(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'state.sqlite');
  const connect=()=>{const db=new Database(file);db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,data TEXT NOT NULL)');cleanups.push(()=>db.close());return db;};
  const db=connect();return{db,connect,records:new PluginAcquisitionRecords(db)};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
test('durable admission precedes native work; duplicate clients do not replay and payloads are absent from records',async()=>{
  const f=await fixture(),gate=Promise.withResolvers<void>();let calls=0;
  const operations=new PluginAcquisitionOperations(f.records,{read:async()=>catalog,mutate:async()=>{calls++;await gate.promise;return catalog;}});
  const input=request(),receipt=operations.start('/project',input,{projectId:'p'});
  expect(receipt.state).toBe('running');expect(calls).toBe(0);
  const follower=new PluginAcquisitionRecords(f.connect());expect(follower.get('/project',input.id)).toEqual(receipt);
  expect(operations.start('/project',input,{projectId:'p'})).toEqual(receipt);
  expect(()=>operations.start('/project',{...input,expectedRevision:'different'},{projectId:'p'})).toThrow('different request');
  expect(()=>operations.start('/other',request(),{projectId:'other'})).toThrow('running or needs review');
  expect(follower.get('/other',input.id)).toBeUndefined();
  expect(operations.list()[0]?.target).toEqual({projectId:'p'});
  const data=f.db.query<{data:string},[]>('SELECT data FROM metadata').all().map(x=>x.data).join('');
  for(const value of ['private-secret','private-query','example.test'])expect(data).not.toContain(value);
  await tick();expect(calls).toBe(1);gate.resolve();await operations.dispose();
  expect(follower.get('/project',input.id)?.state).toBe('succeeded');
});
test('native failures are private needs-review receipts; review fences actual settlement and current native revision',async()=>{
  const f=await fixture(),gate=Promise.withResolvers<void>();let reads=0;
  const operations=new PluginAcquisitionOperations(f.records,{read:async()=>{reads++;return catalog;},mutate:async()=>{await gate.promise;throw new Error('private-credential-native-error');}});
  const input=request();operations.start('/project',input);
  await expect(operations.review('/project',input.id,catalog.revision)).rejects.toThrow('not settled');
  gate.resolve();await tick();expect(operations.get('/project',input.id)?.state).toBe('needs-review');
  expect(JSON.stringify(operations.list())).not.toContain('private-credential');
  await expect(operations.review('/project',input.id,'stale')).rejects.toThrow('changed');
  expect(()=>operations.start('/project',request())).toThrow('needs review');
  const reviewed=await operations.review('/project',input.id,catalog.revision);expect(reviewed.state).toBe('reviewed');expect(reads).toBe(2);
  expect(operations.start('/project',input).state).toBe('reviewed'); // Same identity can never become a retry.
  await operations.dispose();
});
test('host recovery marks interrupted work uncertain without replay and successful native work never outruns a failed receipt commit',async()=>{
  const f=await fixture(),input=request();f.records.claim('/project',input.id,'hash','marketplace.add');
  const recovered=new PluginAcquisitionRecords(f.connect());expect(recovered.get('/project',input.id)?.state).toBe('running');
  recovered.recoverInterrupted();expect(recovered.get('/project',input.id)?.state).toBe('needs-review');
  recovered.review('/project',input.id);
  f.db.exec(`CREATE TRIGGER reject_terminal BEFORE UPDATE ON metadata WHEN json_extract(new.data,'$.state')='succeeded' BEGIN SELECT RAISE(FAIL,'receipt-failure'); END`);
  let calls=0;const operations=new PluginAcquisitionOperations(f.records,{read:async()=>catalog,mutate:async()=>{calls++;return catalog;}});
  const next=request();operations.start('/project',next);await expect(operations.dispose()).rejects.toThrow('receipts');
  expect(calls).toBe(1);expect(f.records.get('/project',next.id)?.state).toBe('running');
  expect(()=>f.records.claim('/project',crypto.randomUUID(),'hash2','marketplace.add')).toThrow('running');
  f.db.exec('DROP TRIGGER reject_terminal');recovered.recoverInterrupted();expect(recovered.get('/project',next.id)?.state).toBe('needs-review');
});
test('graceful shutdown rejects new admissions but drains the exact native operation rather than cancelling it',async()=>{
  const f=await fixture(),gate=Promise.withResolvers<void>();let calls=0,ended=false;
  const operations=new PluginAcquisitionOperations(f.records,{read:async()=>catalog,mutate:async()=>{calls++;await gate.promise;ended=true;return catalog;}});
  const input=request();operations.start('/project',input);let closed=false;
  const stop=operations.dispose().then(()=>{closed=true;});await tick();expect(closed).toBe(false);expect(ended).toBe(false);
  expect(()=>operations.start('/project',request())).toThrow('stopping');
  gate.resolve();await stop;expect(ended).toBe(true);expect(calls).toBe(1);
});
test('bounded private HTTP requires owned targets, returns admission without waiting, and observes the same receipt',async()=>{
  const f=await fixture(),gate=Promise.withResolvers<void>();let calls=0;
  const runtime={read:async()=>catalog,mutate:async()=>{calls++;await gate.promise;return catalog;}};
  const operations=new PluginAcquisitionOperations(f.records,runtime);
  const http=new PluginAcquisitionHttp({operations,read:runtime.read,resolveCwd:target=>{if(target&&'projectId'in target&&target.projectId==='p')return '/project';throw new Error('private-path');}});
  const post=async(method:string,body:unknown)=>{const url=new URL('http://host/v1/integrations/acquisition/'+method);return(await http.route(new Request(url,{method:'POST',body:JSON.stringify(body)}),url))!;};
  expect((await post('catalog',{target:{cwd:'/any'}})).status).toBe(400);
  const input=request();const started=await post('start',{target:{projectId:'p'},request:input});
  expect(started.status).toBe(202);expect(started.headers.get('cache-control')).toBe('no-store');
  expect((await started.json() as {state:string}).state).toBe('running');
  expect((await post('start',{target:{projectId:'p'},request:input})).status).toBe(202);
  const listed=await post('operations',{target:{projectId:'p'}});expect(await listed.text()).not.toContain('private-secret');
  expect((await post('start',{target:{projectId:'p'},request:{...input,id:'../../escape'}})).status).toBe(400);
  gate.resolve();await http.dispose();expect(calls).toBe(1);
  expect((await post('catalog',{target:{projectId:'p'}})).status).toBe(503);
});
test('acquisition parser rejects unknown/unsafe fields while preserving an explicit source',()=>{
  const input=request();expect(parsePluginAcquisition(input)).toEqual(input);
  for(const action of [{operation:'marketplace.remove',name:'../escape'},{operation:'plugin.uninstall',pluginId:'x@y@z',scope:'user'},{operation:'plugin.install',name:'x',marketplace:'y',scope:'all'},{operation:'marketplace.add',source:'ok',env:{TOKEN:'secret'}}])expect(()=>parsePluginAcquisition({...input,action})).toThrow();
});
