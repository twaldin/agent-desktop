import { build } from "vite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/environment-card/${Date.now()}`);
const profile = await mkdtemp(join(tmpdir(), "env-card-"));
const sources = ["apps/desktop/src/renderer/EnvironmentCard.tsx", "apps/desktop/src/renderer/environment-card.css", "scripts/acceptance/environment-card-browser.tsx"];
const hashes = () => Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])).then(Object.fromEntries);
await mkdir(output, { recursive: true });
try {
  const before = await hashes();
  await writeFile(join(output, "index.html"), `<!doctype html><style>html,body,#root{margin:0;width:100%;height:100%;overflow:auto}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "environment-card-browser.tsx"))}"></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  await writeFile(join(output, "main.cjs"), `const{app,BrowserWindow,nativeTheme}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:360,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});try{await win.loadFile(path.join(__dirname,'web/index.html'));const result=await win.webContents.executeJavaScript('runEnvironmentAcceptance()');result.scenes=[];for(const scene of [{theme:'dark',width:360},{theme:'light',width:260}]){nativeTheme.themeSource=scene.theme;win.setContentSize(scene.width,700);await new Promise(resolve=>setTimeout(resolve,150));const geometry=await win.webContents.executeJavaScript('environmentGeometry()');fs.writeFileSync(path.join(__dirname,scene.theme+'.png'),(await win.webContents.capturePage()).toPNG());result.scenes.push({...scene,geometry})}nativeTheme.themeSource='system';result.hidden=true;result.passed&&=result.scenes.every(scene=>scene.geometry.fitting)&&result.scenes[0].geometry.background!==result.scenes[1].geometry.background&&result.scenes[0].geometry.color!==result.scenes[1].geometry.color;fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));win.destroy();app.exit(result.passed?0:1)}catch(error){fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error)},null,2));app.exit(1)}});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
  const code = await child.exited;
  clearTimeout(timer);
  const result = await Bun.file(join(output, "result.json")).json();
  result.sourceAtBuild = before;
  result.sourceAfter = await hashes();
  result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfter);
  result.passed &&= result.sourceHashesStable;
  result.scope = "Actual EnvironmentCard in hidden sandboxed Electron with controlled WorkspaceState and activity; no App, host, or provider action.";
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, checks: result.calls?.length, result: join(output, "result.json") }));
  if (code || !result.passed) throw new Error(`Environment card acceptance failed; inspect ${output}/result.json`);
} finally { await rm(profile, { recursive: true, force: true }); }
