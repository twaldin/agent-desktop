import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// A real isolated Chromium origin/profile; no installed app, provider, or host service is involved.
const root = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? `.data/attachment-cache-acceptance/${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const profile = await mkdtemp(join(tmpdir(), "agent-desktop-attachment-cache-"));
const sourceFiles = ["apps/desktop/src/renderer/attachment-cache.ts", "packages/shared/src/attachments.ts", "scripts/acceptance/attachment-cache-browser.ts", "scripts/acceptance/attachment-cache.ts"];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await readFile(join(root, file))).digest("hex")])));
const before = await hashes();
let server: ReturnType<typeof Bun.serve> | undefined;
let quotaServer: ReturnType<typeof Bun.serve> | undefined;
try {
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "attachment-cache-browser.ts")], outdir: output, format: "iife", target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; img-src blob:; connect-src 'none'"><title>Isolated binary cache acceptance</title><script src="/attachment-cache-browser.js"></script>`);
  const serveFixture = (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path !== "/index.html" && path !== "/attachment-cache-browser.js") return new Response("Not found", { status: 404 });
    return new Response(Bun.file(join(output, path.slice(1))), { headers: { "Cache-Control": "no-store" } });
  };
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serveFixture });
  quotaServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serveFixture });
  const origin = `http://127.0.0.1:${server.port}`;
  const quotaOrigin = `http://127.0.0.1:${quotaServer.port}`;
  await writeFile(join(output, "main.cjs"), `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',${JSON.stringify(profile)});
const phase=process.argv.at(-1),output=${JSON.stringify(output)},origin=${JSON.stringify(origin)},quotaOrigin=${JSON.stringify(quotaOrigin)};
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,width:640,height:480,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const execute=expression=>window.webContents.executeJavaScript(expression+'.catch(error=>{throw new Error((error.name||"Error")+": "+(error.message||String(error)))})');
 try{
  await window.loadURL(origin+'/index.html');
  let result;
  if(phase==='initial'){
   result=await execute('runAttachmentCacheAcceptance()');
   fs.writeFileSync(path.join(output,'initial-progress.json'),JSON.stringify(result,null,2));
   window.webContents.debugger.attach('1.3');
   try{
    // Apply before this fresh origin has an IndexedDB connection or cached disk-space reservation.
    await window.webContents.debugger.sendCommand('Storage.overrideQuotaForOrigin',{origin:quotaOrigin,quotaSize:32768});
    await window.loadURL(quotaOrigin+'/index.html');
    result.quotaControl=await window.webContents.debugger.sendCommand('Storage.getUsageAndQuota',{origin:quotaOrigin});
    if(!result.quotaControl.overrideActive||result.quotaControl.quota!==32768)throw new Error('Native quota override was not applied');
    result.nativeQuotaProbe=await execute('probeAttachmentCacheNativeQuota()');
   }finally{await window.webContents.debugger.sendCommand('Storage.overrideQuotaForOrigin',{origin:quotaOrigin});window.webContents.debugger.detach();}
   result.controlledQuota=await execute('runAttachmentCacheControlledQuota()');
  }else{
   const previous=JSON.parse(fs.readFileSync(path.join(output,'initial.json'),'utf8'));
   result=await execute('runAttachmentCacheReopenAcceptance('+JSON.stringify(previous.persistence)+')');
  }
  fs.writeFileSync(path.join(output,phase+'.json'),JSON.stringify({...result,electron:process.versions.electron,pid:process.pid,hidden:true},null,2));
  window.destroy();app.quit();
 }catch(error){const progress=await window.webContents.executeJavaScript('globalThis.attachmentCacheProgress').catch(()=>null);fs.writeFileSync(path.join(output,phase+'.json'),JSON.stringify({passed:false,error:String(error),progress},null,2));console.error(error);app.exit(1);}
});`);
  for (const phase of ["initial", "reopened"]) {
    const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs"), phase], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); clearTimeout(timer);
    await writeFile(join(output, `${phase}.log`), stdout + stderr);
    if (code !== 0 || !(await Bun.file(join(output, `${phase}.json`)).json()).passed) throw new Error(`Actual Electron ${phase} cache acceptance failed (${code}); see ${output}/${phase}.json.`);
  }
  const after = await hashes(); if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Executed cache/fixture sources changed during acceptance.");
  const initial = await Bun.file(join(output, "initial.json")).json(), reopened = await Bun.file(join(output, "reopened.json")).json();
  if (initial.pid === reopened.pid) throw new Error("Expected independent Electron processes.");
  const result = { passed: true, kind: "Production cache against actual isolated Electron IndexedDB; controlled corruption/API quota error and real native abort/open failures", sourceHashes: after, sourceHashesStable: true, initial, reopened, separateProcessRestart: true, nativeQuotaExhaustionVerified: initial.nativeQuotaProbe.status === "enforced", profileRemovedAfterRun: true, providerOrInstalledAppActions: false };
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, checks: initial.checks.length + reopened.checks.length + 1, duplicateCollisions: initial.duplicateCollisions, nativeQuotaProbe: initial.nativeQuotaProbe.status, controlledQuota: initial.controlledQuota.error.name, result: join(output, "result.json") }));
} finally { server?.stop(true); quotaServer?.stop(true); await rm(profile, { recursive: true, force: true }); }
