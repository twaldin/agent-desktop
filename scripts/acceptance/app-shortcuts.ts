import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? ".data/app-shortcuts-acceptance");
await mkdir(output, { recursive: true, mode: 0o700 });
const profile = await mkdtemp(join(tmpdir(), "agent-desktop-shortcuts-"));
try {
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "app-shortcuts-browser.tsx")], outdir: output, target: "browser", format: "iife" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"><title>Isolated app shortcut acceptance</title><link rel="stylesheet" href="app-shortcuts-browser.css"><style>body{font:14px system-ui;padding:12px}textarea,input,button{margin:4px}dialog{padding:16px}</style><script src="app-shortcuts-browser.js"></script>`);
  await writeFile(join(output, "main.cjs"), `
const {app,BrowserWindow,Menu}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',${JSON.stringify(profile)});
app.whenReady().then(async()=>{
  Menu.setApplicationMenu(null);
  const window=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  try{
    await window.loadFile(path.join(__dirname,'index.html'));
    const result=await window.webContents.executeJavaScript('runAppShortcutAcceptance()');
    result.electron=process.versions.electron;result.hidden=true;result.nativeInputPreparation=await window.webContents.executeJavaScript('prepareTrustedAppShortcutAcceptance()');
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'N',modifiers:[process.platform==='darwin'?'meta':'control']});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'N',modifiers:[process.platform==='darwin'?'meta':'control']});
    await new Promise(resolve=>setTimeout(resolve,100));
    result.electronInput=await window.webContents.executeJavaScript('finishTrustedAppShortcutAcceptance()');
    fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.exit(0);
  }catch(error){fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error)},null,2));console.error(error);app.exit(1);}
});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: "inherit", stderr: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
  const code = await child.exited; clearTimeout(timer);
  if (code) throw new Error(`Electron app-shortcut acceptance failed (${code}).`);
} finally { await rm(profile, { recursive: true, force: true }); }
