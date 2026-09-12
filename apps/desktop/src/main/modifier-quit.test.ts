import {expect,test} from "bun:test";
import {WindowCloseGate,type WindowCloseRequest} from "./window-close";
import {ModifierReleaseWatches} from "./modifier-release";
import type {ModifierReleaseResult} from "@agent-desktop/shared";
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function fixture() {
 const calls:{signal:AbortSignal;finish:(value:ModifierReleaseResult)=>void}[]=[];
 const watches=new ModifierReleaseWatches((_modifier,signal)=>new Promise(finish=>calls.push({signal,finish})));
 const sent:{senderId:number;request:WindowCloseRequest}[]=[];
 const ids=new Set([1,2]);let sequence=0,quits=0;
 const gate=new WindowCloseGate({senderIds:()=>[...ids],prepareQuit:()=>watches.pauseAndDrain(),send:(senderId,request)=>sent.push({senderId,request}),unavailable:()=>{},id:()=>`r-${++sequence}`});
 for(const id of ids) gate.register(id);
 const begin=()=>gate.requestQuit([...ids],()=>{quits++;});
 const approve=()=>{for(const {senderId,request} of [...sent]) if(!request.cancelled) gate.answer(senderId,request.id,true);};
 return {gate,watches,calls,sent,ids,begin,approve,quits:()=>quits};
}
test("renderer loss during drain cancels permission and permits fresh watches and another collective quit",async()=>{
 const f=fixture(),first=f.watches.watch(1,"first","meta");await tick();
 f.begin();f.approve();await tick();expect(f.calls[0]!.signal.aborted).toBe(true);expect(f.quits()).toBe(0);
 expect(await f.watches.watch(2,"blocked","meta")).toBe("unavailable");
 f.gate.destroy(1);f.calls[0]!.finish("cancelled");await first;await tick();
 expect(f.quits()).toBe(0);expect(f.gate.consumeQuitPermit()).toBe(false);
 expect(f.sent.some(x=>x.senderId===2 && x.request.cancelled)).toBe(true);
 f.gate.register(1);const recovered=f.watches.watch(1,"recovered","control");await tick();expect(f.calls).toHaveLength(2);expect(f.calls[1]!.signal.aborted).toBe(false);
 f.begin();f.approve();await tick();expect(f.calls[1]!.signal.aborted).toBe(true);expect(f.quits()).toBe(0);
 f.calls[1]!.finish("cancelled");await recovered;await tick();expect(f.quits()).toBe(1);expect(f.gate.consumeQuitPermit()).toBe(true);
 expect(f.gate.handleWindowClose(1,()=>{})).toBe(true);f.ids.delete(1);f.gate.destroy(1,true);
 expect(f.gate.handleWindowClose(2,()=>{})).toBe(true);f.ids.delete(2);f.gate.destroy(2,true);
 expect(await f.watches.watch(3,"after-success","meta")).toBe("unavailable");await f.watches.dispose();
});
test("reload and a newly opened window during drain both invalidate the approved cohort",async()=>{
 for(const change of ["reload","new-window"] as const) {
  const f=fixture(),watch=f.watches.watch(1,"one","meta");await tick();f.begin();f.approve();await tick();
  if(change==="reload"){f.gate.unregister(1);f.gate.register(1);}else{f.ids.add(3);f.gate.register(3);}
  f.calls[0]!.finish("cancelled");await watch;await tick();expect(f.quits()).toBe(0);expect(f.gate.consumeQuitPermit()).toBe(false);
  const recovered=f.watches.watch(1,"two","alt");await tick();expect(f.calls).toHaveLength(2);f.calls[1]!.finish("released");expect(await recovered).toBe("released");await f.watches.dispose();
 }
});
test("renderer loss after permission grant releases pause; no persistent quit bypass remains",async()=>{
 const f=fixture();f.begin();f.approve();await tick();expect(f.quits()).toBe(1);
 f.gate.destroy(1);expect(f.gate.consumeQuitPermit()).toBe(false);f.gate.register(1);
 const recovered=f.watches.watch(1,"recovered","meta");await tick();expect(f.calls).toHaveLength(1);f.calls[0]!.finish("released");expect(await recovered).toBe("released");
 f.begin();f.approve();await tick();expect(f.quits()).toBe(2);expect(f.gate.consumeQuitPermit()).toBe(true);await f.watches.dispose();
});
test("new unprepared close veto after consumed quit permission restores watch admission",async()=>{
 const f=fixture();f.begin();f.approve();await tick();expect(f.gate.consumeQuitPermit()).toBe(true);
 f.ids.add(3);f.gate.register(3);expect(f.gate.handleWindowClose(3,()=>{})).toBe(false);
 f.gate.answer(3,f.sent.at(-1)!.request.id,false);await tick();
 const recovered=f.watches.watch(1,"recovered","meta");await tick();expect(f.calls).toHaveLength(1);f.calls[0]!.finish("released");expect(await recovered).toBe("released");await f.watches.dispose();
});
test("queued watches cannot escape the drain; nested pause release is idempotent",async()=>{
 let calls=0;const watches=new ModifierReleaseWatches(async()=>{calls++;return "released";});
 const queued=watches.watch(1,"queued","meta"),release1=await watches.pauseAndDrain();expect(await queued).toBe("cancelled");expect(calls).toBe(0);
 const release2=await watches.pauseAndDrain();release1();release1();expect(await watches.watch(1,"blocked","meta")).toBe("unavailable");
 release2();expect(await watches.watch(1,"works","meta")).toBe("released");expect(calls).toBe(1);await watches.dispose();
});

test("a rejected quit callback releases the preparation lease and clears all permits",async()=>{
 const sent:WindowCloseRequest[]=[];let releases=0;
 const gate=new WindowCloseGate({prepareQuit:async()=>()=>{releases++;},send:(_id,request)=>sent.push(request),unavailable:()=>{}});
 gate.register(1);gate.requestQuit([1],()=>{throw Error("quit interrupted");});gate.answer(1,sent[0]!.id,true);await tick();
 expect(releases).toBe(1);expect(gate.consumeQuitPermit()).toBe(false);expect(sent.filter(x=>x.cancelled)).toHaveLength(1);
 expect(gate.handleWindowClose(1,()=>{})).toBe(false);gate.destroy(1);
});
