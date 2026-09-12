import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/files-search-dialog-${Date.now()}`);
if (existsSync(output) && (await readdir(output)).length) throw new Error(`Output must be empty: ${output}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const sources = ["apps/desktop/src/renderer/WorkspaceFileSearch.tsx", "apps/desktop/src/renderer/workspace-file-search.css", "apps/desktop/src/renderer/FileTypeIcon.tsx", "apps/desktop/src/renderer/workspace-state.ts", "packages/shared/src/workspace-protocol.ts", "scripts/acceptance/files-search-dialog.ts", "scripts/acceptance/files-search-dialog-browser.tsx"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(repo, path))).digest("hex")] )));
const sourceAtBuild = await hashes();
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;font:14px system-ui;background:#222;color:#eee}main{padding:16px}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "files-search-dialog-browser.tsx"))}"></script>`);
await writeFile(join(output, "tsconfig.fixture.json"), JSON.stringify({ extends: join(repo, "tsconfig.json"), include: [join(repo, "scripts/acceptance/files-search-dialog-browser.tsx"), join(repo, "apps/desktop/src/renderer/WorkspaceFileSearch.tsx")] }, null, 2));
const check = Bun.spawn([process.execPath, "x", "tsc", "-p", join(output, "tsconfig.fixture.json"), "--pretty", "false"], { cwd: output, stdout: Bun.file(join(output, "strict.log")), stderr: Bun.file(join(output, "strict-errors.log")), env: { HOME: output, PATH: "/usr/bin:/bin" } });
if (await check.exited !== 0) throw new Error(`Strict fixture compilation failed; inspect ${join(output, "strict-errors.log")}`);
await build({ configFile: false, root: output, plugins: [react()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });

const profile = await mkdtemp(join(tmpdir(), "agent-desktop-files-search-dialog-"));
let exitCode = -1;
try {
  await writeFile(join(output, "main.cjs"), String.raw`
const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
const output = process.argv[2], profile = process.argv[3], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath("userData", profile);
app.whenReady().then(async () => {
 const win = new BrowserWindow({ show:false, width:900, height:640, webPreferences:{ sandbox:true, contextIsolation:false, nodeIntegration:false, backgroundThrottling:false } });
 const js = source => win.webContents.executeJavaScript(source, true), fail = message => { throw new Error(message); }, assert = (value,message) => { if (!value) fail(message); };
 const steps = [], state = () => js("fileSearchState()"), observe = async name => steps.push({name,state:await state()});
 const wait = async predicate => { for(let i=0;i<240;i++){ if(await js(predicate))return; await sleep(25); } fail("Timed out: "+predicate); };
 const click = async selector => { const point=await js("fileSearchTarget("+JSON.stringify(selector)+")"); for(const type of ["mouseMove","mouseDown","mouseUp"])win.webContents.sendInputEvent({type,x:point.x,y:point.y,...(type==="mouseMove"?{}:{button:"left",clickCount:1})}); await sleep(80); };
 const key = async keyCode => { const normalized=({Enter:"Return",ArrowDown:"Down",ArrowUp:"Up"})[keyCode]||keyCode; win.webContents.focus(); for(const type of ["keyDown",...(keyCode==="Enter"?["char"]:[]),"keyUp"])win.webContents.sendInputEvent({type,keyCode:type==="char"?"\r":normalized}); await sleep(70); };
 const replace = async text => { await js("document.querySelector('input').focus();document.querySelector('input').select()"); await win.webContents.insertText(text); await sleep(170); };
 const pending = async (query, owner) => { await wait("fileSearchState().pending.some(value=>value.query==="+JSON.stringify(query)+"&&value.owner==="+JSON.stringify(owner)+")"); return (await state()).pending.find(value=>value.query===query&&value.owner===owner).id; };
 const resolve = async (id, paths) => { await js("fileSearchResolve("+id+","+JSON.stringify(paths)+")"); await sleep(80); };
 try {
  await win.loadFile(path.join(output,"web/index.html")); await sleep(260); assert((await state()).activeRole==="combobox", "Search files combobox was not autofocus"); assert((await state()).pending.length===0, "Empty dialog queried files"); await observe("empty-autofocus-no-query");
  await replace("alpha"); const alpha=await pending("alpha","owner-a"); await replace("bravo"); const bravo=await pending("bravo","owner-a"); await resolve(alpha,["old/alpha.ts"]); assert(!(await state()).text.includes("alpha.ts"), "Delayed A replaced newer B"); await resolve(bravo,["new/bravo.ts","new/bravo-two.ts"]); await wait("fileSearchState().options.length===2"); await observe("delayed-a-fenced-after-b");
  await replace("charlie"); const charlie=await pending("charlie","owner-a"); await replace("delta"); await resolve(charlie,["old/charlie.ts"]); await key("Enter"); assert((await state()).open && !(await state()).opened.length, "Editing query allowed old result to open"); const delta=await pending("delta","owner-a"); await resolve(delta,["current/delta.ts"]); await observe("edit-before-reply-cannot-open-old-result");
  await replace("offline"); const offline=await pending("offline","owner-a"); await js("fileSearchControl('fixture-disconnect')"); await replace(""); await resolve(offline,["old/offline.ts"]); assert(!(await state()).text.includes("offline.ts") && !(await state()).opened.length, "Disconnect or empty query accepted late result"); await js("fileSearchControl('fixture-connect')"); await observe("disconnect-empty-fences-late-result");
  await replace("owner"); const ownerA=await pending("owner","owner-a"); await js("fileSearchControl('fixture-owner-b')"); const ownerB=await pending("owner","owner-b"); await resolve(ownerA,["old/owner-a.ts"]); assert(!(await state()).text.includes("owner-a.ts"), "Owner A reply survived owner replacement"); await resolve(ownerB,["current/owner-b.ts"]); await wait("fileSearchState().text.includes('owner-b.ts')"); await observe("owner-change-fences-pending-result");
  await replace("error"); const broken=await pending("error","owner-b"); await js("fileSearchReject("+broken+",'Controlled failure')"); await wait("fileSearchState().text.includes('Controlled failure')"); await click(".workspace-file-search-error button"); const retry=await pending("error","owner-b"); await resolve(retry,["retry/one.ts","retry/two.ts"]); await wait("fileSearchState().options.length===2"); await observe("error-retry");
  await js("document.querySelector('input').focus()"); await key("ArrowDown"); await key("Enter"); await wait("!fileSearchState().open"); assert(JSON.stringify((await state()).opened)==='["retry/two.ts"]', "Arrow/Enter did not open exactly the selected file once"); await observe("keyboard-select-once");
  await click("#file-search-trigger"); await replace("pointer"); const pointer=await pending("pointer","owner-b"); await resolve(pointer,["pointer/one.ts","pointer/two.ts"]); await click('[role="option"][aria-selected="false"]'); await wait("!fileSearchState().open"); assert(JSON.stringify((await state()).opened)==='["retry/two.ts","pointer/two.ts"]', "Pointer selection did not dispatch its exact file once"); await observe("pointer-select-once");
  await click("#file-search-trigger"); await key("Escape"); await wait("!fileSearchState().open && fileSearchState().activeId==='file-search-trigger'"); assert((await state()).opened.length===2, "Escape dispatched file open"); await observe("escape-restores-invoking-trigger");
  await click("#file-search-trigger"); await replace("compose"); const compose=await pending("compose","owner-b"); await resolve(compose,["compose/one.ts"]); await js("fileSearchCompose('compositionstart');fileSearchControl('fixture-render')"); await key("Enter"); assert((await state()).open && (await state()).opened.length===2, "Enter opened during composition after ordinary redraw"); await js("fileSearchCompose('compositionend')"); await key("Enter"); await wait("!fileSearchState().open"); assert(JSON.stringify((await state()).opened)==='["retry/two.ts","pointer/two.ts","compose/one.ts"]', "Composition end Enter did not select exactly once"); await observe("composition-blocks-enter-until-end");
  fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,hidden:true,electron:process.versions.electron,input:"Electron webContents.sendInputEvent for keyboard/pointer; synthetic CompositionEvent only for explicit composition state",steps},null,2));
 } catch(error) { fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:false,error:String(error.stack||error),steps},null,2)); process.exitCode=1; }
 finally { await win.close(); app.quit(); }
});`);
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs"), output, profile], { cwd: profile, stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")), env: { HOME: profile, TMPDIR: profile, PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 60_000);
  try { exitCode = await electron.exited; } finally { clearTimeout(timer); }
} finally { await rm(profile, { recursive: true, force: true }); }
let result: Record<string, unknown>;
try { result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); }
catch (cause) { result = { passed: false, resultReadError: cause instanceof Error ? cause.message : String(cause) }; }
result.exitCode = exitCode; result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun); result.scope = "Production WorkspaceFileSearch in hidden isolated Electron with a controlled deferred WorkspaceState.query fixture. It proves renderer request fencing and selection behavior, not native search correctness or installed App/main input routing."; result.passed = result.passed === true && exitCode === 0 && result.sourceHashesStable;
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
if (!result.passed) throw new Error(`Files search dialog acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed:true, output }));
