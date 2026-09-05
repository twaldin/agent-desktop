import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? `.data/composer-ui-acceptance/${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const profile = await mkdtemp(join(tmpdir(), "agent-composer-ui-"));
const sources = ["apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/Transcript.tsx", "apps/desktop/src/renderer/transcript.css", "apps/desktop/src/renderer/ComposerAutocomplete.tsx", "apps/desktop/src/renderer/composer-autocomplete.ts", "apps/desktop/src/renderer/composer-autocomplete.css", "scripts/acceptance/composer-ui-browser.tsx", "apps/desktop/src/renderer/styles.css"];
const hashes = () => Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])).then(Object.fromEntries);
const before = await hashes();
try {
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'"><title>Isolated composer renderer acceptance</title><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "composer-ui-browser.tsx"))}"></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  await writeFile(join(output, "main.cjs"), `
const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',${JSON.stringify(profile)});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 try{
  await win.loadFile(path.join(__dirname,'web/index.html'));
  const result=await win.webContents.executeJavaScript('runComposerUIAcceptance()');result.captures=[];
  for(const scene of [{name:'reference-wide',width:1780,height:1111,zoom:1},{name:'wide',width:1200,height:1000,zoom:1},{name:'narrow',width:760,height:1000,zoom:1},{name:'zoom150',width:1200,height:1100,zoom:1.5}]){
   win.setContentSize(scene.width,scene.height);win.webContents.setZoomFactor(scene.zoom);
   const geometry=await win.webContents.executeJavaScript('composerUIGeometry()');
   fs.writeFileSync(path.join(__dirname,scene.name+'.png'),(await win.webContents.capturePage()).toPNG());result.captures.push({...scene,...geometry});
  }
  result.hidden=true;result.electron=process.versions.electron;result.passed=result.passed&&result.captures.every(scene=>scene.fitting);
  fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));win.destroy();app.exit(result.passed?0:1);
 }catch(error){const progress=await win.webContents.executeJavaScript('composerUIProgress()').catch(()=>null);fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error),progress},null,2));console.error(error);app.exit(1);}
});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000); const code = await child.exited; clearTimeout(timer);
  const result = await Bun.file(join(output, "result.json")).json(); result.sourceAtBuild = before; result.sourceAfter = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfter); result.passed &&= result.sourceHashesStable;
  result.scope = "Actual production App and autocomplete in isolated hidden Electron. Host catalogs/completions/commands are controlled. No provider/native-session or installed-app actions.";
  result.profileRemovedAfterRun = true; await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks?.length, sourceHashesStable: result.sourceHashesStable, result: join(output, "result.json") }));
  if (code || !result.passed) throw new Error(`Composer UI acceptance failed; inspect ${output}/result.json`);
} finally { await rm(profile, { recursive: true, force: true }); }
