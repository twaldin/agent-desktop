import { expect, test } from 'bun:test';
import type { CommandEnvelope, CommandResult, DesktopBridge, NativeBtwResponse, NativeBtwSnapshot } from '../../../../packages/shared/src/protocol';
import { DraftController, type DraftCache } from './drafts';
import { BtwState } from './btw-state';
const value = (runId: string): NativeBtwSnapshot => ({ runId, sessionId: 'session', question: 'question', answer: '', status: 'running', startedAt: 1, updatedAt: 1 });
function fixture(command: (e: CommandEnvelope) => Promise<CommandResult>, storage?: DraftCache) {
 const memory = new Map<string,string>(); const cache = storage ?? { read: (k:string) => memory.get(k) ?? null, write: (k:string,v:string) => {memory.set(k,v);} };
 const drafts = new DraftController(async e => { if(e.command.type !== 'draft.put') throw Error('unexpected'); return {ok:true,commandId:e.id,value:{...e.command.draft,revision:e.command.expectedRevision+1,updatedAt:1}}; },'host',cache);
 drafts.setConnected(true); drafts.update('btw:session',{text:'question'});
 const bridge = {command,getBtw:async()=>({protocolVersion:1,hostId:'host',sessionId:'session',value:null,draftConsumption:true})} as unknown as DesktopBridge;
 return {cache,drafts,bridge,controller:new BtwState(bridge,'host','session',drafts,cache)};
}
test('lost acknowledgement retains exact request across remount, recovery does not generate another id',async()=>{
 const calls:CommandEnvelope[]=[];const f=fixture(async e=>{calls.push(e);if(calls.length===1)throw Error('connection lost');return {ok:true,commandId:e.id,value:{type:'session.btw',snapshot:value(e.id)}};});
 try {await f.controller.start();expect(f.controller.pending).toBeDefined();expect(f.drafts.get('btw:session').draft.text).toBe('question');
 const restored=new BtwState(f.bridge,'host','session',f.drafts,f.cache);await restored.refresh(true);
 expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(restored.pending).toBeUndefined();expect(f.drafts.get('btw:session').draft.text).toBe('');}finally{f.drafts.dispose();}
});
test('accepted side question preserves typing after Send and only uses side cancellation',async()=>{
 let resolve!:(r:CommandResult)=>void;const calls:CommandEnvelope[]=[];const f=fixture(e=>{calls.push(e);return new Promise(r=>{resolve=r;});});
 try {const send=f.controller.start();while(!calls.length)await Bun.sleep(1);f.drafts.update('btw:session',{text:'next draft'});
 resolve({ok:true,commandId:calls[0]!.id,value:{type:'session.btw',snapshot:value(calls[0]!.id)}});await send;expect(f.drafts.get('btw:session').draft.text).toBe('next draft');
 const stop=f.controller.cancel();while(calls.length<2)await Bun.sleep(1);expect(calls[1]!.command).toEqual({type:'session.btw.cancel',sessionId:'session',runId:calls[0]!.id});resolve({ok:true,commandId:calls[1]!.id,value:{type:'session.btw',snapshot:{...value(calls[0]!.id),status:'cancelled'}}});await stop;}finally{f.drafts.dispose();}
});
test('receipt storage failure prevents provider dispatch; wrong owner observations cannot replace content',async()=>{
 let sends=0;const memory=new Map<string,string>();const f=fixture(async()=>{sends++;throw Error('must not send');},{read:k=>memory.get(k)??null,write:(k,v)=>{if(k.startsWith('btw.pending.'))throw Error('disk full');memory.set(k,v);}});
 try {await f.controller.start();expect(sends).toBe(0);expect(f.controller.error).toContain('disk full');
 f.bridge.getBtw=async()=>({protocolVersion:1,hostId:'other',sessionId:'session',value:value('run')});await f.controller.refresh();expect(f.controller.value).toBeNull();expect(f.controller.error).toContain('another session');}finally{f.drafts.dispose();}
});
test('a stale GET cannot overwrite the side request accepted after that read began',async()=>{
 let read!:(v:NativeBtwResponse)=>void;const f=fixture(async e=>({ok:true,commandId:e.id,value:{type:'session.btw',snapshot:value(e.id)}}));
 try {f.bridge.getBtw=()=>new Promise(r=>{read=r;});const old=f.controller.refresh();await f.controller.start();const id=f.controller.value!.runId;
 read({protocolVersion:1,hostId:'host',sessionId:'session',value:value('old')});await old;expect(f.controller.value?.runId).toBe(id);}finally{f.drafts.dispose();}
});

test('malformed persisted receipts remain blocked after a healthy read instead of generating a replacement send', async () => {
 for (const saved of ['{broken', '{}', JSON.stringify({envelope:{id:'known',command:{type:'session.btw.cancel',sessionId:'session'}}}), JSON.stringify({envelope:{id:'known',command:{type:'session.btw.promote',sessionId:'session'}}})]) {
  let calls=0; const memory=new Map<string,string>();
  memory.set('btw.pending.host.session',saved);
  const f=fixture(async()=>{calls++;throw Error('must not send');},{read:k=>memory.get(k)??null,write:(k,v)=>{memory.set(k,v);}});
  try {await f.controller.refresh();await f.controller.start();expect(calls).toBe(0);expect(f.controller.ready).toBe(false);expect(f.controller.error).toContain('Sending is disabled');expect(memory.get('btw.pending.host.session')).toBe(saved);}finally{f.drafts.dispose();}
 }
});

test('lost promotion receipt reuses its exact identity, preserves drafts, and exposes only the confirmed same-host session', async () => {
 const calls:CommandEnvelope[]=[];
 const promoted = {id:'promoted-session',hostId:'host',projectId:null,cwd:'/project',title:'Forked answer',status:'idle' as const,
  sessionFile:'/sessions/promoted.jsonl',model:{provider:'fixture',id:'model'},createdAt:2,updatedAt:2,archived:false};
 const f=fixture(async e=>{calls.push(e);if(calls.length===1)throw Error('connection lost');return {ok:true,commandId:e.id,value:{type:'session.btw.promote',cancelled:false,session:promoted}};});
 try {
  f.drafts.update('session:session',{text:'main draft stays'});f.drafts.update('btw:session',{text:'side draft stays'});
  f.controller.value={...value('completed-run'),status:'complete',answer:'answer',canPromote:true};f.controller.promotionAvailable=true;f.controller.ready=true;
  await f.controller.promote();expect(f.controller.pending?.envelope.command).toEqual({type:'session.btw.promote',sessionId:'session',runId:'completed-run'});
  const restored=new BtwState(f.bridge,'host','session',f.drafts,f.cache);await restored.refresh(true);
  expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(restored.pending?.promotedSession).toEqual(promoted);
  const afterReceiptRestart=new BtwState(f.bridge,'host','session',f.drafts,f.cache);expect(afterReceiptRestart.takePromotedSession()).toBeUndefined();
  await afterReceiptRestart.refresh(true);expect(calls).toHaveLength(3);expect(calls[2]).toEqual(calls[0]);
  expect(afterReceiptRestart.takePromotedSession()).toEqual(promoted);expect(afterReceiptRestart.pending).toBeUndefined();expect(afterReceiptRestart.takePromotedSession()).toBeUndefined();
  expect(f.drafts.get('session:session').draft.text).toBe('main draft stays');expect(f.drafts.get('btw:session').draft.text).toBe('side draft stays');
 }finally{f.drafts.dispose();}
});

test('cancelled promotion does not navigate and a foreign receipt remains pending for inspection', async () => {
 const original={id:'session',hostId:'host',projectId:null,cwd:'/project',title:'Original',status:'idle' as const,
  sessionFile:'/sessions/original.jsonl',model:{provider:'fixture',id:'model'},createdAt:1,updatedAt:1,archived:false};
 let mode:'cancelled'|'foreign'='cancelled';
 const f=fixture(async e=>({ok:true,commandId:e.id,value:{type:'session.btw.promote',cancelled:mode==='cancelled',session:{...original,hostId:mode==='foreign'?'other':'host'}}}));
 try {
  f.controller.value={...value('complete'),status:'complete',answer:'answer',canPromote:true};f.controller.promotionAvailable=true;f.controller.ready=true;
  await f.controller.promote();expect(f.controller.takePromotedSession()).toBeUndefined();expect(f.controller.pending).toBeUndefined();
  mode='foreign';await f.controller.promote();expect(f.controller.pending?.envelope.command.type).toBe('session.btw.promote');expect(f.controller.error).toContain('another host');expect(f.controller.takePromotedSession()).toBeUndefined();
 }finally{f.drafts.dispose();}
});

test('promotion gates refuse unavailable states and a noncancelled origin-session receipt stays pending', async () => {
 let calls=0;
 const original={id:'session',hostId:'host',projectId:null,cwd:'/project',title:'Original',status:'idle' as const,
  sessionFile:'/sessions/original.jsonl',model:{provider:'fixture',id:'model'},createdAt:1,updatedAt:1,archived:false};
 const f=fixture(async e=>{calls++;return {ok:true,commandId:e.id,value:{type:'session.btw.promote',cancelled:false,session:original}};});
 try {
  f.controller.value={...value('complete'),status:'complete',answer:'answer',canPromote:true};f.controller.promotionAvailable=true;
  await f.controller.promote();expect(calls).toBe(0);
  f.controller.ready=true;f.controller.value.canPromote=false;await f.controller.promote();expect(calls).toBe(0);
  f.controller.value={...f.controller.value,canPromote:true,status:'running'};await f.controller.promote();expect(calls).toBe(0);
  f.controller.value={...f.controller.value,status:'complete'};await f.controller.promote();expect(calls).toBe(1);
  expect(f.controller.pending?.envelope.command.type).toBe('session.btw.promote');expect(f.controller.error).toContain('distinct promoted conversation');expect(f.controller.takePromotedSession()).toBeUndefined();
 }finally{f.drafts.dispose();}
});

test('a promotion receipt cache failure cannot navigate and retries the same host command after storage recovers', async () => {
 const memory=new Map<string,string>();let rejectCompletion=true,calls:CommandEnvelope[]=[];
 const cache:DraftCache={read:key=>memory.get(key)??null,write:(key,data)=>{if(rejectCompletion&&key.startsWith('btw.pending.')&&JSON.parse(data)?.promotedSession)throw Error('receipt disk full');memory.set(key,data);}};
 const promoted={id:'new-session',hostId:'host',projectId:null,cwd:'/project',title:'Fork',status:'idle' as const,
  sessionFile:'/sessions/new.jsonl',model:{provider:'fixture',id:'model'},createdAt:2,updatedAt:2,archived:false};
 const f=fixture(async e=>{calls.push(e);return {ok:true,commandId:e.id,value:{type:'session.btw.promote',cancelled:false,session:promoted}};},cache);
 try {
  f.controller.value={...value('complete'),status:'complete',answer:'answer',canPromote:true};f.controller.promotionAvailable=true;f.controller.ready=true;
  await f.controller.promote();expect(calls).toHaveLength(1);expect(f.controller.pending?.promotedSession).toBeUndefined();expect(f.controller.takePromotedSession()).toBeUndefined();expect(f.controller.error).toContain('disk full');
  rejectCompletion=false;const restored=new BtwState(f.bridge,'host','session',f.drafts,cache);await restored.refresh(true);
  expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(restored.takePromotedSession()).toEqual(promoted);
 }finally{f.drafts.dispose();}
});
test('a completed observation does not fabricate the new draft-consumption receipt', async()=>{
 const calls:CommandEnvelope[]=[];const f=fixture(async e=>{calls.push(e);throw Error('lost response');});
 try {await f.controller.start();const id=calls[0]!.id;f.drafts.update('btw:session',{text:'newer draft'});
 f.bridge.getBtw=async()=>({protocolVersion:1,hostId:'host',sessionId:'session',value:{...value(id),status:'complete',answer:'done'}});
 await f.controller.refresh();expect(calls).toHaveLength(1);expect(f.controller.pending?.envelope.id).toBe(id);expect(f.drafts.get('btw:session').draft.text).toBe('newer draft');}finally{f.drafts.dispose();}
});
test('a cancel receipt for a replacement run cannot settle the selected run',async()=>{
 let calls=0;const f=fixture(async e=>{calls++;return {ok:true,commandId:e.id,value:{type:'session.btw',snapshot:value('replacement')}};});
 try {f.controller.value=value('selected');await f.controller.cancel();expect(calls).toBe(1);expect(f.controller.pending?.envelope.command.type).toBe('session.btw.cancel');expect(f.controller.value.runId).toBe('selected');expect(f.controller.error).toContain('different owner');}finally{f.drafts.dispose();}
});

test('native composer submission retains its saved revision and newer main and side drafts independently', async()=>{
 const calls:CommandEnvelope[]=[];const f=fixture(async e=>{calls.push(e);return {ok:true,commandId:e.id,value:{type:'session.btw',snapshot:value(e.id)}};});
 try {f.drafts.update('session:session',{text:'/btw  explain\nthis'});const captured=await f.drafts.prepareSubmission('session:session');
 f.drafts.update('session:session',{text:'next main prompt'});await f.controller.start(captured);
 expect(calls[0]?.command).toEqual({type:'session.btw.start',sessionId:'session',question:'explain\nthis',nativeCommand:'btw',draft:{id:'session:session',revision:captured.revision}});
 expect(f.drafts.get('session:session').draft.text).toBe('next main prompt');expect(f.drafts.get('btw:session').draft.text).toBe('question');
 }finally{f.drafts.dispose();}
});
test('lost native composer receipt restores the main draft binding and recovers the same command',async()=>{
 const calls:CommandEnvelope[]=[];const f=fixture(async e=>{calls.push(e);if(calls.length===1)throw Error('lost');return {ok:true,commandId:e.id,value:{type:'session.btw',snapshot:value(e.id)}};});
 try{f.drafts.update('session:session',{text:'/btw question'});await f.controller.start(await f.drafts.prepareSubmission('session:session'));
 const restored=new BtwState(f.bridge,'host','session',f.drafts,f.cache);expect(restored.receiptError).toBeUndefined();expect(restored.pending?.draft?.id).toBe('session:session');await restored.refresh(true);
 expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(restored.pending).toBeUndefined();expect(f.drafts.get('session:session').draft.text).toBe('');expect(f.drafts.get('btw:session').draft.text).toBe('question');
 }finally{f.drafts.dispose();}
});
test('an empty native invocation or unrelated captured draft is never sent as a side question',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('must not send');});
 try{f.drafts.update('session:session',{text:'/btw '});await f.controller.start(await f.drafts.prepareSubmission('session:session'));expect(f.controller.error).toContain('Usage');
 f.drafts.update('session:foreign',{text:'/btw foreign'});await f.controller.start(await f.drafts.prepareSubmission('session:foreign'));expect(f.controller.error).toContain('different draft owner');expect(calls).toBe(0);expect(f.drafts.get('session:session').draft.text).toBe('/btw ');
 }finally{f.drafts.dispose();}
});

test('an older host stays readable but does not advertise safe draft submission',async()=>{
 const f=fixture(async()=>{throw Error('no command');});
 try{f.bridge.getBtw=async()=>({protocolVersion:1,hostId:'host',sessionId:'session',value:value('prior')});await f.controller.refresh();expect(f.controller.value?.runId).toBe('prior');expect(f.controller.ready).toBe(false);expect(f.controller.unavailable).toContain('Update the owning host');}finally{f.drafts.dispose();}
});

test('a second side send waits for delayed consumption state, then saves against its actual revision',async()=>{
 const calls:CommandEnvelope[]=[];const f=fixture(async e=>{calls.push(e);return {ok:true,commandId:e.id,value:{type:'session.btw',snapshot:value(e.id)}};});
 try{await f.controller.start();const first=calls[0]!.command;if(first.type!=='session.btw.start')throw Error('wrong command');
 const old=f.drafts.get('btw:session').draft;f.drafts.update(old.id,{text:'second question'});await f.controller.start();expect(calls).toHaveLength(1);expect(f.controller.error).toContain('Waiting for the host');
 f.drafts.ingest({...old,text:'',revision:first.draft!.revision+1,updatedAt:2});await f.controller.start();expect(calls).toHaveLength(2);
 const second=calls[1]!.command;if(second.type!=='session.btw.start')throw Error('wrong command');expect(second.question).toBe('second question');expect(second.draft?.revision).toBe(first.draft!.revision+2);
 }finally{f.drafts.dispose();}
});
