import { afterEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBrowserRecoveryRecord } from "../browser-recovery-record";
import { WorkerReconnectServer, connectWorkerEndpoint, parseWorkerResetPolicyReconnect, type WorkerResetPolicyReconnect } from "./reconnect-wire";

const roots: string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
function afterFrames(count:number):{frames:unknown[];receive(value:unknown):void;done:Promise<void>}{
  const frames:unknown[]=[];const done=Promise.withResolvers<void>();
  return {frames,done:done.promise,receive:value=>{frames.push(value);if(frames.length===count)done.resolve();}};
}
const binding:WorkerResetPolicyReconnect={workerEpoch:randomUUID(),rootSessionId:"session-root-1",sessionFile:"/tmp/original/session.jsonl",cwd:"/tmp/original"};

test("the original reset binding survives socket serialization and only its authenticated owner sees the disconnect lifecycle",async()=>{
  const root=await mkdtemp(join(tmpdir(),"worker-reconnect-reset-"));roots.push(root);
  const input={socketPath:join(root,"worker.sock"),token:randomBytes(32).toString("hex"),instanceId:randomUUID(),resetPolicy:{...binding,extra:"dropped"}};
  let disconnects=0;const lost=Promise.withResolvers<void>();
  const server=await WorkerReconnectServer.listen(input,()=>{},()=>({type:"recovered",instanceId:input.instanceId,resetPolicy:server.endpoint.resetPolicy}),()=>{disconnects+=1;lost.resolve();});
  expect(server.endpoint.resetPolicy).toEqual(binding);
  expect(Object.isFrozen(server.endpoint)).toBe(true);expect(Object.isFrozen(server.endpoint.resetPolicy)).toBe(true);
  expect(server.connected).toBe(false);

  const rejected:unknown[]=[];const wrongClosed=Promise.withResolvers<void>();
  await connectWorkerEndpoint({...server.endpoint,token:randomBytes(32).toString("hex")},value=>rejected.push(value),()=>wrongClosed.resolve());
  await wrongClosed.promise;
  expect(rejected).toEqual([]);expect(disconnects).toBe(0);expect(server.connected).toBe(false);

  server.send({type:"resetPolicy",id:"retained"});
  const seen=afterFrames(2);
  const owner=await connectWorkerEndpoint(server.endpoint,seen.receive,()=>{});
  await seen.done;
  expect(seen.frames).toEqual([{type:"recovered",instanceId:input.instanceId,resetPolicy:binding},{type:"resetPolicy",id:"retained"}]);
  expect(server.connected).toBe(true);
  owner.close();await lost.promise;
  expect(server.connected).toBe(false);

  await server.close();expect(disconnects).toBe(1);
});

test("a present but malformed reset binding fails instead of downgrading to an ownerless endpoint",async()=>{
  const root=await mkdtemp(join(tmpdir(),"worker-reconnect-reset-bad-"));roots.push(root);
  const base={socketPath:join(root,"worker.sock"),token:randomBytes(32).toString("hex"),instanceId:randomUUID()};
  for(const resetPolicy of [null,{...binding,workerEpoch:""},{...binding,rootSessionId:undefined},{...binding,sessionFile:"relative/session.jsonl"},{...binding,cwd:"/tmp/\0"},{...binding,workerEpoch:"x".repeat(513)}])
    await expect(WorkerReconnectServer.listen({...base,resetPolicy:resetPolicy as never},()=>{},()=>({}))).rejects.toThrow("Invalid worker reset-policy reconnect binding.");
  expect(()=>parseWorkerResetPolicyReconnect(binding)).not.toThrow();
  const ownerless=await WorkerReconnectServer.listen(base,()=>{},()=>({}));
  expect("resetPolicy" in ownerless.endpoint).toBe(false);
  await ownerless.close();
});

test("durable recovery records keep and freeze a nested reset binding and reject a malformed one",()=>{
  const endpoint=(pid:number)=>({version:1 as const,pid,instanceId:randomUUID(),socketPath:"/tmp/worker.sock",token:randomBytes(32).toString("hex")});
  const record={version:2 as const,hostId:"host",commandId:"command",sessionId:"session",ownerId:"owner",status:"ready" as const,
    source:{...endpoint(11),resetPolicy:binding},destination:endpoint(12),
    bindings:[{workerPid:11,name:"tab",targetId:"target",ownerId:"owner",operationId:"op",backend:"cdp" as const}],recordedAt:1};
  const parsed=parseBrowserRecoveryRecord(JSON.parse(JSON.stringify(record)));
  expect(parsed.source.resetPolicy).toEqual(binding);
  expect(Object.isFrozen(parsed.source.resetPolicy)).toBe(true);
  expect("resetPolicy" in parsed.destination).toBe(false);
  expect(()=>parseBrowserRecoveryRecord({...record,source:{...record.source,resetPolicy:{...binding,cwd:"relative"}}})).toThrow("Invalid worker reset-policy reconnect binding.");
});
