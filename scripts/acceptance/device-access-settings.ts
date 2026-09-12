import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/device-access-settings-${Date.now()}`);
if (existsSync(output) && (await readdir(output)).length) throw new Error(`Output must be empty: ${output}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const sources = [
  "apps/desktop/src/renderer/DeviceAccessSettings.tsx", "apps/desktop/src/renderer/ConnectionsSettings.tsx", "apps/desktop/src/renderer/connections-settings.css",
  "apps/desktop/src/renderer/NativeSwitch.tsx", "apps/desktop/src/renderer/native-switch.css", "apps/desktop/src/renderer/Icons.tsx", "apps/desktop/src/renderer/styles.css",
  "packages/shared/src/device-access.ts", "packages/shared/src/protocol.ts",
  "scripts/acceptance/device-access-settings.ts", "scripts/acceptance/device-access-settings-browser.tsx",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(repo, path))).digest("hex")])));
const sourceAtBuild = await hashes();
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "device-access-settings-browser.tsx"))}"></script>`);
await writeFile(join(output, "tsconfig.fixture.json"), JSON.stringify({ extends: join(repo, "tsconfig.json"), include: [join(repo, "scripts/acceptance/device-access-settings-browser.tsx"), join(repo, "apps/desktop/src/renderer/ConnectionsSettings.tsx"), join(repo, "apps/desktop/src/renderer/DeviceAccessSettings.tsx")] }, null, 2));
const check = Bun.spawn([process.execPath, "x", "tsc", "-p", join(output, "tsconfig.fixture.json"), "--pretty", "false"], { cwd: output, stdout: Bun.file(join(output, "strict.log")), stderr: Bun.file(join(output, "strict-errors.log")), env: { HOME: output, PATH: "/usr/bin:/bin" } });
if (await check.exited !== 0) throw new Error(`Strict fixture compilation failed; inspect ${join(output, "strict-errors.log")}`);
await build({ configFile: false, logLevel: "warn", root: output, plugins: [react()], base: "./", build: { target: "esnext", outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });

const profile = await mkdtemp(join(tmpdir(), "agent-desktop-device-access-"));
let exitCode = -1;
try {
  await writeFile(join(output, "main.cjs"), String.raw`
const {app,BrowserWindow}=require("electron"),fs=require("node:fs"),path=require("node:path");
const output=process.argv[2],profile=process.argv[3],sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));app.setPath("userData",profile);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
 const js=source=>win.webContents.executeJavaScript(source,true),state=()=>js("deviceAccessState()"),steps=[];
 const assert=(value,message)=>{if(!value)throw Error(message)};
 const wait=async source=>{for(let i=0;i<320;i++){if(await js(source))return;await sleep(25)}throw Error("Timed out: "+source)};
 const observe=async name=>steps.push({name,state:await state()});
 const click=async(selector,aria)=>{const point=await js("(()=>{const e=[...document.querySelectorAll("+JSON.stringify(selector)+")].find(e=>e.getClientRects().length&&!e.disabled&&"+(aria===undefined?"true":"e.getAttribute('aria-label')==="+JSON.stringify(aria))+");if(!e)throw Error('Unavailable target '+"+JSON.stringify(aria??selector)+");const b=e.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()");for(const type of ["mouseMove","mouseDown","mouseUp"])win.webContents.sendInputEvent({type,...point,...(type==="mouseMove"?{}:{button:"left",clickCount:1})});await sleep(50)};
 try {
  await win.loadFile(path.join(output,"web/index.html"));
  await wait("deviceAccessState().reads.length===1&&deviceAccessState().text.includes('Loading device access')");
  let current=await state();assert(current.switches[0].disabled&&current.switches[0].checked==="false","Loading switch was not disabled and unchecked");await observe("loading-disabled");
  await js("deviceAccessControl('release-initial-read');true");await wait("deviceAccessState().text.includes('Work Mac')");
  current=await state();assert(current.switches[0].checked==="true"&&!current.switches[0].disabled,"Default supported state did not load enabled");assert(current.actions.length===2,"Default allowed inventory missing");await observe("default-load");

  await js("deviceAccessControl('set-owner',{hostId:'host-local',supported:false,policy:{revision:2,enabled:true,revokedNodeIds:[]}});deviceAccessControl('emit')");
  await wait("deviceAccessState().owner.policy.revision===2&&deviceAccessState().text.includes('Tailscale discovery is disabled')");
  current=await state();assert(current.switches[0].disabled,"Unsupported switch remained enabled");await observe("unsupported-disabled");
  await js("deviceAccessControl('set-owner',{hostId:'host-local',supported:true,policy:{revision:3,enabled:true,revokedNodeIds:[]}});deviceAccessControl('emit')");
  await wait("deviceAccessState().switches[0].disabled===false&&deviceAccessState().owner.policy.revision===3");

  await click('.connections-access-button','Revoke access for Work Mac');
  await wait("Boolean(deviceAccessState().pending)");
  await click('.connections-access-button','Revoke access for Work Mac').catch(()=>{});
  current=await state();assert(current.updates.length===1,"Pending double action dispatched more than once");assert(current.actions.every(action=>action.disabled),"A device action remained enabled during revoke");assert(current.actions.find(action=>action.aria==='Revoke access for Work Mac')?.spinning,"Selected revoke did not show loading");assert(current.actions.filter(action=>action.spinning).length===1,"More than selected revoke showed loading");await observe("revoke-selected-loading-all-disabled");
  await js("deviceAccessControl('resolve-update')");
  await wait("!deviceAccessState().pending&&deviceAccessState().owner.policy.revision===4&&!deviceAccessState().actions.some(action=>action.aria==='Revoke access for Work Mac')");
  current=await state();assert(!current.text.includes('Access revoked'),"Revoked device leaked into the closed primary inventory");assert(current.statuses.includes('Revoked device access'),"Revoke success notice missing");await observe("revoke-removes-allowed-row");

  await click('.connections-access-button','Revoke access for Phone');await wait("Boolean(deviceAccessState().pending)");
  await js("deviceAccessControl('fail-update','Controlled revision conflict')");
  await wait("!deviceAccessState().pending&&deviceAccessState().alerts.some(value=>value.includes('Controlled revision conflict'))");
  current=await state();assert(current.actions.some(action=>action.aria==='Revoke access for Phone'),"Failed mutation removed allowed device");assert(current.updates.length===2,"Failed mutation repeated unexpectedly");await observe("failure-preserves-device-no-repeat");
  await js("deviceAccessControl('set-owner',{hostId:'host-local',supported:true,policy:{revision:5,enabled:true,revokedNodeIds:['node-work']}});true");
  await click('[role=alert] button','Refresh').catch(async()=>{await click('[role=alert] button')});
  await wait("deviceAccessState().alerts.length===0&&deviceAccessState().actions.some(action=>action.aria==='Revoke access for Phone')");await observe("refresh-accepts-newer-owner-policy");

  await js("deviceAccessControl('set-owner',{hostId:'host-local',supported:true,policy:{revision:6,enabled:true,revokedNodeIds:['node-work','node-phone']}});deviceAccessControl('emit')");
  await wait("deviceAccessState().owner.policy.revision===6&&deviceAccessState().text.includes('Add device to control this Mac remotely')");
  current=await state();assert(current.actions.length===0,"Revoked devices leaked into the primary inventory");
  await observe("subscription-accepts-newer-owner-policy");

  await js("deviceAccessControl('capture-and-emit');true");
  await wait("deviceAccessState().reads.at(-1).deferred===true");
  await click('[role=switch]','Allow connections');await wait("Boolean(deviceAccessState().pending)");await js("deviceAccessControl('resolve-update')");
  await wait("!deviceAccessState().pending&&deviceAccessState().owner.policy.revision===7&&deviceAccessState().switches[0].checked==='false'");
  await js("deviceAccessControl('release-captured-read',{hostId:'host-local',supported:true,policy:{revision:6,enabled:true,revokedNodeIds:['node-work','node-phone']}});true");await sleep(100);
  current=await state();assert(current.switches[0].checked==="false","Stale read overwrote completed availability update");assert(!current.text.includes('Revoked devices')&&!current.text.includes('Work Mac'),"Availability off did not collapse access lists");await observe("stale-read-ignored-and-off-collapses");

  await click('[role=switch]','Allow connections');await wait("Boolean(deviceAccessState().pending)");await js("deviceAccessControl('resolve-update')");
  await wait("!deviceAccessState().pending&&deviceAccessState().owner.policy.revision===8&&deviceAccessState().text.includes('Add device to control this Mac remotely')");
  current=await state();assert(current.actions.length===0&&current.text.includes('Add device to control this Mac remotely'),"Availability on did not restore the empty authorized inventory");await observe("on-restores-inventory");

  await click('.connections-add-button');await wait("document.querySelector('dialog[open]')?.getAttribute('aria-label')==='Add device'");
  await click('.connections-access-button','Allow access for Work Mac');await wait("Boolean(deviceAccessState().pending)");await js("deviceAccessControl('resolve-update')");
  await wait("!deviceAccessState().pending&&deviceAccessState().owner.policy.revision===9&&deviceAccessState().text.includes('Allowed device')");
  current=await state();assert(!current.owner.policy.revokedNodeIds.includes('node-work'),"Allow did not remove the device restriction");assert(current.actions.some(action=>action.aria==='Revoke access for Work Mac'),"Allowed device did not return to allowed inventory");assert(current.statuses.includes('Device access allowed'),"Allow success notice missing");await observe("allow-removes-restriction");
  fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,hidden:true,electron:process.versions.electron,input:"Electron sendInputEvent pointer; controlled deferred bridge reads and updates",steps},null,2));
 } catch(error) { fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:false,error:String(error.stack||error),state:await state().catch(()=>null),steps},null,2)); }
 finally { win.close(); app.quit(); }
});
`);
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs"), output, profile], { cwd: profile, stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")), env: { HOME: profile, TMPDIR: profile, PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 60_000);
  try { exitCode = await electron.exited; } finally { clearTimeout(timer); }
} finally { await rm(profile, { recursive: true, force: true }); }

let result: Record<string, unknown>;
try { result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); }
catch (cause) { result = { passed: false, resultReadError: cause instanceof Error ? cause.message : String(cause) }; }
result.exitCode = exitCode;
result.sourceAtBuild = sourceAtBuild;
result.sourceAfterRun = await hashes();
result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun);
result.scope = "Actual ConnectionsSettings and DeviceAccessSettings with production CSS in hidden isolated Electron. Controlled local bridge only; no host, Tailscale, provider, persisted policy, or native visual proof.";
result.passed = result.passed === true && exitCode === 0 && result.sourceHashesStable;
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
if (!result.passed) throw new Error(`Device access settings acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed: true, output }));
