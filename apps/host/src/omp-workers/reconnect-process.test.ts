import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerClient } from "./runtime";
import type { WorkerReconnectEndpoint } from "./reconnect-wire";

const roots:string[]=[];const pids=new Set<number>();
afterEach(async()=>{for(const pid of pids)try{process.kill(pid,"SIGKILL");}catch{}pids.clear();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function until<T>(read:()=>Promise<T|undefined>):Promise<T>{for(let i=0;i<400;i++){const value=await read();if(value!==undefined)return value;await Bun.sleep(10);}throw new Error("Timed out waiting for recovery fixture");}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

test("an actual owner-process crash leaves the exact worker reconnectable, while explicit disposal retires it",async()=>{
  const root=await mkdtemp(join(tmpdir(),"worker-process-recovery-"));roots.push(root);
  const output=join(root,"endpoint.json"),socketPath=join(root,"worker.sock");
  const owner=Bun.spawn({cmd:[process.execPath,"--no-env-file",fileURLToPath(new URL("./fixtures/reconnect-host-owner.ts",import.meta.url)),output,socketPath],
    cwd:process.cwd(),env:{...process.env,PI_DISABLE_DOTENV:"1"},stdout:"pipe",stderr:"pipe"});
  pids.add(owner.pid);
  const endpoint=await until(async()=>{try{return JSON.parse(await readFile(output,"utf8")) as WorkerReconnectEndpoint;}catch{return undefined;}});
  pids.add(endpoint.pid);expect(alive(endpoint.pid)).toBe(true);
  owner.kill("SIGKILL");await owner.exited;pids.delete(owner.pid);
  await until(async()=>alive(endpoint.pid)?true:undefined);

  const recovered=await WorkerClient.recover({workerPath:fileURLToPath(new URL("./entry.ts",import.meta.url)),startupTimeoutMs:10_000,shutdownTimeoutMs:3_000,
    environment:{...process.env,PI_DISABLE_DOTENV:"1"}},endpoint);
  expect(recovered.pid).toBe(endpoint.pid);
  await expect(recovered.request({operation:"getBrowserMetadata"},3_000)).rejects.toThrow("no initialized session");
  await recovered.close();
  await until(async()=>alive(endpoint.pid)?undefined:true);pids.delete(endpoint.pid);
},20_000);
