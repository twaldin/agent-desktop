import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { BROWSER_AUTOCOMPLETE_OWNER_HEADER, BROWSER_METADATA_OWNER_HEADER } from "../../packages/shared/src/protocol";
import { BrowserAutocompleteHttp } from "../../apps/host/src/browser-autocomplete-http";
import { BrowserAutocompleteService } from "../../apps/host/src/browser-autocomplete-service";
import { BrowserCreateHttp } from "../../apps/host/src/browser-create-http";
import { BrowserControlHttp } from "../../apps/host/src/browser-control-http";
import { BrowserFrameHttp } from "../../apps/host/src/browser-frame-http";
import { BrowserHistoryHttp, type BrowserHistoryHandle } from "../../apps/host/src/browser-history-http";
import { BrowserMetadataHttp } from "../../apps/host/src/browser-metadata-http";
import { WorkerRuntime } from "../../apps/host/src/omp-workers/runtime";
import { HostStore } from "../../apps/host/src/store";

const repository = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? `.data/browser-autocomplete-app-${Date.now()}`);
const sources = [
  "packages/shared/src/browser-autocomplete.ts", "packages/shared/src/browser-autocomplete.test.ts", "packages/shared/src/browser-history.ts", "packages/shared/src/browser-control.ts", "packages/shared/src/draft-browser.ts", "packages/shared/src/protocol.ts",
  "apps/host/src/browser-autocomplete-records.ts", "apps/host/src/browser-autocomplete-records.test.ts", "apps/host/src/browser-autocomplete-service.ts", "apps/host/src/browser-autocomplete-service.test.ts", "apps/host/src/browser-autocomplete-http.ts", "apps/host/src/browser-autocomplete-http.test.ts",
  "apps/host/src/browser-history-http.ts", "apps/host/src/browser-history-revision.ts", "apps/host/src/browser-control-http.ts", "apps/host/src/browser-control-http.test.ts", "apps/host/src/browser-control-requests.ts", "apps/host/src/draft-browser-http.ts", "apps/host/src/draft-browser-control.test.ts", "apps/host/src/browser-frame-http.ts", "apps/host/src/browser-metadata-http.ts", "apps/host/src/server.ts", "apps/host/src/store.ts",
  "apps/host/src/omp-workers/protocol.ts", "apps/host/src/omp-workers/runtime.ts", "apps/host/src/omp-workers/entry.ts",
  "apps/desktop/src/main/browser-autocomplete-transport.ts", "apps/desktop/src/main/browser-history-transport.ts", "apps/desktop/src/main/browser-control-transport.ts", "apps/desktop/src/main/browser-frame-transport.ts", "apps/desktop/src/main/browser-metadata-transport.ts", "apps/desktop/src/main/draft-browser-ipc.ts", "apps/desktop/src/main/draft-browser-preload.ts", "apps/desktop/src/main/draft-browser-transport.ts", "apps/desktop/src/main/main.ts", "apps/desktop/src/main/preload.ts",
  "apps/desktop/src/renderer/BrowserPanel.tsx", "apps/desktop/src/renderer/BrowserAddressInput.tsx", "apps/desktop/src/renderer/browser-preview-source.ts", "apps/desktop/src/renderer/browser-address-suggestions.css", "apps/desktop/src/renderer/browser-address-suggestions.test.tsx", "apps/desktop/src/renderer/browser-panel.css",
  "node_modules/@oh-my-pi/pi-coding-agent/src/tools/browser/tab-supervisor.ts", "node_modules/@oh-my-pi/pi-coding-agent/src/tools/browser/tab-worker.ts", "node_modules/@oh-my-pi/pi-coding-agent/src/tools/browser/tab-protocol.ts",
  "apps/host/src/browser-create-http.ts", "apps/host/src/browser-creation-records.ts", "apps/desktop/src/main/browser-create-transport.ts",
  "apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/DockPanel.tsx", "apps/desktop/src/renderer/dock-state.ts", "apps/desktop/src/renderer/styles.css",
  "patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch", "scripts/acceptance/browser-autocomplete-app-browser.tsx", "scripts/acceptance/browser-autocomplete-app.ts", "bun.lock",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repository, file))).digest("hex")])));
async function chrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && (await stat(process.env.PUPPETEER_EXECUTABLE_PATH).catch(() => undefined))?.isFile()) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const root of [join(homedir(), ".omp/puppeteer/chrome"), join(homedir(), ".cache/puppeteer/chrome")]) for (const version of (await readdir(root).catch(() => [])).sort().reverse()) {
    const candidate = join(root, version, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  throw new Error("Existing Chrome for Testing required");
}

await mkdir(output, { recursive: true, mode: 0o700 });
const isolated = await mkdtemp(join(tmpdir(), "browser-autocomplete-ui-")), agentDir = join(isolated, "agent"), cwd = join(isolated, "project"), profile = join(isolated, "electron");
await Promise.all([agentDir, cwd, profile].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
await writeFile(join(agentDir, "config.yml"), "browser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n", { mode: 0o600 });
const token = randomBytes(32).toString("hex"), sessionId = "22222222-2222-4222-8222-222222222222";
let store = new HostStore(join(isolated,"host")); const hostId=store.host.id;
const slow = Promise.withResolvers<void>(), paths: string[] = [], api: Array<{ path: string; status: number; error?:string }> = [];
const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("../../apps/host/src/omp-workers/fixtures/local-browser-worker.ts", import.meta.url)), environment: { ...process.env, HOME: isolated, PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1", PUPPETEER_EXECUTABLE_PATH: await chrome(), PI_BROWSER_CMUX: "0", PI_BROWSER_RELAY: "0" } });
let owner: Awaited<ReturnType<WorkerRuntime["createBrowserOwner"]>> | undefined;
let historyHandle: BrowserHistoryHandle | undefined;
let autocompleteHandle: import("../../apps/host/src/browser-autocomplete-service").BrowserAutocompleteHandle | undefined;
let autocompleteService = new BrowserAutocompleteService(hostId,store.browserAutocomplete);
let autocomplete = new BrowserAutocompleteHttp({hostId,service:autocompleteService,sessionExists:id=>id===sessionId&&Boolean(owner),getExistingHandle:async id=>id===sessionId?autocompleteHandle:undefined});
const control = new BrowserControlHttp({ hostId, sessionExists: id => id === sessionId && Boolean(owner), getExistingHandle: async id => id === sessionId ? owner : undefined,
  afterCompletedNavigation:async(id,input)=>{if(id!==sessionId||!owner?.getBrowserHistory)return;const captured=owner;await autocompleteService.observeNavigation({kind:"session",id},input.target,{workerPid:captured.workerPid,workerFailure:captured.workerFailure,getBrowserHistory:target=>captured.getBrowserHistory!(target)},()=>owner===captured)} });
const history = new BrowserHistoryHttp({ hostId, sessionExists: id => id === sessionId && Boolean(owner), getExistingHandle: async id => id === sessionId ? historyHandle : undefined });
const creation = new BrowserCreateHttp({records:store.browserCreations,hostId,controlEpoch:control.epoch,sessionExists:id=>id===sessionId&&Boolean(owner),getHandle:async()=>owner!,getExistingHandle:async id=>id===sessionId?owner:undefined});
const metadata = new BrowserMetadataHttp({ hostId, creationTicket: () => ({ controlEpoch: control.epoch, observedAt: Date.now() }), sessionExists: id => id === sessionId && Boolean(owner), getExistingHandle: async id => id === sessionId ? owner : undefined });
const frame = new BrowserFrameHttp({ hostId, controlEpoch: control.epoch, sessionExists: id => id === sessionId && Boolean(owner), getExistingHandle: async id => id === sessionId ? owner : undefined });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (["/one", "/two", "/slow"].includes(url.pathname)) { if (url.pathname === "/slow") await slow.promise; else paths.push(url.pathname); return new Response(`<!doctype html><title>${url.pathname.slice(1)}</title><main>${url.pathname}</main>`, { headers: { "content-type": "text/html" } }); }
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (url.pathname === "/fixture/restart-autocomplete") { if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response("Unauthorized",{status:401}); await autocomplete.dispose(); store.close(); store=new HostStore(join(isolated,"host")); autocompleteService=new BrowserAutocompleteService(hostId,store.browserAutocomplete); autocomplete=new BrowserAutocompleteHttp({hostId,service:autocompleteService,sessionExists:id=>id===sessionId&&Boolean(owner),getExistingHandle:async id=>id===sessionId?autocompleteHandle:undefined}); return Response.json({ok:true}); }
  if (url.pathname.startsWith("/v1/")) { if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 }); const response = await metadata.route(request, url) ?? await creation.route(request, url) ?? await frame.route(request, url) ?? await history.route(request, url) ?? await control.route(request, url) ?? await autocomplete.route(request, url) ?? new Response("Not found", { status: 404 }); let error:string|undefined;if(!response.ok){const value=await response.clone().json().catch(()=>undefined) as any;error=value?.error?.message} api.push({ path: url.pathname, status: response.status,...(error?{error}:{}) }); return response; }
  return new Response("Not found", { status: 404 });
} });

let result: unknown = { passed: false };
try {
  const before = await hashes(); owner = await runtime.createBrowserOwner({ id: sessionId, cwd });
  if (!owner.getBrowserHistory) throw new Error("Native browser history is unavailable");
  historyHandle = { workerPid: owner.workerPid, getBrowserHistory: target => owner!.getBrowserHistory!(target) };
  autocompleteHandle={workerPid:owner.workerPid,workerFailure:owner.workerFailure,getBrowserHistory:target=>owner!.getBrowserHistory!(target)};
    await writeFile(join(output, "index.html"), `<meta charset="utf-8"><div id="root"></div><script type="module" src=${JSON.stringify(relative(output, join(import.meta.dir, "browser-autocomplete-app-browser.tsx")))}></script>`);
  await viteBuild({ configFile: false, root: output, base: "./", plugins:[react(),tailwindcss()], logLevel: "warn", worker:{format:"es"}, build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  const built = await Bun.build({ entrypoints: ["browser-autocomplete", "browser-history", "browser-control", "browser-frame", "browser-metadata", "browser-create"].map(name => join(repository, `apps/desktop/src/main/${name}-transport.ts`)), outdir: join(output, "transport"), target: "node", format: "cjs", naming: "[name].cjs" });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const endpoint = { origin: `http://127.0.0.1:${server.port}`, hostId, token };
  await writeFile(join(output, "preload.cjs"), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixtureApi',{call:(method,args)=>ipcRenderer.invoke('fixture:call',method,args)});`);
  await writeFile(join(output, "main.cjs"), `const{app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path'),fs=require('node:fs'),cp=require('node:child_process');const endpoint=${JSON.stringify(endpoint)},output=${JSON.stringify(output)};const{requestBrowserMetadata}=require('./transport/browser-metadata-transport.cjs'),{requestBrowserFrame}=require('./transport/browser-frame-transport.cjs'),{requestBrowserHistory}=require('./transport/browser-history-transport.cjs'),{requestBrowserControl}=require('./transport/browser-control-transport.cjs'),{requestBrowserAutocomplete}=require('./transport/browser-autocomplete-transport.cjs'),{requestBrowserCreate}=require('./transport/browser-create-transport.cjs');app.setPath('userData',${JSON.stringify(profile)});let win,calls=0,trace=[];const methods={getBrowserMetadata:(id,host)=>requestBrowserMetadata(endpoint,id),createBrowserTab:(id,input,host)=>requestBrowserCreate(endpoint,id,input),getBrowserFrame:(id,input,host)=>requestBrowserFrame(endpoint,id,input),getBrowserHistory:(id,input,host)=>requestBrowserHistory(endpoint,id,input),browserAutocomplete:(id,input,host)=>requestBrowserAutocomplete(endpoint,id,input),controlBrowser:(id,input,host)=>requestBrowserControl(endpoint,id,input)};ipcMain.handle('fixture:call',async(_event,method,args)=>{if(method==='browserCallCount')return calls;if(method==='browserCallTrace')return structuredClone(trace);if(method==='browserCallMarker'){trace.push({method:'MARKER',args,at:Date.now()});return calls}if(method==='restartAutocomplete'){const response=await fetch(endpoint.origin+'/fixture/restart-autocomplete',{method:'POST',headers:{Authorization:'Bearer '+endpoint.token}});if(!response.ok)throw new Error('Restart failed');return response.json()}const fn=methods[method];if(!fn)throw new Error('Unknown fixture method '+method);calls++;trace.push({method,args,at:Date.now()});return fn(...args)});app.whenReady().then(async()=>{win=new BrowserWindow({show:true,width:1440,height:1000,webPreferences:{preload:path.join(output,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on('console-message',(_e,level,message,line,source)=>fs.appendFileSync(path.join(output,'renderer-console.log'),JSON.stringify({level,message,line,source})+'\\n'));await win.loadFile(path.join(output,'web/index.html'),{query:${JSON.stringify({ hostId, sessionId, origin: `http://127.0.0.1:${server.port}` })}});if(process.platform==='darwin'){try{const rows=JSON.parse(cp.execFileSync('yabai',['-m','query','--windows'],{encoding:'utf8'}));const row=rows.find(r=>r.pid===process.pid);if(row&&!row['is-floating'])cp.execFileSync('yabai',['-m','window',String(row.id),'--toggle','float']);win.setBounds({x:80,y:40,width:1440,height:1000})}catch{}}try{const value=await win.webContents.executeJavaScript('runBrowserAutocompleteAppAcceptance()');await win.webContents.capturePage().then(image=>fs.writeFileSync(path.join(output,'full-app.png'),image.toPNG()));fs.writeFileSync(path.join(output,'renderer-result.json'),JSON.stringify({...value,electron:process.versions.electron,bounds:win.getBounds()},null,2));app.exit(value.passed?0:1)}catch(error){fs.writeFileSync(path.join(output,'renderer-result.json'),JSON.stringify({passed:false,error:error&&error.stack||String(error),text:win.webContents.getURL(),body:await win.webContents.executeJavaScript('document.body.innerHTML').catch(()=>null)},null,2));app.exit(1)}});`);
  const mainPath = join(output, "main.cjs");
  const electron = Bun.spawn([process.execPath, join(repository, "node_modules/electron/cli.js"), mainPath], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const deadline = setTimeout(() => electron.kill("SIGTERM"), 90_000), code = await electron.exited; clearTimeout(deadline);
  result = await Bun.file(join(output, "renderer-result.json")).json(); if (code || !(result as { passed?: boolean }).passed) throw new Error(`Electron acceptance failed (${code})`);
  if (JSON.stringify(await hashes()) !== JSON.stringify(before)) throw new Error("Acceptance source changed during execution");
  result = { ...(result as object), paths, api, sourceHashes: before };
} catch (error) { result = { passed: false, error: error instanceof Error ? error.stack ?? error.message : String(error), prior: result, api }; throw error; }
finally { slow.resolve(); await writeFile(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }).catch(() => {}); await autocomplete.dispose().catch(() => {}); await history.dispose().catch(() => {}); await owner?.dispose().catch(() => {}); await runtime.dispose().catch(() => {}); server.stop(true); store.close(); await rm(isolated, { recursive: true, force: true }); }
console.log(JSON.stringify({ passed: true, result: join(output, "result.json") }));
