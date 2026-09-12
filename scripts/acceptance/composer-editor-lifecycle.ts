import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? `.data/composer-editor-lifecycle-${Date.now()}`);
const sources = ["apps/desktop/src/renderer/ComposerEditor.tsx", "apps/desktop/src/renderer/composer-document.ts", "apps/desktop/src/renderer/composer-editor.css", "apps/desktop/src/renderer/composer-clipboard.ts", "scripts/acceptance/composer-editor-lifecycle.ts", "scripts/acceptance/composer-editor-lifecycle-browser.tsx"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])))
const oldResult = process.argv[3] ? resolve(process.argv[3]) : undefined;
const old = oldResult ? JSON.parse(await readFile(oldResult, "utf8")) : undefined;
const oldEmpty = old?.snapshots.find((snapshot: any) => snapshot.name === "empty-to-empty");
if (oldResult && (oldEmpty?.state.placeholder !== null || oldEmpty.state.empty !== null || oldEmpty.state.name !== null || oldEmpty.textboxes?.[0]?.name !== "")) throw new Error("Optional old observation does not describe the recorded failure");
await mkdir(output, { recursive: true, mode: 0o700 }); if ((await readdir(output)).length) throw new Error("Output must be empty");
const before = await hashes();
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;min-height:100%}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "composer-editor-lifecycle-browser.tsx"))}"></script>`);
await build({ configFile: false, logLevel: "warn", root: output, plugins: [react()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
await writeFile(join(output, "launch.json"), JSON.stringify({ profile: join(output, "profile") }), { mode: 0o600 });
await writeFile(join(output, "main.cjs"), String.raw`
const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
const output = process.argv[2], launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json"), "utf8"));
app.setPath("userData", launch.profile); app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.whenReady().then(async () => {
 const win = new BrowserWindow({ show:false, width:640, height:360, webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false } });
 const js = source => win.webContents.executeJavaScript(source), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], snapshots = [], consoleMessages = [], rendererGone = [], primary = process.platform === "darwin" ? "meta" : "control";
 win.webContents.on("console-message", (...args) => consoleMessages.push(args.slice(1).map(String).join(" | "))); win.webContents.on("render-process-gone", (_event, details) => rendererGone.push(details));
 const wait = async source => { for(let i=0;i<400;i++){ if(await js(source)) return; await sleep(25); } throw Error("Condition failed: "+source); };
 const snapshot = async name => { const state = await js("window.state()"); const tree = await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree"); const textboxes = tree.nodes.filter(node => node.role?.value === "textbox").map(node => ({ name: node.name?.value ?? "", role: node.role.value })); snapshots.push({ name, state, textboxes }); return { state, textboxes }; };
 let step = "load";
 try {
  win.webContents.debugger.attach("1.3"); await win.loadFile(path.join(output, "web/index.html")); await wait("window.state?.() && window.state().scope==='empty-a'");
  let initial = await snapshot("empty-a");
  const contract = item => item.state.placeholder === "Ask anything, or describe a task" && item.state.empty === "true" && item.state.ariaLabel === "Prompt" && item.state.before === '"Ask anything, or describe a task"' && item.textboxes.length === 1 && item.textboxes[0].name === "Prompt";
  if (!contract(initial)) throw Error("Initial empty contract differs: "+JSON.stringify(initial)); const aOwner = initial.state.owner;
  step = "empty-a-to-empty-b"; await js("window.switchScope('empty-b')"); await wait("window.state().scope==='empty-b'"); const emptyB = await snapshot("empty-b");
  if (!contract(emptyB) || emptyB.state.owner === aOwner) throw Error("Empty scope change did not retain attributes/AX or replace owner: "+JSON.stringify({ initial, emptyB })); checks.push("empty-a to empty-b retains placeholder, data-empty, aria-label, CSS placeholder, and Accessibility textbox name while replacing the EditorView-owned DOM element");
  step = "same-scope"; await js("window.rerender();window.select(0,0)"); await wait("window.state().tick===1"); const sameScope = await snapshot("same-scope-rerender");
  if (sameScope.state.owner !== emptyB.state.owner || sameScope.state.selection[0] !== 0 || sameScope.state.selection[1] !== 0) throw Error("Ordinary same-scope rerender changed owner or selection: "+JSON.stringify(sameScope)); checks.push("same-scope parent rerender preserves the EditorView owner and an empty selection");
  step = "same-scope-text-selection-undo"; await js("window.replace('bravo')"); await wait("window.state().text==='bravo'"); await js("window.select(1,4);window.rerender()"); await wait("window.state().selection[0]===1&&window.state().selection[1]===4"); const bText = await snapshot("empty-b-text-selection");
  if (bText.state.owner !== emptyB.state.owner || bText.state.text !== "bravo") throw Error("Same-scope text/selection changed owner: "+JSON.stringify(bText)); await sleep(600);
  await js("window.replace('bravo!');window.focusEditor()"); await wait("window.state().text==='bravo!'&&document.activeElement?.id==='prompt'"); win.focus(); win.webContents.focus(); win.webContents.sendInputEvent({ type:"keyDown", keyCode:"z", modifiers:[primary] }); win.webContents.sendInputEvent({ type:"keyUp", keyCode:"z", modifiers:[primary] }); await wait("window.state().text==='bravo'"); const positiveUndo = await snapshot("empty-b-same-scope-undo");
  if (positiveUndo.state.owner !== emptyB.state.owner || positiveUndo.state.text !== "bravo") throw Error("Focused platform-primary undo did not restore same-scope text: "+JSON.stringify(positiveUndo)); checks.push("same-scope text and selection preserve one owner, and focused platform-primary undo changes bravo! back to bravo");
  step = "separate-drafts"; await js("window.switchScope('empty-a')"); await wait("window.state().scope==='empty-a'&&window.state().text==='' "); await js("window.replace('alpha')"); await wait("window.state().text==='alpha'"); const aText = await snapshot("empty-a-draft");
  await js("window.switchScope('empty-b')"); await wait("window.state().scope==='empty-b'&&window.state().text==='bravo'"); const restoredB = await snapshot("empty-b-restored");
  if (restoredB.state.owner === aText.state.owner || restoredB.state.text !== "bravo") throw Error("Restored scope leaked owner or draft: "+JSON.stringify({ aText, restoredB }));
  await js("window.focusEditor()"); await wait("document.activeElement?.id==='prompt'"); win.focus(); win.webContents.focus(); win.webContents.sendInputEvent({ type:"keyDown", keyCode:"z", modifiers:[primary] }); win.webContents.sendInputEvent({ type:"keyUp", keyCode:"z", modifiers:[primary] }); await sleep(100); const undoB = await snapshot("empty-b-restored-undo");
  if (undoB.state.text !== "bravo" || undoB.state.text === "alpha") throw Error("Platform-primary undo crossed scope owner boundary: "+JSON.stringify(undoB)); checks.push("separate scope drafts restore their own text; after rebuilding empty-b, the same focused platform-primary undo leaves bravo intact and cannot resurrect alpha across the EditorView history boundary");
  if (rendererGone.length) throw Error("Renderer isolation failed: "+JSON.stringify({consoleMessages,rendererGone}));
  fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,checks,snapshots,hidden:true,actualProductionComposerEditor:true,consoleMessages,rendererGone,scope:"Actual production ComposerEditor in hidden isolated Electron. Fixture state owns two local drafts only; no host, provider, native Work action, installed app, main/preload, or OS-window behavior is exercised."},null,2)); app.exit(0);
 } catch(error) { fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:false,step,error:String(error),checks,snapshots,state:await js("window.state()").catch(() => null),consoleMessages,rendererGone},null,2)); app.exit(1); }
});
`);
const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
const timer = setTimeout(() => electron.kill("SIGTERM"), 60_000), code = await electron.exited; clearTimeout(timer);
const result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); if (oldResult) result.oldRegression = { result: oldResult, emptyToEmpty: oldEmpty }; result.sourceAtBuild = before; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(before) === JSON.stringify(result.sourceAfterRun); result.passed &&= code === 0 && result.sourceHashesStable;
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2)); await Bun.file(join(output, "launch.json")).delete();
if (!result.passed) throw new Error(`Composer editor lifecycle acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed:true, checks:result.checks.length, output }));
