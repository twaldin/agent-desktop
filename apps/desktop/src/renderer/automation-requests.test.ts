import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AutomationMutation, AutomationsBridge, Automation } from '../../../../packages/shared/src/automations';
import { defaultWindowView } from '../window-state';
import { WindowStateStore } from '../main/window-state';
import { AutomationRequests } from './automation-requests';

const mutation = (): Extract<AutomationMutation, {type:'save'}> => ({ type:'save', requestId:'request', id:'task', expectedRevision:0,
  input:{name:'Reminder',prompt:'Check the project',rrule:'RRULE:FREQ=DAILY',status:'active',notificationPolicy:'all',destination:{kind:'heartbeat',sessionId:'chat'}} });
function receipt(request = mutation()) {
  const task: Automation = {...request.input, destination:{kind:'heartbeat',sessionId:'chat'},id:request.id,hostId:'host',revision:1,createdAt:1,updatedAt:1,nextRunAt:2,lastRunAt:null};
  return {hostId:'host', requestId:request.requestId, task, run:null, snapshot:{hostId:'host', tasks:[task],runs:[],nextRunCursor:null}};
}
function port(calls: AutomationMutation[], reply: () => Promise<ReturnType<typeof receipt>> = async () => receipt()): AutomationsBridge {
  return {list:async()=>receipt().snapshot,mutate:async(_host, request)=>{calls.push(request);return reply();}};
}
function checkpoint(owner: AutomationRequests) {
  const view = {...defaultWindowView(), automationsOpen:true, automationRequests:owner.intents};
  owner.committed(view); owner.saved(view); return view;
}

test('actual window disk acknowledgement precedes transport; confirmed receipt clears only original intent', async () => {
  const root=mkdtempSync(join(tmpdir(),'automation-request-'));
  try {
    const store=new WindowStateStore(root,'primary'), calls:AutomationMutation[]=[], owner=new AutomationRequests([],()=>{});
    const request=mutation(), pending=owner.submit('host',request,port(calls),()=>true);
    expect(calls).toEqual([]);
    const view={...defaultWindowView(),automationRequests:owner.intents}; owner.committed(view);
    expect(calls).toEqual([]); expect(store.saveView(view)).toEqual({});
    const reopened=new WindowStateStore(root,'primary').bootstrap().state!; owner.saved(reopened);
    await pending; expect(calls).toEqual([request]); expect(owner.intents).toEqual([]);
    expect(reopened.automationRequests).toEqual([{hostId:'host',mutation:request}]);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('connection or view retirement before save cannot revive on same-host reconnect', async () => {
  const owner=new AutomationRequests([],()=>{}), calls:AutomationMutation[]=[];
  const pending=owner.submit('host',mutation(),port(calls),()=>true).then(()=> 'success',error=>error.message);
  owner.invalidate('host'); checkpoint(owner);
  expect(await pending).toContain('unavailable before dispatch'); expect(calls).toEqual([]);
  expect(owner.pending('host')?.mutation.requestId).toBe('request');
  const retry=owner.submit('host',mutation(),port(calls),()=>true); checkpoint(owner); await retry;
  expect(calls).toEqual([mutation()]);
});

test('uncertain result stays durable and explicit same-ID retry is required after reopen', async () => {
  const owner=new AutomationRequests([],()=>{}), calls:AutomationMutation[]=[];
  const pending=owner.submit('host',mutation(),port(calls,async()=>{throw new Error('Connection lost');}),()=>true).catch(error=>error.message);
  const saved=checkpoint(owner); expect(await pending).toBe('Connection lost');
  const restored=new AutomationRequests(saved.automationRequests,()=>{}); checkpoint(restored);
  expect(calls).toHaveLength(1); expect(restored.pending('host')?.mutation).toEqual(mutation());
  await expect(restored.submit('host',{...mutation(),requestId:'new'},port(calls),()=>true)).rejects.toThrow('Resolve the original');
  const retry=restored.submit('host',mutation(),port(calls),()=>true); checkpoint(restored); await retry;
  expect(calls.map(call=>call.requestId)).toEqual(['request','request']); expect(restored.intents).toEqual([]);
});

test('dispatched result survives view loss while malformed or foreign response preserves unresolved intent', async () => {
  for(const foreign of [false,true]) {
    let release!:()=>void; const held=new Promise<void>(resolve=>{release=resolve;});
    const owner=new AutomationRequests([],()=>{}), calls:AutomationMutation[]=[];
    const pending=owner.submit('host',mutation(),port(calls,async()=>{await held;return {...receipt(),requestId:foreign?'foreign':'request'};}),()=>true).then(()=> 'success',error=>error.message);
    checkpoint(owner); await Promise.resolve(); expect(calls).toHaveLength(1);
    owner.invalidate('host'); release();
    const result=await pending;
    if(foreign) {expect(result).toContain('different request');expect(owner.intents).toHaveLength(1);}
    else {expect(result).toBe('success');expect(owner.intents).toEqual([]);}
  }
});

test('sparse local bridge history rejects before disk write and retains original reopen', () => {
  const root=mkdtempSync(join(tmpdir(),'automation-sparse-'));
  try {
    const store=new WindowStateStore(root,'primary'), original=defaultWindowView(); expect(store.saveView(original)).toEqual({});
    const bytes=readFileSync(store.file,'utf8');
    expect(store.saveView({...original,automationRequests:new Array(1)}).error).toBeDefined();
    expect(readFileSync(store.file,'utf8')).toBe(bytes); expect(new WindowStateStore(root,'primary').bootstrap().state).toEqual(original);
  } finally {rmSync(root,{recursive:true,force:true});}
});
