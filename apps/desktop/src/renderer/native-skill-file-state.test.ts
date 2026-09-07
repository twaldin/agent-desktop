import {afterEach,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import type {CommandEnvelope,CommandResult,DesktopBridge,NativeSkillFileDocument,NativeSkillFileRef} from "@agent-desktop/shared";
import {NativeSkillFileController,keyFor,sameRef} from "./native-skill-file-state";
import type {OfflineCache} from "./offline-cache";
const ref:NativeSkillFileRef={skillId:"demo",sourcePath:"/skills/demo/SKILL.md",inventory:true,target:{projectId:"p"}};
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const file=(text:string):NativeSkillFileDocument=>({protocolVersion:1,hostId:"h",ref,catalogRevision:"c".repeat(64),document:{kind:"text",text,revision:hash(text),bom:false,encoding:"utf8",path:"SKILL.md",size:Buffer.byteLength(text),modifiedAt:1,mode:420},reveal:{label:"Reveal in Finder",available:true}});
const success=(envelope:CommandEnvelope,content:string,conflict=false):CommandResult=>({ok:true,commandId:envelope.id,value:{type:"skill.file.write",file:file(content),conflict}});
const controllers:NativeSkillFileController[]=[];
afterEach(()=>{for(const c of controllers.splice(0))c.dispose();});
function setup(){
  const values=new Map<string,string>();let fail=false,remote="original";
  const cache:OfflineCache={read:async key=>values.get(key)??null,write:async(key,value)=>{if(fail)throw new Error("disk full");values.set(key,value);}};
  const calls:CommandEnvelope[]=[];
  const bridge={getSkillFile:async()=>file(remote),command:async(envelope:CommandEnvelope)=>{calls.push(envelope);if(envelope.command.type!=="skill.file.write")throw new Error("unexpected command");remote=envelope.command.text;return success(envelope,remote);}} as unknown as DesktopBridge;
  const controller=(cacheOverride=cache,refOverride=ref)=>{const c=new NativeSkillFileController(bridge,"h",refOverride,cacheOverride);controllers.push(c);return c;};
  return {values,cache,bridge,calls,controller,setFailure:(v:boolean)=>fail=v,setRemote:(v:string)=>remote=v};
}
async function until(predicate:()=>boolean){for(let i=0;i<100&&!predicate();i++)await Promise.resolve();expect(predicate()).toBe(true);}

test("cached dirty edits restore offline under a canonical host and reference",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setConnected(false);c.setText("local");await c.flush();
  const reordered={inventory:true,target:{projectId:"p"},sourcePath:ref.sourcePath,skillId:ref.skillId};
  expect(sameRef(ref,reordered)).toBe(true);expect(keyFor("h",ref)).not.toBe(keyFor("other",ref));
  const restored=f.controller(f.cache,reordered);await restored.load(false);expect(restored.state.text).toBe("local");expect(restored.state.dirty).toBe(true);expect(f.calls).toHaveLength(0);
});
test("refresh detects an external change without losing text typed during the read",async()=>{
  const f=setup(),c=f.controller();await c.load(true);
  let resolve!:(file:NativeSkillFileDocument)=>void;f.bridge.getSkillFile=()=>new Promise(r=>resolve=r);
  const read=c.load();await until(()=>Boolean(resolve));c.setText("new local edits");resolve(file("external"));await read;
  expect(c.state.text).toBe("new local edits");expect(c.state.file?.document.text).toBe("external");expect(c.state.conflict).toBe(true);
  c.resolveConflict("use-file");await c.flush();expect(c.state.text).toBe("external");expect(c.state.recoveredText).toBe("new local edits");
  c.restorePreviousEdits();expect(c.state.text).toBe("new local edits");
});
test("newer edits survive the receipt for an earlier save",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("first");
  let resolve!:(result:CommandResult)=>void,envelope!:CommandEnvelope;f.bridge.command=async e=>{envelope=e;return new Promise(r=>resolve=r);};
  const saving=c.save();await until(()=>Boolean(resolve));c.setText("second");resolve(success(envelope,"first"));await saving;
  expect(c.state.text).toBe("second");expect(c.state.dirty).toBe(true);expect(c.state.file?.document.text).toBe("first");
  expect(JSON.parse(f.values.get(keyFor("h",ref))!).pending).toBeUndefined();
});
test("lost receipt survives restart; inspect confirms saved bytes without replacing newer edits",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("first");
  f.bridge.command=async e=>{f.calls.push(e);f.setRemote("first");throw new Error("connection lost after write");};
  await c.save();c.setText("second");await c.flush();c.dispose();
  const restored=f.controller();await restored.load(true);expect(restored.state.uncertain).toBe(true);await restored.save();expect(f.calls).toHaveLength(1);
  expect(await restored.inspectUnknown()).toBe(true);expect(restored.state.text).toBe("second");expect(restored.state.dirty).toBe(true);expect(restored.state.uncertain).toBe(false);expect(f.calls).toHaveLength(1);
});
test("differing observation leaves unknown pending; explicit retry uses the same receipt and preserves edits",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("first");let pending!:CommandEnvelope;
  f.bridge.command=async e=>{f.calls.push(e);pending=e;throw new Error("lost");};await c.save();c.setText("second");
  expect(await c.inspectUnknown()).toBe(false);expect(c.state.uncertain).toBe(true);
  f.bridge.command=async e=>{f.calls.push(e);return success(e,"first");};await c.retryUnknown();
  expect(f.calls[1]).toEqual(pending);expect(c.state.text).toBe("second");expect(c.state.file?.document.text).toBe("first");expect(c.state.dirty).toBe(true);
});
test("pending snapshot is recoverable even if process dies before outcome is stored",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("first");let complete!:(result:CommandResult)=>void,envelope!:CommandEnvelope;
  f.bridge.command=e=>{envelope=e;return new Promise(r=>complete=r);};const saving=c.save();await until(()=>Boolean(complete));
  const copied=new Map(f.values),cache:OfflineCache={read:async key=>copied.get(key)??null,write:async(key,value)=>{copied.set(key,value);}};
  const restored=f.controller(cache);await restored.load(false);expect(restored.state.uncertain).toBe(true);expect(restored.state.text).toBe("first");
  complete(success(envelope,"first"));await saving;
});
test("failed local persistence prevents dispatch and a later successful write recovers",async()=>{
  const f=setup(),c=f.controller();await c.load(true);f.setFailure(true);c.setText("draft");await expect(c.flush()).rejects.toThrow();expect(await c.save()).toBe(false);expect(f.calls).toHaveLength(0);expect(c.state.saving).toBe(false);
  f.setFailure(false);c.setText("draft after recovery");await c.flush();expect(await c.save()).toBe(true);expect(f.calls).toHaveLength(1);
});
test("owner and receipt identity mismatches cannot replace editor contents",async()=>{
  const f=setup(),c=f.controller();await c.load(true);f.bridge.getSkillFile=async()=>({...file("wrong"),hostId:"other"});await c.load();expect(c.state.text).toBe("original");expect(c.state.error).toContain("different owner");
  c.setText("local");f.bridge.command=async e=>({...success(e,"local"),commandId:"different"});await c.save();expect(c.state.uncertain).toBe(true);expect(c.state.text).toBe("local");expect(c.state.file?.document.text).toBe("original");
});
test("disconnect cancels a scheduled autosave, offline edits remain durable",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("offline soon");await c.flush();c.setConnected(false);
  await Bun.sleep(3100);expect(f.calls).toHaveLength(0);expect(c.state.dirty).toBe(true);
  c.setConnected(true);expect(await c.save()).toBe(true);expect(f.calls).toHaveLength(1);
});

test("a read started before a successful save cannot roll back its confirmed baseline",async()=>{
  const f=setup(),c=f.controller();await c.load(true);let finishRead!:(value:NativeSkillFileDocument)=>void;
  f.bridge.getSkillFile=()=>new Promise(r=>finishRead=r);const refresh=c.load();await until(()=>Boolean(finishRead));
  c.setText("saved while reading");await c.save();finishRead(file("original"));await refresh;
  expect(c.state.text).toBe("saved while reading");expect(c.state.file?.document.text).toBe("saved while reading");expect(c.state.dirty).toBe(false);
});
test("restored edits without a baseline require an explicit conflict choice",async()=>{
  const f=setup();f.values.set(keyFor("h",ref),JSON.stringify({version:1,file:null,text:"unbased edits",dirty:true,conflict:false}));
  const c=f.controller();await c.load(true);expect(c.state.conflict).toBe(true);expect(c.state.text).toBe("unbased edits");expect(await c.save()).toBe(false);expect(f.calls).toHaveLength(0);
});
test("host OUTCOME_UNKNOWN retains the exact pending receipt instead of allowing a new save",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("draft");
  f.bridge.command=async e=>{f.calls.push(e);return {ok:false,commandId:e.id,error:{code:"OUTCOME_UNKNOWN",message:"receipt interrupted"}};};
  await c.save();expect(c.state.uncertain).toBe(true);await c.save();expect(f.calls).toHaveLength(1);
  expect(JSON.parse(f.values.get(keyFor("h",ref))!).pending.id).toBe(f.calls[0]!.id);
});

test("oversized edits survive offline reopening and can be shortened before saving",async()=>{
  const f=setup(),c=f.controller();await c.load(true);
  const oversized="é".repeat(1024*1024+1);c.setText(oversized);await c.flush();
  expect(await c.save()).toBe(false);expect(f.calls).toHaveLength(0);expect(c.state.error).toContain("1 MiB");
  c.dispose();const restored=f.controller();await restored.load(false);
  expect(restored.state.text).toBe(oversized);expect(restored.state.dirty).toBe(true);
  restored.setText("shortened retained edit");await restored.load(true);expect(await restored.save()).toBe(true);
  expect(f.calls).toHaveLength(1);expect(restored.state.text).toBe("shortened retained edit");expect(restored.state.dirty).toBe(false);
});

test("normal close drains skill save and preserves offline edits without delivery",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("close skill save");
  expect(await c.prepareWindowClose()).toBe(true);expect(f.calls).toHaveLength(1);expect(c.state.dirty).toBe(false);
  c.setConnected(false);c.setText("offline close");expect(await c.prepareWindowClose()).toBe(true);expect(f.calls).toHaveLength(1);
  const next=f.controller();await next.load(false);expect(next.state.text).toBe("offline close");expect(next.state.dirty).toBe(true);
});
test("close preserves unknown skill command identity and blocks failed recovery storage",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("pending close");
  f.bridge.command=async e=>{f.calls.push(e);throw new Error("lost receipt");};
  expect(await c.prepareWindowClose()).toBe(false);expect(await c.prepareWindowClose()).toBe(false);expect(f.calls).toHaveLength(1);
  expect(JSON.parse(f.values.get(keyFor("h",ref))!).pending.id).toBe(f.calls[0]!.id);
  c.setConnected(false);f.setFailure(true);await expect(c.prepareWindowClose()).rejects.toThrow("disk full");expect(c.state.text).toBe("pending close");
});

test("canceling a close waiter does not drain edits after an existing skill save",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("first");let complete!:(result:CommandResult)=>void,envelope!:CommandEnvelope;
  f.bridge.command=e=>{envelope=e;f.calls.push(e);return new Promise(r=>complete=r);};const saving=c.save();await until(()=>Boolean(complete));
  const abort=new AbortController(),closing=c.prepareWindowClose(abort.signal),rejected=closing.catch(error=>error);
  await Promise.resolve();abort.abort(new Error("keep open"));expect((await rejected).message).toBe("keep open");c.setText("later");complete(success(envelope,"first"));await saving;
  expect(f.calls).toHaveLength(1);expect(c.state.text).toBe("later");expect(c.state.dirty).toBe(true);
});

test("view switch waits for an existing save and drains newer edits; repeated requests do not toggle twice",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("first");
  const replies:Array<(result:CommandResult)=>void>=[];
  f.bridge.command=e=>{f.calls.push(e);return new Promise(r=>replies.push(r));};
  const save=c.save();await until(()=>replies.length===1);
  const switching=c.toggleSource();expect(await c.toggleSource()).toBe(false);
  c.setText("second");expect(c.state.source).toBe(false);expect(c.state.switchingSource).toBe(true);
  replies[0]!(success(f.calls[0]!,"first"));await save;await until(()=>replies.length===2);
  expect(c.state.source).toBe(false);replies[1]!(success(f.calls[1]!,"second"));
  expect(await switching).toBe(true);expect(c.state.source).toBe(true);expect(c.state.dirty).toBe(false);
  expect(c.state.switchingSource).toBe(false);expect(f.calls).toHaveLength(2);
});
test("cancelled mode switch leaves its view and newer edits intact after the original save returns",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("first");
  let reply!:(result:CommandResult)=>void;
  f.bridge.command=e=>{f.calls.push(e);return new Promise(r=>reply=r);};
  const abort=new AbortController(),switching=c.toggleSource(abort.signal);await until(()=>Boolean(reply));
  c.setText("second");abort.abort();reply(success(f.calls[0]!,"first"));
  expect(await switching).toBe(false);expect(c.state.source).toBe(false);expect(c.state.text).toBe("second");
  expect(c.state.dirty).toBe(true);expect(f.calls).toHaveLength(1);expect(c.state.switchingSource).toBe(false);
});
test("offline clean view can switch; dirty or conflicting offline view cannot",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setConnected(false);
  expect(await c.toggleSource()).toBe(true);c.setText("offline draft");await c.flush();
  expect(await c.toggleSource()).toBe(false);expect(c.state.source).toBe(true);expect(c.state.text).toBe("offline draft");
  expect(c.state.error).toContain("before switching views");expect(f.calls).toHaveLength(0);
  f.setRemote("changed externally");await c.load(true);expect(c.state.conflict).toBe(true);
  expect(await c.toggleSource()).toBe(false);expect(c.state.source).toBe(true);expect(f.calls).toHaveLength(0);
});
test("Undo to baseline during a save still waits for receipt and saves the intended baseline",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("first");
  const replies:Array<(result:CommandResult)=>void>=[];
  f.bridge.command=e=>{f.calls.push(e);return new Promise(r=>replies.push(r));};
  const save=c.save();await until(()=>replies.length===1);c.setText("original");expect(c.state.dirty).toBe(false);
  const switching=c.toggleSource();await Promise.resolve();expect(c.state.source).toBe(false);
  replies[0]!(success(f.calls[0]!,"first"));await save;await until(()=>replies.length===2);
  replies[1]!(success(f.calls[1]!,"original"));expect(await switching).toBe(true);
  expect(c.state.text).toBe("original");expect(c.state.file?.document.text).toBe("original");expect(f.calls).toHaveLength(2);
});
test("unconfirmed view-switch save is not retried even if the user undoes to the old baseline",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("first");
  f.bridge.command=async e=>{f.calls.push(e);throw new Error("lost receipt");};
  expect(await c.toggleSource()).toBe(false);c.setText("original");
  expect(await c.toggleSource()).toBe(false);expect(c.state.source).toBe(false);expect(c.state.uncertain).toBe(true);
  expect(f.calls).toHaveLength(1);expect(JSON.parse(f.values.get(keyFor("h",ref))!).pending.id).toBe(f.calls[0]!.id);
});

test("close after disconnect waits for a previously dispatched write but retains later offline edits",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("delivered");
  let reply!:(result:CommandResult)=>void;f.bridge.command=e=>{f.calls.push(e);return new Promise(r=>reply=r);};
  const save=c.save();await until(()=>Boolean(reply));c.setConnected(false);c.setText("later offline");
  let closed=false;const close=c.prepareWindowClose().then(value=>{closed=value;return value;});
  await Promise.resolve();await Promise.resolve();expect(closed).toBe(false);
  reply(success(f.calls[0]!,"delivered"));await save;expect(await close).toBe(true);
  expect(c.state.text).toBe("later offline");expect(c.state.dirty).toBe(true);expect(f.calls).toHaveLength(1);
  const restored=f.controller();await restored.load(false);expect(restored.state.text).toBe("later offline");
});
