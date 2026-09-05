import { build as viteBuild } from "vite";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { BROWSER_METADATA_OWNER_HEADER, jpegViewportDimensions, type BrowserFrameSnapshot, type BrowserMetadataSnapshot } from "../../packages/shared/src/protocol";
import { BrowserFrameHttp } from "../../apps/host/src/browser-frame-http";
import { BrowserMetadataHttp } from "../../apps/host/src/browser-metadata-http";
import { WorkerRuntime, type WorkerSession } from "../../apps/host/src/omp-workers/runtime";

const repository = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? `.data/ui-acceptance/native-browser-preview-${Date.now()}`);
const sourceFiles = [
  "apps/desktop/src/main/browser-frame-transport.ts", "apps/desktop/src/main/browser-metadata-transport.ts", "apps/desktop/src/renderer/BrowserPanel.tsx",
  "apps/desktop/src/renderer/browser-panel.css", "apps/host/src/browser-frame-http.ts", "apps/host/src/browser-metadata-http.ts", "apps/host/src/omp-browser/frame.ts",
  "apps/host/src/omp-workers/entry.ts", "apps/host/src/omp-workers/protocol.ts", "apps/host/src/omp-workers/runtime.ts",
  "apps/host/src/omp-workers/fixtures/browser-frame-extension.ts", "apps/host/src/omp-workers/fixtures/local-browser-worker.ts",
  "packages/shared/src/browser-frame.ts", "packages/shared/src/browser.ts", "patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch",
  "scripts/acceptance/native-browser-preview-browser.tsx", "scripts/acceptance/native-browser-preview.ts",
];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await readFile(join(repository, file))).digest("hex")])));
async function browserExecutable(): Promise<string> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && (await stat(process.env.PUPPETEER_EXECUTABLE_PATH).catch(() => undefined))?.isFile()) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const directory of [join(homedir(), ".omp/puppeteer/chrome"), join(homedir(), ".cache/puppeteer/chrome")]) for (const version of (await readdir(directory).catch(() => [])).sort().reverse()) {
    const candidate = join(directory, version, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  throw new Error("Native browser preview acceptance requires an existing Chrome for Testing executable");
}
const workerAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
async function waitFor(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await sleep(50); }
  throw new Error(`Timed out: ${message}`);
}

await mkdir(output, { recursive: true, mode: 0o700 });
const isolated = await mkdtemp(join(tmpdir(), "native-browser-preview-")), agentDir = join(isolated, "agent"), cwd = join(isolated, "project"), profile = join(isolated, "electron-profile");
await Promise.all([agentDir, cwd, profile].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
const before = await hashes(), token = randomBytes(32).toString("hex"), hostId = "native-preview-owner";
const requests: Array<Record<string, unknown>> = [], heartbeats: number[] = [];
let session: WorkerSession | undefined;
const metadataEndpoint = new BrowserMetadataHttp({ hostId, sessionExists: id => id === session?.id, getExistingHandle: async id => id === session?.id ? session : undefined });
const frameEndpoint = new BrowserFrameHttp({ hostId, sessionExists: id => id === session?.id, getExistingHandle: async id => id === session?.id ? session : undefined });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/page") return new Response(`<!doctype html><meta charset="utf-8"><title>Actual native preview</title><style>html,body{margin:0;width:100%;height:100%;background:#173f5f;color:white;font:24px system-ui}main{padding:32px}input{display:block;margin-top:24px;width:420px}</style><main>Actual native viewport<input id="draft" value="unsent native input"></main><script>document.cookie='native_preview_cookie=retained; SameSite=Lax';const draft=document.querySelector('#draft');globalThis.browserFrameState={get cookie(){return document.cookie},get unsentInput(){return draft.value},marker:'unchanged'};setInterval(()=>fetch('/heartbeat',{cache:'no-store'}).catch(()=>{}),100)</script>`, { headers: { "Content-Type": "text/html", "Set-Cookie": "native_preview_server=retained; SameSite=Lax", "Cache-Control": "no-store" } });
  if (url.pathname === "/heartbeat") { heartbeats.push(Date.now()); return new Response(null, { status: 204 }); }
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (url.pathname.startsWith("/v1/")) {
    const authorized = request.headers.get("Authorization") === `Bearer ${token}`;
    if (!authorized) return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
    const response = await metadataEndpoint.route(request, url) ?? await frameEndpoint.route(request, url) ?? new Response("Not found", { status: 404 });
    const record: Record<string, unknown> = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: request.method, owner: request.headers.get(BROWSER_METADATA_OWNER_HEADER), tokenAccepted: true, status: response.status };
    if (response.ok) {
      const body = await response.clone().json() as BrowserMetadataSnapshot | BrowserFrameSnapshot;
      if ("mimeType" in body) { const bytes = Uint8Array.from(Buffer.from(body.data, "base64")); Object.assign(record, { response: { protocolVersion: body.protocolVersion, hostId: body.hostId, sessionId: body.sessionId, workerPid: body.workerPid, name: body.name, targetId: body.targetId, url: body.url, title: body.title, mimeType: body.mimeType, ...jpegViewportDimensions(bytes), bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") } }); }
      else Object.assign(record, { response: body });
    }
    requests.push(record); return response;
  }
  return new Response("Not found", { status: 404 });
} });
const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("../../apps/host/src/omp-workers/fixtures/local-browser-worker.ts", import.meta.url)), environment: {
  HOME: isolated, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb", PUPPETEER_EXECUTABLE_PATH: await browserExecutable(),
  BROWSER_FRAME_TEST_URL: `http://127.0.0.1:${server.port}/page`, PI_BROWSER_CMUX: "0", PI_BROWSER_RELAY: "0",
} });
let result: Record<string, unknown> = { passed: false };
try {
  const extension = fileURLToPath(new URL("../../apps/host/src/omp-workers/fixtures/browser-frame-extension.ts", import.meta.url));
  await writeFile(join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\nbrowser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n`, { mode: 0o600 });
  session = await runtime.create({ cwd, interactions: true });
  const opened = session.startPrompt("/open-browser-frame-contract"); await opened.accepted; await opened.completion;
  const nativeMetadata = await session.getBrowserMetadata(); if (nativeMetadata.availability !== "running" || nativeMetadata.tabs.length !== 1) throw new Error("Native OMP tab did not become available");
  const tab = nativeMetadata.tabs[0]!, target = { workerPid: session.workerPid, name: tab.name, targetId: tab.targetId };

  await writeFile(join(output, "index.html"), `<meta charset="utf-8"><div id="root"></div><script type="module" src=${JSON.stringify(relative(output, join(import.meta.dir, "native-browser-preview-browser.tsx")))}></script>`);
  await viteBuild({ configFile: join(repository, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  const transport = await Bun.build({ entrypoints: [join(repository, "apps/desktop/src/main/browser-metadata-transport.ts"), join(repository, "apps/desktop/src/main/browser-frame-transport.ts")], outdir: join(output, "transport"), target: "node", format: "cjs", naming: "[name].cjs" });
  if (!transport.success) throw new Error(transport.logs.join("\n"));
  await writeFile(join(output, "preload.cjs"), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativePreviewBridge',{getBrowserMetadata:(sessionId,hostId)=>ipcRenderer.invoke('native-preview:metadata',sessionId,hostId),getBrowserFrame:(sessionId,target,hostId)=>ipcRenderer.invoke('native-preview:frame',sessionId,target,hostId),capture:label=>ipcRenderer.invoke('native-preview:capture',label)});`, { mode: 0o600 });
  await writeFile(join(output, "main.cjs"), `const{app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path');const{requestBrowserMetadata}=require('./transport/browser-metadata-transport.cjs'),{requestBrowserFrame}=require('./transport/browser-frame-transport.cjs');
app.setPath('userData',${JSON.stringify(profile)});const output=${JSON.stringify(output)},endpoint={origin:${JSON.stringify(`http://127.0.0.1:${server.port}`)},hostId:${JSON.stringify(hostId)},token:${JSON.stringify(token)}};let window;
ipcMain.handle('native-preview:metadata',(_event,sessionId,hostId)=>{if(hostId!==endpoint.hostId)throw new Error('Unexpected fixture owner');return requestBrowserMetadata(endpoint,sessionId)});ipcMain.handle('native-preview:frame',(_event,sessionId,target,hostId)=>{if(hostId!==endpoint.hostId)throw new Error('Unexpected fixture owner');return requestBrowserFrame(endpoint,sessionId,target)});ipcMain.handle('native-preview:capture',async(_event,label)=>{if(!['initial','remounted'].includes(label))throw new Error('Invalid capture label');fs.writeFileSync(path.join(output,label+'.png'),(await window.webContents.capturePage()).toPNG());return label+'.png'});
app.whenReady().then(async()=>{window=new BrowserWindow({show:false,width:900,height:700,webPreferences:{preload:path.join(output,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});try{await window.loadFile(path.join(output,'web/index.html'),{query:${JSON.stringify({ hostId, sessionId: session.id, workerPid: String(target.workerPid), name: target.name, targetId: target.targetId, url: tab.url, title: tab.title ?? "" })}});const value=await window.webContents.executeJavaScript('runNativeBrowserPreviewAcceptance()');fs.writeFileSync(path.join(output,'renderer-result.json'),JSON.stringify({...value,electron:process.versions.electron,hidden:true},null,2));window.destroy();app.exit(value.passed?0:1)}catch(error){const progress=await window.webContents.executeJavaScript('nativeBrowserPreviewProgress()').catch(()=>null);fs.writeFileSync(path.join(output,'renderer-result.json'),JSON.stringify({passed:false,error:String(error),progress},null,2));fs.writeFileSync(path.join(output,'failure.png'),(await window.webContents.capturePage()).toPNG());app.exit(1)}});`, { mode: 0o600 });
  const electron = Bun.spawn([process.execPath, join(repository, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const deadline = setTimeout(() => electron.kill("SIGTERM"), 90_000); const code = await electron.exited; clearTimeout(deadline);
  const renderer = await Bun.file(join(output, "renderer-result.json")).json(); if (code || !renderer.passed) throw new Error(`Hidden Electron pipeline failed (${code})`);
  const inspected = session.startPrompt("/inspect-browser-frame-contract"); await inspected.accepted; await inspected.completion;
  const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const states = entries.filter(entry => entry.type === "custom" && entry.customType === "browser-frame-contract-state").map(entry => entry.data);
  if (states.length !== 2 || states[0].url !== tab.url || states[1].url !== tab.url || JSON.stringify(states[0].viewport) !== JSON.stringify(states[1].viewport)
    || states[0].state?.cookie !== states[1].state?.cookie || states[1].state?.unsentInput !== "unsent native input" || states[1].state?.marker !== "unchanged") throw new Error("Native document state changed while the preview viewer was hidden or remounted");
  const beforeDispose = await session.getBrowserMetadata(); if (beforeDispose.availability !== "running" || beforeDispose.tabs[0]?.targetId !== target.targetId) throw new Error("Viewer disposal closed or replaced the native tab");
  await waitFor(() => heartbeats.length >= 3, "native page heartbeats"); const pid = session.workerPid; await session.dispose(); await waitFor(() => !workerAlive(pid), "disposed worker exit");
  const heartbeatCount = heartbeats.length; await sleep(500); if (heartbeats.length !== heartbeatCount) throw new Error("Owned native page remained active after session disposal");
  const after = await hashes(); if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Acceptance source hashes changed during execution");
  const frameRequests = requests.filter(request => request.path === `/v1/sessions/${session!.id}/browser-frame`);
  if (!frameRequests.length || !frameRequests.every(request => request.status === 200 && request.owner === hostId && request.tokenAccepted === true)) throw new Error("Authenticated production frame route was not exercised");
  result = { passed: true, scope: "Actual isolated OMP worker and tab through authenticated Bun HTTP, production Electron main transports, minimal preload, and production BrowserPanel", renderer,
    native: { hostId, sessionId: session.id, workerPid: pid, target: { name: target.name, targetId: target.targetId }, metadataBeforeDispose: beforeDispose, documentBeforeAndAfterViewer: states, sessionDispose: { workerReaped: true, heartbeatStopped: true, heartbeatCount } },
    http: { requestCount: requests.length, requests }, captures: ["initial.png", "remounted.png"], sourceHashes: after, sourceHashesStable: true, providerCalls: false, installedServicesTouched: false };
} catch (error) {
  result = { passed: false, error: error instanceof Error ? error.stack ?? error.message : String(error), requests: requests.map(({ token: _token, ...request }) => request) };
  throw error;
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }).catch(() => {});
  await runtime.dispose().catch(() => {}); server.stop(true); await rm(isolated, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: true, requests: requests.length, captures: 2, result: join(output, "result.json") }));
