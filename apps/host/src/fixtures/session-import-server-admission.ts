import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const originalFetch=globalThis.fetch.bind(globalThis);
let blockedParentFetches=0;
globalThis.fetch=Object.assign(async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.hostname!=="127.0.0.1"){blockedParentFetches++;throw new Error("Fixture outbound transport disabled");}
  return originalFetch(input,init);
},{preconnect(){throw new Error("Fixture preconnect disabled");}}) as typeof fetch;
const {createCooperativeOriginal,observeEnrolledOriginal,openAdmittedOriginal}=await import("@oh-my-pi/pi-coding-agent/session/original-session-ownership");
const {getSessionsDir}=await import("@oh-my-pi/pi-utils");
const {startHost}=await import("../server");
const {requestNativeImportListing,requestNativeImportInspection,requestNativeImportPreparation,requestNativeImportAdmission,requestNativeImportStatus}=await import("../../../desktop/src/main/session-import-transport");
const root=await realpath(process.argv[2]!);
const agentDirectory=join(root,"agent"),cwd=join(root,"project"),dataDirectory=join(root,"host");
await Promise.all([agentDirectory,cwd].map(path=>mkdir(path,{recursive:true})));
await writeFile(join(agentDirectory,"config.yml"),"extensions: []\nretry:\n  enabled: false\n");
const sessionDirectory=join(getSessionsDir(agentDirectory),"--original-project--"),ownershipDirectory=join(agentDirectory,"original-session-ownership");
await mkdir(sessionDirectory,{recursive:true});
const workerPath=join(root,"blocked-worker.ts");
await writeFile(workerPath,`globalThis.fetch=Object.assign(async()=>{throw Error('Fixture worker outbound disabled')},{preconnect(){throw Error('Fixture worker preconnect disabled')}});await import(${JSON.stringify(fileURLToPath(new URL("../omp-workers/entry.ts",import.meta.url)))});`);
const created=await createCooperativeOriginal({ownershipDirectory,cwd,sessionDirectory});
const binding=created.binding;
created.manager.appendMessage({role:"user",content:"Keep this exact original history",timestamp:1});
await created.manager.ensureOnDisk();await created.manager.flush();
let writer:typeof created.manager|undefined=created.manager;
let host:Awaited<ReturnType<typeof startHost>>|undefined;
const options={agentDirectory,dataDirectory,discoveryDirectory:cwd,workerPath,port:0,tailscale:false};
const endpoint=()=>({origin:host!.connection.origin,hostId:host!.store.host.id,token:host!.connection.token});
const signal=new AbortController().signal;
const prepare=async()=>{
  const listing=await requestNativeImportListing(endpoint(),signal);
  const candidate=listing.candidates.find(row=>row.nativeId===binding.nativeId);assert.ok(candidate);
  const inspection=await requestNativeImportInspection(endpoint(),candidate.candidateId,signal);
  assert.equal(inspection.inspection.originalFile,binding.originalFile);
  const result=await requestNativeImportPreparation(endpoint(),{candidateId:candidate.candidateId,revision:inspection.inspection.revision},signal);
  if(result.state!=="ready")throw new Error(result.message);
  return result;
};
const messages=async()=>{
  const current=endpoint();
  const response=await fetch(current.origin+"/v1/sessions/"+encodeURIComponent(binding.nativeId)+"/messages",{headers:{Authorization:"Bearer "+current.token}});
  return {status:response.status,body:await response.json()};
};
try {
  host=await startHost(options);
  const before=await readFile(binding.originalFile);
  const busy=await prepare();
  assert.deepEqual(await readFile(binding.originalFile),before,"Preparation must preserve original bytes");
  const refused=await requestNativeImportAdmission(endpoint(),{commandId:"held-original",preparationId:busy.preparationId},signal);
  assert.equal(refused.state,"refused",JSON.stringify(refused));
  assert.equal(host.store.getSession(binding.nativeId),undefined);
  assert.deepEqual(await readFile(binding.originalFile),before);
  writer.seal();await writer.close();writer=undefined;
  const prepared=await prepare(),command={commandId:"import-original",preparationId:prepared.preparationId};
  const imported=await requestNativeImportAdmission(endpoint(),command,signal);
  assert.equal(imported.state,"imported",JSON.stringify(imported));
  assert.deepEqual(await requestNativeImportStatus(endpoint(),command.commandId,signal),imported);
  assert.deepEqual(await requestNativeImportAdmission(endpoint(),command,signal),imported);
  assert.equal(host.store.getSession(binding.nativeId)?.sessionFile,binding.originalFile);
  const live=await messages();assert.equal(live.status,200,JSON.stringify(live.body));assert.match(JSON.stringify(live.body),/Keep this exact original history/);
  await assert.rejects(openAdmittedOriginal({ownershipDirectory,binding,source:await observeEnrolledOriginal(ownershipDirectory,binding),commandId:"foreign-while-imported"}));
  await host.stop();host=undefined;
  // After a full host stop, the released original can have a cooperating writer.
  // Catalog recovery must not route through ordinary runtime.open and bypass it.
  writer=await openAdmittedOriginal({ownershipDirectory,binding,source:await observeEnrolledOriginal(ownershipDirectory,binding),commandId:"external-after-stop"});
  host=await startHost(options);
  assert.deepEqual(await requestNativeImportStatus(endpoint(),command.commandId,signal),imported,"Receipt lookup must not reopen the writer");
  const held=await messages();assert.equal(held.status,400,JSON.stringify(held.body));
  assert.equal(host.store.getSession(binding.nativeId)?.sessionFile,binding.originalFile);
  writer.seal();await writer.close();writer=undefined;
  const resumed=await messages();assert.equal(resumed.status,200,JSON.stringify(resumed.body));assert.match(JSON.stringify(resumed.body),/Keep this exact original history/);
  assert.equal(host.store.getSession(binding.nativeId)?.id,binding.nativeId);
  assert.equal(blockedParentFetches,0);
  console.log(JSON.stringify({busyRefused:true,exactOriginalImported:true,savedOutcomeNoReplay:true,coldReopenRespectsWriter:true,releasedOriginalResumes:true}));
} finally {
  if(writer){writer.seal();await writer.close();}
  await host?.stop();
}
