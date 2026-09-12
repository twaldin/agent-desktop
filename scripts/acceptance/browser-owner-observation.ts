/** Actual selected supervisor acquisition and owner lookup; controlled native dependencies. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const selectedPath = process.argv[2]; if (!selectedPath) throw new Error("Pass exact tab-supervisor.ts");
const source = await readFile(selectedPath, "utf8");
function section(start: string, end: string) { const a = source.indexOf(start), b = source.indexOf(end, a); assert(a >= 0 && b > a); return source.slice(a,b); }
const sections = [section("const tabs = new Map", "function markReportedInitFailure"), section("export function getTab(", "export async function runInTab("), section("export interface OwnerTabObservation", "/**\n * Captures the current viewport")];
const body = new Bun.Transpiler({loader:"ts"}).transformSync(sections.join("\n").replaceAll("export ", ""));
type Handle = {kind:{kind:string};refCount:number;browser?:object;client?:{connectionGeneration?:number;request(method:string,params:object):Promise<object>}};
type Tab = {name:string;targetId:string;ownerSessionId:string;state:string;browser:Handle;kindTag:string;worker:unknown};
type Result = {name:string;ownerSessionId:string;targetId:string;kindTag:string;presence:string};
function harness(kind = "headless") {
 const events:string[] = [], captures:unknown[] = []; let captureGate:Promise<void>|undefined, inspectGate:Promise<void>|undefined, releaseGate:Promise<void>|undefined;
 let captureError:Error|undefined, readError:Error|undefined, releaseError:Error|undefined, answer="present", initFail=false;
 const tabCleanups = new WeakMap<object, Promise<void>>(); const worker = {mode:"worker",onMessage(_f:unknown){return()=>{};},terminate:async()=>{events.push("terminate");}};
 const handle:Handle = {kind:{kind},refCount:1,...(kind==="cmux"?{client:{connectionGeneration:1,async request(method:string,_params:object){events.push(method);return{surface_id:"target",url:"about:blank"};}}}:{browser:{}})};
 async function capture(context:unknown) { events.push("capture"); captures.push(context); await captureGate; if(captureError)throw captureError; return {assertCurrent(){},async inspect(_id:string){events.push("inspect");await inspectGate;if(readError)throw readError;return answer;}}; }
 class CmuxTab { async readyInfo(){events.push("ready");return{targetId:"target",url:"about:blank",title:""};} async goto(){events.push("goto");} }
 const api = new Function("captureBrowserTargetObservation","captureCmuxSurfaceObservation","holdBrowser","releaseBrowser","buildInitPayload","spawnTabWorker","spawnInlineWorker","initializeTabWorker","closeAbandonedWorkerPage","isReportedInitFailure","initBudgetExhausted","ToolError","ToolAbortError","BrowserTabCreateRejected","getProjectDir","runInTabWithSnapshot","releaseTab","CmuxTab","mapWaitUntil","DEFAULT_VIEWPORT","logger","handleTabMessage","sharedScopeOf","recordSharedTarget","tabCleanups","process",`${body}\nreturn {acquireTab,inspectTabForOwner,tabs,tabObservations,tabObservationReads};`)(
 capture, (context:unknown)=>{events.push("capture");captures.push(context);if(captureError)throw captureError;return{assertCurrent(){},async inspect(){events.push("inspect");await inspectGate;if(readError)throw readError;return{};}};},
 (b:Handle)=>{events.push("hold");b.refCount++;}, async(b:Handle)=>{events.push("release");await releaseGate;b.refCount--;if(releaseError)throw releaseError;},
 async()=>{events.push("build");return{mode:"headless"};}, async()=>{events.push("spawn");return worker;}, async()=>{events.push("inline");return{...worker,mode:"inline"};},
 async()=>{events.push("init");if(initFail){initFail=false;throw new Error("worker init failed");}return{targetId:"target",url:"about:blank",title:""};},
 ()=>{events.push("abandoned");},()=>false,()=>false,Error,Error,Error,()=>"/controlled",async()=>{},async()=>{throw new Error("Unexpected releaseTab");},CmuxTab,(v:unknown)=>v,{}, {warn(){}},()=>{},()=>undefined,async()=>{},tabCleanups,{env:{}},
 ) as {acquireTab(name:string,b:Handle,opts:object):Promise<{tab:Tab;created:boolean}>;inspectTabForOwner(owner:string,t:{name:string;targetId:string}):Promise<Result>;tabs:Map<string,Tab>;tabObservations:WeakMap<Tab,(id:string)=>Promise<string>>;tabObservationReads:Set<Tab>};
 return {api,events,captures,handle,tabCleanups,
   create(name="tab",signal?:AbortSignal){return api.acquireTab(name,handle,{ownerSessionId:"owner",timeoutMs:100,signal});},
   read(name="tab"){return api.inspectTabForOwner("owner",{name,targetId:"target"});},
   captureHold(){const g=Promise.withResolvers<void>();captureGate=g.promise;return g;},
   readHold(){const g=Promise.withResolvers<void>();inspectGate=g.promise;return g;},
   releaseHold(){const g=Promise.withResolvers<void>();releaseGate=g.promise;return g;},
   failCapture(){captureError=new Error("Original capture unavailable");}, failRead(){readError=new Error("Original read failed");}, failRelease(){releaseError=new Error("Lease release failed");},
   absent(){answer="absent";}, retryInit(){initFail=true;},
 };
}
// Acquisition-owned constants/state are real module context, supplied unchanged below.
const ticks=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const passed:string[]=[],failed:Array<{name:string;error:string}>=[];
async function scenario(name:string,run:()=>Promise<void>){if(process.argv.includes("--settlement-pair")&&!name.startsWith("release gap:"))return;try{await run();passed.push(name);}catch(error){failed.push({name,error:error instanceof Error?error.stack??error.message:String(error)});}}
await scenario("all configured backends capture once before native creation then inspect exact owner",async()=>{
 for(const kind of ["headless","spawned","connected","relay","cmux"]){
  const h=harness(kind); const made=await h.create();assert.equal(made.created,true);
  assert(h.events.indexOf("capture")<h.events.indexOf(kind==="cmux"?"browser.open_split":"build"));
  assert.deepEqual(await h.read(),{name:"tab",ownerSessionId:"owner",targetId:"target",kindTag:kind,presence:"present"});
  const reused=await h.create();assert.equal(reused.created,false);assert.equal(h.captures.length,1);assert.equal(h.handle.refCount,2);assert.equal(h.api.tabObservationReads.size,0);
 }
});
await scenario("held capture precedes worker target selection and late abort prevents spawning",async()=>{
 const h=harness(),gate=h.captureHold(),abort=new AbortController();const creating=h.create("tab",abort.signal);await ticks();
 assert(!h.events.includes("build"));assert(!h.events.includes("spawn"));abort.abort();gate.resolve();
 await assert.rejects(creating,/aborted/);assert.equal(h.api.tabs.size,0);assert.equal(h.handle.refCount,1);
});
await scenario("inline fallback preserves original capture and successful target",async()=>{
 const h=harness();h.retryInit();await h.create();assert.equal(h.captures.length,1);assert(h.events.includes("inline"));assert.equal((await h.read()).presence,"present");
});
await scenario("capture failure remains visible without recapture; cmux reuse requires its original observation",async()=>{
 for(const kind of ["relay","cmux"]){const h=harness(kind);h.failCapture();await h.create();await assert.rejects(h.read(),/Original capture unavailable/);await assert.rejects(h.read(),/Original capture unavailable/);if(kind==="cmux")await assert.rejects(h.create(),/Original capture unavailable/);else await h.create();assert.equal(h.captures.length,1);assert.equal(h.handle.refCount,2);}
});
await scenario("creation-time browser binding rejects handle or kind replacement without recapturing",async()=>{
 for(const changeKind of [false,true]){const h=harness();await h.create();if(changeKind)h.handle.kind={kind:"relay"};else h.handle.browser={};await assert.rejects(h.read(),/backend changed/);assert.equal(h.captures.length,1);assert(!h.events.includes("inspect"));assert.equal(h.handle.refCount,2);}
});
await scenario("mutating a published tab target or owner cannot transfer its original observation",async()=>{
 for(const field of ["targetId","ownerSessionId"] as const){const h=harness();const {tab}=await h.create();tab[field]="replacement";await assert.rejects(h.api.inspectTabForOwner(tab.ownerSessionId,{name:"tab",targetId:tab.targetId}),/tab identity changed/);assert(!h.events.includes("inspect"));assert.equal(h.captures.length,1);}
});
await scenario("native root absence is returned only for still-owned live tab; cmux error is not absence",async()=>{
 const h=harness();await h.create();h.absent();assert.equal((await h.read()).presence,"absent");
 const cmux=harness("cmux");await cmux.create();cmux.failRead();await assert.rejects(cmux.read(),/Original read failed/);assert.equal(cmux.handle.refCount,2);
});
await scenario("replacement or permanent retirement during read rejects even if original becomes alive again",async()=>{
 for(const retire of [false,true]){const h=harness();const {tab}=await h.create();const gate=h.readHold();const reading=h.read();await ticks();assert.equal(h.handle.refCount,3);
  if(retire){h.tabCleanups.set(tab,Promise.resolve());tab.state="dead";tab.state="alive";}else h.api.tabs.set("tab",{...tab});
  gate.resolve();await assert.rejects(reading,/changed/);assert.equal(h.handle.refCount,2);assert.equal(h.api.tabObservationReads.size,0);
 }
});
await scenario("retirement and unobserved historical tab reject before backend read",async()=>{
 const h=harness();const {tab}=await h.create();h.tabCleanups.set(tab,Promise.resolve());await assert.rejects(h.read(),/no longer available/);assert(!h.events.includes("inspect"));
 h.api.tabs.set("tab",{...tab});await assert.rejects(h.read(),/not captured/);assert.equal(h.captures.length,1);
});
await scenario("input copy preserves exact target and delayed release rechecks owner",async()=>{
 const h=harness();const {tab}=await h.create(),readGate=h.readHold();const target={name:"tab",targetId:"target"};const reading=h.api.inspectTabForOwner("owner",target);await ticks();target.name="other";target.targetId="other";
 const release=h.releaseHold();readGate.resolve();await ticks();h.api.tabs.set("tab",{...tab});release.resolve();await assert.rejects(reading,/changed/);assert.equal(h.handle.refCount,2);
});
await scenario("read and release failures both survive and capacity is restored",async()=>{
 const h=harness();await h.create();h.failRead();h.failRelease();await assert.rejects(h.read(),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors[0].message==="Original read failed"&&error.errors[1].message==="Lease release failed");assert.equal(h.api.tabObservationReads.size,0);
});
await scenario("duplicate and ninth concurrent reads refuse without losing eight retained holds",async()=>{
 const h=harness();for(let i=0;i<9;i++)await h.create("tab"+i);const gate=h.readHold();const reads=Array.from({length:8},(_,i)=>h.read("tab"+i));await ticks();
 await assert.rejects(h.read("tab0"),/concurrency/);await assert.rejects(h.read("tab8"),/concurrency/);assert.equal(h.api.tabObservationReads.size,8);assert.equal(h.events.filter(e=>e==="inspect").length,8);
 gate.resolve();await Promise.all(reads);assert.equal(h.api.tabObservationReads.size,0);assert.equal(h.handle.refCount,10);
});
// Hold the release after the native read has completed, while keeping the
// published tab and browser wrapper unchanged. Exercise the actual acquisition
// capture and final settlement; no query-time replacement identity is seeded.
for (const kind of ["headless", "spawned", "connected", "relay", "cmux"]) {
 for (const mutation of ["native", "kind"] as const) {
  await scenario(`release gap: ${kind} ${mutation} replacement rejects earlier presence`, async () => {
   const h = harness(kind); const { tab } = await h.create();
   const capturedNative = h.handle.client ?? h.handle.browser;
   const gate = h.releaseHold(); const reading = h.read().then(value => ({ value }), error => ({ error }));
   await ticks(); assert.equal(h.events.filter(e => e === "inspect").length, 1);
   assert.equal(h.api.tabObservationReads.size, 1);
   if (mutation === "kind") h.handle.kind = { kind: "changed-kind" };
   else if (kind === "cmux") h.handle.client = { async request() { throw new Error("Replacement must not be read"); } };
   else h.handle.browser = {};
   assert.equal(h.api.tabs.get("tab"), tab); assert.equal(tab.browser, h.handle);
   gate.resolve(); const result = await reading;
   assert("error" in result, "Changed native identity must not return the earlier observation");
   assert(result.error instanceof Error); assert.match(result.error.message, /backend changed/);
   assert.equal(h.api.tabObservationReads.size, 0); assert.equal(h.handle.refCount, 2);
   assert.equal(h.captures.length, 1); assert.equal(h.captures[0], capturedNative);
   assert.equal(h.events.filter(e => e === "inspect").length, 1);
  });
 }
 await scenario(`release gap: ${kind} unchanged owner succeeds without recapture`, async () => {
  const h = harness(kind); await h.create(); const gate = h.releaseHold(); const reading = h.read();
  await ticks(); gate.resolve(); assert.equal((await reading).presence, "present");
  assert.equal(h.captures.length, 1); assert.equal(h.handle.refCount, 2); assert.equal(h.api.tabObservationReads.size, 0);
 });
}
for (const mutation of ["native", "kind"] as const) {
 await scenario(`release gap: root ${mutation} replacement rejects earlier absence`, async () => {
  const h = harness(); await h.create(); h.absent(); const gate = h.releaseHold();
  const reading = h.read().then(value => ({ value }), error => ({ error })); await ticks();
  assert.equal(h.events.filter(e => e === "inspect").length, 1);
  if (mutation === "kind") h.handle.kind = { kind: "relay" }; else h.handle.browser = {};
  gate.resolve(); const result = await reading;
  assert("error" in result, "Changed native identity must not return the earlier absence");
  assert(result.error instanceof Error); assert.match(result.error.message, /backend changed/);
  assert.equal(h.captures.length, 1); assert.equal(h.handle.refCount, 2); assert.equal(h.api.tabObservationReads.size, 0);
 });
}
await scenario("release gap: unchanged root absence remains valid", async () => {
 const h = harness(); await h.create(); h.absent(); const gate = h.releaseHold(); const reading = h.read();
 await ticks(); gate.resolve(); assert.equal((await reading).presence, "absent"); assert.equal(h.captures.length, 1);
});
console.log(JSON.stringify({selectedPath,sha256:createHash("sha256").update(source).digest("hex"),sections:sections.map(s=>({bytes:Buffer.byteLength(s),sha256:createHash("sha256").update(s).digest("hex")})),passed,failed,counts:{pass:passed.length,fail:failed.length},limits:"Actual selected supervisor chunks with controlled capture/readers/worker/registry dependencies. No SDK/browser/worker/IPC/native execution; browser holds are not collective inspection drain."},null,2));if(failed.length)process.exitCode=1;
