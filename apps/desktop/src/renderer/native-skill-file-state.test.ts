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

test("explicit offline discard persists the baseline without a host write",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setConnected(false);c.setText("discard me");await c.flush();
  expect(await c.discardEdits()).toBe(true);expect(c.state.text).toBe("original");expect(c.state.dirty).toBe(false);
  c.dispose();const restored=f.controller();await restored.load(false);expect(restored.state.text).toBe("original");expect(restored.state.dirty).toBe(false);expect(f.calls).toHaveLength(0);
});
test("discard cannot abandon the receipt of a write with unknown outcome",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("delivered");
  f.bridge.command=async e=>{f.calls.push(e);throw new Error("lost receipt");};await c.save();c.setText("later");
  expect(c.canDiscardEdits()).toBe(false);expect(await c.discardEdits()).toBe(false);expect(c.state.text).toBe("later");
  expect(JSON.parse(f.values.get(keyFor("h",ref))!).pending.id).toBe(f.calls[0]!.id);expect(f.calls).toHaveLength(1);
});
test("failed discard storage restores edits and can be retried explicitly",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setConnected(false);c.setText("retained");await c.flush();f.setFailure(true);
  expect(await c.discardEdits()).toBe(false);expect(c.state.text).toBe("retained");expect(c.state.dirty).toBe(true);expect(c.state.error).toContain("disk full");
  f.setFailure(false);expect(await c.discardEdits()).toBe(true);expect(f.calls).toHaveLength(0);
});
test("newer edit during discard persistence keeps the file open",async()=>{
  const f=setup();let release!:(()=>void),held=false;
  const cache:OfflineCache={read:f.cache.read,write:async(k,v)=>{if(held){held=false;await new Promise<void>(r=>release=r);}await f.cache.write(k,v);}};
  const c=f.controller(cache);await c.load(true);c.setConnected(false);c.setText("old");await c.flush();held=true;
  const discard=c.discardEdits();await until(()=>Boolean(release));c.setText("newer");release();
  expect(await discard).toBe(false);await c.flush();expect(c.state.text).toBe("newer");expect(c.state.dirty).toBe(true);
  const restored=f.controller();await restored.load(false);expect(restored.state.text).toBe("newer");
});
test("disposal blocks autosave scheduled by a queued cache completion or late receipt",async()=>{
  const f=setup(),c=f.controller();await c.load(true);c.setText("queued");c.dispose();await c.flush();
  const second=f.controller();await second.load(true);second.setText("in flight");let reply!:(result:CommandResult)=>void;
  f.bridge.command=e=>{f.calls.push(e);return new Promise(r=>reply=r);};const save=second.save();await until(()=>Boolean(reply));
  second.setText("later retained");second.dispose();reply(success(f.calls[0]!,"in flight"));await save;
  await Bun.sleep(3100);expect(f.calls).toHaveLength(1);expect(await second.save()).toBe(false);expect(await second.saveUntilClean()).toBe(false);
});

test("disposal during pre-dispatch persistence prevents the queued host command",async()=>{
  const f=setup();let hold=false,release!:()=>void;
  const cache:OfflineCache={read:f.cache.read,write:async(k,v)=>{if(hold){hold=false;await new Promise<void>(r=>release=r);}await f.cache.write(k,v);}};
  const c=f.controller(cache);await c.load(true);c.setText("not sent");await c.flush();hold=true;
  const save=c.save();await until(()=>Boolean(release));c.dispose();release();expect(await save).toBe(false);
  expect(f.calls).toHaveLength(0);expect(await c.toggleSource()).toBe(false);
  const restored=f.controller();await restored.load(false);expect(restored.state.text).toBe("not sent");expect(restored.state.dirty).toBe(true);expect(restored.state.uncertain).toBe(false);
});

test("skill image leases retain native owner and release a late acquisition after close",async()=>{
  const f=setup(),c=f.controller(),seen:unknown[]=[],released:string[]=[];
  let complete!:(value:{url:string;id:string})=>void;
  f.bridge.acquireSkillImage=(resource,path,host)=>{seen.push({resource,path,host});return new Promise(resolve=>complete=resolve);};
  f.bridge.releaseWorkspaceImage=async id=>{released.push(id);};
  await expect(c.acquireImage("assets/picture.svg")).rejects.toThrow("Reconnect");
  c.setConnected(true);const generation=c.imageGeneration;c.setConnected(true);expect(c.imageGeneration).toBe(generation);
  const pending=c.acquireImage("assets/picture.svg").catch(error=>error);c.dispose();complete({id:"lease",url:"agent-workspace-image://image/lease"});
  expect(await pending).toBeInstanceOf(Error);expect(released).toEqual(["lease"]);
  expect(seen).toEqual([{resource:ref,path:"assets/picture.svg",host:"h"}]);expect(f.calls).toHaveLength(0);
});


test("skill Open persists before launch, retains unknown receipt across reload and prevents a different application",async()=>{
  const f=setup(),c=f.controller();await c.load(true);
  f.bridge.command=async e=>{f.calls.push(e);expect(JSON.parse(f.values.get(keyFor("h",ref))!).pendingOpen.id).toBe(e.id);throw Error("lost launch receipt");};
  await expect(c.openFile("vscode")).rejects.toThrow("original receipt");
  expect(f.calls).toHaveLength(1);await c.flush();c.dispose();
  const restored=f.controller();await restored.load(true);
  await expect(restored.openFile("fileManager")).rejects.toThrow("same application");expect(f.calls).toHaveLength(1);
  f.bridge.command=async e=>{f.calls.push(e);return {ok:true,commandId:e.id,value:{type:"skill.file.open",targetId:"vscode"}};};
  expect(await restored.openFile("vscode")).toBe(true);expect(f.calls[1]).toEqual(f.calls[0]);
  expect(JSON.parse(f.values.get(keyFor("h",ref))!).pendingOpen).toBeUndefined();expect(restored.state.text).toBe("original");
});

test("skill Open stops before delivery on storage/disconnect and retains ID when acknowledged cleanup fails",async()=>{
  const f=setup(),c=f.controller();await c.load(true);f.setFailure(true);
  await expect(c.openFile("vscode")).rejects.toThrow("disk full");expect(f.calls).toHaveLength(0);
  f.setFailure(false);c.setConnected(false);await expect(c.openFile("vscode")).rejects.toThrow("Reconnect");expect(f.calls).toHaveLength(0);
  c.setConnected(true);
  f.bridge.command=async e=>{f.calls.push(e);f.setFailure(true);return {ok:true,commandId:e.id,value:{type:"skill.file.open",targetId:"vscode"}};};
  await expect(c.openFile("vscode")).rejects.toThrow("disk full");f.setFailure(false);
  f.bridge.command=async e=>{f.calls.push(e);return {ok:true,commandId:e.id,value:{type:"skill.file.open",targetId:"vscode"}};};
  await c.openFile("vscode");expect(f.calls[1]).toEqual(f.calls[0]);
});

test("skill Save as retains the exact owner and does not force a dirty buffer save",async()=>{
  const f=setup(),c=f.controller(),copies:unknown[]=[];await c.load(true);c.setText("unsaved local buffer");
  f.bridge.saveSkillFileCopy=async(resource,host)=>{copies.push({resource,host});return {path:"/chosen/copy.md"};};
  expect(c.canSaveCopy).toBe(true);expect(await c.saveCopy()).toEqual({path:"/chosen/copy.md"});
  expect(copies).toEqual([{resource:ref,host:"h"}]);expect(f.calls).toHaveLength(0);expect(c.state.text).toBe("unsaved local buffer");
  c.setConnected(false);await expect(c.saveCopy()).rejects.toThrow("Reconnect");expect(copies).toHaveLength(1);
});
