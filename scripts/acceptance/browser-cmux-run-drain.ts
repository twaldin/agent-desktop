/** Controlled actual cmux source bodies; no native module import or backend. */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
const base = ".data/browser-cmux-run-drain-2026-09-11";
const cmuxPath = process.env.CMUX_RUN_SOURCE ?? `${base}/native-source/native/src/tools/browser/cmux/cmux-tab.ts`;
const supervisorPath = process.env.SUPERVISOR_SOURCE ?? `${base}/native-source/native/src/tools/browser/tab-supervisor.ts`;
const [cmux, supervisor, scope, errors, abortable] = await Promise.all([cmuxPath, supervisorPath, `${base}/primary/run-scope.ts`, `${base}/primary/tool-errors.ts`, `${base}/primary/abortable.ts`].map(p => readFile(p, "utf8")));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const compile = (s: string) => new Bun.Transpiler({loader:"ts"}).transformSync(s.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm,""));
function between(s: string, a: string, b: string) { const start=s.indexOf(a), end=s.indexOf(b,start); assert(start>=0&&end>start); return s.slice(start,end); }
const cleanupSource=between(supervisor,"function cleanupTab(","export const BROWSER_TAB_OWNER_CLOSE_VERSION");
const bindSource=scope.slice(scope.indexOf("export function bindRunFacade<"));
const {ToolError,ToolAbortError,throwIfAborted}=new Function(`${compile(errors)};return {ToolError,ToolAbortError,throwIfAborted}`)();
const {untilAborted,AbortError}=new Function("assert",`${compile(abortable)};return {untilAborted,AbortError}`)(assert);

const ticks=async()=>{for(let i=0;i<64;i++)await Promise.resolve();};
function outcome(p:Promise<unknown>){let result:{ok:boolean;value?:unknown;error?:unknown}|undefined;void p.then(value=>result={ok:true,value},error=>result={ok:false,error});return {get value(){return result;},async settled(){await ticks();return result;}};}
function messages(e:unknown):string {return e instanceof AggregateError ? e.errors.map(messages).join(" | ") : e instanceof Error?`${e.message}${e.cause?` (${messages(e.cause)})`:""}`:String(e);}
type Body=(scope:any,hooks:any)=>unknown;
function harness(){
 let setupFail=false,cleanupFail=false,interceptors=0,tracking=0,serial=0;
 const expected=new WeakSet<object>();
 const observers:Array<(error:unknown)=>boolean>=[];
 const requests:string[]=[];let request: (method:string)=>Promise<any>=async()=>({value:true});
 let fileRead=async()=>new ArrayBuffer(1);
 const pm={markExpectedCleanupError(e:object){expected.add(e);return e;},isExpectedCleanupError(e:unknown){return typeof e==="object"&&e!==null&&expected.has(e);},interceptUnhandledRejections(callback:(error:unknown)=>boolean){if(setupFail)throw new Error("interceptor setup failed");interceptors++;observers.push(callback);return()=>{interceptors--;observers.splice(observers.indexOf(callback),1);if(cleanupFail)throw new Error("interceptor cleanup failed");};}};
 const scopeApi=new Function("AsyncLocalStorage","untilAborted","postmortem","ToolError","throwIfAborted","Bun",`${compile(scope)};return {bindRunFacade,waitForRun,withBrowserPromiseCombinatorTracking,resolvePredicateTimeout,isBrowserRunOwnedRejection,markBrowserRunRejection,observeBrowserRunPromise}`)(AsyncLocalStorage,untilAborted,pm,ToolError,throwIfAborted,{sleep:async()=>{}});
 const deps:Record<string,unknown>={ToolError,ToolAbortError,OperationAbortError:AbortError,postmortem:pm,logger:{debug(){},warn(){}},AbortSignal,crypto:{randomUUID:()=>`run${++serial}`},Bun:{sleep:async()=>{},file:()=>({type:"application/octet-stream",arrayBuffer:()=>fileRead()})},JsRuntime:class{},RunOutput:class{pushText(){}pushDisplay(){}finish(){return[];}},cloneSafe:structuredClone,throwIfAborted,bindRunFacade:scopeApi.bindRunFacade,waitForRun:scopeApi.waitForRun,withBrowserPromiseCombinatorTracking:async(owner:unknown,cb:unknown,run:()=>Promise<unknown>)=>{tracking++;try{return await scopeApi.withBrowserPromiseCombinatorTracking(owner,cb,run);}finally{tracking--;}},resolvePredicateTimeout:scopeApi.resolvePredicateTimeout,isBrowserRunOwnedRejection:scopeApi.isBrowserRunOwnedRejection,markBrowserRunRejection:scopeApi.markBrowserRunRejection,observeBrowserRunPromise:scopeApi.observeBrowserRunPromise,untilAborted,DEFAULT_VIEWPORT:{width:800,height:600,deviceScaleFactor:1},mapWaitUntil:(x:unknown)=>x,GEOMETRY_SCRIPT:"",resizeImage:async()=>({}),formatScreenshot:()=>"",resolveToCwd:(p:string)=>p,extractReadableFromHtml:()=>"",buildAriaSnapshotScript:()=>"",assertSelectorString:(s:unknown)=>assert.equal(typeof s,"string"),Snowflake:{next:()=>"image"},os:{},path,fs:{},serializeEvalWithEnvelope:(s:string)=>s,unwrapEvalEnvelope:(v:unknown)=>v};
 const mod=new Function(...Object.keys(deps),`${compile(cmux)};return {CmuxTab,runCmuxCodeWithContext,drain:typeof drainCmuxRun==='function'?drainCmuxRun:()=>Promise.resolve()}`)(...Object.values(deps));
 const tab=new mod.CmuxTab({client:{request:(m:string)=>{requests.push(m);return request(m);}},surfaceId:"original",url:"about:blank"});
 let savedScope:any,body:Body=()=>"success",tool=async()=>"tool" as unknown;
 const runtime={setCwd(){},setRunScope(s:any){savedScope=s;},run(_code:unknown,_filename:unknown,hooks:any){try{return Promise.resolve(body(savedScope,hooks));}catch(e){return Promise.reject(e);}}};
 tab.ensureRuntime=()=>runtime;
 const tabRecord={backend:"cmux",cmuxTab:tab};
 const cleanupTab=new Function("tabCleanups","activeTabCleanups","tabObservationReads","drainTabTools","drainCmuxRun",`${compile(cleanupSource)};return cleanupTab`)(new WeakMap(),new Map(),new WeakMap(),()=>Promise.resolve(),mod.drain);
 const run=(signal?:AbortSignal)=>mod.runCmuxCodeWithContext(tab,{code:"controlled",timeoutMs:60000,signal},{snapshot:{cwd:"/controlled",excludeWebP:false},callTool:()=>tool()});
 return {tab,requests,run,emit(error:Error){for(const cb of [...observers])if(cb(error))break;},drain:()=>mod.drain(tab) as Promise<void>,cleanup:(fn:()=>Promise<void>=async()=>{})=>cleanupTab(tabRecord,fn) as Promise<void>,setBody(v:Body){body=v;},setRequest(v:typeof request){request=v;},setFile(v:typeof fileRead){fileRead=v;},setTool(v:typeof tool){tool=v;},failSetup(v:boolean){setupFail=v;},failCleanup(){cleanupFail=true;},get scope(){return savedScope;},get tracking(){return tracking;},get interceptors(){return interceptors;}};
}
const passed:string[]=[], failures:{name:string;error:string}[]=[], evidence:unknown[]=[];
async function scenario(name:string,body:()=>Promise<unknown>){try{evidence.push({name,value:await body()});passed.push(name);}catch(e){failures.push({name,error:e instanceof Error?e.stack??e.message:String(e)});}}
await scenario("caller cancellation returns while original runtime and cleanup remain pending",async()=>{
 const h=harness(),gate=Promise.withResolvers<unknown>(),ac=new AbortController();h.setBody(()=>gate.promise);
 const run=outcome(h.run(ac.signal));await ticks();ac.abort();await ticks();const drain=outcome(h.cleanup());await ticks();const before={caller:run.value?.ok,pending:!drain.value,tracking:h.tracking};
 gate.resolve("late");await ticks();assert.equal(before.pending,true);assert.equal(before.caller,false);assert.equal(before.tracking,1);assert.equal(drain.value?.ok,true);assert.equal(h.tracking,0);return before;
});
for(const kind of ["runtime","tool","request","close"] as const) for(const fails of [false,true]) await scenario(`${kind} actual completion ${fails?"error":"success"} survives cancellation`,async()=>{
 const h=harness(),gate=Promise.withResolvers<any>(),ac=new AbortController();let guest:any;
 h.setRequest(()=>gate.promise);h.setTool(()=>gate.promise);
 h.setBody((s,hooks)=>{if(kind==="runtime")return gate.promise;guest=outcome(kind==="tool"?hooks.callTool("actual",{}):kind==="close"?s.tab.closeSurface():s.tab.title());return "returned";});
 // Request runtime itself must settle on cancellation; actual raw request remains held.
 if(kind==="request") h.setBody(s=>{guest=outcome(s.tab.title());return Promise.resolve("returned");});
 const run=outcome(h.run(ac.signal));await ticks();ac.abort();await ticks();const drain=outcome(h.cleanup());await ticks();const pending=!drain.value;
 if(fails)gate.reject(new Error(`late ${kind}`));else gate.resolve({value:"title"});await ticks();
 assert.equal(pending,true);assert.equal(drain.value?.ok,!fails);if(fails)assert.match(messages(drain.value?.error),new RegExp(`late ${kind}`));return {pending,caller:run.value?.ok,guest:guest?.value?.ok,drain:drain.value?.ok,errors:messages(drain.value?.error)};
});
for(const handle of [false,true]) await scenario(`${handle?"returned handle":"tab"} dropped upload is held and cannot dispatch after cancellation`,async()=>{
 const h=harness(),gate=Promise.withResolvers<ArrayBuffer>();h.setFile(()=>gate.promise);let guest:any;
 h.setBody(async s=>{const target=handle?await s.tab.ref("e1"):s.tab;guest=outcome(handle?target.uploadFile("file.bin"):target.uploadFile("input","file.bin"));return "returned";});
 const run=outcome(h.run());await ticks();const drain=outcome(h.cleanup());await ticks();const before={pending:!drain.value,requests:h.requests.length};gate.resolve(new ArrayBuffer(3));await ticks();
 assert.equal(before.pending,true);assert.equal(h.requests.length,before.requests);assert.equal(drain.value?.ok,true);assert.equal(guest.value?.ok,false);assert.equal(run.value?.ok,true);return before;
});
await scenario("new run refused during drain, fresh run admitted after success",async()=>{
 const h=harness(),gate=Promise.withResolvers<unknown>(),ac=new AbortController();h.setBody(()=>gate.promise);const first=outcome(h.run(ac.signal));await ticks();ac.abort();await ticks();h.setBody(()=>"fresh");const blocked=outcome(h.run());await ticks();gate.resolve("late");await ticks();const blockedValue=blocked.value;await h.drain();const fresh=await h.run();await h.drain();assert.equal(blockedValue?.ok,false);assert.match(messages(blockedValue?.error),/drain/);assert.equal(fresh.returnValue,"fresh");return {blocked:blockedValue?.ok,first:first.value?.ok,fresh:fresh.returnValue};
});
await scenario("interceptor setup failure releases run state for deliberate retry",async()=>{
 const h=harness();h.failSetup(true);const result=outcome(h.run());await ticks();const drain=outcome(h.drain());await ticks();h.failSetup(false);const retried=outcome(h.run());await ticks();assert.equal(result.value?.ok,false);assert.equal(drain.value?.ok,true);assert.equal(retried.value?.ok,true);return {failed:result.value?.ok,drain:drain.value?.ok,retry:retried.value?.ok};
});
await scenario("cleanup hook failure retained and refuses later reuse",async()=>{
 const h=harness();h.failCleanup();const first=outcome(h.run());await ticks();const drain=outcome(h.drain());await ticks();const next=outcome(h.run());await ticks();assert.equal(drain.value?.ok,false);assert.match(messages(drain.value?.error),/cleanup failed/);assert.equal(next.value?.ok,false);return {first:first.value?.ok,drain:drain.value?.ok,next:next.value?.ok};
});
await scenario("reentrant supervisor cleanup joins reserved tool and independent cleanup error",async()=>{
 const h=harness(),gate=Promise.withResolvers<unknown>();let drain:any;h.setTool(()=>{drain=outcome(h.cleanup(async()=>{throw new Error("resource cleanup");}));return gate.promise;});h.setBody((_s,hooks)=>{void hooks.callTool("actual",{}).catch(()=>{});return "returned";});
 const run=outcome(h.run());await ticks();const pending=!drain.value;gate.reject(new Error("late tool"));await ticks();assert.equal(pending,true);assert.equal(drain.value?.ok,false);assert.match(messages(drain.value?.error),/resource cleanup/);assert.match(messages(drain.value?.error),/late tool/);return {pending,run:run.value?.ok,errors:messages(drain.value?.error)};
});
await scenario("active reported operational error does not poison drain",async()=>{
 const h=harness();h.setBody(()=>{throw new Error("reported error");});await assert.rejects(h.run(),/reported error/);await h.drain();h.setBody(()=>"retry");assert.equal((await h.run()).returnValue,"retry");await h.drain();return {retry:true};
});
await scenario("real typed abort and unrelated named error stay distinct",async()=>{
 const outcomes:boolean[]=[];for(const genuine of [true,false]){const h=harness(),gate=Promise.withResolvers<unknown>(),ac=new AbortController();h.setBody(()=>gate.promise);const run=outcome(h.run(ac.signal));await ticks();ac.abort();await ticks();const drain=outcome(h.drain());const error=genuine?new ToolAbortError():Object.assign(new Error("unrelated"),{name:"ToolAbortError"});gate.reject(error);await ticks();outcomes.push(drain.value?.ok===true);void run;}assert.deepEqual(outcomes,[true,false]);return outcomes;
});
await scenario("internal drain and setters are absent from guest tab",async()=>{
 const h=harness();let found:unknown;h.setBody(s=>{found=[typeof s.tab.drainRun,typeof s.tab.setRunContext,typeof s.tab.clearRunContext];return "success";});await h.run();await h.drain();assert.deepEqual(found,["undefined","undefined","undefined"]);return found;
});
for(const expected of [false,true]) await scenario(`late global rejection ${expected?"expected":"operational"} during retained runtime`,async()=>{
 const h=harness(),gate=Promise.withResolvers<unknown>(),ac=new AbortController();h.setBody(()=>gate.promise);const run=outcome(h.run(ac.signal));await ticks();ac.abort();await ticks();const drain=outcome(h.cleanup());const error=expected?new ToolAbortError():new Error("late global failure");error.stack="Error at cmux-run-run1.js:1";h.emit(error);gate.resolve("late");await ticks();assert.equal(drain.value?.ok,expected);if(!expected)assert.match(messages(drain.value?.error),/late global failure/);return {run:run.value?.ok,drain:drain.value?.ok};
});
const result={selected:{cmuxPath,supervisorPath},hashes:{cmux:hash(cmux),supervisor:hash(supervisor),cleanup:hash(cleanupSource),bind:hash(bindSource),errors:hash(errors),abortable:hash(abortable)},counts:{pass:passed.length,fail:failures.length},passed,failures,evidence,limits:"Actual complete cmux module and supervisor cleanup; original complete run-scope, tool errors, abortable source with controlled runtime/client/FS/tool/interceptor boundaries. 64 microtasks are observations, not deadline proof. Missing prior module drain falls back to already-complete only for before comparator; no claimed old API. No native JS evaluator, socket, browser/Worker/IPC, physical cleanup or lease. Interceptor delivery is controlled; no real unhandled-rejection process policy or native timing proof."};
console.log(JSON.stringify(result,null,2));if(failures.length)process.exitCode=1;
