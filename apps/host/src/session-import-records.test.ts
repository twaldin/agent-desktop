import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostStore } from "./store";
import { OriginalImportRecords, type OriginalImportBinding } from "./session-import-records";
import type { SessionSummary } from "@agent-desktop/shared";
const original: OriginalImportBinding = {protocol:1,enrollmentId:"enrollment",registryId:"registry",nativeId:"native-original",originalFile:"/profile/original.jsonl",recordedCwd:"/project",canonicalCwd:"/project"};
const summary = (store: HostStore): SessionSummary => ({id:original.nativeId,hostId:store.host.id,projectId:null,cwd:original.recordedCwd,sessionFile:original.originalFile,title:"Original history",model:null,status:"idle",createdAt:1,updatedAt:2,archived:false});
test("original import reserves before publication, commits binding with catalog, and preserves it through reopen", async () => {
  const root=await mkdtemp(join(tmpdir(),"original-import-records-"));let store=new HostStore(join(root,"host.sqlite"));
  try {
    let records=new OriginalImportRecords(store);
    const input={...original};records.reserve("import-command",input);input.originalFile="/replacement";
    expect(store.getSession(original.nativeId)).toBeUndefined();
    expect(()=>records.bindingForSession(original.nativeId)).toThrow("recovery");
    expect(()=>records.reserve("second-command",original)).toThrow("retained import");
    expect(()=>records.reserve("import-command",{...original,nativeId:"replacement"})).toThrow("another original");
    expect(records.publish("import-command",original,summary(store))).toMatchObject({id:original.nativeId,sessionFile:original.originalFile});
    const bound=records.bindingForSession(original.nativeId)!;bound.enrollmentId="caller-mutated";
    expect(records.bindingForSession(original.nativeId)).toEqual(original);
    store.close();store=new HostStore(join(root,"host.sqlite"));records=new OriginalImportRecords(store);
    expect(records.read("import-command")?.state).toBe("admitted");
    expect(records.bindingForSession(original.nativeId)).toEqual(original);
    store.upsertSession({...summary(store),title:"Later native title"});
    expect(records.publish("import-command",original,summary(store)).title).toBe("Later native title");
    expect(()=>records.publish("import-command",{...original,enrollmentId:"replacement"},summary(store))).toThrow("changed");
  } finally {store.close();await rm(root,{recursive:true,force:true})}
});
test("catalog collisions and uncertain admission never authorize replacement or ordinary reopen", async () => {
  const root=await mkdtemp(join(tmpdir(),"original-import-records-")),store=new HostStore(join(root,"host.sqlite"));
  try {
    const records=new OriginalImportRecords(store);records.reserve("pending",original);
    store.upsertSession({...summary(store),sessionFile:"/different.jsonl"});
    expect(()=>records.publish("pending",original,summary(store))).toThrow("replace");
    expect(store.getSession(original.nativeId)?.sessionFile).toBe("/different.jsonl");
    expect(records.read("pending")?.state).toBe("reserved");
    records.settleFailure("pending","unknown","Worker completion unconfirmed");
    expect(()=>records.bindingForSession(original.nativeId)).toThrow("recovery");
    expect(()=>records.settleFailure("pending","refused","assume no effects")).toThrow("uncertain");
    expect(()=>records.reserve("new",original)).toThrow("retained import");
    expect(records.bindingForSession("unrelated-session")).toBeUndefined();
  } finally {store.close();await rm(root,{recursive:true,force:true})}
});
test("proven pre-admission refusal permits a fresh explicit command without erasing its old receipt", async () => {
  const root=await mkdtemp(join(tmpdir(),"original-import-records-")),store=new HostStore(join(root,"host.sqlite"));
  try {
    const records=new OriginalImportRecords(store);records.reserve("refused",original);records.settleFailure("refused","refused","External enrolled writer still owns the file");
    records.reserve("fresh-explicit-command",original);
    expect(records.read("refused")?.state).toBe("refused");
    expect(records.read("fresh-explicit-command")?.state).toBe("reserved");
    expect(()=>records.bindingForSession(original.nativeId)).toThrow("recovery");
  } finally {store.close();await rm(root,{recursive:true,force:true})}
});
