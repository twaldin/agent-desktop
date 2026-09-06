import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import { startHost } from "../../apps/host/src/server";
import type { CommandEnvelope, CommandResult, HostState, Project, SessionSummary, TranscriptMessage } from "../../packages/shared/src/protocol";

const root = resolve(import.meta.dir, "../..");
const slash = process.argv.includes("--slash");
const promote = process.argv.includes("--promote");
if (slash && promote) throw new Error("Choose one isolated acceptance scenario.");
const output = resolve(process.argv[2] ?? `.data/btw-ui-${Date.now()}`);
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-btw-ui-")));
const dataDirectory = join(fixture, "data"), agentDirectory = join(fixture, "agent"), source = join(fixture, "source"), gates = join(fixture, "gates");
await Promise.all([dataDirectory, agentDirectory, source, gates].map(value => mkdir(value, { recursive: true, mode: 0o700 })));
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error(`Refusing to replace nonempty acceptance evidence: ${output}`);
const sources = [
  "packages/shared/src/btw.ts", "packages/shared/src/protocol.ts", "packages/shared/src/composer-actions.ts", "apps/host/src/omp/composer-actions.ts",
  "apps/host/src/omp/btw.ts", "apps/host/src/omp/runtime.ts", "apps/host/src/omp-workers/protocol.ts", "apps/host/src/omp-workers/entry.ts", "apps/host/src/omp-workers/runtime.ts", "apps/host/src/omp-workers/fixtures/btw-provider.ts",
  "apps/host/src/btw-promotion.ts", "apps/host/src/btw.ts", "apps/host/src/btw-http.ts", "apps/host/src/server.ts", "apps/host/src/store.ts", "apps/host/src/validation.ts",
  "apps/desktop/src/main/main.ts", "apps/desktop/src/main/preload.ts", "apps/desktop/src/main/btw-transport.ts", "apps/desktop/src/window-state.ts",
  "apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/SideChat.tsx", "apps/desktop/src/renderer/btw-state.ts", "apps/desktop/src/renderer/side-chat.css", "apps/desktop/src/renderer/DockPanel.tsx", "apps/desktop/src/renderer/dock-state.ts", "apps/desktop/src/renderer/use-workbench-dock.tsx", "apps/desktop/src/renderer/desktop-state.ts", "apps/desktop/src/renderer/host-catalog.ts", "apps/desktop/src/renderer/drafts.ts", "apps/desktop/src/renderer/composer-autocomplete.ts", "apps/desktop/src/renderer/Icons.tsx",
  "scripts/acceptance/btw.ts", "scripts/acceptance/btw-browser.tsx",
];
const hashes = () => Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(root, file))).digest("hex")])).then(Object.fromEntries);
let host: Awaited<ReturnType<typeof startHost>> | undefined, proxy: ReturnType<typeof Bun.serve> | undefined;
try {
  const provider = join(root, "apps/host/src/omp-workers/fixtures/btw-provider.ts"), providerWrapper = join(fixture, "btw-provider-wrapper.ts");
  await writeFile(providerWrapper, `import provider from ${JSON.stringify(provider)};\nexport default function(pi: unknown) { process.env.BTW_CONTRACT_GATES = ${JSON.stringify(gates)}; return provider(pi as never); }\n`);
  await writeFile(join(agentDirectory, "config.yml"), `extensions:\n  - ${JSON.stringify(providerWrapper)}\nmodelRoles:\n  default: [btw-contract/controlled]\ndefaultThinkingLevel: off\nretry:\n  enabled: false\ntools:\n  approvalMode: yolo\n`);
  host = await startHost({ dataDirectory, agentDirectory, discoveryDirectory: source, workerPath: join(root, "apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), tailscale: false, port: 0 });
  const hostRequest = (route: string, body?: unknown, btw = false) => fetch(host!.connection.origin + route, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${host!.connection.token}`, "content-type": "application/json", ...(btw ? { "X-Agent-Host-Id": host!.store.host.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const send = async (envelope: CommandEnvelope) => { const response = await hostRequest("/v5/commands", envelope); if (!response.ok) throw new Error(`Host command HTTP ${response.status}: ${await response.text()}`); const result = await response.json() as CommandResult; if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result; };
  const modelDeadline = Date.now() + 15_000; let modelState: HostState | undefined;
  while (Date.now() < modelDeadline) { modelState = await (await hostRequest("/v1/state")).json() as HostState; if (modelState.models.some(value => value.provider === "btw-contract" && value.id === "controlled")) break; await Bun.sleep(25); }
  if (!modelState?.models.some(value => value.provider === "btw-contract" && value.id === "controlled")) throw new Error(`Controlled model unavailable: ${JSON.stringify(modelState?.diagnostics)}`);
  const added = await send({ id: crypto.randomUUID(), command: { type: "project.add", path: source, name: "Side chat fixture" } });
  if (!added.value || !("path" in added.value)) throw new Error("Project add failed.");
  const project = added.value as Project, model = { provider: "btw-contract", id: "controlled" };
  const created = await send({ id: crypto.randomUUID(), command: { type: "session.create", projectId: project.id, model } });
  if (!created.value || !("sessionFile" in created.value)) throw new Error("Session create failed.");
  const session = created.value as SessionSummary;
  await writeFile(join(gates, "1.release"), "");
  await send({ id: crypto.randomUUID(), command: { type: "session.prompt", sessionId: session.id, text: "Persistent main context for the side chat acceptance", model } });
  const idleDeadline = Date.now() + 15_000;
  while (Date.now() < idleDeadline) { const state = await (await hostRequest("/v1/state")).json() as HostState; if (state.sessions.find(value => value.id === session.id)?.status === "idle") break; await Bun.sleep(25); }
  const messagesBefore = await (await hostRequest(`/v1/sessions/${session.id}/messages`)).json() as TranscriptMessage[];

  const capability = crypto.randomUUID(), observed: Array<{route:string;method:string;type?:string;id?:string;command?:unknown}> = [];
  const cors = { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); if (!url.pathname.startsWith(`/${capability}/`)) return new Response(null, { status: 404 }); if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const route = url.pathname.slice(capability.length + 1), body = request.method === "POST" ? await request.json() : undefined;
    observed.push({ route, method: request.method, type: (body as any)?.command?.type, id: (body as any)?.id, ...((body as any)?.command?.type?.startsWith("session.btw.") ? { command: (body as any).command } : {}) });
    const allowedGet = ["/v1/state","/v1/preferences","/v1/theme"].includes(route) || /^\/v1\/sessions\/[^/]+\/(messages|interactions|questions|controls|btw)$/.test(route);
    const allowedPost = ["/v5/commands","/v1/workspace/query","/v1/models/composer","/v1/composer/actions","/v1/composer/completions"].includes(route);
    if (!(request.method === "GET" && allowedGet) && !(request.method === "POST" && allowedPost)) return new Response(null, { status: 403, headers: cors });
    const response = await hostRequest(route, body, route.endsWith("/btw") || route.endsWith("/questions") || route.startsWith("/v1/composer/")), bytes = await response.arrayBuffer();
    return new Response(bytes, { status: response.status, headers: { ...cors, "content-type": response.headers.get("content-type") ?? "application/json" } });
  }});

  const before = await hashes();
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src http://127.0.0.1:${proxy.port}"><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "btw-browser.tsx"))}"></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", worker: { format: "es" }, build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  const endpoint = `http://127.0.0.1:${proxy.port}/${capability}`;
  await writeFile(join(output, "main.cjs"), `const{app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setPath('userData',${JSON.stringify(join(fixture,"profile"))});const sleep=ms=>new Promise(r=>setTimeout(r,ms));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.setContentSize(1440,1000);const inputs=[],captures=[];const evaljs=s=>win.webContents.executeJavaScript(s,true);const click=async(s,t)=>{const p=await evaljs('window.acceptanceTarget('+JSON.stringify(s)+','+JSON.stringify(t)+')'),z=win.webContents.getZoomFactor(),x=Math.round(p.x*z),y=Math.round(p.y*z);win.webContents.sendInputEvent({type:'mouseMove',x,y});await sleep(20);win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});await sleep(30);win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});inputs.push({kind:'pointer',selector:s,text:t,point:p});await sleep(150)};const insert=async text=>{win.webContents.insertText(text);inputs.push({kind:'text',length:text.length});await sleep(450)};const key=async(k,mods=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:k,modifiers:mods});win.webContents.sendInputEvent({type:'keyUp',keyCode:k,modifiers:mods});inputs.push({kind:'key',key:k,modifiers:mods});await sleep(150)};const capture=async name=>{const state=await evaljs('window.acceptanceState()'),image=await win.webContents.capturePage();fs.writeFileSync(path.join(__dirname,name+'.png'),image.toPNG());captures.push({name,state,raster:image.getSize(),outerFrame:win.getBounds(),contentBounds:win.getContentBounds(),zoom:win.webContents.getZoomFactor()})};let step='load';try{await win.loadFile(path.join(__dirname,'web/index.html'),{query:{endpoint:${JSON.stringify(endpoint)},owner:${JSON.stringify(host.store.host.id)},session:${JSON.stringify(session.id)}}});win.webContents.focus();await evaljs('window.awaitEmpty()');await capture('00-empty');const first='Explain the current context';step='draft';await click('[aria-label="Side chat prompt"]');await insert(first);await click('[data-app-shell-tab-close-button]');await evaljs('window.awaitClosed()');await key('s',['meta','alt']);await evaljs('window.awaitReopenedDraft('+JSON.stringify(first)+')');await capture('01-reopened-draft');step='running';await key('ENTER');await evaljs('window.awaitRunning('+JSON.stringify(first)+')');await capture('02-running');step='stop';await click('[aria-label="Stop side chat"]');await evaljs('window.awaitStopped()');await capture('03-stopped');const second='Answer the second side question';step='complete';await click('[aria-label="Side chat prompt"]');await insert(second);fs.writeFileSync(${JSON.stringify(join(gates,"3.release"))},'');await key('ENTER');await evaljs('window.awaitComplete('+JSON.stringify(second)+')');await capture('04-complete');if(${JSON.stringify(slash)}){step='slash';await click('#prompt');await insert('/btw');await evaljs('window.awaitSlashMenu()');await capture('05-slash-menu');await key('TAB');await insert('Explain via main composer');fs.writeFileSync(${JSON.stringify(join(gates,"4.release"))},'');await key('ENTER');await evaljs('window.awaitSlashComplete("Explain via main composer")');await capture('06-slash-complete')}if(${JSON.stringify(promote)}){step='promotion-drafts';await click('#prompt');await insert('Keep unsent main prompt');await click('[aria-label="Side chat prompt"]');await insert('Keep unsent side prompt');await evaljs('window.awaitPromotionDrafts()');await capture('05-promotion-drafts');step='promote';await click('.side-chat-promote');await evaljs('window.awaitPromoted()');await capture('06-promoted')}fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:true,hidden:true,electron:process.versions.electron,inputs,captures,state:await evaljs('window.acceptanceState()')},null,2));app.exit(0)}catch(error){fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error),stack:error&&error.stack,step,inputs,captures,state:await evaljs('window.acceptanceState()').catch(()=>null)},null,2));app.exit(1)}});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => child.kill("SIGTERM"), 75_000), exitCode = await child.exited; clearTimeout(timer);
  const result = await Bun.file(join(output, "result.json")).json().catch(() => ({ passed: false, error: "Electron exited without result" }));
  const messagesAfter = await (await hostRequest(`/v1/sessions/${session.id}/messages`)).json() as TranscriptMessage[];
  const sourceAfter = await hashes(), commands = observed.filter(value => value.route === "/v5/commands" && value.type?.startsWith("session.btw."));
  Object.assign(result, { exitCode, sourceAtBuild: before, sourceAfterBuild: sourceAfter, sourceHashesStable: JSON.stringify(before) === JSON.stringify(sourceAfter),
    hostEvidence: { sessionId: session.id, finalDrafts: host.store.listDrafts(), sessionCount: host.store.listSessions().length, mainMessagesUnchanged: JSON.stringify(messagesBefore) === JSON.stringify(messagesAfter), mainMessageCount: messagesAfter.length, commands, providerCalls: (await readdir(gates)).filter(name => name.endsWith(".started")).sort() },
    scope: "Production App SideChat in hidden sandboxed Electron against an authenticated disposable host and controlled outbound-fetch-disabled OMP provider. The renderer bridge uses capability-scoped HTTP directly, so this does not exercise desktop main-process IPC. Screenshots are controlled App evidence, not native Codex pixel parity." });
  if (slash) {
    const direct = commands.filter(row => (row.command as any)?.nativeCommand === "btw");
    const command = direct[0]?.command as any;
    const draft = host.store.getDraft(`session:${session.id}`);
    result.hostEvidence.directCommandVerified = direct.length === 1 && command.question === "Explain via main composer"
      && command.draft?.id === `session:${session.id}` && draft?.text === "" && draft.revision === command.draft.revision + 1
      && result.hostEvidence.sessionCount === 1;
    result.passed &&= result.hostEvidence.directCommandVerified;
  }
  if (promote) {
    const promotions = commands.filter(row => row.type === 'session.btw.promote');
    const receipt = promotions[0]?.id ? host.store.getCommand(promotions[0].id) : undefined;
    const value = receipt?.result?.ok ? receipt.result.value : undefined;
    result.hostEvidence.promotionVerified = promotions.length === 1 && value && 'type' in value && value.type === 'session.btw.promote'
      && !value.cancelled && value.session.id !== session.id && result.state?.route?.sessionId === value.session.id
      && host.store.getDraft(`session:${session.id}`)?.text === 'Keep unsent main prompt'
      && host.store.getDraft(`btw:${session.id}`)?.text === 'Keep unsent side prompt' && host.store.listSessions().length === 2;
    result.passed &&= Boolean(result.hostEvidence.promotionVerified);
  }
  result.passed &&= exitCode === 0 && result.sourceHashesStable && result.hostEvidence.mainMessagesUnchanged && commands.length === (slash || promote ? 4 : 3) && result.captures?.length === (slash || promote ? 7 : 5) && result.state?.checks?.length === (slash || promote ? 7 : 5);
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, captures: result.captures?.length, result: join(output, "result.json") }));
  if (!result.passed) throw new Error(`Side chat acceptance failed; inspect ${join(output, "result.json")}`);
} catch (cause) {
  if (!await Bun.file(join(output, "result.json")).exists()) await writeFile(join(output, "result.json"), JSON.stringify({ passed: false, phase: "host-or-build", error: cause instanceof Error ? cause.message : String(cause) }, null, 2));
  throw cause;
} finally { proxy?.stop(); await host?.stop(); await rm(fixture, { recursive: true, force: true }); }
