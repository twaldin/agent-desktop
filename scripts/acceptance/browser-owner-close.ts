/** Selected maintained native functions with controlled workers/backends only.
 * No OMP import, browser process, sockets, provider or SDK execution. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const path = process.argv[2]; if (!path) throw new Error("Pass exact tab-supervisor.ts source");
const source = await readFile(path, "utf8");
const begin = source.includes("const tabCleanups =") ? source.indexOf("const tabCleanups =") : source.indexOf("export async function releaseTab(");
const end = source.indexOf("\nexport async function releaseAllTabs", begin);
const forceBegin = source.indexOf("async function forceKillTab("), forceEnd = source.indexOf("\n/**", forceBegin);
assert(begin >= 0 && end > begin && forceBegin >= 0 && forceEnd > forceBegin);
const selected = source.slice(begin, end) + "\n" + source.slice(forceBegin, forceEnd);
const body = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replaceAll("export ", ""));
type Target = { name: string; targetId: string };
type Tab = Target & { ownerSessionId: string; state: string; backend: string; kindTag: string; cmuxOwnsSurface: boolean; pending: Map<string, any>; browser: any; worker: any };
type API = { release(name: string, options?: { kill?: boolean; timeoutMs?: number }): Promise<boolean>; force(name: string, reason: string): Promise<void>;
 owner?: (owner: string, target: Target, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<{ ownerSessionId: string; name: string; targetId: string; released: true }> };
class Rejected extends Error { override name = "BrowserActionRejected"; }
function harness(kind = "headless") {
 const tabs = new Map<string, Tab>(); const calls: { operation: string; target?: string; options?: any }[] = [];
 let closed = Promise.resolve(), terminated = Promise.resolve(), released = Promise.resolve(), orphan = Promise.resolve(), surface = Promise.resolve();
 const log = (operation: string, target?: string, options?: any) => calls.push({ operation, target, options });
 function tab(targetId = "original", name = "desktop-request") {
  const value: Tab = { name, targetId, ownerSessionId: "owner", state: "alive", backend: kind === "cmux" ? "cmux" : "worker", kindTag: kind, cmuxOwnsSurface: true, pending: new Map(),
   browser: { targetId, client: { request: (_method: string, args: any) => { log("surface", args.surface_id); return surface; } } },
   worker: { send: (message: any) => log(message.type, targetId), terminate: () => { log("terminate", targetId); return terminated; } } };
  tabs.set(name,value); return value;
 }
 const api = new Function("tabs","killedTabs","logger","postmortem","ToolError","BrowserActionRejected","DEFAULT_TAB_CLOSE_TIMEOUT_MS","waitForClosed","waitForTabCleanup","releaseBrowser","closeOrphanTarget","sharedScopeOf","forgetSharedTarget","isLastSurfaceCloseError",
  `${body}\nreturn {release:releaseTab,force:forceKillTab,owner:typeof releaseTabForOwner==='function'?releaseTabForOwner:undefined};`)(tabs,new Map(),{debug(){}},{markExpectedCleanupError:(v:Error)=>v},Error,Rejected,5000,
   () => closed, (_tab: Tab,_timeout: number,_message: string,pending: Promise<void>)=>pending,
   (browser: any, options: any) => { log("browser",browser.targetId,options);return released; },
   (value: Tab) => {log("orphan",value.targetId);return orphan;},()=>undefined,async()=>{},(error: Error)=>error.message === "last surface") as API;
 return { tabs, calls, tab, api,
  hold(stage: "closed"|"terminated"|"released"|"orphan"|"surface") { const gate=Promise.withResolvers<void>(); if(stage==="closed")closed=gate.promise;else if(stage==="terminated")terminated=gate.promise;else if(stage==="released")released=gate.promise;else if(stage==="orphan")orphan=gate.promise;else surface=gate.promise;return gate; },
  count(operation:string){return calls.filter(v=>v.operation===operation).length;} };
}
const completed: string[]=[];const failed: {name:string;error:string}[]=[];
async function scenario(name: string, run:()=>Promise<void>) { try { await run();completed.push(name); } catch(error) {failed.push({name,error:error instanceof Error?error.stack??error.message:String(error)});} }
const ticks=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
await scenario("late ordinary cleanup never removes replacement",async()=>{
 const h=harness();h.tab();const gate=h.hold("closed");const pending=h.api.release("desktop-request");h.tab("replacement");gate.resolve();await pending;
 assert.equal(h.tabs.get("desktop-request")?.targetId,"replacement");assert.deepEqual(h.calls.filter(v=>v.operation==="browser").map(v=>v.target),["original"]);
});
await scenario("reentrant release shares original cleanup",async()=>{
 const h=harness();const original=h.tab();const gate=h.hold("closed");let nested:Promise<boolean>|undefined;
 const cancellation=new AbortController();cancellation.signal.addEventListener("abort",()=>{nested=h.api.release(original.name);});
 original.pending.set("call",{toolCalls:new Map([["tool",cancellation]]),reject(){}});
 const first=h.api.release(original.name);gate.resolve();await Promise.all([first,nested]);assert.equal(h.count("close"),1);assert.equal(h.count("terminate"),1);assert.equal(h.count("browser"),1);
});
await scenario("force kill joins already admitted release",async()=>{
 const h=harness();h.tab();const gate=h.hold("closed");const release=h.api.release("desktop-request"),force=h.api.force("desktop-request","timeout");
 gate.resolve();await Promise.all([release,force]);assert.equal(h.count("terminate"),1);assert.equal(h.count("browser"),1);assert.equal(h.count("orphan"),0);
});
await scenario("force kill drains browser after failed termination and orphan cleanup",async()=>{
 const h=harness();h.tab();const terminate=h.hold("terminated"),orphan=h.hold("orphan"),release=h.hold("released");
 let settled=false;const pending=h.api.force("desktop-request","timeout").then(()=>{settled=true;return undefined;},error=>{settled=true;return error as Error;});
 terminate.reject(new Error("terminate failed"));await ticks();orphan.reject(new Error("orphan failed"));await ticks();
 // Attach the old skipped dependency to avoid manufacturing an unhandled failure.
 void orphan.promise.catch(()=>{});
 assert.equal(h.count("browser"),1);assert.equal(settled,false);release.resolve();const error=await pending;assert.match(error?.message??"",/terminate failed/);assert.equal(h.tabs.size,0);
});
if(!process.argv.includes("--legacy-pair")) {
 await scenario("ordinary forced fallback retains termination error after orphan and browser failures",async()=>{
  const h=harness();h.tab();const closed=h.hold("closed"),terminate=h.hold("terminated"),orphan=h.hold("orphan"),release=h.hold("released");
  let settled=false;
  const pending=h.api.owner!("owner",{name:"desktop-request",targetId:"original"}).then(()=>{settled=true;return undefined;},error=>{settled=true;return error as Error;});
  closed.reject(new Error("close acknowledgement failed"));await ticks();
  terminate.reject(new Error("first termination failure"));await ticks();
  orphan.reject(new Error("later orphan failure"));await ticks();
  assert.deepEqual(h.calls.map(value=>value.operation),["close","terminate","orphan","browser"]);
  assert.equal(settled,false);
  release.reject(new Error("last browser release failure"));
  assert.equal((await pending)?.message,"first termination failure");
  assert.equal(h.tabs.size,0);
 });
 await scenario("owner identity and pre-admission cancellation reject without cleanup",async()=>{
  const h=harness();h.tab();assert.equal(typeof h.api.owner,"function");const aborted=new AbortController();aborted.abort();
  for(const [owner,target,options] of [["foreign",{name:"desktop-request",targetId:"original"},{}],["owner",{name:"desktop-request",targetId:"replacement"},{}],["owner",{name:"missing",targetId:"original"},{}],["",{name:"desktop-request",targetId:"original"},{}],["owner",{name:"desktop-request",targetId:"original"},{signal:aborted.signal}],["owner",{name:"desktop-request",targetId:"original"},{timeoutMs:Infinity}]] as const) {
   await assert.rejects(h.api.owner!(owner,target,options),{name:"BrowserActionRejected"});
  }
  assert.deepEqual(h.calls,[]);assert.equal(h.tabs.get("desktop-request")?.state,"alive");
 });
 await scenario("admitted owner close drains after abort and returns captured identity",async()=>{
  const h=harness();h.tab();const gate=h.hold("closed"),cancel=new AbortController();const target={name:"desktop-request",targetId:"original"};
  const pending=h.api.owner!("owner",target,{signal:cancel.signal,timeoutMs:4567});target.targetId="changed";cancel.abort();gate.resolve();
  assert.deepEqual(await pending,{ownerSessionId:"owner",name:"desktop-request",targetId:"original",released:true});assert.equal(h.count("browser"),1);assert.equal(h.calls.find(v=>v.operation==="browser")?.options.kill,false);
 });
 await scenario("duplicate same-owner close joins then absent target cannot be invented",async()=>{
  const h=harness();h.tab();const gate=h.hold("closed");const target={name:"desktop-request",targetId:"original"};const a=h.api.owner!("owner",target),b=h.api.owner!("owner",target);gate.resolve();await Promise.all([a,b]);
  assert.equal(h.count("terminate"),1);assert.equal(h.count("browser"),1);await assert.rejects(h.api.owner!("owner",target),{name:"BrowserActionRejected"});
 });
 await scenario("forced cleanup first is shared and preserves late replacement",async()=>{
  const h=harness();h.tab();const gate=h.hold("terminated");const a=h.api.force("desktop-request","timeout"),b=h.api.owner!("owner",{name:"desktop-request",targetId:"original"});h.tab("replacement");gate.resolve();await Promise.all([a,b]);
  assert.equal(h.count("terminate"),1);assert.equal(h.count("browser"),1);assert.equal(h.tabs.get("desktop-request")?.targetId,"replacement");
 });
 await scenario("normal termination failure still drains release and rejects completion",async()=>{
  const h=harness();h.tab();const terminate=h.hold("terminated"),release=h.hold("released");let settled=false;
  const p=h.api.owner!("owner",{name:"desktop-request",targetId:"original"}).then(()=>{settled=true;return undefined;},error=>{settled=true;return error as Error;});
  await ticks();terminate.reject(new Error("terminate failed"));await ticks();assert.equal(h.count("browser"),1);assert.equal(settled,false);release.resolve();assert.match((await p)?.message??"",/terminate failed/);
 });
 for(const kind of ["headless","relay","connected","spawned","cmux"])await scenario(`${kind} keeps native release policy without shared kill`,async()=>{
  const h=harness(kind);h.tab();const p=h.api.owner!("owner",{name:"desktop-request",targetId:"original"});await p;
  assert.equal(h.count("surface"),kind==="cmux"?1:0);assert.equal(h.count("terminate"),kind==="cmux"?0:1);assert.equal(h.calls.find(v=>v.operation==="browser")?.options.kill,false);
 });
 await scenario("cmux last surface exception preserves native release semantics",async()=>{
  const h=harness("cmux");h.tab();const surface=h.hold("surface");const p=h.api.owner!("owner",{name:"desktop-request",targetId:"original"});surface.reject(new Error("last surface"));assert.equal((await p).released,true);assert.equal(h.count("browser"),1);
 });
 await scenario("cmux operational close error still releases browser and rejects",async()=>{
  const h=harness("cmux");h.tab();const surface=h.hold("surface"),release=h.hold("released");const p=h.api.owner!("owner",{name:"desktop-request",targetId:"original"});const observed=p.catch(error=>error as Error);surface.reject(new Error("surface failure"));await ticks();assert.equal(h.count("browser"),1);release.resolve();assert.match((await observed as Error).message,/surface failure/);
 });
}
console.log(JSON.stringify({sourcePath:path,sourceSha256:new Bun.CryptoHasher("sha256").update(source).digest("hex"),selectedSha256:new Bun.CryptoHasher("sha256").update(selected).digest("hex"),completed,failed,passed:completed.length,failures:failed.length,nativeRuntime:false,limits:"Selected actual supervisor cleanup/owner API with controlled maps/workers/backends; no SDK/import/browser/IPC/backend execution or native acknowledgment proof"},null,2));
if(failed.length)process.exitCode=1;
