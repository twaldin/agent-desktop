import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/keep-awake-settings-${Date.now()}`);
if (existsSync(output) && (await readdir(output)).length) throw new Error(`Output must be empty: ${output}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const sources = [
  "apps/desktop/src/renderer/KeepAwakeSettings.tsx", "apps/desktop/src/renderer/NativeSwitch.tsx", "apps/desktop/src/renderer/native-switch.css",
  "apps/desktop/src/renderer/connections-settings.css", "apps/desktop/src/renderer/preferences-state.ts", "apps/desktop/src/renderer/styles.css",
  "packages/shared/src/preferences.ts", "packages/shared/src/protocol.ts",
  "scripts/acceptance/keep-awake-settings.ts", "scripts/acceptance/keep-awake-settings-browser.tsx",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(repo, path))).digest("hex")])));
const before = await hashes();
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%}main{width:640px;padding:40px}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "keep-awake-settings-browser.tsx"))}"></script>`);
await writeFile(join(output, "tsconfig.fixture.json"), JSON.stringify({ extends: join(repo, "tsconfig.json"), include: [join(repo, "scripts/acceptance/keep-awake-settings-browser.tsx"), join(repo, "apps/desktop/src/renderer/KeepAwakeSettings.tsx")] }, null, 2));
const check = Bun.spawn([process.execPath, "x", "tsc", "-p", join(output, "tsconfig.fixture.json"), "--pretty", "false"], { cwd: output, stdout: Bun.file(join(output, "strict.log")), stderr: Bun.file(join(output, "strict-errors.log")), env: { HOME: output, PATH: "/usr/bin:/bin" } });
if (await check.exited !== 0) throw new Error(`Strict fixture compilation failed; inspect ${join(output, "strict-errors.log")}`);
await build({ configFile: false, logLevel: "warn", root: output, plugins: [react()], base: "./", build: { target: "esnext", outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });

const profile = await mkdtemp(join(tmpdir(), "agent-desktop-keep-awake-settings-"));
let exitCode = -1;
try {
  await writeFile(join(output, "main.cjs"), String.raw`
const {app,BrowserWindow}=require("electron"),fs=require("node:fs"),path=require("node:path");
const output=process.argv[2],profile=process.argv[3],sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));app.setPath("userData",profile);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:800,height:500,webPreferences:{sandbox:true,contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
 const js=source=>win.webContents.executeJavaScript(source,true),state=()=>js("keepAwakeState()"),steps=[];
 const assert=(value,message)=>{if(!value)throw Error(message)};
 const wait=async source=>{for(let i=0;i<320;i++){if(await js(source))return;await sleep(25)}throw Error("Timed out: "+source)};
 const observe=async name=>steps.push({name,state:await state()});
 const click=async(selector,text)=>{const point=await js("(()=>{const e=[...document.querySelectorAll("+JSON.stringify(selector)+")].find(e=>e.getClientRects().length&&!e.disabled&&"+(text===undefined?"true":"e.textContent.includes("+JSON.stringify(text)+")")+");if(!e)throw Error('Unavailable target');const b=e.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()");for(const type of ["mouseMove","mouseDown","mouseUp"])win.webContents.sendInputEvent({type,...point,...(type==="mouseMove"?{}:{button:"left",clickCount:1})});await sleep(50)};
 try {
  await win.loadFile(path.join(output,"web/index.html"));await wait("keepAwakeState().statusReads.length===1");
  let current=await state();assert(current.switch.checked==="false"&&current.switch.disabled,"Absent preference or loading status did not render disabled false");assert(current.switch.label==="Keep this Mac awake","Production switch label differs");await observe("late-initial-status-disabled-default-false");
  await js("keepAwakeControl('release-initial-status');true");await wait("keepAwakeState().switch.disabled===false");await observe("supported-status-enables-write");

  await click('[role=switch]');await wait("Boolean(keepAwakeState().pendingCommand)");
  await click('[role=switch]').catch(()=>{});current=await state();assert(current.commands.length===1,"Pending preference click repeated the command");assert(current.commands[0].command.change.key==="connections.keepAwakeWhilePluggedIn"&&current.commands[0].command.change.value===true,"Write did not carry the keep-awake boolean");assert(current.switch.disabled&&current.switch.checked==="false","Unacknowledged preference changed the switch");assert(current.alerts.some(value=>value.includes('awaiting confirmation')),"Pending receipt state was not visible");await observe("pending-save-disabled-not-optimistic");
  await js("keepAwakeControl('resolve-command')");await wait("keepAwakeState().switch.checked==='true'&&!keepAwakeState().pendingCommand&&!keepAwakeState().preferenceBusy");
  current=await state();assert(current.preferences===true&&current.pendingPreferences.length===0,"Acknowledged value was not ingested");assert(current.records[0].revision.opId===current.commands[0].id,"Receipt did not bind the original command ID");assert(current.cacheWrites.some(item=>item.value.includes('connections.keepAwakeWhilePluggedIn')),"Acknowledged preference was not persisted to the production cache");await observe("acknowledged-save-persisted");

  await click('[role=switch]');await wait("Boolean(keepAwakeState().pendingCommand)");await js("keepAwakeControl('fail-command')");
  await wait("keepAwakeState().alerts.some(value=>value.includes('Controlled preference save failed'))");current=await state();assert(current.switch.checked==="true","Failed save changed the committed switch value");assert(current.pendingPreferences.length===0&&current.commands.length===2,"Definite failure was retained or replayed");await observe("failed-save-preserves-committed-value");
  await click('[role=alert] button','Refresh preferences');await wait("keepAwakeState().alerts.length===0&&keepAwakeState().switch.disabled===false");

  await js("keepAwakeControl('set-status',{supported:false,active:false});keepAwakeControl('emit-status');true");await wait("keepAwakeState().text.includes('Sleep prevention is unavailable')");current=await state();assert(current.switch.disabled,"Unsupported platform left switch writable");await observe("unsupported-status-disabled");

  await js("keepAwakeControl('capture-status-and-emit');true");await wait("keepAwakeState().statusReads.at(-1).deferred===true");
  await js("keepAwakeControl('set-status',{supported:true,active:false,onBattery:false});keepAwakeControl('emit-status');true");await wait("keepAwakeState().switch.disabled===false&&!keepAwakeState().text.includes('Sleep prevention is unavailable')");
  await js("keepAwakeControl('release-captured-status',{supported:false,active:false});true");await sleep(100);current=await state();assert(!current.switch.disabled&&!current.text.includes('Sleep prevention is unavailable'),"Late older status overwrote newer supported status");await observe("late-status-cannot-overwrite-newer-result");

  fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,hidden:true,electron:process.versions.electron,input:"Electron sendInputEvent pointer; actual PreferencesState over controlled deferred owner bridge",steps},null,2));
 } catch(error) { fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:false,error:String(error.stack||error),state:await state().catch(()=>null),steps},null,2)); }
 finally { win.close();app.quit(); }
});
`);
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs"), output, profile], { cwd: profile, stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")), env: { HOME: profile, TMPDIR: profile, PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 60_000); try { exitCode = await electron.exited; } finally { clearTimeout(timer); }
} finally { await rm(profile, { recursive: true, force: true }); }

let result: Record<string, unknown>;
try { result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); } catch (cause) { result = { passed: false, resultReadError: cause instanceof Error ? cause.message : String(cause) }; }
result.exitCode = exitCode; result.sourceBeforeBuild = before; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceBeforeBuild) === JSON.stringify(result.sourceAfterRun);
result.scope = "Actual KeepAwakeSettings, NativeSwitch, PreferencesState and production CSS in hidden isolated Electron. Controlled owner bridge only; no OS power-save blocker, host persistence, network, provider, or native visual proof.";
result.passed = result.passed === true && exitCode === 0 && result.sourceHashesStable;
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
if (!result.passed) throw new Error(`Keep-awake settings acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed: true, output }));
