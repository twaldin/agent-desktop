import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../.."), args = process.argv.slice(2), sourceIndex = args.indexOf("--app-source"), old = args.includes("--old");
if (sourceIndex !== -1 && !args[sourceIndex + 1]) throw new Error("--app-source requires a file path.");
const app = sourceIndex === -1 ? old ? join(repo, ".data/chooser-lifecycle-2026-09-08/before/App.tsx") : join(repo, "apps/desktop/src/renderer/App.tsx") : resolve(args[sourceIndex + 1]!);
const frozen = app !== join(repo, "apps/desktop/src/renderer/App.tsx");
const output = resolve(args.find((value, index) => value !== "--old" && value !== "--app-source" && (sourceIndex === -1 || index !== sourceIndex + 1)) ?? `.data/chooser-lifecycle-${Date.now()}`);
const sources = ["apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/app-shortcuts.ts", "apps/desktop/src/renderer/workspace-state.ts", "apps/desktop/src/renderer/DockPanel.tsx", "scripts/acceptance/chooser-lifecycle.ts", "scripts/acceptance/chooser-lifecycle-browser.tsx"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
const selectedApp = async () => ({ path: app, sha256: createHash("sha256").update(await readFile(app)).digest("hex") });
await mkdir(output, { recursive: true, mode: 0o700 }); if ((await readdir(output)).length) throw new Error("Output must be empty");
const sourceAtBuild = { files: await hashes(), selectedApp: await selectedApp() };
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "chooser-lifecycle-browser.tsx"))}"></script>`);
const frozenAppImports = { name: "frozen-app-imports", resolveId(source: string, importer?: string) {
  if (!frozen || importer !== app || !source.startsWith(".")) return;
  const base = resolve(repo, "apps/desktop/src/renderer", source);
  return [base, `${base}.tsx`, `${base}.ts`, `${base}.css`].find(existsSync);
} };
await build({ configFile: false, logLevel: "warn", root: output, plugins: [frozenAppImports, react(), tailwindcss()], resolve: { alias: { "chooser-lifecycle-app": app } }, base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
const profile = await mkdtemp(join(tmpdir(), "agent-desktop-chooser-lifecycle-"));
let code = -1;
try {
  await writeFile(join(output, "main.cjs"), `const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});try{await w.loadFile(path.join(__dirname,'web/index.html'));const result=await w.webContents.executeJavaScript('runChooserLifecycleAcceptance()');result.hidden=true;result.electron=process.versions.electron;fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));app.exit(0)}catch(error){fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(error)},null,2));app.exit(1)}});`);
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs")], { cwd: profile, stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")), env: { HOME: profile, TMPDIR: profile, PATH: "/usr/bin:/bin", ELECTRON_ENABLE_LOGGING: "" } });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 60_000);
  try { code = await electron.exited; } finally { clearTimeout(timer); }
} finally {
  await rm(profile, { recursive: true, force: true });
}
const result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = { files: await hashes(), selectedApp: await selectedApp() }; result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun); result.passed &&= code === 0 && result.sourceHashesStable;
result.variant = app === join(repo, "apps/desktop/src/renderer/App.tsx") ? "current-App" : "explicit-App-source";
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
if (!result.passed) throw new Error(`Chooser lifecycle acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed: true, output }));
