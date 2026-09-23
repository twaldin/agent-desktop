import {expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HostStore} from "./store";
import {OriginalImportRecords,type OriginalImportBinding} from "./session-import-records";
import {SessionImportActions,type OriginalAdmissionPort} from "./session-import-actions";
import type {WorkerSession} from "./omp-workers/runtime";
const gate=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{resolve,promise}};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"import-actions-")),store=new HostStore(root),records=new OriginalImportRecords(store);
  const binding:OriginalImportBinding={protocol:1,enrollmentId:"enrollment",registryId:"registry",nativeId:"original",originalFile:join(root,"original.jsonl"),recordedCwd:root,canonicalCwd:root};
  // This metadata-only worker port is deliberately controlled. Actual ownership
  // and worker IPC have their own native integration fixtures.
  const handle={id:binding.nativeId,sessionFile:binding.originalFile,cwd:root,title:"Original",model:null,createdAt:1} as unknown as WorkerSession;
  const held=gate<void>();let calls=0,current=true,retains=0,status:Awaited<ReturnType<OriginalAdmissionPort["status"]>>={commandId:"command",state:"absent"};
  const admission:OriginalAdmissionPort={
    prepare:async()=>({ok:true,preparationId:"preparation",binding,source:binding}),
    admit:async input=>{calls++;records.reserve(input.commandId,binding);status={commandId:input.commandId,state:"pending",binding};await held.promise;status={commandId:input.commandId,state:"admitted",binding};return{status,handle}},
    status:async()=>status,getRetainedHandle:()=>current?handle:undefined,
  };
  const actions=new SessionImportActions({hostId:store.host.id,admission,records,retain(value){expect(value).toBe(handle);retains++}});
  return{root,store,records,binding,handle,held,actions,admission,lose:()=>current=false,calls:()=>calls,retains:()=>retains,close:async()=>{held.resolve();await actions.dispose();store.close();await rm(root,{recursive:true,force:true})}};
}
test("native admission and catalog publication stay ordered; duplicates join and status never opens a worker",async()=>{
  const f=await fixture();try{
    expect(await f.actions.prepare("candidate","revision")).toMatchObject({state:"ready",original:{sessionId:"original"}});
    const first=f.actions.admit("command","preparation");await Promise.resolve();await Promise.resolve();
    const duplicate=f.actions.admit("command","preparation");
    expect(await f.actions.admit("command","different")).toMatchObject({state:"refused",reason:"request-conflict"});
    expect(await f.actions.status("command")).toMatchObject({state:"pending"});expect(f.store.getSession("original")).toBeUndefined();
    f.held.resolve();expect(await first).toMatchObject({state:"imported",original:{sessionId:"original",originalFile:f.binding.originalFile}});expect(await duplicate).toEqual(await first);
    expect(f.calls()).toBe(1);expect(f.retains()).toBe(1);expect(f.records.bindingForSession("original")).toEqual(f.binding);
    f.lose();expect(await f.actions.status("command")).toMatchObject({state:"imported"});expect(f.calls()).toBe(1);
  }finally{await f.close()}
});
test("an admitted receipt without the exact retained worker remains unknown, including a new action owner",async()=>{
  const f=await fixture();try{
    f.lose();f.held.resolve();expect(await f.actions.admit("command","preparation")).toMatchObject({state:"unknown"});
    expect(f.store.getSession("original")).toBeUndefined();expect(await f.actions.status("command")).toMatchObject({state:"unknown"});
    const cold=new SessionImportActions({hostId:f.store.host.id,admission:f.admission,records:f.records,retain(){throw Error("No cold worker may be acquired")}});
    expect(await cold.status("command")).toMatchObject({state:"unknown"});expect(f.calls()).toBe(1);await cold.dispose();
  }finally{await f.close()}
});
test("shutdown cancels pre-dispatch work and joins an already dispatched admission without publishing late",async()=>{
  const untouched=await fixture();try{
    const work=untouched.actions.admit("command","preparation"),closed=untouched.actions.dispose();
    expect(await work).toMatchObject({state:"refused",reason:"stopping"});await closed;expect(untouched.calls()).toBe(0);
  }finally{await untouched.close()}
  const f=await fixture();try{
    const work=f.actions.admit("command","preparation");await Promise.resolve();await Promise.resolve();
    let closed=false;const drain=f.actions.dispose().then(()=>closed=true);await Promise.resolve();expect(closed).toBe(false);
    f.held.resolve();expect(await work).toMatchObject({state:"unknown"});await drain;expect(closed).toBe(true);
    expect(f.store.getSession("original")).toBeUndefined();expect(f.retains()).toBe(0);
  }finally{await f.close()}
});
