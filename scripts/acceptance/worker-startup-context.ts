/** Actual maintained parent/child-open bodies with controlled spawn/manager boundaries.
 * No child process, SDK import, native session or provider is started. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { localEnvironmentForWorker } from "../../apps/host/src/local-environments/environment";
const base = path.resolve(".data/worker-startup-context-2026-09-11");
const parentPath = process.env.STARTUP_PARENT ?? path.resolve("apps/host/src/omp-workers/runtime.ts");
const nativePath = process.env.STARTUP_NATIVE ?? path.resolve("apps/host/src/omp/runtime.ts");
const parent = await fs.readFile(parentPath,"utf8"), native = await fs.readFile(nativePath,"utf8");
const helper = await fs.readFile("apps/host/src/omp/session-files.ts","utf8");
const selected: Record<string,string> = {};
function section(name: string, source: string, start: string, end?: string) {
  const a=source.indexOf(start), b=end ? source.indexOf(end,a) : source.length;
  assert(a>=0 && b>a, name); return selected[name]=source.slice(a,b);
}
const transpile=(s:string)=>new Bun.Transpiler({loader:"ts"}).transformSync(s);
const runtimeBody=section("WorkerRuntime",parent,"export class WorkerRuntime {");
const clientBody=section("WorkerClient",parent,"export class WorkerClient {","/** One native OMP process");
const openBody=section("OmpRuntime.open",native,"  async #open(","  async #attach(");
const helperBody=section("sessionFiles",helper,"export async function requireDirectory(");
interface Identity {id:string;cwd:string;directory:string}
interface Handle {id:string;cwd:string;dispose():Promise<void>}
interface Runtime {create(options:{cwd:string;model?:unknown;sessionDirectory?:string}, env?:unknown):Promise<Handle>; open(options:{sessionFile:string;interactions?:boolean},env?:unknown):Promise<Handle>;createBrowserOwner(owner:{id:string;cwd:string}):Promise<Handle>;listModels(cwd:string):Promise<unknown>;dispose():Promise<void>}
interface Init {mode:string;options?:{cwd?:string;sessionFile?:string;expectedIdentity?:Identity};owner?:{id:string;cwd:string}}
function harness(options:{directory?:(p:string)=>Promise<string>;header?:{id:string;cwd:string};wrongMetadata?:boolean;environment?:Record<string,string>}={}) {
  const clients:Client[]=[];const calls:unknown[]=[];
  class Client {
    pid=123; snapshot: {id:string;cwd:string;sessionFile:string}|undefined; closes=0;
    constructor(readonly options:unknown,readonly environment:unknown,readonly directory?:string){clients.push(this);}
    async request(message:{operation:string;args?:Init}) {
      calls.push(message); if(message.operation!=="init")return [];
      const init=message.args!;
      if(init.mode==="create" || init.mode==="open") this.snapshot={id:options.wrongMetadata?"foreign":init.options?.expectedIdentity?.id??"session",cwd:options.wrongMetadata?"/foreign":init.options?.cwd??init.options?.expectedIdentity?.cwd??"/selected",sessionFile:"/session.jsonl"};
      return {ownerId:init.owner?.id,cwd:init.owner?.cwd};
    }
    async close(){this.closes++;} subscribe(){return ()=>{};} subscribeFailure(){return ()=>{};}
  }
  const C=new Function("WorkerClient","requireDirectory","readSessionHeader","realpath","path","localEnvironmentForWorker",transpile(runtimeBody.replace("export class","class"))+"\nreturn WorkerRuntime;")(
    Client,options.directory??(async (p:string)=>p==="/selected"?"/canonical":p),async()=>({...options.header??{id:"original",cwd:"/selected"}}),async(p:string)=>p,path,localEnvironmentForWorker) as new(options:unknown)=>Runtime;
  return {runtime:new C({agentDir:"relative-profile",environment:options.environment??{PWD:"/daemon",PROFILE:"original",PI_DISABLE_DOTENV:"1"}}),clients,calls};
}
const results:Array<{name:string;ok:boolean;error?:string}>=[];
async function test(name:string,fn:()=>Promise<void>){try{await fn();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:String(e)});}}
await test("create captures final canonical cwd before spawn",async()=>{
  const gate=Promise.withResolvers<string>(),entered=Promise.withResolvers<void>();const env={PWD:"/daemon",PROFILE:"original"};
  const h=harness({environment:env,directory:async()=>{entered.resolve();return gate.promise;}});
  const input={cwd:"/selected",sessionDirectory:"relative-sessions"};const pending=h.runtime.create(input);for(let i=0;i<16;i++)await Promise.resolve();input.cwd="/later";env.PROFILE="later";const premature=h.clients.length;gate.resolve("/canonical");const handle=await pending;
  try{assert.equal(premature,0);assert.equal(h.clients[0]?.directory,"/canonical");assert.equal(handle.cwd,"/canonical");assert.equal((h.clients[0]?.environment as typeof env).PROFILE,"original");assert.equal((h.calls[0] as {args:Init}).args.options?.cwd,"/canonical");assert.equal((h.calls[0] as {args:{options:{sessionDirectory:string}}}).args.options.sessionDirectory,path.resolve("relative-sessions"));}finally{await h.runtime.dispose();}
});
await test("browser owner uses captured original canonical directory",async()=>{const h=harness();const input={id:"draft",cwd:"/selected"};const p=h.runtime.createBrowserOwner(input);input.id="other";input.cwd="/other";const x=await p;try{assert.equal(h.clients[0]?.directory,"/canonical");assert.equal(x.id,"draft");assert.equal(x.cwd,"/canonical");}finally{await h.runtime.dispose();}});
await test("reopen carries original raw identity plus canonical launch directory",async()=>{const h=harness();const input={sessionFile:"/session.jsonl",interactions:true};const p=h.runtime.open(input);input.interactions=false;const x=await p;try{assert.equal(h.clients[0]?.directory,"/canonical");assert.equal(x.id,"original");assert.equal(x.cwd,"/selected");const sent=(h.calls[0] as {args:{options:{sessionFile:string;expectedIdentity:Identity;interactions:boolean}}}).args.options;assert.equal(sent.sessionFile,"/session.jsonl");assert.equal(sent.interactions,true);assert.deepEqual(sent.expectedIdentity,{id:"original",cwd:"/selected",directory:"/canonical"});}finally{await h.runtime.dispose();}});
await test("relative saved cwd refuses before spawn and releases file reservation",async()=>{const header={id:"original",cwd:"relative-project"};const h=harness({header});try{await assert.rejects(h.runtime.open({sessionFile:"/session.jsonl"}),/must be absolute/);assert.equal(h.clients.length,0);header.cwd="/selected";const recovered=await h.runtime.open({sessionFile:"/session.jsonl"});assert.equal(recovered.id,"original");assert.equal(h.clients.length,1);}finally{await h.runtime.dispose();}});
await test("invalid directory does not spawn",async()=>{const h=harness({directory:async()=>{throw new Error("directory missing");}});try{await assert.rejects(h.runtime.create({cwd:"/gone"}),/directory missing/);assert.equal(h.clients.length,0);}finally{await h.runtime.dispose();}});
await test("shutdown while canonicalization is held prevents later spawn",async()=>{const gate=Promise.withResolvers<string>(),entered=Promise.withResolvers<void>();const h=harness({directory:async()=>{entered.resolve();return gate.promise;}});const p=h.runtime.create({cwd:"/selected"}).catch(e=>e);for(let i=0;i<16;i++)await Promise.resolve();const d=h.runtime.dispose();gate.resolve("/canonical");const outcome=await p;await d;assert.match(String(outcome),/disposed/);assert.equal(h.clients.length,0);});
for(const mode of ["create","open"] as const)await test(`${mode} rejects mismatching native metadata and closes child`,async()=>{const h=harness({wrongMetadata:true});try{await assert.rejects(mode==="create"?h.runtime.create({cwd:"/selected"}):h.runtime.open({sessionFile:"/session.jsonl"}),/changed/);assert.equal(h.clients[0]?.closes,1);}finally{await h.runtime.dispose();}});
for(const matches of [true,false])await test(`prepared worktree ${matches?"matches":"mismatch refuses spawn"}`,async()=>{const h=harness();const environment={sourceRoot:"/source",worktreeRoot:matches?"/canonical":"/other",environmentDelta:{version:1,set:{SELECTED:"yes"},unset:[]}};try{if(matches){await h.runtime.create({cwd:"/selected"},environment);assert.equal(h.clients[0]?.directory,"/canonical");assert.equal((h.clients[0]?.environment as Record<string,string>).SELECTED,"yes");assert.equal((h.clients[0]?.environment as Record<string,string>).CODEX_WORKTREE_PATH,"/canonical");}else{await assert.rejects(h.runtime.create({cwd:"/selected"},environment),/worktree environment/);assert.equal(h.clients.length,0);}}finally{await h.runtime.dispose();}});
await test("discovery remains independent of selected operation cwd",async()=>{const h=harness();try{await h.runtime.listModels("/project");assert.equal(h.clients[0]?.directory,undefined);assert.equal((h.clients[0]?.environment as Record<string,string>).PWD,"/daemon");}finally{await h.runtime.dispose();}});
for(const directory of [undefined,"/canonical"])await test(`actual WorkerClient spawn options ${directory?"directory-bound":"discovery"}`,async()=>{
  let observed: {cwd?:string;cmd:string[];env:Record<string,string>}|undefined;
  const fakeBun={spawn:(opts:typeof observed)=>{observed=opts;return {pid:123};}};
  const Client=new Function("Bun","path","fileURLToPath","getBundledRuntimeRoot","assertBundledRuntime","setTimeout","clearTimeout",transpile(clientBody.replace("export class","class").replaceAll("import.meta.url",JSON.stringify(pathToFileURL(parentPath).href)))+"\nreturn WorkerClient;")(fakeBun,path,fileURLToPath,()=>undefined,()=>{throw new Error("unexpected bundled assertion");},()=>({unref(){}}),()=>{}) as new(o:unknown,e:unknown,cwd?:string)=>unknown;
  const env={PWD:"/daemon",PROFILE:"configured",PI_DISABLE_DOTENV:"1",PI_CODING_AGENT_DIR:"environment-profile"};new Client({executablePath:"/controlled/bun",workerPath:"relative-entry.ts",agentDir:"relative-profile"},env,directory);
  assert(observed);assert.equal(observed.cwd,directory);assert.equal(observed.env.PWD,directory??"/daemon");assert.equal(observed.env.PI_CODING_AGENT_DIR,path.resolve("relative-profile"));assert.deepEqual(observed.cmd,["/controlled/bun","--no-env-file",path.resolve("relative-entry.ts")]);assert.equal(observed.env.PROFILE,"configured");assert.equal(env.PWD,"/daemon");for(const agentDir of [undefined, ""]){new Client({executablePath:"/controlled/bun",workerPath:"relative-entry.ts",agentDir},env,directory);assert.equal(observed.env.PI_CODING_AGENT_DIR,path.resolve("environment-profile"));}assert.equal(env.PI_CODING_AGENT_DIR,"environment-profile");
});
function openHarness(header:{id:string;cwd:string},directory:string,managerIdentity=header) {
 const calls:string[]=[];const manager={getSessionId:()=>managerIdentity.id,getCwd:()=>managerIdentity.cwd,close:async()=>{calls.push("close");}};
 const C=new Function("realpath","readSessionHeader","requireDirectory","SessionManager",transpile(`class Harness { #reservedFiles=new Set(); #assertActive(){} async #attach(){return "attached";} ${openBody} open(options){return this.#open(options);} }`)+"\nreturn Harness;")(async(p:string)=>p,async()=>({...header}),async()=>directory,{open:async()=>{calls.push("open");return manager;}}) as new()=>{open(o:unknown):Promise<string>};
 return {runtime:new C(),calls};
}
const expectedIdentity={id:"original",cwd:"/selected",directory:"/canonical"};
for(const changed of ["id","cwd","directory"] as const)await test(`actual child open rejects changed ${changed} before manager side effects`,async()=>{const h=openHarness({id:changed==="id"?"foreign":"original",cwd:changed==="cwd"?"/other":"/selected"},changed==="directory"?"/replacement":"/canonical");await assert.rejects(h.runtime.open({sessionFile:"/session.jsonl",expectedIdentity}),/changed/);assert.deepEqual(h.calls,[]);});
await test("child retains post-manager identity comparison and closes failure",async()=>{const h=openHarness({id:"original",cwd:"/selected"},"/canonical",{id:"foreign",cwd:"/selected"});await assert.rejects(h.runtime.open({sessionFile:"/session.jsonl",expectedIdentity}),/changed/);assert.deepEqual(h.calls,["open","close"]);});
await test("matching reopened header and legacy direct open remain valid",async()=>{for(const expected of [expectedIdentity,undefined]){const h=openHarness({id:"original",cwd:"/selected"},"/canonical");assert.equal(await h.runtime.open({sessionFile:"/session.jsonl",expectedIdentity:expected}),"attached");assert.deepEqual(h.calls,["open"]);}});
// Execute copied pure title-slot source with its actual constants, never import the SDK.
const slots=await fs.readFile(path.join(base,"primary/session-title-slot.ts"),"utf8"), entries=await fs.readFile(path.join(base,"primary/session-entries.ts"),"utf8");
const constantsBody=entries.split("\n").filter(line=>line.startsWith("export const ")).join("\n");
selected.titleSlot=slots;selected.titleConstants=constantsBody;
const pure=transpile(constantsBody.replaceAll("export ","")+slots.slice(slots.indexOf("const utf8Encoder")).replaceAll("export ",""));
const title=new Function(pure+"\nreturn {parseTitleSlotLine,serializeTitleSlot};")() as {parseTitleSlotLine(s:string):unknown;serializeTitleSlot(o:unknown):string};
const files=new Function("realpath","stat","access","constants","open","parseTitleSlotLine",transpile(helperBody.replaceAll("export ",""))+"\nreturn {requireDirectory,readSessionHeader};")(fs.realpath,fs.stat,fs.access,constants,fs.open,title.parseTitleSlotLine) as {requireDirectory(p:string):Promise<string>;readSessionHeader(p:string):Promise<{id:string;cwd:string}>};
await test("moved real FS helper preserves legacy/title-slot parsing and directory validation",async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),"worker-startup-source-"));try{const file=path.join(dir,"session.jsonl");const header={type:"session",id:"saved",cwd:dir};for(const prefix of ["",title.serializeTitleSlot({title:"雪",updatedAt:"2026-09-11"})]){await fs.writeFile(file,prefix+JSON.stringify(header)+"\n");assert.deepEqual(await files.readSessionHeader(file),{id:"saved",cwd:dir});}await assert.rejects(files.requireDirectory(file),/directory/);assert.equal(await files.requireDirectory(dir),await fs.realpath(dir));await fs.writeFile(file,'{"type":"message"}\n');await assert.rejects(files.readSessionHeader(file),/valid native identity/);}finally{await fs.rm(dir,{recursive:true,force:true});}});
console.log(JSON.stringify({passed:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,results,sourcePaths:{parentPath,nativePath},selected:Object.fromEntries(Object.entries(selected).map(([k,s])=>[k,{sha256:new Bun.CryptoHasher("sha256").update(s).digest("hex"),bytes:Buffer.byteLength(s)}])),limits:"Controlled actual maintained classes/open body and copied pure title parser with disposable FS. No Worker/SDK import/process/native/session/IPC; no OS race/atomic lease or full first-Send acceptance. Parent and native selections both vary in before comparison; helpers/current dependencies unchanged."},null,2));
if(results.some(x=>!x.ok))process.exitCode=1;
