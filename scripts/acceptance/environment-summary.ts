import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/environment-summary-${Date.now()}`);
if (existsSync(output) && (await readdir(output)).length) throw new Error(`Output must be empty: ${output}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const sources = ["apps/desktop/src/renderer/EnvironmentCard.tsx", "apps/desktop/src/renderer/environment-card.css", "apps/desktop/src/window-state.ts", "apps/desktop/src/renderer/workspace-state.ts", "packages/shared/src/session-activity.ts", "scripts/acceptance/environment-summary.ts", "scripts/acceptance/environment-summary-browser.tsx"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(repo, path))).digest("hex")])));
const sourceAtBuild = await hashes();
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;font:14px system-ui;background:#222;color:#eee}main{padding:12px;display:grid;gap:8px;justify-items:start}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "environment-summary-browser.tsx"))}"></script>`);
await writeFile(join(output, "tsconfig.fixture.json"), JSON.stringify({ extends: join(repo, "tsconfig.json"), include: [join(repo, "scripts/acceptance/environment-summary-browser.tsx"), join(repo, "apps/desktop/src/renderer/EnvironmentCard.tsx")] }, null, 2));
const check = Bun.spawn([process.execPath, "x", "tsc", "-p", join(output, "tsconfig.fixture.json"), "--pretty", "false"], { cwd: output, stdout: Bun.file(join(output, "strict.log")), stderr: Bun.file(join(output, "strict-errors.log")), env: { HOME: output, PATH: "/usr/bin:/bin" } });
if (await check.exited !== 0) throw new Error(`Strict fixture compilation failed; inspect ${join(output, "strict-errors.log")}`);
await build({ configFile: false, root: output, plugins: [react()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
const profile = await mkdtemp(join(tmpdir(), "agent-desktop-environment-summary-"));
let exitCode = -1;
try {
  await writeFile(join(output, "main.cjs"), String.raw`
const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
const output=process.argv[2],profile=process.argv[3],sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)); app.setPath("userData",profile);
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:520,height:820,webPreferences:{sandbox:true,contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}}); const js=source=>win.webContents.executeJavaScript(source,true), assert=(value,message)=>{if(!value)throw new Error(message)}, steps=[];
const state=()=>js("environmentSummaryState()"), observe=async name=>steps.push({name,state:await state()}), wait=async test=>{for(let n=0;n<160;n++){if(await js(test))return;await sleep(25)}throw new Error("Timed out: "+test)};
const click=async selector=>{const p=await js("environmentSummaryTarget("+JSON.stringify(selector)+")");for(const type of ["mouseMove","mouseDown","mouseUp"])win.webContents.sendInputEvent({type,x:p.x,y:p.y,...(type==="mouseMove"?{}:{button:"left",clickCount:1})});await sleep(80)};
const key=async code=>{win.webContents.focus();for(const type of ["keyDown",...(code==="Space"?["char"]:[]),"keyUp"])win.webContents.sendInputEvent({type,keyCode:type==="char"?" ":code==="Space"?"Space":code});await sleep(80)};
try {await win.loadFile(path.join(output,"web/index.html"));await wait("Boolean(document.querySelector('.environment-card'))");
 assert(!await js("document.querySelector('[data-section=subagents]')||document.querySelector('[data-section=jobs]')||document.querySelector('[data-section=sources]')"),"Available empty activity or empty sources rendered a section"); await observe("available-empty-sections-omitted");
 await click("#mode-unavailable"); await wait("document.querySelectorAll('[data-section=subagents],[data-section=jobs]').length===2"); assert(await js("document.body.textContent.includes('Agents are unavailable')&&document.body.textContent.includes('Jobs are unsupported')"),"Unavailable agents/jobs were not independently visible"); await observe("unavailable-agents-jobs-visible");
 await click("#mode-active"); await wait("document.querySelectorAll('[data-section=side-chats],[data-section=subagents],[data-section=jobs],[data-section=sources]').length===4"); await click("[data-section=side-chats] .environment-row"); await click("[data-section=sources] .environment-sources button"); assert(JSON.stringify((await state()).calls)==='["side-chat","source"]',"Activity callbacks were not preserved"); await observe("nonempty-activity-callbacks");
 const toggle="[data-section=jobs] .environment-section-toggle"; await click(toggle); await wait("document.querySelector('[data-section=jobs] .environment-section-body').hidden"); assert((await js("document.activeElement===document.querySelector("+JSON.stringify(toggle)+")")),"Pointer toggle did not retain DOM focus"); await click("#unrelated-redraw"); assert(await js("document.querySelector('[data-section=jobs] .environment-section-body').hidden"),"Unrelated workspace redraw lost collapsed state"); await observe("pointer-toggle-persists-through-redraw");
 const sourceToggle="[data-section=sources] .environment-section-toggle"; await click(sourceToggle); await key("Space"); await wait("!document.querySelector('[data-section=sources] .environment-section-body').hidden"); assert(await js("document.activeElement===document.querySelector("+JSON.stringify(sourceToggle)+")"),"Keyboard toggle did not retain DOM focus"); assert((await state()).calls.length===2,"Collapsing dispatched an environment action"); await observe("keyboard-toggle-no-dispatch");
 const view=await state(); assert(view.viewport.card.left>=0&&view.viewport.card.top>=0&&view.viewport.card.right<=view.viewport.width&&view.viewport.card.bottom<=view.viewport.height,"Environment card is outside the viewport"); fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,hidden:true,electron:process.versions.electron,input:"Electron webContents.sendInputEvent for pointer and keyboard",steps},null,2));
}catch(error){fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:false,error:String(error.stack||error),steps},null,2));process.exitCode=1}finally{await win.close();app.quit()}});`);
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs"), output, profile], { cwd: profile, stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")), env: { HOME: profile, TMPDIR: profile, PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 60_000); try { exitCode = await electron.exited; } finally { clearTimeout(timer); }
} finally { await rm(profile, { recursive: true, force: true }); }
let result: Record<string, unknown>; try { result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); } catch (cause) { result = { passed:false, resultReadError: cause instanceof Error ? cause.message : String(cause) }; }
result.exitCode=exitCode; result.sourceAtBuild=sourceAtBuild; result.sourceAfterRun=await hashes(); result.sourceHashesStable=JSON.stringify(result.sourceAtBuild)===JSON.stringify(result.sourceAfterRun); result.scope="Actual EnvironmentCard in hidden isolated Electron with a controlled WorkspaceState and controlled activity snapshots. It proves renderer section behavior only; it makes no native OMP execution, host, provider, git, terminal, or source-backend claim."; result.passed=result.passed===true&&exitCode===0&&result.sourceHashesStable;
await writeFile(join(output,"result.json"),JSON.stringify(result,null,2)); if(!result.passed)throw new Error(`Environment summary acceptance failed; inspect ${join(output,"result.json")}`); console.log(JSON.stringify({passed:true,output}));
