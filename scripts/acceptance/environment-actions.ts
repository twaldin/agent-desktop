import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import { startHost } from "../../apps/host/src/server";
import { LocalEnvironmentStore } from "../../apps/host/src/local-environments";
import { serializeLocalEnvironment, type CommandEnvelope, type CommandResult, type DraftInput, type NativeTerminalInfo, type Project } from "../../packages/shared/src/protocol";

const root = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/environment28/actions-ui-${Date.now()}`);
const nativeBundle = process.env.AGENT_TEST_TMUX_BUNDLE;
if (!nativeBundle) throw new Error("AGENT_TEST_TMUX_BUNDLE must name the reviewed bundled tmux runtime.");
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-environment-actions-")));
const dataDirectory = join(fixture, "data"), agentDirectory = join(fixture, "agent"), source = join(fixture, "source"), marker = join(source, "action-runs");
await Promise.all([dataDirectory, agentDirectory, source].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
let host: Awaited<ReturnType<typeof startHost>> | undefined, proxy: ReturnType<typeof Bun.serve> | undefined;
const terminalIds = new Set<string>();
const sources = ["apps/desktop/src/renderer/App.tsx","apps/desktop/src/renderer/EnvironmentCard.tsx","apps/desktop/src/renderer/EnvironmentActions.tsx","apps/desktop/src/renderer/environment-actions.css","apps/desktop/src/renderer/workspace-state.ts","apps/desktop/src/renderer/use-workbench-dock.tsx","apps/desktop/src/renderer/DockTerminal.tsx","apps/desktop/src/renderer/NativeTerminalPanel.tsx","apps/desktop/src/renderer/native-terminal-view.ts","apps/desktop/src/renderer/styles.css","apps/host/src/server.ts","apps/host/src/local-environments/actions.ts","apps/host/src/terminals/native-manager.ts","apps/host/src/terminals/native-store.ts","apps/host/src/terminals/native-http.ts","packages/shared/src/local-environments.ts","packages/shared/src/workspace-protocol.ts","packages/shared/src/terminals.ts","scripts/acceptance/environment-actions.ts","scripts/acceptance/environment-actions-browser.tsx"];
const hashes = () => Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])).then(Object.fromEntries);

await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error(`Refusing to replace nonempty acceptance evidence: ${output}`);
try {
  const saved = await new LocalEnvironmentStore(source).save({ expectedRevision: null, raw: serializeLocalEnvironment({ version: 1, name: "Action environment", setup: { script: "" }, actions: [{ name: "Count run", icon: "run", command: "printf 'executed\\n' >> action-runs; printf '%s%s_%s\\n' ACTION_ READY \"$(wc -l < action-runs | tr -d ' ')\"" }] }) });
  if (saved.type !== "saved") throw new Error("Action environment fixture was not saved.");
  host = await startHost({ dataDirectory, agentDirectory, discoveryDirectory: source, workerPath: join(root, "apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), nativeTerminalBundle: await realpath(nativeBundle), tailscale: false, port: 0 });
  const hostRequest = (path: string, body?: unknown) => fetch(host!.connection.origin + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${host!.connection.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const send = async (envelope: CommandEnvelope) => { const response = await hostRequest("/v5/commands", envelope); if (!response.ok) throw new Error(`Host command HTTP ${response.status}`); return response.json() as Promise<CommandResult>; };
  const added = await send({ id: crypto.randomUUID(), command: { type: "project.add", path: source, name: "Action fixture" } });
  if (!added.ok || !added.value || !("path" in added.value)) throw new Error("Project add failed.");
  const project = added.value as Project;
  const draft: DraftInput = { id: "new-conversation", text: "", projectId: project.id, model: null, execution: { type: "local" } };
  const seeded = await send({ id: crypto.randomUUID(), commandVersion: 5, command: { type: "draft.put", draft, expectedRevision: 0 } });
  if (!seeded.ok) throw new Error("Draft seed failed.");

  const capability = crypto.randomUUID(), observed: Array<{ path: string; type?: string; id?: string; terminalId?: string; resultTerminalId?: string }> = [];
  const cors = { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); if (!url.pathname.startsWith(`/${capability}/`)) return new Response(null, { status: 404 }); if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = url.pathname.slice(capability.length + 1), body = request.method === "POST" ? await request.json() : undefined;
    const type = (body as any)?.command?.type ?? (body as any)?.query?.type ?? (body as any)?.type; const terminalId = (body as any)?.terminalId;
    const observation = { path, type, id: (body as any)?.id, terminalId } as (typeof observed)[number]; observed.push(observation);
    const allowedGet = ["/v1/state","/v1/preferences","/v1/theme","/v2/terminals/capabilities"].includes(path) || /^\/v1\/sessions\/[^/]+\/(messages|interactions)$/.test(path);
    const allowedPost = ["/v5/commands","/v1/workspace/query","/v1/models/composer","/v2/terminals/query","/v2/terminals/action","/v2/terminals/input"].includes(path);
    if (!(request.method === "GET" && allowedGet) && !(request.method === "POST" && allowedPost)) return new Response(null, { status: 403, headers: cors });
    const response = await hostRequest(path, body), bytes = await response.arrayBuffer();
    try { observation.resultTerminalId = JSON.parse(new TextDecoder().decode(bytes))?.value?.terminal?.id; } catch {}
    return new Response(bytes, { status: response.status, headers: { ...cors, "content-type": response.headers.get("content-type") ?? "application/json" } });
  }});

  const before = await hashes();
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src http://127.0.0.1:${proxy.port}"><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "environment-actions-browser.tsx"))}"></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", worker: { format: "es" }, build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  const endpoint = `http://127.0.0.1:${proxy.port}/${capability}`;
  await writeFile(join(output, "main.cjs"), `const{app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setPath('userData',${JSON.stringify(join(fixture,"profile"))});const sleep=ms=>new Promise(r=>setTimeout(r,ms));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.setContentSize(1440,1000);const inputs=[],captures=[];const evaljs=s=>win.webContents.executeJavaScript(s,true);const click=async(s,t)=>{const p=await evaljs('window.acceptanceTarget('+JSON.stringify(s)+','+JSON.stringify(t)+')'),z=win.webContents.getZoomFactor(),x=Math.round(p.x*z),y=Math.round(p.y*z);win.webContents.sendInputEvent({type:'mouseMove',x,y});await sleep(20);win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});await sleep(30);win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});inputs.push({selector:s,text:t,point:p});await sleep(150)};const key=async k=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:k});win.webContents.sendInputEvent({type:'keyUp',keyCode:k});await sleep(120)};const markerCount=()=>{try{return fs.readFileSync(${JSON.stringify(marker)},'utf8').split('\\n').filter(Boolean).length}catch{return 0}};const waitMarker=async count=>{const end=Date.now()+20000;while(markerCount()<count){if(Date.now()>end)throw new Error('Timed out waiting for action marker '+count);await sleep(50)}};const capture=async name=>{const state=await evaljs('window.acceptanceState()'),image=await win.webContents.capturePage();fs.writeFileSync(path.join(__dirname,name+'.png'),image.toPNG());captures.push({name,state,raster:image.getSize(),outerFrame:win.getBounds(),contentBounds:win.getContentBounds(),zoom:win.webContents.getZoomFactor()})};let step='load';try{await win.loadFile(path.join(__dirname,'web/index.html'),{query:{endpoint:${JSON.stringify(endpoint)},owner:${JSON.stringify(host.store.host.id)}}});win.webContents.focus();await evaljs('window.awaitReady()');step='card';await click('[aria-label="Environment"]');await evaljs('window.awaitCard()');await capture('00-card');step='menu-keyboard';await click('[aria-label="Actions"]');await evaljs('window.awaitMenu()');await evaljs('window.assertActionFocus()');await capture('01-actions-menu');await key('ARROWDOWN');await key('ESCAPE');await evaljs('window.assertTriggerFocus()');step='first-run';await click('[aria-label="Actions"]');await evaljs('window.awaitMenu()');await click('.environment-actions-menu button','Run: Count run');await waitMarker(1);await evaljs('window.awaitTerminal()');await capture('02-first-run');step='second-run';await click('[aria-label="Run: Count run"]');await waitMarker(2);await evaljs('window.awaitSecondRun()');await capture('03-second-run');fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:true,hidden:true,electron:process.versions.electron,inputs,captures,state:await evaljs('window.acceptanceState()')},null,2));app.exit(0)}catch(error){fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error),stack:error&&error.stack,step,inputs,captures,state:await evaljs('window.acceptanceState()').catch(()=>null)},null,2));app.exit(1)}});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => child.kill("SIGTERM"), 75_000), exitCode = await child.exited; clearTimeout(timer);
  const result = await Bun.file(join(output, "result.json")).json().catch(() => ({ passed: false, error: "Electron exited without result" }));
  for (const item of observed) if (item.path === "/v2/terminals/action" && item.terminalId) terminalIds.add(item.terminalId);
  const list = await (await hostRequest("/v2/terminals/query", { type: "list", target: { projectId: project.id } })).json() as { terminals: NativeTerminalInfo[] };
  for (const terminal of list.terminals) terminalIds.add(terminal.id);
  const markerText = await readFile(marker, "utf8").catch(() => "");
  const sourceAfter = await hashes(), actionReceipts = observed.filter(item => item.path === "/v5/commands" && item.type === "workspace.mutate"), actionTerminalIds = actionReceipts.map(item => item.resultTerminalId).filter((id): id is string => Boolean(id));
  Object.assign(result, { exitCode, sourceAtBuild: before, sourceAfterBuild: sourceAfter, sourceHashesStable: JSON.stringify(before) === JSON.stringify(sourceAfter), markerText, markerRuns: markerText.split("\n").filter(Boolean).length,
    hostEvidence: { terminalIds: list.terminals.map(item => item.id), actionReceipts: actionReceipts.length, actionTerminalIds, observedRequests: observed }, rendererContentSize: result.captures?.[0]?.contentBounds, scope: "Production App in hidden sandboxed Electron with real authenticated host routes and the reviewed bundled tmux runtime. This is controlled App interaction evidence, not native Codex pixel parity." });
  result.passed &&= exitCode === 0 && result.sourceHashesStable && markerText === "executed\nexecuted\n" && list.terminals.length === 1 && actionTerminalIds.length === 2 && new Set(actionTerminalIds).size === 1 && actionTerminalIds[0] === list.terminals[0]?.id && result.captures?.length === 4 && result.state?.checks?.length === 6;
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, captures: result.captures?.length, result: join(output, "result.json") }));
  if (!result.passed) throw new Error(`Environment actions acceptance failed; inspect ${join(output, "result.json")}`);
} finally {
  if (host) for (const terminalId of terminalIds) await fetch(host.connection.origin + "/v2/terminals/action", { method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "content-type": "application/json" }, body: JSON.stringify({ type: "close", terminalId }) }).catch(() => {});
  proxy?.stop(); await host?.stop(); await rm(fixture, { recursive: true, force: true });
}
