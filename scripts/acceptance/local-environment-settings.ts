import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import { startHost } from "../../apps/host/src/server";
import type { CommandResult, Project } from "../../packages/shared/src/protocol";

const root = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/local-environment-settings/${Date.now()}`);
const fixture = await mkdtemp(join(tmpdir(), "agent-desktop-local-environment-settings-"));
const dataDirectory = join(fixture, "data"), agentDirectory = join(fixture, "agent"), projectRoot = join(fixture, "project");
await Promise.all([dataDirectory, agentDirectory, projectRoot].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
let host: Awaited<ReturnType<typeof startHost>> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;
const sources = ["apps/desktop/src/renderer/LocalEnvironmentSettings.tsx", "apps/desktop/src/renderer/local-environment-settings.css", "apps/desktop/src/renderer/SettingsSidebar.tsx", "apps/desktop/src/renderer/settings-sidebar.css", "apps/desktop/src/renderer/local-environment-state.ts", "apps/desktop/src/renderer/offline-cache.ts", "apps/desktop/src/renderer/styles.css", "apps/host/src/local-environments/index.ts", "apps/host/src/workspace-http.ts", "packages/shared/src/local-environments.ts", "scripts/acceptance/local-environment-settings-browser.tsx", "scripts/acceptance/local-environment-settings.ts"];
const hashes = () => Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])).then(Object.fromEntries);
await mkdir(output, { recursive: true, mode: 0o700 });
try {
  host = await startHost({ dataDirectory, agentDirectory, discoveryDirectory: projectRoot, tailscale: false, port: 0 });
  const requestHost = async (path: string, body?: unknown) => fetch(host!.connection.origin + path, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${host!.connection.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  const added = await (await requestHost("/v1/commands", { id: crypto.randomUUID(), command: { type: "project.add", path: projectRoot, name: "Environment fixture" } })).json() as CommandResult;
  if (!added.ok || !added.value || !("path" in added.value)) throw new Error("Failed to add owned fixture project");
  const project = added.value as Project;
  const envDir = join(projectRoot, ".agent-desktop", "environments");
  await mkdir(envDir, { recursive: true }); await writeFile(join(envDir, "broken.toml"), "name = [\n");
  const capability = crypto.randomUUID(), saves: string[] = [];
  const cors = { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`/${capability}/`)) return new Response(null, { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: cors });
    const path = url.pathname.slice(capability.length + 1), body = await request.json() as any;
    const allowedQuery = path === "/v1/workspace/query" && body.target?.projectId === project.id && ["environments.list", "environment.read"].includes(body.query?.type);
    const allowedSave = path === "/v1/commands" && body.command?.type === "workspace.mutate" && body.command.target?.projectId === project.id && body.command.action?.type === "environment.save";
    if (!allowedQuery && !allowedSave) return new Response(null, { status: 403, headers: cors });
    if (allowedSave) saves.push(body.id);
    const response = await requestHost(path, body);
    return new Response(response.body, { status: response.status, headers: { ...cors, "content-type": "application/json" } });
  } });
  const before = await hashes();
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src http://127.0.0.1:${proxy.port}"><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "local-environment-settings-browser.tsx"))}"></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  await writeFile(join(output, "main.cjs"), `
const {app,BrowserWindow,nativeTheme}=require('electron'),path=require('node:path'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(fixture, "profile"))}); nativeTheme.themeSource='dark';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const evaluate=source=>window.webContents.executeJavaScript(source,true), captures=[], inputs=[];
 const wait=async(source,label)=>{for(let i=0;i<250;i++){if(await evaluate('Boolean('+source+')'))return;await sleep(20)}throw Error('Timed out: '+label)};
 const click=async(selector)=>{const p=await evaluate('acceptanceTarget('+JSON.stringify(selector)+')');await sleep(30);const z=window.webContents.getZoomFactor(),x=Math.round(p.x*z),y=Math.round(p.y*z);for(const type of ['mouseMove','mouseDown','mouseUp'])window.webContents.sendInputEvent({type,x,y,button:'left',clickCount:1});inputs.push({selector,p,zoom:z});await sleep(80)};
 const type=async(selector,value)=>{await click(selector);await window.webContents.insertText(value);await sleep(80)};
 const capture=async(name)=>{const state=await evaluate('acceptanceState()');if(state.horizontalOverflow)throw Error('Horizontal overflow');const image=await window.webContents.capturePage();fs.writeFileSync(path.join(__dirname,name+'.png'),image.toPNG());captures.push({name,...state,raster:image.getSize(),zoom:window.webContents.getZoomFactor(),frame:window.getBounds()})};
 let step='load';
 try {
  await window.loadFile(path.join(__dirname,'web/index.html'),{query:{endpoint:${JSON.stringify(`http://127.0.0.1:${proxy.port}/${capability}`)},project:${JSON.stringify(JSON.stringify(project))}}});
  window.setContentSize(1440,1000);window.webContents.focus();
  await wait('[...document.querySelectorAll("button")].some(e=>e.textContent.trim()==="Add environment"&&!e.disabled)','catalog');
  step='new';await click('button.primary-button');await wait('document.querySelector(".local-environment-field input")','editor');
  await type('.local-environment-field input','Fixture environment');await click('.local-environment-platforms button:nth-child(2)');
  await type('textarea[aria-label="setup script for macOS"]','touch SHOULD_NOT_EXECUTE');await capture('01-editor');await click('.environment-variables-trigger');await wait('document.querySelector(".environment-variables-popover")?.matches(":popover-open")','variables popup');await wait('(()=>{const p=document.querySelector(".environment-variables-popover").getBoundingClientRect(),b=document.querySelector(".environment-variables-trigger").getBoundingClientRect();return Math.abs(p.right-b.right)<1&&Math.abs(p.top-b.bottom-4)<1&&p.bottom<innerHeight})()','variables anchored within viewport');await capture('01b-variables');window.webContents.sendInputEvent({type:'keyDown',keyCode:'ESCAPE'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'ESCAPE'});await wait('!document.querySelector(".environment-variables-popover")?.matches(":popover-open")','variables dismissed');
  step='save';await click('.local-environment-form-actions button[type=submit]');await wait('document.body.textContent.includes("Environment saved.")','save receipt');
  await capture('02-saved');
  step='draft';await type('.local-environment-field input',' unsaved');await sleep(300);window.webContents.reload();
  await wait('document.querySelector(".local-environment-field input")?.value==="Fixture environment unsaved"','cached unsaved edit');await capture('03-restored');
  step='repair';await click('.local-environment-breadcrumbs .text-button');await wait('document.querySelector(".local-environment-row.error button")','broken entry');await click('.local-environment-row.error button');
  await wait('document.querySelector(".local-environment-repair textarea")','raw repair');await capture('04-repair');
  await click('.local-environment-repair textarea');window.webContents.selectAll();await wait('document.activeElement?.selectionStart===0 && document.activeElement?.selectionEnd===document.activeElement?.value?.length','native select all');inputs.push({command:'webContents.selectAll',target:'raw repair'});
  await window.webContents.insertText('version=1\\nname="Repaired"\\n[setup]\\nscript=""\\n');await sleep(100);
  await click('.local-environment-repair .local-environment-form-actions .primary-button');await wait('document.body.textContent.includes("Environment saved.")','repair receipt');await capture('05-repaired');
  fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:true,captures,inputs,hidden:true,electron:process.versions.electron},null,2));
  app.exit(0);
 }catch(error){fs.writeFileSync(path.join(__dirname,'failure.png'),(await window.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error),step,captures,inputs,state:await evaluate('acceptanceState()').catch(()=>null)},null,2));app.exit(1)}
});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000); const exitCode = await child.exited; clearTimeout(timer);
  const result = await Bun.file(join(output, "result.json")).json();
  const saved = await readFile(join(envDir, "fixture-environment.toml"), "utf8").catch(() => "");
  const repaired = await readFile(join(envDir, "broken.toml"), "utf8");
  const markerExists = await access(join(projectRoot, "SHOULD_NOT_EXECUTE")).then(() => true, () => false);
  const state = await (await requestHost("/v1/state")).json();
  Object.assign(result, { exitCode, saves, saved, repaired, markerExists, sessionCount: state.sessions.length, sourceAtBuild: before, sourceAfter: await hashes(),
    scope: "Controlled hidden Electron component with actual native pointer/text input, real authenticated owning-host API and real files. Not a native window/reference comparison or provider test." });
  result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfter);
  result.passed &&= exitCode === 0 && result.sourceHashesStable && saves.length === 2 && new Set(saves).size === 2 && saved.includes('name = "Fixture environment"') && saved.includes("touch SHOULD_NOT_EXECUTE") && repaired.includes('name="Repaired"') && !markerExists && state.sessions.length === 0;
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, captures: result.captures?.length, result: join(output, "result.json") }));
  if (!result.passed) throw new Error("Environment settings acceptance failed");
} finally { proxy?.stop(); await host?.stop(); await rm(fixture, { recursive: true, force: true }); }
