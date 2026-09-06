import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerRuntime } from './runtime';

async function fixture(branchHook=false) {
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-btw-promotion-')));
 const agentDir=path.join(root,'agent'),cwd=path.join(root,'project'),gates=path.join(root,'gates');
 await Promise.all([agentDir,cwd,gates].map(p=>mkdir(p)));
 await writeFile(path.join(agentDir,'config.yml'),`extensions:\n  - ${JSON.stringify(fileURLToPath(new URL('./fixtures/btw-provider.ts',import.meta.url)))}\nretry:\n  enabled: false\n`);
 if (branchHook) {
  const hook=path.join(root,'branch-hook.ts');
  await writeFile(hook, `export default function(pi) { pi.on('session_before_branch', async (_event,ctx)=>({cancel:!await ctx.ui.confirm('Promote side answer','Create the native branch?')})); }`);
  const config=await readFile(path.join(agentDir,'config.yml'),'utf8');
  await writeFile(path.join(agentDir,'config.yml'),config.replace('retry:',`  - ${JSON.stringify(hook)}\nretry:`));
 }
 const runtime=new WorkerRuntime({agentDir,workerPath:fileURLToPath(new URL('./fixtures/no-provider-worker.ts',import.meta.url)),environment:{PATH:process.env.PATH,TMPDIR:tmpdir(),PI_CODING_AGENT_DIR:agentDir,BTW_CONTRACT_GATES:gates,TERM:'dumb'}});
 return {root,runtime,cwd,gates,close:async()=>{await runtime.dispose();await rm(root,{recursive:true,force:true});}};
}

test('native side promotion persists a distinct branch, retires old callbacks and releases both file reservations only on disposal', async()=>{
 const {runtime,cwd,gates,close}=await fixture();
 try{
  const events:unknown[]=[];const session=await runtime.create({cwd,interactions:true,onEvent:e=>events.push(e)});
  await writeFile(path.join(gates,'1.release'),'');
  await session.prompt('Parent history',{model:{provider:'btw-contract',id:'controlled'}});
  const originId=session.id,originFile=session.sessionFile,original=await readFile(originFile),messages=await session.getMessages();
  await writeFile(path.join(gates,'2.release'),'');await session.startBtw({runId:'promote-side',question:'A real side question'});
  let side=await session.getBtw();const deadline=Date.now()+8000;
  while(side?.status!=='complete'&&Date.now()<deadline){await Bun.sleep(10);side=await session.getBtw();}
  expect(side?.status).toBe('complete');const beforeEvents=events.length;
  const promoted=await session.promoteBtw('promote-side');
  expect(promoted.cancelled).toBe(false);expect(promoted.sessionId).not.toBe(originId);expect(promoted.sessionFile).not.toBe(originFile);
  expect(session.id).toBe(promoted.sessionId);expect(session.sessionFile).toBe(promoted.sessionFile);
  expect(await readFile(originFile)).toEqual(original);// A queued parent agent_end can arrive after its completion RPC. No branch
  // messages or new-owner UI events may be published to that origin callback.
  expect(events.slice(beforeEvents).filter((e:any)=>e.type !== 'agent_end' && e.sessionId !== originId)).toEqual([]);
  await expect(session.getMessages()).rejects.toThrow('transitioning');
  await expect(session.promoteBtw('promote-side')).rejects.toThrow('transitioning');
  await expect(runtime.open({sessionFile:originFile})).rejects.toThrow('already open');
  await expect(runtime.open({sessionFile:promoted.sessionFile})).rejects.toThrow('already open');
  await session.dispose();
  const parent=await runtime.open({sessionFile:originFile}),child=await runtime.open({sessionFile:promoted.sessionFile});
  expect(parent.id).toBe(originId);expect(await parent.getMessages()).toEqual(messages);
  expect(child.id).toBe(promoted.sessionId);const branch=await child.getMessages();
  expect(branch.length).toBe(messages.length+2);expect(JSON.stringify(branch)).toContain('A real side question');expect(JSON.stringify(branch)).toContain('Side answer 2');
  expect(await readFile(originFile)).toEqual(original);
 }finally{await close();}
},30000);

test('native branch hooks remain interactive, cancellation preserves the origin, and accepted promotion retires it',async()=>{
 const f=await fixture(true);
 try{
  const session=await f.runtime.create({cwd:f.cwd,interactions:true});
  await writeFile(path.join(f.gates,'1.release'),'');await session.prompt('Parent history',{model:{provider:'btw-contract',id:'controlled'}});
  const origin=session.id,file=session.sessionFile,bytes=await readFile(file);
  const complete=async(run:string,call:number)=>{
   await writeFile(path.join(f.gates,`${call}.release`),'');await session.startBtw({runId:run,question:run});
   const deadline=Date.now()+7000;while((await session.getBtw())?.status!=='complete'&&Date.now()<deadline)await Bun.sleep(10);
   expect((await session.getBtw())?.status).toBe('complete');
  };
  const interaction=async()=>{
   const deadline=Date.now()+7000;let list=await session.listInteractions();
   while(!list.some(i=>i.title==='Promote side answer')&&Date.now()<deadline){await Bun.sleep(10);list=await session.listInteractions();}
   const found=list.find(i=>i.title==='Promote side answer');expect(found).toBeDefined();return found!;
  };
  await complete('cancelled-branch',2);const cancel=session.promoteBtw('cancelled-branch');const question=await interaction();
  await expect(session.getMessages()).rejects.toThrow('transitioning');
  await expect(session.setModel({provider:'btw-contract',id:'controlled'})).rejects.toThrow('transitioning');
  await session.respondInteraction(question.id,{value:false});expect((await cancel).cancelled).toBe(true);
  expect(session.id).toBe(origin);expect(await readFile(file)).toEqual(bytes);expect(await session.getMessages()).toHaveLength(2);
  expect((await session.promoteBtw('cancelled-branch')).cancelled).toBe(true);expect(await session.listInteractions()).toHaveLength(0);
  await complete('accepted-branch',3);const promote=session.promoteBtw('accepted-branch');const accepted=await interaction();
  await session.respondInteraction(accepted.id,{value:true});expect((await promote).cancelled).toBe(false);
  expect(session.id).not.toBe(origin);expect(await readFile(file)).toEqual(bytes);
 }finally{await f.close();}
},30000);

test('disposing during a native branch confirmation cancels the question and settles promotion before releasing ownership',async()=>{
 const f=await fixture(true);
 try{
  const session=await f.runtime.create({cwd:f.cwd,interactions:true});
  await writeFile(path.join(f.gates,'1.release'),'');await session.prompt('Parent history',{model:{provider:'btw-contract',id:'controlled'}});
  const id=session.id,file=session.sessionFile,bytes=await readFile(file);
  await writeFile(path.join(f.gates,'2.release'),'');await session.startBtw({runId:'dispose-confirm',question:'Dispose confirmation'});
  let deadline=Date.now()+7000;while((await session.getBtw())?.status!=='complete'&&Date.now()<deadline)await Bun.sleep(10);
  expect((await session.getBtw())?.status).toBe('complete');const promotion=session.promoteBtw('dispose-confirm');
  deadline=Date.now()+7000;let questions=await session.listInteractions();
  while(!questions.length&&Date.now()<deadline){await Bun.sleep(10);questions=await session.listInteractions();}
  expect(questions.some(q=>q.title==='Promote side answer')).toBe(true);
  const closing=session.dispose();expect((await promotion).cancelled).toBe(true);await closing;
  expect(session.id).toBe(id);
  const after=await readFile(file,'utf8'),before=bytes.toString('utf8');expect(after.startsWith(before)).toBe(true);
  const appended=after.slice(before.length).trim().split('\n').map(line=>JSON.parse(line));
  expect(appended).toHaveLength(1);expect(appended[0]).toMatchObject({type:'custom',customType:'session_exit',data:{reason:'dispose',kind:'normal'}});
  const reopened=await f.runtime.open({sessionFile:file});expect(reopened.id).toBe(id);expect(await reopened.getMessages()).toHaveLength(2);
 }finally{await f.close();}
},30000);
