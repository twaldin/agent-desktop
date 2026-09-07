import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationDelivery, type NotificationDeliveryAdapter } from './notification-delivery';
import type { HostNotification } from '@agent-desktop/shared';
import { notificationPreferences, parsePreferenceChange } from '../../../../packages/shared/src/preferences';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const notice=(id:string,kind:HostNotification['kind']='completion',state:HostNotification['state']='open'):HostNotification=>({id,kind,state,sessionId:'session-one',createdAt:123,title:'A task',body:'Turn completed.'});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'notification-delivery-'));roots.push(root);
  const file=join(root,'ledger.json');let focused=false;
  let prefs=notificationPreferences();const shown:Array<{notice:HostNotification;options:Parameters<NotificationDeliveryAdapter['show']>[1];closed:number}>=[],targets:unknown[]=[];
  const adapter:NotificationDeliveryAdapter={preferences:()=>prefs,focused:()=>focused,supported:()=>true,
    show:(notice,options)=>{const item={notice,options,closed:0};shown.push(item);return{close:()=>{item.closed++;options.onClosed();}};},navigate:target=>targets.push(target),statusChanged:()=>{}};
  const delivery=new NotificationDelivery(file,adapter);
  return {delivery,file,adapter,shown,targets,focus:(value:boolean)=>{focused=value;},prefs:(value:Partial<typeof prefs>)=>{prefs={...prefs,...value};}};
}
test('new attachment drops historical completions and already-resolved questions at the state barrier',()=>{
  const f=fixture();f.delivery.begin('host-one');
  f.delivery.event('host-one',1,notice('old'));
  f.delivery.event('host-one',2,notice('answered','question'));
  f.delivery.event('host-one',3,notice('answered','question','resolved'));
  f.delivery.snapshot('host-one',3,[],true);
  expect(f.shown).toHaveLength(0);expect(f.delivery.cursor('host-one')).toBe(3);
  f.delivery.event('host-one',4,notice('new'));expect(f.shown.map(x=>x.notice.id)).toEqual(['new']);
});
test('reconnect and process restart deliver a missed completion once and reconcile unanswered questions',()=>{
  const f=fixture();f.delivery.begin('host-one');f.delivery.snapshot('host-one',10,[],true);
  f.delivery.event('host-one',11,notice('first'));
  const restarted=new NotificationDelivery(f.file,f.adapter);restarted.begin('host-one');
  restarted.event('host-one',11,notice('first'));restarted.event('host-one',12,notice('missed'));
  restarted.event('host-one',13,notice('ended','question'));restarted.event('host-one',14,notice('ended','question','resolved'));
  restarted.snapshot('host-one',15,[notice('pending','question')],true);
  expect(f.shown.map(x=>x.notice.id)).toEqual(['first','missed','pending']);
  restarted.snapshot('host-one',16,[notice('pending','question')],true);expect(f.shown).toHaveLength(3);
  restarted.event('host-one',17,notice('pending','question','resolved'));expect(f.shown[2]!.closed).toBe(1);
  const raw=readFileSync(f.file,'utf8');expect(raw).not.toContain('A task');expect(raw).not.toContain('Turn completed.');
});
test('missed resolution outside replay window closes the original pending OS notification',()=>{
  const f=fixture();f.delivery.begin('host-one');f.delivery.snapshot('host-one',1,[notice('pending','question')],true);
  f.delivery.begin('host-one');f.delivery.snapshot('host-one',1000,[],true);
  expect(f.shown[0]!.closed).toBe(1);expect(f.shown).toHaveLength(1);
});
test('foreground completion policy and distinct permission/question switches suppress without later replay',()=>{
  const f=fixture();f.delivery.begin('host-one');f.delivery.snapshot('host-one',0,[],true);f.focus(true);
  f.delivery.event('host-one',1,notice('focused'));expect(f.shown).toHaveLength(0);
  f.prefs({completionPolicy:'always',questionRequired:false,approvalRequired:true,sound:true});
  f.delivery.event('host-one',2,notice('always'));f.delivery.event('host-one',3,notice('question','question'));f.delivery.event('host-one',4,notice('permission','permission'));
  expect(f.shown.map(x=>x.notice.id)).toEqual(['always','permission']);expect(f.shown[0]!.options.silent).toBe(false);
  f.prefs({completionPolicy:'never',approvalRequired:false});f.delivery.preferencesChanged();expect(f.shown.map(x=>x.closed)).toEqual([1,1]);
  f.focus(false);f.delivery.event('host-one',1,notice('focused'));expect(f.shown).toHaveLength(2);
});
test('same notification ID on different owners stays distinct, and clicks only navigate the exact owner',()=>{
  const f=fixture();for(const host of ['host-one','host-two']){f.delivery.begin(host);f.delivery.snapshot(host,0,[],true);f.delivery.event(host,1,notice('same'));}
  expect(f.shown).toHaveLength(2);f.shown[1]!.options.onClick();expect(f.targets).toEqual([{hostId:'host-two',sessionId:'session-one'}]);
});
test('unreadable ledger fails closed rather than replaying prior delivery',()=>{
  const f=fixture();writeFileSync(f.file,'broken');const broken=new NotificationDelivery(f.file,f.adapter);
  broken.begin('host-one');broken.snapshot('host-one',1,[notice('q','question')],true);broken.event('host-one',2,notice('c'));
  expect(f.shown).toHaveLength(0);expect(broken.status().error).toContain('paused');
});
test('legacy preference bytes remain compatible and modern completion policy is validated',()=>{
  const legacy={turnComplete:true,approvalRequired:false,sound:false};
  expect(parsePreferenceChange({key:'general.notifications',value:legacy})).toEqual({key:'general.notifications',value:legacy});
  expect(notificationPreferences(legacy)).toMatchObject({completionPolicy:'unfocused',questionRequired:true});
  expect(notificationPreferences({...legacy,turnComplete:false}).completionPolicy).toBe('never');
  expect(()=>parsePreferenceChange({key:'general.notifications',value:{...legacy,completionPolicy:'never'}})).toThrow('disagree');
  expect(()=>parsePreferenceChange({key:'general.notifications',value:{...legacy,questionRequired:'yes'}})).toThrow();
  expect(parsePreferenceChange({key:'general.notifications',value:{...legacy,completionPolicy:'always',questionRequired:false}})).toMatchObject({value:{completionPolicy:'always',questionRequired:false}});
});

test('historical state frames are not replay barriers and cannot flash a resolved question',()=>{
  const f=fixture();f.delivery.begin('host-one');f.delivery.snapshot('host-one',0,[],true);
  f.delivery.begin('host-one');f.delivery.event('host-one',1,notice('q','question'));
  f.delivery.snapshot('host-one',2,[notice('q','question')]);
  expect(f.shown).toHaveLength(0);
  f.delivery.event('host-one',3,notice('q','question','resolved'));
  f.delivery.snapshot('host-one',4,[],true);expect(f.shown).toHaveLength(0);
});

test('pending question identity survives completed-history eviction and a process restart',()=>{
  const f=fixture();f.delivery.begin('host-one');f.delivery.snapshot('host-one',0,[notice('long-question','question')],true);
  const ledger=JSON.parse(readFileSync(f.file,'utf8'));
  ledger.hosts['host-one'].seen=Array.from({length:2000},(_,index)=>`completion-${index}`);
  ledger.hosts['host-one'].sequence=2000;writeFileSync(f.file,JSON.stringify(ledger));
  const restarted=new NotificationDelivery(f.file,f.adapter);restarted.begin('host-one');
  restarted.snapshot('host-one',2001,[notice('long-question','question')],true);
  expect(f.shown).toHaveLength(1);
  restarted.event('host-one',2002,notice('long-question','question','resolved'));
  expect(JSON.parse(readFileSync(f.file,'utf8')).hosts['host-one'].pending).toEqual([]);
});
test('zero-event initial synchronization persists a cursor before the first reconnect',()=>{
  const f=fixture();f.delivery.begin('host-one');f.delivery.snapshot('host-one',0,[],true);
  const restarted=new NotificationDelivery(f.file,f.adapter);restarted.begin('host-one');restarted.event('host-one',1,notice('first-missed'));restarted.snapshot('host-one',1,[],true);
  expect(f.shown.map(x=>x.notice.id)).toEqual(['first-missed']);
});
