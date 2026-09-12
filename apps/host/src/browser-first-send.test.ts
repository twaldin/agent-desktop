import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserFirstSend } from "./browser-first-send";
import { HostStore } from "./store";
import type { BrowserCreateRequest, DraftBrowserContinuation } from "@agent-desktop/shared";
import type { WorkerSession } from "./omp-workers/runtime";
import type { DraftBrowserWorkers, DraftBrowserHandle } from "./browser-draft-workers";

const roots:string[]=[]; const stores:HostStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const request:BrowserCreateRequest={requestId:"page-one",controlEpoch:"epoch-one",observedAt:1000,initialUrl:"https://example.invalid"};
function fixture(backend:"worker"|"cmux"="worker"){
 const root=realpathSync(mkdtempSync(join(tmpdir(),"browser-first-send-")));roots.push(root);const store=new HostStore(root);stores.push(store);
 const saved=store.putDraft({id:"draft",text:"send",projectId:null,model:null},0);if(!saved.ok)throw new Error("draft");
 const owner={hostId:store.host.id,ownerId:"owner",draftId:"draft",draftRevision:1};store.draftBrowserOwners.claim({id:owner.ownerId,draftId:owner.draftId,draftRevision:1,projectId:null,cwd:root});
 store.draftBrowserCreations.claim(owner.ownerId,request);store.draftBrowserCreations.finish(owner.ownerId,request,{protocolVersion:1,ownerKind:"draft",hostId:store.host.id,ownerId:owner.ownerId,requestId:request.requestId,outcome:"completed",workerPid:42,targetDisposition:backend==="worker"?"created-page":"created-surface",tab:{name:"desktop-page-one",targetId:"target",backend,kindTag:backend==="worker"?"headless":"cmux",state:"alive",url:"https://example.invalid",viewport:{width:640,height:480}}});
 const calls:string[]=[];const evaluation=backend==="worker"?{backend:"cdp" as const,descriptor:{version:1 as const,channel:"channel",targetId:"target",activateForScreenshot:false},start:async()=>{},receive:()=>{},dispose:async()=>{calls.push("dispose")}}:{backend:"cmux" as const,state:{surfaceId:"target"},request:async()=>({}),dispose:async()=>{calls.push("dispose")}};
 const source={id:"owner",cwd:root,workerPid:42,reserveBrowserEvaluation:async()=>{calls.push("reserve");return{workerPid:42,name:"desktop-page-one",targetId:"target",ownerId:"owner",operationId:"ignored",phase:"ready" as const}},openBrowserEvaluation:async()=>{calls.push("open");return evaluation}} as unknown as DraftBrowserHandle;
 const workers={inspect:()=>({state:"ready" as const,workerPid:42}),getExisting:async()=>source} as unknown as DraftBrowserWorkers;
 const destination={id:"session",installBrowserContinuation:async(input:unknown,actual:unknown)=>{calls.push("install");expect(actual).toBe(evaluation);expect(input).toMatchObject({sourceOwnerId:"owner",target:{workerPid:42,name:"desktop-page-one",targetId:"target"}})}} as unknown as WorkerSession;
 const continuation:DraftBrowserContinuation={version:1,owner:{ownerId:"owner",draftId:"draft",draftRevision:1},pages:[{request,target:{workerPid:42,name:"desktop-page-one",targetId:"target"},backend,kindTag:backend==="worker"?"headless":"cmux"}]};
 return{root,store,calls,workers,destination,continuation};
}
for(const backend of ["worker","cmux"] as const)test(`retains exact ${backend} evaluator without recreating its browser`,async()=>{const f=fixture(backend),service=new BrowserFirstSend(f.store,f.workers);const receipt=await service.attach("command",{id:"draft",revision:1},f.continuation,f.destination);expect(f.calls).toEqual(["reserve","open","install"]);expect(receipt).toMatchObject({version:1,ownerId:"owner",sessionId:"session",pages:[{name:"desktop-page-one",targetId:"target",backend}]});});

test("rejects stale durable page identity before native reservation",async()=>{const f=fixture();f.continuation.pages[0]!.target.targetId="changed";await expect(new BrowserFirstSend(f.store,f.workers).attach("command",{id:"draft",revision:1},f.continuation,f.destination)).rejects.toThrow("durable creation receipt");expect(f.calls).toEqual([]);});

test("a post-reservation destination failure is unknown and never retries",async()=>{const f=fixture();let installs=0;const destination={...f.destination,installBrowserContinuation:async()=>{installs++;throw new Error("lost reply")}} as WorkerSession;const service=new BrowserFirstSend(f.store,f.workers);await expect(service.attach("same-command",{id:"draft",revision:1},f.continuation,destination)).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});await expect(service.attach("same-command",{id:"draft",revision:1},f.continuation,destination)).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});expect(installs).toBe(1);expect(f.calls.filter(x=>x==="reserve")).toHaveLength(1);});

test("restart projects a retained live binding as unavailable without browser replay",()=>{const f=fixture();const command={type:"session.create" as const,projectId:null,draft:{id:"draft",revision:1},browserContinuation:f.continuation};f.store.claimCommand("command","hash",command);f.store.upsertSession({id:"session",hostId:f.store.host.id,projectId:null,cwd:f.root,title:"New conversation",status:"idle",sessionFile:join(f.root,"session.jsonl"),model:null,createdAt:1,updatedAt:1,archived:false});f.store.recordBrowserContinuation({commandId:"command",sessionId:"session",ownerId:"owner",pages:[{name:"desktop-page-one",targetId:"target",backend:"worker",operationId:"operation"}]});f.store.close();stores.splice(stores.indexOf(f.store),1);const reopened=new HostStore(f.root);stores.push(reopened);expect(reopened.getSession("session")).toMatchObject({status:"error",error:expect.stringContaining("not reacquired")});expect(reopened.getCommand("command")?.state).toBe("pending");});

test("a recovery-capable handoff durably fences both exact worker instances and legacy receipt persistence cannot erase it",async()=>{
  const f=fixture(),command={type:"session.create" as const,projectId:null,draft:{id:"draft",revision:1},browserContinuation:f.continuation};
  f.store.claimCommand("recovery-command","hash",command);
  const enabled:string[]=[],transferred:number[]=[];
  const source=await f.workers.getExisting({hostId:f.store.host.id,ownerId:"owner",draftId:"draft",draftRevision:1});
  Object.assign(source!,{enableBrowserRecovery:async(socketPath:string,token:string,instanceId:string)=>{enabled.push("source");return{version:1 as const,pid:42,socketPath,token,instanceId};}});
  Object.assign(f.workers,{transferToRecovery:(_owner:unknown,pid:number)=>transferred.push(pid)});
  Object.assign(f.destination,{workerPid:84,enableBrowserRecovery:async(socketPath:string,token:string,instanceId:string)=>{enabled.push("destination");return{version:1 as const,pid:84,socketPath,token,instanceId};}});
  const receipt=await new BrowserFirstSend(f.store,f.workers,join(f.root,"recovery")).attach("recovery-command",{id:"draft",revision:1},f.continuation,f.destination);
  expect(enabled.sort()).toEqual(["destination","source"]);expect(transferred).toEqual([42]);
  const saved=f.store.listBrowserRecoveries()[0]!;expect(saved).toMatchObject({status:"ready",commandId:"recovery-command",sessionId:"session",source:{pid:42},destination:{pid:84}});
  expect(saved.source.instanceId).not.toBe(saved.destination.instanceId);expect(saved.source.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  expect(()=>f.store.recordBrowserRecovery({...saved,source:{...saved.source,instanceId:crypto.randomUUID()}})).toThrow("durable native owner");
  expect(()=>f.store.recordBrowserRecovery({...saved,status:"arming"})).toThrow("durable native owner");
  f.store.recordBrowserContinuation({commandId:"recovery-command",...receipt!});
  expect(f.store.listBrowserRecoveries()[0]).toEqual(saved);
});

test("a recovered native session and its original creation receipt commit together",()=>{
  const f=fixture(),command={type:"session.create" as const,projectId:null,draft:{id:"draft",revision:1},browserContinuation:f.continuation};
  f.store.claimCommand("recover-create","recover-hash",command);
  f.store.recordBrowserRecovery({version:2,hostId:f.store.host.id,commandId:"recover-create",sessionId:"recovered-session",ownerId:"owner",status:"ready",
    source:{version:1,pid:42,instanceId:crypto.randomUUID(),socketPath:join(f.root,"source.sock"),token:"a".repeat(64)},
    destination:{version:1,pid:84,instanceId:crypto.randomUUID(),socketPath:join(f.root,"destination.sock"),token:"b".repeat(64)},
    bindings:[{workerPid:42,name:"desktop-page-one",targetId:"target",ownerId:"owner",operationId:"operation",backend:"cdp"}],recordedAt:1});
  const session={id:"recovered-session",hostId:f.store.host.id,projectId:null,cwd:f.root,title:"Recovered",status:"idle" as const,
    sessionFile:join(f.root,"recovered.jsonl"),model:null,createdAt:1,updatedAt:2,archived:false};
  const result=f.store.finishBrowserRecoveredSession("recover-create",session);
  expect(result).toMatchObject({ok:true,commandId:"recover-create",value:{id:"recovered-session",cwd:f.root}});
  expect(f.store.getCommand("recover-create")).toMatchObject({state:"done",result});
  expect(f.store.getSession("recovered-session")).toMatchObject({id:"recovered-session",status:"idle"});
  expect(f.store.listBrowserRecoveries()).toHaveLength(1);
});
