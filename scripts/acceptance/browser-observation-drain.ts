/** Actual selected supervisor read/drain/batch bodies with controlled resource gates. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const selectedPath=process.argv[2];if(!selectedPath)throw new Error("Pass exact supervisor source");
const source=await readFile(selectedPath,"utf8");
function part(a:string,b:string){const start=source.indexOf(a),end=source.indexOf(b,start);assert(start>=0&&end>start);return source.slice(start,end);}
const batchStart=source.includes("async function releaseMatchingTabs")?"async function releaseMatchingTabs":"export async function releaseAllTabs";
const chunks=[part("const tabs = new Map","function markReportedInitFailure"),part("const tabCleanups = new WeakMap","export const BROWSER_TAB_OWNER_CLOSE_VERSION"),part(batchStart,"/**\n * Enumerates current"),part("export interface OwnerTabObservation","/**\n * Captures the current viewport")];
const body=new Bun.Transpiler({loader:"ts"}).transformSync(chunks.join("\n").replaceAll("export ",""));
type Tab={name:string;ownerSessionId:string;targetId:string;state:string;kindTag:string;backend:string;browser:{refCount:number};};
const ticks=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
function harness(){
 const gates=new Map<Tab,ReturnType<typeof Promise.withResolvers<string>>>(),calls:string[]=[];let releaseGate:Promise<void>|undefined,releaseError:Error|undefined,onHold:(()=>void)|undefined;
 const cleanupBodies=new Map<Tab,()=>Promise<void>>();
 let api:{tabs:Map<string,Tab>;reads:Map<Tab,unknown>|Set<Tab>;observations:WeakMap<Tab,((id:string)=>Promise<string>)|{inspect:(id:string)=>Promise<string>;assertCurrent():void}>;cleanup(tab:Tab,run:()=>Promise<void>):Promise<void>;inspect(owner:string,t:{name:string;targetId:string}):Promise<unknown>;owner(id:string):Promise<number>;all():Promise<number>;headless():Promise<void>};
 const run=async(tab:Tab)=>{calls.push("cleanup:"+tab.ownerSessionId+":"+tab.name);tab.state="dead";if(api.tabs.get(tab.name)===tab)api.tabs.delete(tab.name);await cleanupBodies.get(tab)?.();};
 api=new Function("ToolError","holdBrowser","releaseBrowser","releaseTabSession","releaseTab",`${body}\nreturn {tabs,reads:tabObservationReads,observations:tabObservations,cleanup:cleanupTab,inspect:inspectTabForOwner,owner:releaseTabsForOwner,all:releaseAllTabs,headless:dropHeadlessTabs};`)(Error,
 (b:Tab["browser"])=>{b.refCount++;onHold?.();},async(b:Tab["browser"])=>{calls.push("lease-release");await releaseGate;b.refCount--;if(releaseError)throw releaseError;},run,
 async(name:string)=>{const tab=api.tabs.get(name);if(!tab)return false;await api.cleanup(tab,()=>run(tab));return true;});
 return {api,calls,cleanupBodies,add(name="tab",owner="owner",kind="headless"){
  const tab:Tab={name,ownerSessionId:owner,targetId:name+"-target",state:"alive",kindTag:kind,backend:kind==="cmux"?"cmux":"worker",browser:{refCount:1}};
  const gate=Promise.withResolvers<string>();gates.set(tab,gate);api.tabs.set(name,tab);const inspect=async()=>{calls.push("read:"+name);return gate.promise;};api.observations.set(tab,source.includes("interface CapturedTabObservation")?{inspect,assertCurrent(){}}:inspect);return tab;
 },read(tab:Tab){return api.inspect(tab.ownerSessionId,{name:tab.name,targetId:tab.targetId}).catch(error=>error as Error);},
 gate(tab:Tab){return gates.get(tab)!;},close(tab:Tab){return api.cleanup(tab,()=>run(tab));},
 releaseHold(){const gate=Promise.withResolvers<void>();releaseGate=gate.promise;return gate;},failRelease(){releaseError=new Error("lease failed");},onHold(fn:()=>void){onHold=fn;}};
}
const passed:string[]=[],failures:Array<{name:string;error:string}>=[];
async function scenario(name:string,run:()=>Promise<void>){try{await run();passed.push(name);}catch(error){failures.push({name,error:error instanceof Error?error.stack??error.message:String(error)});}}
await scenario("cleanup waits for held inspection even after native body removes map entry",async()=>{
 const h=harness(),tab=h.add(),query=h.read(tab);await ticks();let done=false;const close=h.close(tab).then(()=>{done=true;});await ticks();const premature=done;
 h.gate(tab).resolve("present");const [result]=await Promise.all([query,close]);assert.equal(premature,false);assert(result instanceof Error);assert.equal(tab.browser.refCount,1);assert.equal(h.api.reads.size,0);
});
await scenario("cleanup failure cannot skip pending read failure and lease release",async()=>{
 const h=harness(),tab=h.add();h.cleanupBodies.set(tab,async()=>{throw new Error("native close failed");});const query=h.read(tab);await ticks();let done=false;const close=h.close(tab).catch(error=>{done=true;return error as Error;});await ticks();const premature=done;
 h.gate(tab).reject(new Error("backend read failed"));const [queryError,error]=await Promise.all([query,close]);assert.equal(premature,false);assert(queryError instanceof Error);assert(error instanceof AggregateError);assert.deepEqual(error.errors.map((e:Error)=>e.message),["native close failed","backend read failed"]);assert.equal(tab.browser.refCount,1);
});
await scenario("synchronously throwing cleanup still retains pending inspection",async()=>{
 const h=harness(),tab=h.add(),query=h.read(tab);await ticks();let done=false;let close:Promise<unknown>;
 try{close=h.api.cleanup(tab,()=>{throw new Error("sync cleanup failed");}).catch(error=>{done=true;return error;});}catch(error){done=true;close=Promise.resolve(error);}
 await ticks();const premature=done;h.gate(tab).resolve("present");const [,error]=await Promise.all([query,close]);assert.equal(premature,false);assert(error instanceof Error);assert.match(error.message,/sync cleanup failed/);
});
await scenario("lease-release wait and failure remain part of retained tab cleanup",async()=>{
 const h=harness(),tab=h.add(),release=h.releaseHold();h.failRelease();const query=h.read(tab);h.gate(tab).resolve("present");await ticks();let done=false;const close=h.close(tab).then(()=>{done=true;},error=>{done=true;return error;});await ticks();const premature=done;
 release.resolve();const [queryError,error]=await Promise.all([query,close]);assert.equal(premature,false);assert(queryError instanceof Error);assert(error instanceof Error);assert.match(error.message,/lease failed/);assert.equal(tab.browser.refCount,1);
});
await scenario("owner shutdown joins removed active original and leaves same-name foreign replacement",async()=>{
 const h=harness(),tab=h.add(),query=h.read(tab);await ticks();const close=h.close(tab);await ticks();const replacement=h.add("tab","foreign");let done=false;const owner=h.api.owner("owner").then(n=>{done=true;return n;});await ticks();const premature=done;
 h.gate(tab).resolve("present");const [,count]=await Promise.all([query,owner,close]);assert.equal(premature,false);assert.equal(count,1);assert.equal(h.api.tabs.get("tab"),replacement);assert.equal(h.calls.filter(c=>c==="cleanup:foreign:tab").length,0);
});
await scenario("batch shutdown drains other selected tabs despite an earlier cleanup failure",async()=>{
 const h=harness(),a=h.add("A"),b=h.add("B"),gate=Promise.withResolvers<void>();h.cleanupBodies.set(a,async()=>{throw new Error("A close failed");});h.cleanupBodies.set(b,()=>gate.promise);
 let done=false;const owner=h.api.owner("owner").catch(error=>{done=true;return error;});await ticks();const premature=done,started=h.calls.includes("cleanup:owner:B");gate.resolve();const error=await owner;
 assert.equal(started,true);assert.equal(premature,false);assert(error instanceof Error);assert.match(error.message,/A close failed/);
});
if(!process.argv.includes("--pair")){
 await scenario("retirement bars reentrant inspection without adding backend work",async()=>{
  const h=harness(),tab=h.add();let denied:Promise<unknown>|undefined;await h.api.cleanup(tab,async()=>{denied=h.read(tab);});const error=await denied;assert(error instanceof Error);assert.equal(h.calls.filter(c=>c.startsWith("read:")).length,0);
 });
 await scenario("reentrant cleanup during hold observes registered drain and prevents first read",async()=>{
  const h=harness(),tab=h.add();let close:Promise<void>|undefined;h.onHold(()=>{close=h.close(tab);});const result=await h.read(tab);await close;assert(result instanceof Error);assert.equal(h.calls.filter(c=>c.startsWith("read:")).length,0);assert.equal(tab.browser.refCount,1);
 });
 await scenario("headless and all-tab shutdown include their removed active resources",async()=>{
  for(const mode of ["headless","all"] as const){const h=harness(),tab=h.add(),foreign=h.add("cmux","foreign","cmux"),query=h.read(tab);await ticks();const close=h.close(tab);await ticks();let done=false;const batch=(mode==="headless"?h.api.headless():h.api.all()).then(()=>{done=true;});await ticks();const premature=done;h.gate(tab).resolve("present");await Promise.all([query,close,batch]);assert.equal(premature,false);assert.equal(h.api.tabs.has(foreign.name),mode==="headless");}
 });
 await scenario("ordinary successful read frees its slot and needs no retained cleanup",async()=>{
  const h=harness(),tab=h.add();h.gate(tab).resolve("absent");const result=await h.read(tab);assert(!(result instanceof Error));assert.equal(h.api.reads.size,0);await h.close(tab);assert.equal(tab.browser.refCount,1);
 });
 await scenario("multiple batch errors survive and repeated cleanup does not run twice",async()=>{
  const h=harness(),a=h.add("A"),b=h.add("B");h.cleanupBodies.set(a,async()=>{throw new Error("A failed");});h.cleanupBodies.set(b,async()=>{throw new Error("B failed");});
  await assert.rejects(h.api.all(),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors[0].message==="A failed"&&error.errors[1].message==="B failed");
  await assert.rejects(h.close(a),/A failed/);assert.equal(h.calls.filter(c=>c==="cleanup:owner:A").length,1);
 });
}
console.log(JSON.stringify({selectedPath,sha256:createHash("sha256").update(source).digest("hex"),chunks:chunks.map(s=>({bytes:Buffer.byteLength(s),sha256:createHash("sha256").update(s).digest("hex")})),passed,failures,counts:{pass:passed.length,fail:failures.length},limits:"Actual selected query/cleanup/batch bodies, controlled native cleanup/read/lease callbacks. Held gates settled before pair assertions. No native/SDK/IPC or wallclock proof."},null,2));if(failures.length)process.exitCode=1;
