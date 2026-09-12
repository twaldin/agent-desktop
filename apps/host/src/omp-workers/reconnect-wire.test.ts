import { afterEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerReconnectServer, connectWorkerEndpoint } from "./reconnect-wire";

const roots: string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function until(check:()=>boolean):Promise<void>{
  for(let i=0;i<200;i++){if(check())return;await Bun.sleep(5);}
  throw new Error("Timed out waiting for reconnect fixture state");
}

test("one exact worker endpoint survives transport loss and replays its bounded outbound queue to the next authenticated owner",async()=>{
  const root=await mkdtemp(join(tmpdir(),"worker-reconnect-"));roots.push(root);
  const input={socketPath:join(root,"worker.sock"),token:randomBytes(32).toString("hex"),instanceId:randomUUID()};
  const received:unknown[]=[], first:unknown[]=[], second:unknown[]=[];
  const server=await WorkerReconnectServer.listen(input,value=>received.push(value),()=>({type:"recovered",pid:process.pid,instanceId:input.instanceId}));
  expect(server.endpoint).toEqual({version:1,pid:process.pid,...input});

  const a=await connectWorkerEndpoint(server.endpoint,value=>first.push(value),()=>{});
  await until(()=>first.length===1);
  a.send({type:"request",id:"first"});await until(()=>received.length===1);
  server.send({type:"response",id:"first",ok:true});await until(()=>first.length===2);
  a.close();await Bun.sleep(10);

  server.send({type:"response",id:"orphan",ok:true});
  const b=await connectWorkerEndpoint(server.endpoint,value=>second.push(value),()=>{});
  await until(()=>second.length===2);
  expect(second).toEqual([
    {type:"recovered",pid:process.pid,instanceId:input.instanceId},
    {type:"response",id:"orphan",ok:true},
  ]);
  b.close();await server.close();
});

test("an invalid token cannot consume the endpoint or receive queued worker traffic",async()=>{
  const root=await mkdtemp(join(tmpdir(),"worker-reconnect-auth-"));roots.push(root);
  const input={socketPath:join(root,"worker.sock"),token:randomBytes(32).toString("hex"),instanceId:randomUUID()};
  const server=await WorkerReconnectServer.listen(input,()=>{},()=>({type:"recovered",instanceId:input.instanceId}));
  const rejected:unknown[]=[];
  const wrong=await connectWorkerEndpoint({...server.endpoint,token:randomBytes(32).toString("hex")},value=>rejected.push(value),()=>{});
  await Bun.sleep(20);expect(rejected).toEqual([]);wrong.close();
  server.send({type:"kept"});
  const accepted:unknown[]=[];
  const right=await connectWorkerEndpoint(server.endpoint,value=>accepted.push(value),()=>{});
  await until(()=>accepted.length===2);
  expect(accepted).toEqual([{type:"recovered",instanceId:input.instanceId},{type:"kept"}]);
  right.close();await server.close();
});
