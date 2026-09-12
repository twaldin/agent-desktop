/** Actual reservation/channel/cleanup bodies with controlled original backend and snapshot boundary. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = ".data/browser-reservation-backend-2026-09-11/native-source/native/src/tools/browser";
const paths = [process.env.CMUX_RESERVATION_SOURCE ?? `${base}/tab-supervisor.ts`, `${base}/cmux/evaluation-channel.ts`];
const [supervisor, channel] = await Promise.all(paths.map(p => readFile(p, "utf8")));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const compile = (s: string) => new Bun.Transpiler({loader:"ts"}).transformSync(s.replace(/^import[\s\S]*?;\r?\n/gm," ").replace(/^export /gm,""));
function between(s: string, a: string, b: string) { const i=s.indexOf(a), j=s.indexOf(b,i); assert(i>=0&&j>i);return s.slice(i,j); }
const selected = between(supervisor,"export const BROWSER_TAB_EVALUATION_RESERVATION_VERSION","export function getTab(");
const cleanup = between(supervisor,"const tabCleanups = new WeakMap","export const BROWSER_TAB_OWNER_CLOSE_VERSION");
class ToolError extends Error {}
class ToolAbortError extends Error {}
class BrowserActionRejected extends Error {}
const ticks=async()=>{for(let i=0;i<48;i++)await Promise.resolve();};
const messages=(e:unknown):string=>e instanceof AggregateError?e.errors.map(messages).join(" | "):e instanceof Error?e.message:String(e);
function outcome(p:Promise<unknown>){let result:{ok:boolean,error?:unknown,value?:unknown}|undefined;void p.then(value=>{result={ok:true,value};},error=>{result={ok:false,error};});return{get result(){return result;}};}
function harness(backend="cmux") {
 const actions:string[]=[], initial=Promise.withResolvers<void>(), reads=Promise.withResolvers<Record<string,unknown>>();
 let current=true, failRelease=false, requestCount=0, requestImpl:()=>Promise<Record<string,unknown>>=()=>reads.promise;
 const state={version:1,surfaceId:"surface-original",url:"before-drain",title:"original",viewport:{width:901,height:702},elementRefs:[]};
 const cmux={state}; const native={request:async(method:string,params:Record<string,unknown>)=>{requestCount++;actions.push(method);assert.equal(params.surface_id,state.surfaceId);return requestImpl();}};
 const tab:any={name:"original",targetId:state.surfaceId,ownerSessionId:"owner",state:"alive",browser:{},backend,kindTag:backend,cmuxTab:cmux,pending:new Map(),worker:{assertActive(){},send(){},terminate(){return initial.promise;}},connectionOwner:{assertCurrent(){}}};
 const tabs=new Map([[tab.name,tab]]), observations=new WeakMap([[tab,{assertCurrent(){if(!current)throw new Error("original source lost");}}]]);
 const create = new Function("ToolError","captureCmuxRetainedState",`${compile(channel)};return createCmuxEvaluationChannel;`)(ToolError,(value:any)=>structuredClone(value.state));
 const deps:Record<string,unknown>={ToolError,ToolAbortError,BrowserActionRejected,tabs,tabObservations:observations,tabObservationReads:new Map(),viewportCaptures:new Map(),humanActions:new Map(),acquireChains:new Map(),holdBrowser(){actions.push("hold");},releaseBrowser:async()=>{actions.push("release-browser");},drainCmuxRun:()=>initial.promise,drainTabTools:async()=>{},releaseTabSession:async()=>{actions.push("release-resource");tab.state="dead";if(failRelease)throw new Error("resource release failed");},originalCmuxTabSource:()=>({client:native}),createCmuxEvaluationChannel:create};
 const api=new Function(...Object.keys(deps),`${compile(selected)}\n${compile(cleanup)};return {reserve:reserveTabEvaluationForOwner,open:openReservedCmuxEvaluation};`)(...Object.values(deps));
 const target={name:tab.name,targetId:tab.targetId};
 const reservation=api.reserve("owner",target,"operation");
 return {api,reservation,target,state,actions,reads,initial,tab,open:()=>api.open("owner",target,"operation"),invalidate(){current=false;},failRelease(){failRelease=true;},setRequest(fn:typeof requestImpl){requestImpl=fn;},get requests(){return requestCount;}};
}
const passed:string[]=[],failures:unknown[]=[],evidence:unknown[]=[];
async function test(name:string,body:()=>Promise<unknown>){try{evidence.push({name,value:await body()});passed.push(name);}catch(e){failures.push({name,error:e instanceof Error?e.stack:String(e)});}}
await test("only ready exact original cmux reservation publishes access and post-drain state",async()=>{
 const h=harness();assert.throws(h.open,/not ready/);h.state.url="after-old-drain";h.initial.resolve();await h.reservation.ready;
 assert.throws(()=>h.api.open("foreign",h.target,"operation"));assert.throws(()=>h.api.open("owner",h.target,"other"));
 const c=h.open();assert.equal(c.state.url,"after-old-drain");h.state.url="later-old-mutation";assert.equal(h.open().state.url,"after-old-drain");assert.equal(h.requests,0);await h.reservation.dispose();return {url:c.state.url,requests:h.requests};
});
await test("worker/CDP reservation is not converted into a cmux channel",async()=>{
 const h=harness("worker");h.initial.resolve();await h.reservation.ready;assert.throws(h.open,/not a cmux/);assert.equal(h.requests,0);await h.reservation.dispose();return{requests:h.requests};
});
await test("retirement before ready never opens or reconnects a channel",async()=>{
 const h=harness();const disposal=outcome(h.reservation.dispose());h.initial.resolve();await ticks();assert.throws(h.open);assert.equal(disposal.result?.ok,true);assert.equal(h.requests,0);return disposal.result;
});
for(const response of ["valid","reject","malformed"] as const) await test(`owner cleanup waits original ${response} request before resource release`,async()=>{
 const h=harness();h.initial.resolve();await h.reservation.ready;const c=h.open();const request=outcome(c.request("browser.eval",{surface_id:h.target.targetId,script:"1"}));
 const disposal=outcome(h.reservation.dispose());await ticks();const before={pending:!disposal.result,release:h.actions.includes("release-resource")};
 if(response==="reject")h.reads.reject(new Error("late native error"));else h.reads.resolve(response==="malformed"?null as any:{value:1});
 await ticks();assert.deepEqual(before,{pending:true,release:false});assert.equal(request.result?.ok,false);assert.equal(disposal.result?.ok,response==="valid");assert.equal(h.actions.filter(x=>x==="release-resource").length,1);assert.equal(h.actions.filter(x=>x==="release-browser").length,1);
 if(response!=="valid")assert.match(messages(disposal.result?.error),response==="reject"?/late native error/:/Invalid cmux evaluation record/);return {before,disposal:disposal.result?.ok};
});
await test("native request synchronous owner disposal reserves work before callbacks",async()=>{
 const h=harness();h.initial.resolve();await h.reservation.ready;const c=h.open();let disposal:ReturnType<typeof outcome>|undefined;
 h.setRequest(()=>{disposal=outcome(h.reservation.dispose());return h.reads.promise;});const request=outcome(c.request("browser.screenshot",{surface_id:h.target.targetId}));await ticks();const pending=!disposal?.result,resource=h.actions.includes("release-resource");h.reads.resolve({data:"image"});await ticks();assert.equal(pending,true);assert.equal(resource,false);assert.equal(disposal?.result?.ok,true);assert.equal(request.result?.ok,false);return {pending,resource};
});
await test("independent request and resource errors retained without skipping release hold",async()=>{
 const h=harness();h.initial.resolve();await h.reservation.ready;const c=h.open();outcome(c.request("browser.eval",{surface_id:h.target.targetId,script:"1"}));h.failRelease();const disposal=outcome(h.reservation.dispose());h.reads.reject(new Error("request failed"));await ticks();assert.match(messages(disposal.result?.error),/request failed/);assert.match(messages(disposal.result?.error),/resource release failed/);assert.equal(h.actions.filter(x=>x==="release-browser").length,1);return{errors:messages(disposal.result?.error)};
});
await test("disposed channel cannot be replaced by reopening the same reservation",async()=>{
 const h=harness();h.initial.resolve();await h.reservation.ready;await h.open().dispose();await assert.rejects(h.open().request("browser.url.get",{surface_id:h.target.targetId}),/retired/);assert.equal(h.requests,0);await h.reservation.dispose();return {requests:h.requests};
});
await test("lost original source cannot publish a fresh channel",async()=>{
 const h=harness();h.initial.resolve();await h.reservation.ready;h.invalidate();assert.throws(h.open,/original source lost/);assert.equal(h.requests,0);await assert.rejects(h.reservation.dispose(),/Reserved browser disposal failed/);return{requests:h.requests};
});
console.log(JSON.stringify({paths,hashes:{supervisor:hash(supervisor),reservation:hash(selected),cleanup:hash(cleanup),channel:hash(channel)},counts:{pass:passed.length,fail:failures.length},passed,failures,evidence,limits:"Actual complete channel plus selected native reservation/cleanup; controlled snapshot/client/resource cleanup, no SDK/native/Worker/IPC. 48 microtasks are observations only; gates settled before comparisons."},null,2));if(failures.length)process.exitCode=1;
