import { expect, test } from "bun:test";
import { observeTaskHintModifier, type HintTimer, type NativeHintWatch } from "./task-shortcut-hints";
import type { ModifierReleaseResult } from "@agent-desktop/shared";

// Optional preserved renderer selection supplies the same final lost-delivery test.
const observe: typeof observeTaskHintModifier = process.env.AGENT_DESKTOP_HINT_OBSERVER_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_HINT_OBSERVER_SOURCE)).observeTaskHintModifier : observeTaskHintModifier;
const tick = () => new Promise<void>(resolve=>setTimeout(resolve,0));
function fixture() {
  const target=new EventTarget(),document=Object.assign(new EventTarget(),{hidden:false}),changes:boolean[]=[];
  const jobs: {fn:()=>void;cancelled:boolean}[]=[], watches:{signal:AbortSignal;finish:(result:ModifierReleaseResult)=>void}[]=[];
  const timer:HintTimer=(fn,delay)=>{expect(delay).toBe(500);const job={fn,cancelled:false};jobs.push(job);return()=>{job.cancelled=true;};};
  const native:NativeHintWatch=(modifier,signal)=>{expect(modifier).toBe("meta");return new Promise(finish=>watches.push({signal,finish}));};
  const stop=observe(target,document,"meta",value=>changes.push(value),timer,native);
  const input=(type:string,metaKey=true)=>target.dispatchEvent(Object.assign(new Event(type),{metaKey,ctrlKey:false}));
  const show=async()=>{input("keydown");jobs.at(-1)!.fn();await tick();};
  return {input,show,stop,changes,watches,document};
}
test("lost renderer keyup: native completion clears visible hints",async()=>{
  const f=fixture();await f.show();expect(f.changes).toEqual([true]);expect(f.watches.length).toBe(1);
  f.watches[0]!.finish("released");await tick();expect(f.changes).toEqual([true,false]);f.stop();
});
test("unavailable also clears hints without another input; old completion cannot clear new hold",async()=>{
  const f=fixture();await f.show();f.input("blur");expect(f.watches[0]!.signal.aborted).toBe(true);
  await f.show();f.watches[0]!.finish("released");await tick();expect(f.changes).toEqual([true,false,true]);
  f.watches[1]!.finish("unavailable");await tick();expect(f.changes).toEqual([true,false,true,false]);f.stop();
});
test("delivered keyup, visibility, composition and unmount cancel the watch",async()=>{
  for(const kind of ["keyup","hidden","compositionstart","dispose"] as const){
    const f=fixture();await f.show();
    if(kind==="dispose")f.stop();else if(kind==="hidden"){f.document.hidden=true;f.document.dispatchEvent(new Event("visibilitychange"));}else f.input(kind,false);
    expect(f.watches[0]!.signal.aborted).toBe(true);const before=[...f.changes];f.watches[0]!.finish("released");await tick();expect(f.changes).toEqual(before);f.stop();
  }
});
