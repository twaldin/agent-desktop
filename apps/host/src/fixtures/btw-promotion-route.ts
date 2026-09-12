import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandEnvelope, CommandResult, NativeBtwResponse, SessionSummary } from '@agent-desktop/shared';
import { startHost } from '../server';
const root=process.argv[2]!, agentDir=path.join(root,'agent'),cwd=path.join(root,'project'),gates=path.join(root,'gates');
await Promise.all([agentDir,cwd,gates].map(p=>mkdir(p)));
const hook=path.join(root,'branch-hook.ts'),count=path.join(root,'branches.log');
await writeFile(hook,`import {appendFileSync} from 'node:fs'; export default function(pi) { pi.on('session_before_branch', async (_e,ctx)=>{appendFileSync(${JSON.stringify(count)},'branch\\n'); return {cancel:!await ctx.ui.confirm('Promote side answer','Create the native branch?')};}); }`);
await writeFile(path.join(agentDir,'config.yml'),`extensions:\n  - ${JSON.stringify(fileURLToPath(new URL('../omp-workers/fixtures/btw-provider.ts',import.meta.url)))}\n  - ${JSON.stringify(hook)}\nretry:\n  enabled: false\n`);
for(let i=1;i<=4;i++)await writeFile(path.join(gates,`${i}.release`),'');
const options={dataDirectory:path.join(root,'data'),agentDirectory:agentDir,discoveryDirectory:cwd,workerPath:fileURLToPath(new URL('../omp-workers/fixtures/no-provider-worker.ts',import.meta.url))};
let host=await startHost(options);
async function request(url:string,body?:unknown,owner=false){const response=await fetch(host.connection.origin+url,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${host.connection.token}`,'Content-Type':'application/json',...(owner?{'X-Agent-Host-Id':host.store.host.id}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<any>;}
const command=(envelope:CommandEnvelope)=>request('/v1/commands',envelope) as Promise<CommandResult>;
// These requests intentionally remain pending while the fixture answers the
// native confirmation. Attach rejection ownership immediately so a fast peer
// close cannot become an unhandled rejection before the later assertion awaits it.
function deferred<T>(promise:Promise<T>){void promise.catch(()=>undefined);return promise;}
async function until<T>(read:()=>Promise<T>,accept:(v:T)=>boolean){const deadline=Date.now()+8000;let v=await read();while(!accept(v)&&Date.now()<deadline){await Bun.sleep(10);v=await read();}assert(accept(v),JSON.stringify(v));return v;}
const side=(id:string)=>request(`/v1/sessions/${id}/btw`,undefined,true) as Promise<NativeBtwResponse>;
async function answer(id:string,value:boolean){const questions=await until(()=>request(`/v1/sessions/${id}/interactions`),v=>v.some((q:any)=>q.title==='Promote side answer'));const q=questions.find((q:any)=>q.title==='Promote side answer');await request(`/v1/sessions/${id}/interactions`,{interactionId:q.id,response:{value}});}
async function prepared(label:string){
 const created=await command({id:`create-${label}`,command:{type:'session.create',projectId:null,cwd,model:{provider:'btw-contract',id:'controlled'}}});assert(created.ok);const session=created.value as SessionSummary;
 assert((await command({id:`prompt-${label}`,command:{type:'session.prompt',sessionId:session.id,text:'Parent history'}})).ok);
 await until(async()=>host.store.getSession(session.id),v=>v?.status==='idle');
 assert((await command({id:`side-${label}`,command:{type:'session.btw.start',sessionId:session.id,question:`Side ${label}`}})).ok);
 const ready=await until(()=>side(session.id),v=>v.value?.status==='complete');assert.equal(ready.promotion,true);assert.equal(ready.value?.canPromote,true);
 return session;
}
try{
 const original=await prepared('success'),bytes=await readFile(original.sessionFile);
 for(const prefix of ['session','btw'])assert((await command({id:`draft-${prefix}`,command:{type:'draft.put',expectedRevision:0,draft:{id:`${prefix}:${original.id}`,text:`Keep ${prefix}`,projectId:null,model:null}}})).ok);
 const draftBytes=JSON.stringify(host.store.listDrafts());
 const cancel:CommandEnvelope={id:'promote-cancel',command:{type:'session.btw.promote',sessionId:original.id,runId:'side-success'}};
 const cancelling=deferred(command(cancel));await answer(original.id,false);const cancelled=await cancelling;
 assert(cancelled.ok && cancelled.value && 'type' in cancelled.value && cancelled.value.type==='session.btw.promote' && cancelled.value.cancelled);
 assert.deepEqual(await command(cancel),cancelled);assert.equal((await side(original.id)).value?.canPromote,true);
 const promote:CommandEnvelope={id:'promote-success',command:{type:'session.btw.promote',sessionId:original.id,runId:'side-success'}};
 const promoting=deferred(command(promote)),duplicate=deferred(command(promote));await until(()=>request(`/v1/sessions/${original.id}/interactions`),v=>v.length>0);
 assert.equal((await side(original.id)).value?.canPromote,false);
 const competing=deferred(command({id:'promote-competing',command:promote.command}));await answer(original.id,true);
 const result=await promoting;assert(result.ok && result.value && 'type' in result.value && result.value.type==='session.btw.promote');
 if(!result.ok || !result.value || !('type' in result.value) || result.value.type!=='session.btw.promote')throw new Error('Missing promotion receipt');
 const child=result.value.session;assert(!result.value.cancelled);assert.notEqual(child.id,original.id);assert.notEqual(child.sessionFile,original.sessionFile);
 assert.deepEqual(await duplicate,result);assert.deepEqual(await command(promote),result);assert.equal((await competing).ok,false);
 assert.equal(host.store.listSessions().length,2);assert.equal(JSON.stringify(host.store.listDrafts()),draftBytes);assert.deepEqual(await readFile(original.sessionFile),bytes);
 const messages=await request(`/v1/sessions/${child.id}/messages`);assert.match(JSON.stringify(messages),/Side success/);assert.match(JSON.stringify(messages),/Side answer 2/);
 assert.equal((await side(original.id)).value?.canPromote,false);assert.equal((await readFile(count,'utf8')).trim().split('\n').length,2);
 // Force the actual SQLite receipt to fail after native branch creation. Neither
 // duplicate nor a fresh command may dispatch another branch for that run.
 const failure=await prepared('failure');
 const db=new Database(path.join(root,'data','state.sqlite'));
 db.exec("CREATE TRIGGER reject_promotion_receipt BEFORE UPDATE ON commands WHEN OLD.id = 'promote-lost' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
 const lostEnvelope:CommandEnvelope={id:'promote-lost',command:{type:'session.btw.promote',sessionId:failure.id,runId:'side-failure'}};
 const lost=deferred(command(lostEnvelope));await answer(failure.id,true);const unknown=await lost;assert(!unknown.ok);assert.equal(unknown.error.code,'OUTCOME_UNKNOWN');
 assert.equal(host.store.listSessions().length,3);assert.equal(host.store.getCommand('promote-lost')?.state,'pending');
 db.exec('DROP TRIGGER reject_promotion_receipt');db.close();
 assert.equal((await command(lostEnvelope)).ok,false);assert.equal((await command({id:'lost-new-id',command:lostEnvelope.command})).ok,false);
 assert.equal((await readFile(count,'utf8')).trim().split('\n').length,3);
 await host.stop();host=await startHost(options);
 assert.deepEqual(await command(promote),result);assert.equal((await command(lostEnvelope)).ok,false);
 assert.equal((await side(failure.id)).value?.canPromote,false);assert.equal(JSON.stringify(host.store.listDrafts()),draftBytes);
 await writeFile(path.join(root,'btw-promotion-route.passed'),'native promotion HTTP contracts passed\n');
}finally{await host.stop();}
