import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? ".data/transcript-scroll-acceptance");
await mkdir(output, { recursive: true, mode: 0o700 });
const profile = await mkdtemp(join(tmpdir(), "agent-desktop-scroll-"));
try {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "transcript-scroll-browser.ts")], outdir: output, target: "browser", format: "iife" });
  if (!result.success) throw new Error(result.logs.join("\n"));
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"><title>Transcript scroll acceptance fixture</title><link rel="stylesheet" href="transcript-scroll-browser.css"><style>body{margin:0;background:#181818;color:#eee;font:16px system-ui}.transcript-scroll{height:500px;width:720px;overflow:auto;overflow-anchor:none;position:relative}.transcript{padding:12px 16px}article{margin-bottom:25px}p{line-height:1.5;margin:0 0 12px}pre{white-space:pre-wrap}button{color:inherit;background:#333}</style><div class="transcript-scroll" tabindex="0"><div class="transcript"></div></div><script src="transcript-scroll-browser.js"></script>`);
  await writeFile(join(output, "main.cjs"), `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});try{await window.loadFile(path.join(__dirname,'index.html'));const result=await window.webContents.executeJavaScript("runTranscriptScrollAcceptance().catch(error => { throw new Error((error.name || 'Error') + ': ' + (error.message || String(error))); })");fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.exit(0);}catch(error){fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error)},null,2));console.error(error);app.exit(1);}});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: "inherit", stderr: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
  const code = await child.exited; clearTimeout(timer);
  if (code) throw new Error(`Electron reading-position acceptance failed (${code}).`);
} finally { await rm(profile, { recursive: true, force: true }); }
