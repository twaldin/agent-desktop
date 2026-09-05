import { build } from "vite";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dir, "../.."), out = resolve(process.argv[2] ?? `.data/browser-panel/${Date.now()}`);
const profile = await mkdtemp(join(tmpdir(), "browser-panel-"));
const sources = ["apps/desktop/src/renderer/BrowserPanel.tsx", "apps/desktop/src/renderer/browser-panel.css", "scripts/acceptance/browser-panel-browser.tsx", "scripts/acceptance/browser-panel.ts", "scripts/acceptance/fixtures/browser-preview.jpg"];
const hashes = () => Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])).then(Object.fromEntries);
await mkdir(out, { recursive: true });
try {
  const before = await hashes();
  await writeFile(join(out, "index.html"), `<meta charset="utf-8"><div id="root"></div><script type="module" src=${JSON.stringify(relative(out, join(import.meta.dir, "browser-panel-browser.tsx")))}></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: out, logLevel: "warn", build: { outDir: join(out, "web"), emptyOutDir: true, rollupOptions: { input: join(out, "index.html") } } });
  await writeFile(join(out, "main.cjs"), `const{app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',${JSON.stringify(profile)});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:720,height:500,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
try{await w.loadFile(path.join(__dirname,'web/index.html'));const r=await w.webContents.executeJavaScript('runBrowserPanelAcceptance()');r.scenes=[];
for(const s of [{name:'wide',width:1200,height:800,zoom:1},{name:'narrow',width:320,height:500,zoom:1},{name:'zoom150',width:900,height:600,zoom:1.5}]){w.setContentSize(s.width,s.height);w.webContents.setZoomFactor(s.zoom);await new Promise(x=>setTimeout(x,100));r.scenes.push({...s,...await w.webContents.executeJavaScript('browserGeometry()')});fs.writeFileSync(path.join(__dirname,s.name+'.png'),(await w.webContents.capturePage()).toPNG());}
r.passed&&=r.scenes.every(x=>x.fitting);fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(r,null,2));w.destroy();app.exit(r.passed?0:1);
}catch(error){const progress=await w.webContents.executeJavaScript('browserPanelProgress()').catch(()=>null);fs.writeFileSync(path.join(__dirname,'failure.png'),(await w.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error),progress},null,2));app.exit(1);}});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(out, "main.cjs")], { stdout: Bun.file(join(out, "electron.log")), stderr: Bun.file(join(out, "electron-errors.log")) });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
  const code = await child.exited; clearTimeout(timer);
  const result = await Bun.file(join(out, "result.json")).json();
  result.sourceAtBuild = before; result.sourceAfter = await hashes(); result.sourceHashesStable = JSON.stringify(before) === JSON.stringify(result.sourceAfter); result.passed &&= result.sourceHashesStable;
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks?.length, captures: result.scenes?.length, result: join(out, "result.json") }));
  if (code || !result.passed) throw new Error("Browser panel acceptance failed.");
} finally { await rm(profile, { recursive: true, force: true }); }
