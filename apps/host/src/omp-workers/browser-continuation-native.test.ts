import { expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { WorkerRuntime } from "./runtime";

async function browserExecutable(): Promise<string> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && (await stat(process.env.PUPPETEER_EXECUTABLE_PATH).catch(() => undefined))?.isFile()) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const root of [join(homedir(), ".omp/puppeteer/chrome"), join(homedir(), ".cache/puppeteer/chrome")]) for (const version of (await readdir(root).catch(() => [])).sort().reverse()) {
    const candidate = join(root, version, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  throw new Error("Browser continuation contract requires an existing Chrome for Testing executable");
}

test("a real CDP tab moves between native workers without page recreation", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-continuation-native-")), agentDir = join(root, "agent"), cwd = join(root, "project");
  await Promise.all([agentDir, cwd].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return new Response("<!doctype html><title>Retained native page</title><button style='position:fixed;inset:0 auto auto 0;width:80px;height:40px' onclick='browserFrameState.count++'>Count</button><script>document.cookie='retained=yes';globalThis.browserFrameState={token:'same-document',count:19}</script>", { headers: { "content-type": "text/html" } });
  } });
  const extension = fileURLToPath(new URL("./fixtures/browser-continuation-extension.ts", import.meta.url));
  await writeFile(join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\nbrowser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n`, { mode: 0o600 });
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/local-browser-worker.ts", import.meta.url)), environment: {
    HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb", PUPPETEER_EXECUTABLE_PATH: await browserExecutable(), BROWSER_FRAME_TEST_URL: `http://127.0.0.1:${server.port}/page`, PI_BROWSER_CMUX: "0", PI_BROWSER_RELAY: "0",
  } });
  try {
    const source = await runtime.createBrowserOwner({ id: "draft-native-owner", cwd });
    await source.createBrowserTab("desktop-native-continuation", `http://127.0.0.1:${server.port}/page`);
    const metadata = await source.getBrowserMetadata();
    if (metadata.availability !== "running") throw new Error("Source native browser did not start");
    const tab = metadata.tabs[0]!, target = { workerPid: source.workerPid, name: tab.name, targetId: tab.targetId };
    const operationId = crypto.randomUUID();
    expect(await source.reserveBrowserEvaluation(target, operationId)).toMatchObject({ phase: "ready", ownerId: source.id, targetId: tab.targetId });
    const evaluation = await source.openBrowserEvaluation(target, operationId, "cdp", 30_000);
    const destination = await runtime.create({ cwd, interactions: true });
    await destination.installBrowserContinuation({ sourceOwnerId: source.id, operationId, target, kindTag: tab.kindTag }, evaluation);
    const inherited = await destination.getBrowserMetadata();
    expect(inherited).toMatchObject({ availability: "running", workerPid: destination.workerPid,
      tabs: [{ name: tab.name, targetId: tab.targetId, backend: "worker", url: `http://127.0.0.1:${server.port}/page` }] });
    const frame=await destination.getBrowserFrame({workerPid:destination.workerPid,name:tab.name,targetId:tab.targetId});
    expect(frame).toMatchObject({name:tab.name,targetId:tab.targetId,url:`http://127.0.0.1:${server.port}/page`,mimeType:"image/jpeg"});expect(frame.data.length).toBeGreaterThan(100);
    if (!frame.context) throw new Error("Retained browser frame omitted its document context");
    await destination.controlBrowser({requestId:crypto.randomUUID(),controlEpoch:"retained-proof",capturedAt:Date.now(),target:{workerPid:destination.workerPid,name:tab.name,targetId:tab.targetId},context:frame.context,action:{type:"click",x:10,y:10}});
    const inspected = destination.startPrompt(`/inspect-retained-browser-contract ${tab.name}`);
    await inspected.accepted; await inspected.completion;
    const entries = (await readFile(destination.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const state = entries.find(entry => entry.customType === "browser-continuation-contract")?.data;
    expect(state).toMatchObject({ url: `http://127.0.0.1:${server.port}/page`, title: "Retained native page", state: { token: "same-document", count: 20 },cookie:expect.stringContaining("retained=yes") });
    expect(requests.filter(path => path === "/page")).toHaveLength(1);
    expect(await destination.closeBrowserTab({workerPid:destination.workerPid,name:tab.name,targetId:tab.targetId})).toMatchObject({released:true,name:tab.name,targetId:tab.targetId});
    await destination.dispose(); await source.dispose();
  } finally { await runtime.dispose(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 90_000);

test("the installed native cmux facade keeps the captured surface on its controlled original channel",async()=>{
  const root=await mkdtemp(join(tmpdir(),"browser-continuation-cmux-")),agentDir=join(root,"agent"),cwd=join(root,"project");
  await Promise.all([agentDir,cwd].map(path=>mkdir(path,{recursive:true,mode:0o700})));
  const extension=fileURLToPath(new URL("./fixtures/browser-continuation-extension.ts",import.meta.url));
  await writeFile(join(agentDir,"config.yml"),`extensions:\n  - ${JSON.stringify(extension)}\nretry:\n  enabled: false\n`,{mode:0o600});
  const runtime=new WorkerRuntime({agentDir,workerPath:fileURLToPath(new URL("./fixtures/local-browser-worker.ts",import.meta.url)),environment:{HOME:root,PATH:process.env.PATH,TMPDIR:tmpdir(),PI_CODING_AGENT_DIR:agentDir,TERM:"dumb",PI_BROWSER_CMUX:"0",PI_BROWSER_RELAY:"0"}});
  let requests=0,disposed=0,idleChecks=0;const idleEntered=Promise.withResolvers<void>(),idleRelease=Promise.withResolvers<void>();
  try{
    const destination=await runtime.create({cwd,interactions:true}),target={workerPid:12345,name:"desktop-cmux-continuation",targetId:"surface-one"};
    const evaluation={backend:"cmux" as const,state:{version:1 as const,surfaceId:target.targetId,url:"https://cmux.invalid/retained",title:"Retained cmux surface",viewport:{width:900,height:700},elementRefs:[]},
      request:async(method:string,params:Record<string,unknown>)=>{requests++;expect(method).toBe("browser.eval");expect(params.surface_id).toBe(target.targetId);return{surface_id:target.targetId,value:{__ompOk:{url:"https://cmux.invalid/retained",title:"Retained cmux surface",state:{token:"same-surface",count:11,evidence:"controlled-cmux-channel"},cookie:"retained=cmux"}}};},
      waitForIdle:async()=>{idleChecks++;idleEntered.resolve();await idleRelease.promise;},
      dispose:async()=>{disposed++;}};
    const installation=destination.installBrowserContinuation({sourceOwnerId:"draft-cmux-owner",operationId:crypto.randomUUID(),target,kindTag:"cmux"},evaluation);
    expect(await Promise.race([idleEntered.promise.then(()=>"idle" as const),installation.then(()=>"published" as const)])).toBe("idle");
    idleRelease.resolve();await installation;
    expect(await destination.getBrowserMetadata()).toMatchObject({availability:"running",workerPid:destination.workerPid,tabs:[{name:target.name,targetId:target.targetId,backend:"cmux",url:evaluation.state.url}]});
    const inspected=destination.startPrompt(`/inspect-retained-browser-contract ${target.name}`);await inspected.accepted;await inspected.completion;
    const entries=(await readFile(destination.sessionFile,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(entries.find(entry=>entry.customType==="browser-continuation-contract")?.data).toMatchObject({url:evaluation.state.url,state:{token:"same-surface",count:11,evidence:"controlled-cmux-channel"},cookie:"retained=cmux"});
    expect(requests).toBe(1);expect(idleChecks).toBe(1);await destination.dispose();expect(disposed).toBe(1);
  }finally{await runtime.dispose();await rm(root,{recursive:true,force:true});}
},30_000);
