import { afterEach,expect,test } from "bun:test";
import { homedir,tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,writeFile } from "node:fs/promises";
import type { BrowserMetadataAvailability,CommandEnvelope } from "@agent-desktop/shared";
import { BROWSER_METADATA_OWNER_HEADER } from "@agent-desktop/shared";
import { startHost } from "./server";
import { WorkerRuntime } from "./omp-workers/runtime";
import type { WorkerReconnectEndpoint } from "./omp-workers/reconnect-wire";
import type { BrowserEvaluationBinding } from "./omp-browser/evaluation-wire";

const roots:string[]=[];const pids=new Set<number>();const hosts=new Set<Awaited<ReturnType<typeof startHost>>>();
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
async function retire(pid:number):Promise<void>{if(!alive(pid))return;try{process.kill(pid,"SIGTERM")}catch{return}for(let i=0;i<200&&alive(pid);i++)await Bun.sleep(25);if(alive(pid))try{process.kill(pid,"SIGKILL")}catch{}}
afterEach(async()=>{for(const host of hosts)await host.stop().catch(()=>{});hosts.clear();await Promise.all([...pids].map(retire));pids.clear();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function chrome():Promise<string>{if(process.env.PUPPETEER_EXECUTABLE_PATH&&(await stat(process.env.PUPPETEER_EXECUTABLE_PATH).catch(()=>undefined))?.isFile())return process.env.PUPPETEER_EXECUTABLE_PATH;for(const root of[join(homedir(),".omp/puppeteer/chrome"),join(homedir(),".cache/puppeteer/chrome")])for(const version of(await readdir(root).catch(()=>[])).sort().reverse()){const value=join(root,version,"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");if((await stat(value).catch(()=>undefined))?.isFile())return value;}throw new Error("Existing Chrome for Testing required");}
async function until<T>(read:()=>Promise<T|undefined>):Promise<T>{for(let i=0;i<1200;i++){const value=await read();if(value!==undefined)return value;await Bun.sleep(25);}throw new Error("Timed out waiting for host recovery fixture");}

test("an authenticated retry after host loss commits the exact arming browser session without recreation",async()=>{
  const root=await mkdtemp(join(tmpdir(),"browser-recovery-http-"));roots.push(root);const dataDirectory=join(root,"data"),agentDir=join(root,"agent"),cwd=join(root,"project");await Promise.all([dataDirectory,agentDir,cwd].map(path=>mkdir(path,{recursive:true,mode:0o700})));
  await writeFile(join(agentDir,"config.yml"),"browser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n",{mode:0o600});
  const pageRequests:string[]=[];const page=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){pageRequests.push(new URL(request.url).pathname);return new Response("<!doctype html><title>HTTP restart</title><script>document.cookie='restartHttp=kept';globalThis.restartHttp={count:17}</script>",{headers:{"content-type":"text/html"}});}});
  const output=join(root,"owner.json"),owner=Bun.spawn({cmd:[process.execPath,"--no-env-file",fileURLToPath(new URL("./omp-workers/fixtures/browser-recovery-host-owner.ts",import.meta.url)),root,dataDirectory,agentDir,cwd,`http://127.0.0.1:${page.port}/page`,output],cwd:process.cwd(),env:{...process.env,PI_DISABLE_DOTENV:"1",PUPPETEER_EXECUTABLE_PATH:await chrome()},stdout:"pipe",stderr:"pipe"});pids.add(owner.pid);
  type Saved={envelope:CommandEnvelope;sourcePid:number;destinationPid:number;sessionId:string;tab:{name:string;targetId:string};url:string;source:WorkerReconnectEndpoint;destination:WorkerReconnectEndpoint;binding:BrowserEvaluationBinding};
  const saved=await until(async()=>{try{return JSON.parse(await readFile(output,"utf8")) as Saved}catch{return undefined}}).catch(async error=>{console.error(await new Response(owner.stderr).text());throw error;});pids.add(saved.sourcePid);pids.add(saved.destinationPid);
  owner.kill("SIGKILL");await owner.exited;pids.delete(owner.pid);
  const host=await startHost({dataDirectory,agentDirectory:agentDir,discoveryDirectory:cwd,port:0,tailscale:false,workerPath:fileURLToPath(new URL("./omp-workers/fixtures/local-browser-worker.ts",import.meta.url))});hosts.add(host);
  const finish=host.store.finishBrowserRecoveredSession.bind(host.store);let failDurable=true;
  Object.assign(host.store,{finishBrowserRecoveredSession:(commandId:string,session:Parameters<typeof finish>[1])=>{if(failDurable){failDurable=false;throw new Error("controlled durable commit failure");}return finish(commandId,session);}});
  const response=await fetch(`${host.connection.origin}/v15/commands`,{method:"POST",headers:{authorization:`Bearer ${host.connection.token}`,"content-type":"application/json"},body:JSON.stringify(saved.envelope)});
  const failedText=await response.text();expect(response.status,failedText).toBe(200);expect(JSON.parse(failedText)).toMatchObject({ok:false,commandId:saved.envelope.id,error:{code:"OUTCOME_UNKNOWN",message:expect.stringContaining("durable commit failure")}});
  await Bun.sleep(10);const recoveredResponse=await fetch(`${host.connection.origin}/v15/commands`,{method:"POST",headers:{authorization:`Bearer ${host.connection.token}`,"content-type":"application/json"},body:JSON.stringify(saved.envelope)});
  const responseText=await recoveredResponse.text();expect(recoveredResponse.status,responseText).toBe(200);const receipt=JSON.parse(responseText);expect(receipt).toMatchObject({ok:true,commandId:saved.envelope.id,value:{id:saved.sessionId,cwd:await realpath(cwd)}});
  const repeated=await fetch(`${host.connection.origin}/v15/commands`,{method:"POST",headers:{authorization:`Bearer ${host.connection.token}`,"content-type":"application/json"},body:JSON.stringify(saved.envelope)});
  expect(await repeated.json()).toEqual(receipt);
  const metadataResponse=await fetch(`${host.connection.origin}/v1/sessions/${encodeURIComponent(saved.sessionId)}/browser-metadata`,{headers:{authorization:`Bearer ${host.connection.token}`,[BROWSER_METADATA_OWNER_HEADER]:host.connection.hostId}});
  expect(metadataResponse.status).toBe(200);const metadata=await metadataResponse.json() as BrowserMetadataAvailability;
  expect(metadata).toMatchObject({availability:"running",workerPid:saved.destinationPid,tabs:[{name:saved.tab.name,targetId:saved.tab.targetId,url:saved.url}]});
  expect(pageRequests.filter(path=>path==="/page")).toHaveLength(1);
  await host.stop();hosts.delete(host);expect(alive(saved.sourcePid)&&alive(saved.destinationPid)).toBe(true);
  const restarted=await startHost({dataDirectory,agentDirectory:agentDir,discoveryDirectory:cwd,port:0,tailscale:false,workerPath:fileURLToPath(new URL("./omp-workers/fixtures/local-browser-worker.ts",import.meta.url))});hosts.add(restarted);
  const afterRestart=await fetch(`${restarted.connection.origin}/v1/sessions/${encodeURIComponent(saved.sessionId)}/browser-metadata`,{headers:{authorization:`Bearer ${restarted.connection.token}`,[BROWSER_METADATA_OWNER_HEADER]:restarted.connection.hostId}});
  expect(afterRestart.status).toBe(200);expect(await afterRestart.json()).toMatchObject({availability:"running",workerPid:saved.destinationPid,tabs:[{name:saved.tab.name,targetId:saved.tab.targetId,url:saved.url}]});
  expect(pageRequests.filter(path=>path==="/page")).toHaveLength(1);await restarted.stop();hosts.delete(restarted);
  const cleanup=new WorkerRuntime({agentDir,workerPath:fileURLToPath(new URL("./omp-workers/fixtures/local-browser-worker.ts",import.meta.url)),startupTimeoutMs:10_000,shutdownTimeoutMs:15_000});
  const exact=await cleanup.recoverBrowserContinuation({...saved,bindings:[saved.binding]});await exact.session.dispose();await exact.closeSource();await cleanup.dispose();
  await until(async()=>!alive(saved.sourcePid)&&!alive(saved.destinationPid)?true:undefined);pids.delete(saved.sourcePid);pids.delete(saved.destinationPid);page.stop(true);
},120_000);
