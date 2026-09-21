import { build } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const out = resolve(process.argv[2] ?? '.data/goal-drafts');
const profile = await mkdtemp(join(tmpdir(), 'agent-goal-drafts-'));
const sources = ['apps/desktop/src/renderer/GoalPanel.tsx', 'apps/desktop/src/renderer/goal-draft.ts',
  'apps/desktop/src/renderer/goal-draft.test.ts', 'apps/desktop/src/renderer/use-goal-control.ts',
  'apps/desktop/src/renderer/use-session-activity.ts', 'apps/desktop/src/renderer/App.tsx',
  'packages/shared/src/goal-control.ts', 'packages/shared/src/session-activity.ts',
  'scripts/acceptance/goal-drafts.ts', 'scripts/acceptance/goal-drafts-browser.tsx'];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path =>
  [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
await mkdir(out, { recursive: true });
try {
  const before = await hashes();
  await writeFile(join(out, 'before.json'), JSON.stringify(before, null, 2));
  await writeFile(join(out, 'index.html'), `<meta charset="utf-8"><div id="root"></div><script type="module" src=${JSON.stringify(relative(out, join(import.meta.dir, 'goal-drafts-browser.tsx')))}></script>`);
  await build({ configFile: join(root, 'apps/desktop/vite.config.ts'), root: out, logLevel: 'warn',
    build: { outDir: join(out, 'web'), emptyOutDir: true, rollupOptions: { input: join(out, 'index.html') } } });
  await writeFile(join(out, 'main.cjs'), `const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',${JSON.stringify(profile)});
const phase=process.argv.at(-1);
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:720,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 try {
  await w.loadFile(path.join(__dirname,'web/index.html'));
  const result=await w.webContents.executeJavaScript('goalDraftRun('+JSON.stringify(phase)+')');
  result.pid=process.pid;result.versions={electron:process.versions.electron,chrome:process.versions.chrome};
  result.captures=[];
  for(const scene of [{name:'normal',width:720,height:700,zoom:1},{name:'narrow',width:320,height:600,zoom:1},{name:'zoom150',width:900,height:800,zoom:1.5}]) {
   w.setContentSize(scene.width,scene.height);w.webContents.setZoomFactor(scene.zoom);await new Promise(r=>setTimeout(r,60));
   fs.writeFileSync(path.join(__dirname,phase+'-'+scene.name+'.png'),(await w.webContents.capturePage()).toPNG());result.captures.push(scene);
  }
  w.webContents.session.flushStorageData();
  fs.writeFileSync(path.join(__dirname,phase+'.json'),JSON.stringify(result,null,2));w.destroy();app.quit();
 } catch(error) {
  const progress=await w.webContents.executeJavaScript('goalDraftProgress()').catch(()=>null);
  fs.writeFileSync(path.join(__dirname,phase+'-failure.png'),(await w.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(__dirname,phase+'.json'),JSON.stringify({passed:false,error:String(error),progress},null,2));app.exit(1);
 }
});`);
  const phases = [];
  for (const phase of ['write', 'restore']) {
    const argv = [process.execPath, join(root, 'node_modules/electron/cli.js'), join(out, 'main.cjs'), phase];
    const child = Bun.spawn(argv, { stdout: Bun.file(join(out, `${phase}.stdout`)), stderr: Bun.file(join(out, `${phase}.stderr`)) });
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
    const exitCode = await child.exited; clearTimeout(timer);
    const result = await Bun.file(join(out, `${phase}.json`)).json();
    phases.push({ argv, exitCode, result });
    await writeFile(join(out, 'processes.json'), JSON.stringify(phases, null, 2));
    if (exitCode || !result.passed) throw new Error(`Goal draft ${phase} failed.`);
  }
  const after = await hashes(); await writeFile(join(out, 'after.json'), JSON.stringify(after, null, 2));
  const result = { passed: JSON.stringify(before) === JSON.stringify(after), phases,
    sourceHashesStable: JSON.stringify(before) === JSON.stringify(after), qualification: 'Selected input map, not full transitive fence. App prop source is bound but full App is not mounted by this component fixture.' };
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error('Goal draft sources changed during acceptance.');
  console.log(JSON.stringify({ passed: true, phases: 2, checks: phases.map(p => p.result.checks.length), out }));
} finally { await rm(profile, { recursive: true, force: true }); }
