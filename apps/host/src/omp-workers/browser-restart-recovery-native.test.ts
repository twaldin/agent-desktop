import { afterEach, expect, test } from "bun:test";
import { homedir,tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile } from "node:fs/promises";
import { WorkerRuntime } from "./runtime";
import type { WorkerReconnectEndpoint } from "./reconnect-wire";
import type { BrowserEvaluationBinding } from "../omp-browser/evaluation-wire";

const roots:string[]=[];const pids=new Set<number>();
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
async function retire(pid:number):Promise<void>{if(!alive(pid))return;try{process.kill(pid,"SIGTERM")}catch{return}for(let i=0;i<200&&alive(pid);i++)await Bun.sleep(25);if(alive(pid))try{process.kill(pid,"SIGKILL")}catch{}}
afterEach(async()=>{await Promise.all([...pids].map(retire));pids.clear();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function chrome():Promise<string>{if(process.env.PUPPETEER_EXECUTABLE_PATH&&(await stat(process.env.PUPPETEER_EXECUTABLE_PATH).catch(()=>undefined))?.isFile())return process.env.PUPPETEER_EXECUTABLE_PATH;for(const root of[join(homedir(),".omp/puppeteer/chrome"),join(homedir(),".cache/puppeteer/chrome")])for(const version of(await readdir(root).catch(()=>[])).sort().reverse()){const value=join(root,version,"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");if((await stat(value).catch(()=>undefined))?.isFile())return value;}throw new Error("Existing Chrome for Testing required");}
async function until<T>(read:()=>Promise<T|undefined>):Promise<T>{for(let i=0;i<1200;i++){const value=await read();if(value!==undefined)return value;await Bun.sleep(25);}throw new Error("Timed out waiting for native recovery fixture");}

test("an actual host-owner crash reattaches the exact native CDP document without recreation",async()=>{
  const root=await mkdtemp(join(tmpdir(),"browser-restart-native-"));roots.push(root);const agentDir=join(root,"agent"),cwd=join(root,"project");await Promise.all([agentDir,cwd].map(path=>mkdir(path,{recursive:true,mode:0o700})));
  const extension=fileURLToPath(new URL("./fixtures/browser-continuation-extension.ts",import.meta.url));
  await writeFile(join(agentDir,"config.yml"),`extensions:\n  - ${JSON.stringify(extension)}\nbrowser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n`,{mode:0o600});
  const requests:string[]=[];const page=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){requests.push(new URL(request.url).pathname);return new Response("<!doctype html><title>Restart retained page</title><button onclick='browserFrameState.count++'>Count</button><script>document.cookie='restart=kept';globalThis.browserFrameState={token:'same-process-document',count:41}</script>",{headers:{"content-type":"text/html"}});}});
  const output=join(root,"owner.json"),url=`http://127.0.0.1:${page.port}/page`;
  const owner=Bun.spawn({cmd:[process.execPath,"--no-env-file",fileURLToPath(new URL("./fixtures/browser-recovery-owner.ts",import.meta.url)),root,agentDir,cwd,url,output],cwd:process.cwd(),env:{...process.env,PI_DISABLE_DOTENV:"1",PUPPETEER_EXECUTABLE_PATH:await chrome()},stdout:"pipe",stderr:"pipe"});pids.add(owner.pid);
  type Saved={source:WorkerReconnectEndpoint;destination:WorkerReconnectEndpoint;sessionId:string;binding:BrowserEvaluationBinding;tab:{name:string;targetId:string};url:string};
  const saved=await until(async()=>{try{return JSON.parse(await readFile(output,"utf8")) as Saved}catch{return undefined}});pids.add(saved.source.pid);pids.add(saved.destination.pid);
  owner.kill("SIGKILL");await owner.exited;pids.delete(owner.pid);
  const runtime=new WorkerRuntime({agentDir,workerPath:fileURLToPath(new URL("./fixtures/local-browser-worker.ts",import.meta.url)),environment:{...process.env,HOME:root,PI_CODING_AGENT_DIR:agentDir,PI_DISABLE_DOTENV:"1",PUPPETEER_EXECUTABLE_PATH:await chrome(),PI_BROWSER_CMUX:"0",PI_BROWSER_RELAY:"0"}});
  try{
    const recovered=await runtime.recoverBrowserContinuation({...saved,bindings:[saved.binding]});
    const destination=recovered.session,metadata=await destination.getBrowserMetadata();
    expect(destination.workerPid).toBe(saved.destination.pid);expect(metadata).toMatchObject({availability:"running",workerPid:saved.destination.pid,tabs:[{name:saved.tab.name,targetId:saved.tab.targetId,url}]});
    const frame=await destination.getBrowserFrame({workerPid:destination.workerPid,...saved.tab});if(!frame.context)throw new Error("Recovered frame omitted context");
    await destination.controlBrowser({requestId:crypto.randomUUID(),controlEpoch:"restart",capturedAt:Date.now(),target:{workerPid:destination.workerPid,...saved.tab},context:frame.context,action:{type:"click",x:10,y:10}});
    const run=destination.startPrompt(`/inspect-retained-browser-contract ${saved.tab.name}`);await run.accepted;await run.completion;
    const entries=(await readFile(destination.sessionFile,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(entries.find(entry=>entry.customType==="browser-continuation-contract")?.data).toMatchObject({url,title:"Restart retained page",state:{token:"same-process-document",count:42},cookie:expect.stringContaining("restart=kept")});
    expect(requests.filter(path=>path==="/page")).toHaveLength(1);
    await destination.dispose();await recovered.closeSource();pids.delete(saved.source.pid);pids.delete(saved.destination.pid);
  }finally{await runtime.dispose();page.stop(true);}
},120_000);

test("a crash with an admitted native browser request reports unknown and never replays or substitutes it",async()=>{
  const root=await mkdtemp(join(tmpdir(),"browser-restart-inflight-"));roots.push(root);const agentDir=join(root,"agent"),cwd=join(root,"project");await Promise.all([agentDir,cwd].map(path=>mkdir(path,{recursive:true,mode:0o700})));
  const extension=fileURLToPath(new URL("./fixtures/browser-continuation-extension.ts",import.meta.url));
  await writeFile(join(agentDir,"config.yml"),`extensions:\n  - ${JSON.stringify(extension)}\nbrowser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n`,{mode:0o600});
  const requests:string[]=[];const page=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){const path=new URL(request.url).pathname;requests.push(path);if(path==="/started")return new Response("started");return new Response("<!doctype html><title>Held request</title><script>globalThis.browserFrameState={count:1}</script>",{headers:{"content-type":"text/html"}});}});
  const output=join(root,"owner.json"),arm=join(root,"armed"),url=`http://127.0.0.1:${page.port}/page`,executable=await chrome();
  const owner=Bun.spawn({cmd:[process.execPath,"--no-env-file",fileURLToPath(new URL("./fixtures/browser-recovery-owner.ts",import.meta.url)),root,agentDir,cwd,url,output,arm],cwd:process.cwd(),env:{...process.env,PI_DISABLE_DOTENV:"1",PUPPETEER_EXECUTABLE_PATH:executable},stdout:"pipe",stderr:"pipe"});pids.add(owner.pid);
  type Saved={source:WorkerReconnectEndpoint;destination:WorkerReconnectEndpoint;sessionId:string;binding:BrowserEvaluationBinding};
  const saved=await until(async()=>{try{return JSON.parse(await readFile(output,"utf8")) as Saved}catch{return undefined}});pids.add(saved.source.pid);pids.add(saved.destination.pid);
  await until(async()=>{try{return(await readFile(arm,"utf8"))==="submitted"?true:undefined}catch{return undefined}});
  await until(async()=>requests.includes("/started")?true:undefined);
  owner.kill("SIGKILL");await owner.exited;pids.delete(owner.pid);
  const options={agentDir,workerPath:fileURLToPath(new URL("./fixtures/local-browser-worker.ts",import.meta.url)),startupTimeoutMs:10_000,shutdownTimeoutMs:15_000,environment:{...process.env,HOME:root,PI_CODING_AGENT_DIR:agentDir,PI_DISABLE_DOTENV:"1",PUPPETEER_EXECUTABLE_PATH:executable,PI_BROWSER_CMUX:"0",PI_BROWSER_RELAY:"0"}};
  const runtime=new WorkerRuntime(options);
  try{
    await expect(runtime.recoverBrowserContinuation({...saved,bindings:[saved.binding]})).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});
    expect(requests.filter(path=>path==="/page")).toHaveLength(1);
  }finally{await runtime.dispose();page.stop(true);}
},120_000);
