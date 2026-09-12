import { expect, test } from "bun:test";
import { observeTaskHintModifier, taskShortcutHintLabels, type HintTimer } from "./task-shortcut-hints";
import { readAppCommandBindings } from "./app-command-bindings";
import type { MainTaskTarget } from "./main-task-targets";

function fixture(modifier: "meta" | "control"="meta") {
  const target=new EventTarget(), document=Object.assign(new EventTarget(),{hidden:false}), changes:boolean[]=[];
  let now=0;
  const jobs:{at:number;callback:()=>void;cancelled:boolean}[]=[];
  const timer:HintTimer=(callback,delay)=>{const job={at:now+delay,callback,cancelled:false};jobs.push(job);return()=>{job.cancelled=true;};};
  const stop=observeTaskHintModifier(target,document,modifier,value=>changes.push(value),timer);
  const input=(type:string,flags:Record<string,unknown>={})=>target.dispatchEvent(Object.assign(new Event(type,{cancelable:true}),{metaKey:false,ctrlKey:false,...flags}));
  const advance=(milliseconds:number)=>{now+=milliseconds;for(const job of jobs){if(!job.cancelled && job.at<=now){job.cancelled=true;job.callback();}}};
  return {target,document,changes,jobs,input,advance,stop};
}

test("hints wait 500ms without repeat resets, never prevent key delivery, and clear on release",()=>{
  const f=fixture();
  expect(f.input('keydown',{metaKey:true})).toBe(true);
  f.advance(499);expect(f.changes).toEqual([]);
  f.input('keydown',{metaKey:true,repeat:true});f.advance(1);expect(f.changes).toEqual([true]);
  f.input('keyup',{metaKey:false});expect(f.changes).toEqual([true,false]);
  f.stop();
});
test("quick release, blur, hidden document and disposal invalidate even a queued old timer",()=>{
  for(const stop of ['release','blur','hidden','dispose'] as const){
    const f=fixture();f.input('keydown',{metaKey:true});const stale=f.jobs[0]!.callback;
    if(stop==='release')f.input('keyup');
    if(stop==='blur')f.input('blur');
    if(stop==='hidden'){f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));}
    if(stop==='dispose')f.stop();
    stale();f.advance(500);expect(f.changes).toEqual([]);f.stop();
  }
});
test("control target, composition and pointer modifier snapshots keep independent lifetimes",()=>{
  const f=fixture('control');f.input('keydown',{metaKey:true});f.advance(600);expect(f.changes).toEqual([]);
  f.input('keydown',{ctrlKey:true});f.advance(500);expect(f.changes).toEqual([true]);
  f.input('compositionstart');expect(f.changes).toEqual([true,false]);
  f.input('keydown',{ctrlKey:true});f.advance(600);expect(f.changes).toEqual([true,false]);
  f.input('compositionend');f.input('keydown',{ctrlKey:true});f.advance(500);expect(f.changes).toEqual([true,false,true]);
  f.input('pointermove',{ctrlKey:false});expect(f.changes).toEqual([true,false,true,false]);
  f.stop();f.input('keydown',{ctrlKey:true});f.advance(600);expect(f.changes).toEqual([true,false,true,false]);
});
test("same held modifier after a blur needs a new full delay",()=>{
  const f=fixture();f.input('keydown',{metaKey:true});f.advance(500);f.input('blur');
  f.input('keydown',{metaKey:true});f.advance(499);expect(f.changes).toEqual([true,false]);
  f.advance(1);expect(f.changes).toEqual([true,false,true]);f.stop();
});
const targets:MainTaskTarget[]=[{kind:'chat',hostId:'home',sessionId:'chat'},...Array.from({length:11},(_,i)=>({kind:'content' as const,tabId:`file-${i}`,hostId:'work',target:'session:remote' as const}))];
test("hints use effective keys and reverse the whole task list before the nine-slot cap",()=>{
  const bindings=readAppCommandBindings(undefined,true,'tabs').bindings;
  const ltr=taskShortcutHintLabels(targets,'ltr',bindings),rtl=taskShortcutHintLabels(targets,'rtl',bindings);
  expect(ltr.chat).toBe('⌘1');expect(ltr.content.get('file-0')).toBe('⌘2');expect(ltr.content.get('file-8')).toBeUndefined();
  expect(rtl.chat).toBeUndefined();expect(rtl.content.get('file-10')).toBe('⌘1');expect(rtl.content.get('file-2')).toBe('⌘9');expect(rtl.content.size).toBe(9);
  const secondary=taskShortcutHintLabels(targets,'ltr',readAppCommandBindings(undefined,true,'sidebar').bindings);
  expect(secondary.chat).toBe('⌃1');
});
test("cleared and unavailable keys do not invent hints; custom sequence uses its actual label",()=>{
  const hints=taskShortcutHintLabels(targets,'ltr',{'task-tab-1':[], 'task-tab-2':['Command+Shift+K Ctrl+2']});
  expect(hints.chat).toBeUndefined();expect(hints.content.get('file-0')).toBe('⇧⌘K ⌃2');expect(hints.content.size).toBe(1);
  expect(taskShortcutHintLabels(targets,'ltr',{}).content.size).toBe(0);
});
