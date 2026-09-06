import { build } from "vite";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dir, "../.."),
  out = resolve(process.argv[2] ?? `.data/browser-dock-hook/${Date.now()}`),
  profile = await mkdtemp(join(tmpdir(), "dock-hook-"));
await mkdir(out, { recursive: true });
const sources = ["apps/desktop/src/renderer/use-workbench-dock.tsx", "apps/desktop/src/renderer/dock-state.ts", "apps/desktop/src/window-state.ts", "scripts/acceptance/browser-dock-hook-browser.tsx", "scripts/acceptance/browser-dock-hook.ts"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(root,file))).digest("hex")])));
const before = await hashes();
try {
  await writeFile(
    join(out, "index.html"),
    `<div id="root"></div><script type="module" src=${JSON.stringify(relative(out, join(import.meta.dir, "browser-dock-hook-browser.tsx")))}></script>`,
  );
  await build({
    configFile: join(root, "apps/desktop/vite.config.ts"),
    root: out,
    build: {
      outDir: join(out, "web"),
      rollupOptions: { input: join(out, "index.html") },
    },
  });
  await writeFile(
    join(out, "main.cjs"),
    `const{app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{let w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});try{await w.loadFile(path.join(__dirname,'web/index.html'));let r=await w.webContents.executeJavaScript('runBrowserDockHook()');fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(r));app.exit(r.passed?0:1)}catch(e){fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(e),progress:await w.webContents.executeJavaScript('browserDockHookProgress()').catch(()=>null)}));app.exit(1)}})`,
  );
  let c = Bun.spawn([
    process.execPath,
    join(root, "node_modules/electron/cli.js"),
    join(out, "main.cjs"),
  ]);
  const deadline = setTimeout(() => c.kill("SIGTERM"), 45_000);
  let code = await c.exited; clearTimeout(deadline);
  let r = await Bun.file(join(out, "result.json")).json();
  r.sourceAtBuild = before; r.sourceAfter = await hashes(); r.sourceHashesStable = JSON.stringify(before) === JSON.stringify(r.sourceAfter);
  r.passed &&= r.sourceHashesStable;
  r.scope = "Production dock hook in hidden Electron with controlled transport; functional state checks only, no native backend or visual parity claim.";
  await writeFile(join(out,"result.json"), JSON.stringify(r,null,2));
  console.log(
    JSON.stringify({ passed: r.passed, result: join(out, "result.json") }),
  );
  if (code || !r.passed) throw Error("dock hook acceptance failed");
} finally {
  await rm(profile, { recursive: true, force: true });
}
