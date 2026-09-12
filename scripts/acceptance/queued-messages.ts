import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/queued-messages-${Date.now()}`);
const sources = [
  "apps/desktop/src/renderer/QueuedMessages.tsx", "apps/desktop/src/renderer/queued-message-icons.tsx", "apps/desktop/src/renderer/queued-messages-state.ts", "apps/desktop/src/renderer/queued-messages.css", "packages/shared/src/queued-messages.ts", "apps/desktop/src/renderer/Icons.tsx", "apps/desktop/src/renderer/styles.css", "apps/desktop/src/renderer/theme.css", "scripts/acceptance/queued-messages.ts", "scripts/acceptance/queued-messages-browser.tsx",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty");
const before = await hashes();
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><title>Queued messages</title><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "queued-messages-browser.tsx"))}"></script>`);
await build({ configFile: join(repo, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
await writeFile(join(output, "main.cjs"), String.raw`
const {app,BrowserWindow}=require("electron"),fs=require("node:fs"),path=require("node:path");
const output=process.argv[2];app.setPath("userData",path.join(output,"profile"));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});const js=s=>win.webContents.executeJavaScript(s),sleep=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],snapshots=[];
const wait=async(s)=>{for(let i=0;i<320;i++){const value=await js(s);if(value)return value;await sleep(25)}throw Error("Timed out: "+s)};
try{await win.loadFile(path.join(output,"web/index.html"));await wait("window.queueFixture?.state()");
 const click=async(id,label)=>js("document.querySelector('[data-queue-id=\""+id+"\"] [aria-label=\""+label+"\"]').click()");
 await wait("window.queueFixture.state().ids.length===3");
 fs.writeFileSync(path.join(output,"queue-wide.png"),(await win.webContents.capturePage()).toPNG());
 await click("epoch:first","Move queued message down");await wait("window.queueFixture.state().ids[0]==='epoch:second'");checks.push("actual row move dispatches captured order and renders acknowledged native snapshot");
 if(!await js("document.querySelector('[data-queue-id=\"epoch:first\"] [aria-label=\"Move queued message down\"]').disabled"))throw Error("Cross-lane move enabled");
 await click("epoch:follow-up","Send queued message now");await wait("!document.querySelector('[aria-label=\"Send queued message now\"]')");checks.push("follow-up promotion updates delivered lane; cross-lane reorder unavailable");
 await js("window.queueFixture.setFail(true)");await click("epoch:first","Delete queued message");await wait("window.queueFixture.state().error?.includes('Original queue update refused')");if(!await js("window.queueFixture.state().ids.includes('epoch:first')"))throw Error("Failed delete lost input");checks.push("failed delete retains original row and displays error without replay");
 await js("window.queueFixture.setFail(false);document.querySelector('[role=alert] button').click()");await wait("!window.queueFixture.state().error");await click("epoch:first","Delete queued message");await wait("!window.queueFixture.state().ids.includes('epoch:first')");checks.push("explicit refresh then delete removes only acknowledged original message");
 const state=await js("window.queueFixture.state()");if(state.calls.length!==4||state.calls.some(c=>c.hostId!=='original-host'||c.sessionId!=='original-session'))throw Error("Wrong owner or replay");
 win.setContentSize(520,520);await sleep(100);if(await js("document.body.scrollWidth>innerWidth"))throw Error("Horizontal overflow");await js("window.queueFixture.seedMany()");await wait("window.queueFixture.state().ids.length===30");if(!await js("(()=>{const list=document.querySelector('.queued-messages ol');return list.clientHeight<=innerHeight*.3+1 && list.scrollHeight>list.clientHeight && document.body.scrollWidth<=innerWidth})()"))throw Error("Long queue overflow differs");checks.push("many long queued rows scroll within30dvh without horizontal overflow");snapshots.push(await js("window.queueFixture.state()"));fs.writeFileSync(path.join(output,"queue-narrow.png"),(await win.webContents.capturePage()).toPNG());await js("window.queueFixture.setConnected(false)");await wait("!document.querySelector('[aria-label=\"Queued messages\"]')");checks.push("narrow rows fit and disconnected owner drops controls");
 fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,checks,snapshots,scope:"Actual maintained queue component/state and theme in isolated hidden Electron; controlled native queue bridge, not actual host/worker/provider/full-App or pinned pixel parity."},null,2));app.exit(0)}catch(error){fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:false,error:String(error),checks,snapshots,state:await js("window.queueFixture?.state()").catch(()=>null)},null,2));app.exit(1)}});`);
const child = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
const timer = setTimeout(() => child.kill("SIGTERM"), 60_000); const code = await child.exited; clearTimeout(timer);
const result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); result.sourceAtBuild = before; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(before) === JSON.stringify(result.sourceAfterRun); result.passed &&= code === 0 && result.sourceHashesStable; await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
if (!result.passed) throw new Error(`Queued messages acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed: true, checks: result.checks.length, output }));
