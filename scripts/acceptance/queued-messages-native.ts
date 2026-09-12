import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import type { CommandEnvelope, CommandResult, SessionSummary } from "../../packages/shared/src/protocol";
import { startHost } from "../../apps/host/src/server";

const repo = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? `.data/queued-messages-native-${Date.now()}`);
if (existsSync(output) && (await readdir(output)).length) throw new Error(`Output must be empty: ${output}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const sources = ["apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/QueuedMessages.tsx", "apps/desktop/src/renderer/queued-messages-state.ts",
  "apps/desktop/src/renderer/queued-messages.css", "apps/desktop/src/renderer/queued-message-icons.tsx",
  "apps/host/src/omp/queued-messages.ts", "apps/host/src/queued-messages-http.ts", "apps/host/src/server.ts", "apps/host/src/omp-workers/fixtures/queue-provider.ts",
  "scripts/acceptance/queued-messages-native.ts", "scripts/acceptance/queued-messages-native-browser.tsx"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(path.join(repo, file))).digest("hex")])));
const sourceAtBuild = await hashes(), isolated = await mkdtemp(path.join(tmpdir(), "agent-desktop-queue-native-"));
const agent = path.join(isolated, "agent"), project = path.join(isolated, "project"), gates = path.join(isolated, "gates");
await Promise.all([mkdir(agent), mkdir(project), mkdir(gates)]);
const previousQueueGates = process.env.QUEUE_ACCEPTANCE_GATES;
process.env.QUEUE_ACCEPTANCE_GATES = gates;
await writeFile(path.join(agent, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../../apps/host/src/omp-workers/fixtures/queue-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
const host = await startHost({ dataDirectory: path.join(isolated, "data"), agentDirectory: agent, discoveryDirectory: project,
  workerPath: fileURLToPath(new URL("../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts", import.meta.url)), tailscale: false, port: 0 });
const auth = { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" };
const command = async (envelope: CommandEnvelope): Promise<CommandResult> => {
  const response = await fetch(`${host.connection.origin}/v1/commands`, { method: "POST", headers: auth, body: JSON.stringify(envelope) });
  assert.equal(response.status, 200); return response.json();
};
const waitFile = async (file: string) => { const deadline = Date.now() + 8_000; while (!await Bun.file(file).exists() && Date.now() < deadline) await Bun.sleep(10); assert(await Bun.file(file).exists()); };
let electron: ReturnType<typeof Bun.spawn> | undefined;
try {
  const created = await command({ id: crypto.randomUUID(), command: { type: "session.create", projectId: null, cwd: project } }); assert(created.ok);
  const session = created.value as SessionSummary;
  const prompt = await command({ id: crypto.randomUUID(), command: { type: "session.prompt", sessionId: session.id, text: "Hold native queue",
    model: { provider: "queue-acceptance", id: "controlled" } } });
  assert(prompt.ok); assert.equal(prompt.admission?.kind, "user-message");
  await waitFile(path.join(gates, "1.started"));
  await writeFile(path.join(output, "index.html"), `<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.__QUEUE_NATIVE__=${JSON.stringify({ origin: host.connection.origin, token: host.connection.token, hostId: host.store.host.id, sessionId: session.id })}</script><script type="module" src="${relative(output, path.join(import.meta.dir, "queued-messages-native-browser.tsx"))}"></script>`);
  await writeFile(path.join(output, "tsconfig.fixture.json"), JSON.stringify({ extends: path.join(repo, "tsconfig.json"), include: [path.join(repo, "scripts/acceptance/queued-messages-native-browser.tsx"), path.join(repo, "apps/desktop/src/renderer/QueuedMessages.tsx")] }, null, 2));
  const check = Bun.spawn([process.execPath, "x", "tsc", "-p", path.join(output, "tsconfig.fixture.json"), "--pretty", "false"], { cwd: output, stdout: Bun.file(path.join(output, "strict.log")), stderr: Bun.file(path.join(output, "strict-errors.log")), env: { HOME: isolated, PATH: "/usr/bin:/bin" } });
  if (await check.exited !== 0) throw new Error("Strict fixture compilation failed");
  await build({ configFile: path.join(repo, "apps/desktop/vite.config.ts"), root: output, plugins: [react()], base: "./", build: { target: "esnext", outDir: path.join(output, "web"), rollupOptions: { input: path.join(output, "index.html") } } });
  await writeFile(path.join(output, "main.cjs"), String.raw`
const {app,BrowserWindow}=require("electron"),WebSocket=require("ws"),fs=require("node:fs"),path=require("node:path");const out=process.argv[2],profile=process.argv[3],sleep=ms=>new Promise(r=>setTimeout(r,ms));app.setPath("userData",profile);
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{contextIsolation:false,nodeIntegration:false,webSecurity:false,backgroundThrottling:false}}),js=s=>win.webContents.executeJavaScript(s,true),steps=[];
const wait=async s=>{for(let i=0;i<320;i++){if(await js(s))return;await sleep(25)}throw Error("Timed out: "+s)},state=()=>js("queueNativeState()"),click=async(row,label)=>{const point=await js("(()=>{const r=[...document.querySelectorAll('.queued-message')].find(e=>e.textContent.includes("+JSON.stringify(row)+"));const b=[...r.querySelectorAll('button')].find(e=>e.ariaLabel==="+JSON.stringify(label)+"&&!e.disabled);if(!b)throw Error('Unavailable '+"+JSON.stringify(label)+");const q=b.getBoundingClientRect();return{x:q.x+q.width/2,y:q.y+q.height/2}})()");for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});await sleep(60)};
try{await win.loadFile(path.join(out,'web/index.html'));const socket=new WebSocket(${JSON.stringify(host.connection.origin.replace("http:", "ws:") + "/v1/events")},['agent-desktop',${JSON.stringify(host.connection.token)}]);socket.on('message',raw=>{try{const value=JSON.parse(String(raw));if(value.type==='queued-messages'&&value.sessionId===${JSON.stringify(session.id)})void js('queueNativeInvalidate()')}catch{}});await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});await wait("queueNativeState().rows.length===3");steps.push({name:'real-native-inventory',state:await state()});await click('First native steer','Move queued message down');await wait("queueNativeState().rows[0].text.includes('Second native steer')");steps.push({name:'same-lane-reorder',state:await state()});await click('Native follow-up','Send queued message now');await wait("queueNativeState().rows.every(r=>r.lane==='Steering message')");steps.push({name:'promote-native-follow-up',state:await state()});await click('Second native steer','Delete queued message');await wait("queueNativeState().rows.length===2&&!queueNativeState().rows.some(r=>r.text.includes('Second native steer'))&&queueNativeState().invalidations>=3");steps.push({name:'remove-and-invalidation',state:await state()});socket.close();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,hidden:true,electron:process.versions.electron,steps},null,2));}catch(e){fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:String(e.stack||e),state:await state().catch(()=>null),steps},null,2))}finally{win.close();app.quit()}});`);
  const profile = path.join(isolated, "electron-profile"); await mkdir(profile);
  electron = Bun.spawn([process.execPath, path.join(repo, "node_modules/electron/cli.js"), path.join(output, "main.cjs"), output, profile], { cwd: isolated,
    stdout: Bun.file(path.join(output, "electron.log")), stderr: Bun.file(path.join(output, "electron-errors.log")), env: { HOME: isolated, TMPDIR: isolated, PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => electron?.kill("SIGTERM"), 60_000); let exitCode: number; try { exitCode = await electron.exited; } finally { clearTimeout(timer); }
  const result = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"));
  result.exitCode = exitCode; result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(sourceAtBuild) === JSON.stringify(result.sourceAfterRun);
  result.scope = "Production QueuedMessages in hidden Electron against isolated real host HTTP, worker IPC, OMP queue and websocket invalidation. The browser bridge directly calls authenticated host HTTP; this does not prove production main/preload routing or native pixel parity.";
  result.passed = result.passed === true && exitCode === 0 && result.sourceHashesStable;
  await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error(`Native queue acceptance failed: ${path.join(output, "result.json")}`);
  await writeFile(path.join(gates, "1.release"), "");
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  electron?.kill("SIGTERM"); await host.stop(); await rm(isolated, { recursive: true, force: true });
  if (previousQueueGates === undefined) delete process.env.QUEUE_ACCEPTANCE_GATES; else process.env.QUEUE_ACCEPTANCE_GATES = previousQueueGates;
}
