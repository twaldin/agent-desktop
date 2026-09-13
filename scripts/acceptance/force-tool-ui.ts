import { build } from "vite";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? ".data/force-tool-ui-component-dom");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "agent-force-tool-ui-"));
const files = ["apps/desktop/src/renderer/ForceToolControl.tsx", "apps/desktop/src/renderer/use-force-tool.ts", "apps/desktop/src/renderer/force-tool-state.ts", "apps/desktop/src/renderer/force-tool.css", "scripts/acceptance/force-tool-ui-browser.tsx", "scripts/acceptance/force-tool-ui.ts"];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(join(root, file))).digest("hex")])));
const before = await hashes();
await writeFile(join(output, "source-before.json"), JSON.stringify(before, null, 2));
try {
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated force-tool component</title><script type="module" src="${relative(output, join(import.meta.dir, "force-tool-ui-browser.tsx"))}"></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: output, cacheDir: join(output, ".vite"), logLevel: "warn", build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  await writeFile(join(output, "main.cjs"), `const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:800,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});try{await win.loadFile(path.join(__dirname,'web/index.html'));const result=await win.webContents.executeJavaScript('runForceToolUiAcceptance()');result.captures=[];for(const scene of [{name:'wide',width:800,height:900,zoom:1},{name:'narrow',width:360,height:760,zoom:1},{name:'zoom150',width:800,height:900,zoom:1.5}]){win.setContentSize(scene.width,scene.height);win.webContents.setZoomFactor(scene.zoom);const geometry=await win.webContents.executeJavaScript('showForceToolUiScene()');fs.writeFileSync(path.join(__dirname,scene.name+'.png'),(await win.webContents.capturePage()).toPNG());result.captures.push({...scene,...geometry});}result.passed=result.passed&&result.captures.every(s=>s.fits);result.electron=process.versions.electron;fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));app.exit(result.passed?0:1);}catch(error){fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error.stack||error)},null,2));fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(1);}});`);
  const process = Bun.spawn([Bun.which("bun")!, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const exit = await process.exited;
  const after = await hashes();
  await writeFile(join(output, "source-after.json"), JSON.stringify(after, null, 2));
  await writeFile(join(output, "source-provenance.json"), JSON.stringify({ before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) }, null, 2));
  console.log(await readFile(join(output, "result.json"), "utf8"));
  if (exit || JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Component DOM acceptance failed or source changed during capture.");
} finally { await rm(profile, { recursive: true, force: true }); }
