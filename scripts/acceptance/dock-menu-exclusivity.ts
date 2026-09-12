import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2), sourceIndex = args.indexOf("--panel-source");
if (sourceIndex !== -1 && !args[sourceIndex + 1]) throw new Error("--panel-source requires a file path");
const panel = sourceIndex === -1 ? join(repo, "apps/desktop/src/renderer/DockPanel.tsx") : resolve(args[sourceIndex + 1]!);
const frozen = panel !== join(repo, "apps/desktop/src/renderer/DockPanel.tsx");
const output = resolve(sourceIndex === -1 ? args[0] ?? `.data/dock-menu-exclusivity-${Date.now()}` : args.find((value, index) => value !== "--panel-source" && index !== sourceIndex + 1) ?? `.data/dock-menu-exclusivity-${Date.now()}`);
const sources = ["apps/desktop/src/renderer/DockPanel.tsx", "apps/desktop/src/renderer/dock-panel.css", "scripts/acceptance/dock-menu-exclusivity.ts", "scripts/acceptance/dock-menu-exclusivity-browser.tsx"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
const selectedPanel = async () => ({ path: panel, sha256: createHash("sha256").update(await readFile(panel)).digest("hex") });
if (existsSync(output) && (await readdir(output)).length) throw new Error(`Output must be empty: ${output}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const sourceAtBuild = { files: await hashes(), selectedPanel: await selectedPanel() };
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}main,.fixture{width:100%;height:100%;display:grid;grid-template-columns:minmax(0,1fr) 320px;grid-template-rows:minmax(0,1fr) 240px}.dock-panel-right{grid-column:2;grid-row:1 / span 2}.dock-panel-bottom{grid-column:1;grid-row:2}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "dock-menu-exclusivity-browser.tsx"))}"></script>`);
const frozenImports = { name: "frozen-panel-imports", resolveId(source: string, importer?: string) { if (!frozen || importer !== panel || !source.startsWith(".")) return; const base = resolve(repo, "apps/desktop/src/renderer", source); return [base, `${base}.tsx`, `${base}.ts`, `${base}.css`].find(existsSync); } };
await build({ configFile: false, logLevel: "warn", root: output, plugins: [frozenImports, react()], resolve: { alias: { "dock-menu-exclusivity-panel": panel, "@radix-ui/react-dropdown-menu": join(repo, "apps/desktop/node_modules/@radix-ui/react-dropdown-menu") } }, base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });

const profile = await mkdtemp(join(tmpdir(), "agent-desktop-dock-menu-exclusivity-"));
let code = -1;
try {
  await writeFile(join(output, "main.cjs"), String.raw`
const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
const output = process.argv[2], profile = process.argv[3], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath("userData", profile);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 700, webPreferences: { sandbox: true, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source, true), state = () => js("dockExclusivityState()");
  const fail = message => { throw new Error(message); }, assert = (value, message) => { if (!value) fail(message); };
  const steps = [], observe = async name => steps.push({ name, state: await state() });
  const click = async selector => { const point = await js("dockExclusivityTarget(" + JSON.stringify(selector) + ")"); for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, ...(type === "mouseMove" ? {} : { button: "left", clickCount: 1 }) }); await sleep(100); };
  const focus = async selector => { const focused = await js("document.querySelector(" + JSON.stringify(selector) + ")?.focus(); document.activeElement?.matches(" + JSON.stringify(selector) + ")"); assert(focused, "could not focus " + selector); };
  const key = async value => { const keyCode = ({ Escape: "ESCAPE" })[value] || value; win.focus(); win.webContents.focus(); for (const type of ["keyDown", "keyUp"]) win.webContents.sendInputEvent({ type, keyCode }); await sleep(80); };
  const trigger = destination => '[aria-label="Open ' + (destination === 'right' ? 'side' : destination) + ' panel tab"]';
  const options = destination => '[data-app-shell-tab-strip-controller="' + destination + '"] [aria-label="Dock options"]';
  try {
    await win.loadFile(path.join(output, "web/index.html")); await sleep(250);
    await click(options("right")); assert((await state()).details.right, "right Dock options did not open");
    await click(trigger("right")); let current = await state(); assert(!current.details.right && current.menus.length === 1 && current.menus[0] === "right", "same-dock options -> plus was not exclusive: " + JSON.stringify(current)); await observe("same-dock-options-to-plus");
    await key("Escape"); current = await state(); assert(!current.menus.length && current.active.includes("Open side panel tab"), "Escape did not close plus and restore trigger: " + JSON.stringify(current)); await observe("escape-restored-trigger");
    await click(options("bottom")); assert((await state()).details.bottom, "bottom Dock options did not open");
    await click(trigger("right")); current = await state(); assert(!current.details.bottom && current.menus.length === 1 && current.menus[0] === "right", "cross-dock options -> plus was not exclusive: " + JSON.stringify(current)); await observe("cross-dock-options-to-plus");
    await click(options("right")); current = await state(); assert(!current.menus.length && current.details.right, "plus -> options did not dismiss plus: " + JSON.stringify(current)); await observe("plus-to-options");
    await click(options("right"));
    await focus(trigger("right")); await key("Enter"); current = await state(); assert(current.menus.length === 1, "keyboard did not open plus before blur");
    await js("window.dispatchEvent(new Event('blur'))"); await sleep(120); current = await state(); assert(!current.menus.length, "window blur did not close plus: " + JSON.stringify(current)); await observe("window-blur-closed-plus");
    assert(!(await state()).selected.length, "chooser action callback dispatched: " + JSON.stringify((await state()).selected));
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, hidden: true, electron: process.versions.electron, input: "Electron webContents.sendInputEvent pointer and keyboard; renderer window blur event for Radix dismissal", steps, selected: (await state()).selected }, null, 2));
  } catch (error) { fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, error: String(error.stack || error), steps }, null, 2)); process.exitCode = 1; }
  finally { await win.close(); app.quit(); }
});`);
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs"), output, profile], { cwd: profile, stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")), env: { HOME: profile, TMPDIR: profile, PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 60_000);
  try { code = await electron.exited; } finally { clearTimeout(timer); }
} finally { await rm(profile, { recursive: true, force: true }); }
const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = { files: await hashes(), selectedPanel: await selectedPanel() }; result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun); result.variant = frozen ? "explicit-panel-source" : "current-panel"; result.passed &&= code === 0 && result.sourceHashesStable;
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
if (!result.passed) throw new Error(`Dock menu exclusivity acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed: true, output }));
