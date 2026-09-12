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
