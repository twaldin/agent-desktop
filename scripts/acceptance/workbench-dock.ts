import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/workbench-dock-acceptance/${Date.now()}`);
const profile = await mkdtemp(join(tmpdir(), "agent-workbench-dock-"));
const sources = ["apps/desktop/src/renderer/use-workbench-dock.tsx", "apps/desktop/src/renderer/dock-state.ts", "apps/desktop/src/renderer/native-terminal-bridge.ts", "scripts/acceptance/workbench-dock-browser.tsx", "scripts/acceptance/workbench-dock.ts"];
const hashes = () => Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])).then(Object.fromEntries);
const before = await hashes();
await mkdir(output, { recursive: true, mode: 0o700 });
try {
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "workbench-dock-browser.tsx"))}"></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  await writeFile(join(output, "main.cjs"), `const{app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});try{await win.loadFile(path.join(__dirname,'web/index.html'));const result=await win.webContents.executeJavaScript('runWorkbenchDockAcceptance()');result.hidden=true;result.electron=process.versions.electron;fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));win.destroy();app.exit(result.passed?0:1)}catch(error){const progress=await win.webContents.executeJavaScript('workbenchDockProgress()').catch(()=>null);fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error),progress},null,2));app.exit(1)}});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000); const code = await child.exited; clearTimeout(timer);
  const result = await Bun.file(join(output, "result.json")).json(); result.sourceAtBuild = before; result.sourceAfter = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfter); result.passed &&= result.sourceHashesStable;
  result.scope = "Actual useWorkbenchDock hook in hidden sandboxed Electron with controlled native terminal query/action envelopes; no host, tmux pane, provider, or installed-app action.";
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks?.length, sourceHashesStable: result.sourceHashesStable, result: join(output, "result.json") }));
  if (code || !result.passed) throw new Error(`Workbench dock acceptance failed; inspect ${output}/result.json`);
} finally { await rm(profile, { recursive: true, force: true }); }
