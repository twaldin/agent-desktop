import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/branch-selector-${Date.now()}`);
if (existsSync(output) && (await readdir(output)).length) throw new Error(`Output must be empty: ${output}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const sources = ["apps/desktop/src/renderer/BranchSelector.tsx", "apps/desktop/src/renderer/branch-selector.css", "apps/desktop/src/renderer/ComposerContext.tsx", "apps/desktop/src/renderer/EnvironmentCard.tsx", "apps/desktop/src/renderer/workspace-state.ts", "scripts/acceptance/branch-selector.ts", "scripts/acceptance/branch-selector-browser.tsx"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(repo, path))).digest("hex")] )));
const sourceAtBuild = await hashes();
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;font:14px system-ui;background:#222;color:#eee}main{padding:16px}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "branch-selector-browser.tsx"))}"></script>`);
await writeFile(join(output, "tsconfig.fixture.json"), JSON.stringify({ extends: join(repo, "tsconfig.json"), include: [join(repo, "scripts/acceptance/branch-selector-browser.tsx"), join(repo, "apps/desktop/src/renderer/BranchSelector.tsx")] }, null, 2));
const check = Bun.spawn([process.execPath, "x", "tsc", "-p", join(output, "tsconfig.fixture.json"), "--pretty", "false"], { cwd: output, stdout: Bun.file(join(output, "strict.log")), stderr: Bun.file(join(output, "strict-errors.log")), env: { HOME: output, PATH: "/usr/bin:/bin" } });
if (await check.exited !== 0) throw new Error(`Strict fixture compilation failed; inspect ${join(output, "strict-errors.log")}`);
await build({ configFile: false, root: output, plugins: [react()], base: "./", build: { target: "esnext", outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });

const profile = await mkdtemp(join(tmpdir(), "agent-desktop-branch-selector-"));
let exitCode = -1;
try {
  await writeFile(join(output, "main.cjs"), String.raw`
const {app,BrowserWindow}=require("electron"),fs=require("node:fs"),path=require("node:path");
const output=process.argv[2],profile=process.argv[3],sleep=ms=>new Promise(r=>setTimeout(r,ms));app.setPath("userData",profile);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
 const js=s=>win.webContents.executeJavaScript(s,true),state=()=>js("branchState()"),steps=[];
 const assert=(v,m)=>{if(!v)throw Error(m)};
 const wait=async s=>{for(let i=0;i<240;i++){if(await js(s))return;await sleep(25)}throw Error("Timed out: "+s)};
 const observe=async name=>{steps.push({name,state:await state()})};
 const click=async(selector,text)=>{const p=await js("(()=>{const e=[...document.querySelectorAll("+JSON.stringify(selector)+")].find(e=>e.getClientRects().length&& !e.disabled && "+(text===undefined?"true":"e.textContent.includes("+JSON.stringify(text)+")")+");if(!e)throw Error('Unavailable target');const b=e.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()");for(const type of ["mouseMove","mouseDown","mouseUp"])win.webContents.sendInputEvent({type,...p,...(type==="mouseMove"?{}:{button:"left",clickCount:1})});await sleep(80)};
 const key=async keyCode=>{win.webContents.focus();for(const type of ["keyDown","keyUp"])win.webContents.sendInputEvent({type,keyCode});await sleep(100)};
 const open=async()=>{await click('[aria-label="Switch branch"]');await wait("Boolean(document.querySelector('[role=menu] input'))")};
 const closed=()=>wait("!document.querySelector('[role=menu]')&&!document.querySelector('dialog[open]')");
 try{
 await win.loadFile(path.join(output,"web/index.html"));await wait("Boolean(document.querySelector('[aria-label=\"Switch branch\"]'))");
 await open();await key("ESCAPE");await closed();assert((await state()).active==="Switch branch","Escape failed to restore production trigger");await observe("menu-escape-restore");
 await open();await click('[role=menuitemradio]',"main");await closed();assert((await state()).executed.length===0,"Selecting current branch dispatched checkout");
 await open();await click('[role=menuitemradio]',"feature/one");await closed();assert((await state()).ownerA.branch==="feature/one","Checkout did not refresh shared state");assert((await state()).deliveries[0].command.action.expectedRevision==="owner-a:0","Checkout did not use status revision");await observe("owner-qualified-checkout-once");
 await open();await click('[role=menuitem]',"Create");await wait("Boolean(document.querySelector('dialog[open] input'))");assert(await js("document.activeElement?.getAttribute('aria-label')==='Branch name'"),"Create dialog failed initial focus");assert(await js("document.querySelector('dialog input').value==='codex/'"),"Branch prefix missing");await key("ESCAPE");await closed();assert((await state()).active==="Switch branch","Create Escape lost trigger focus");assert((await state()).executed.length===1,"Create cancellation dispatched checkout");await observe("create-prefix-focus-cancel");
 await open();await click('[role=menuitem]',"Create");await wait("Boolean(document.querySelector('dialog[open] input'))");await win.webContents.insertText("test");await click('dialog button[type=submit]');await closed();assert((await state()).ownerA.branch==="codex/test","Create did not use prefix and entered name");assert((await state()).deliveries[1].command.action.create===true,"Create flag missing");await observe("create-checkout-once");
 await js("branchControl('drop')");await open();await click('[role=menuitemradio]',"main");await wait("Boolean(branchState().ownerA.pending)");await wait("document.body.innerText.includes('Retry original workspace command')");await click('button',"Retry original workspace command");await wait("!branchState().ownerA.pending&&branchState().ownerA.branch==='main'");await key("ESCAPE");await closed();const recovered=await state();assert(recovered.executed.length===3&&recovered.deliveries.length===4,"Receipt retry re-executed checkout");assert(recovered.deliveries[2].id===recovered.deliveries[3].id,"Retry changed command identity");await observe("lost-reply-original-receipt-only");
 await js("branchControl('hold')");await open();await click('[role=menuitemradio]',"feature/one");await wait("branchState().deliveries.length===5");await js("branchControl('owner-b')");await closed();await open();await js("branchControl('release')");await wait("branchState().ownerA.branch==='feature/one'&&!branchState().ownerA.pending");assert(await js("Boolean(document.querySelector('[role=menu]'))"),"Old owner completion dismissed new owner menu");assert((await state()).ownerB.branch==="main","Old checkout changed new owner state");await key("ESCAPE");await closed();await observe("old-owner-completion-preserves-new-menu");
 await click('#variant');await open();await click('[role=menuitemradio]',"feature/one");await closed();const end=await state();assert(end.deliveries.at(-1).command.target.sessionId==="owner-b","Session selector lost owner target");assert(end.ownerB.branch==="feature/one","Composer presentation failed checkout");await observe("composer-presentation-session-owner");
 fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,hidden:true,electron:process.versions.electron,input:"Electron sendInputEvent pointer/keys, insertText; deliberate owner/transport controls through test seam",steps},null,2));
 }catch(error){fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:false,error:String(error.stack||error),state:await state().catch(()=>null),steps},null,2))}finally{win.close();app.quit()}
});
`);
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs"), output, profile], { cwd: profile, stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")), env: { HOME: profile, TMPDIR: profile, PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 60_000);
  try { exitCode = await electron.exited; } finally { clearTimeout(timer); }
} finally { await rm(profile, { recursive: true, force: true }); }
let result: Record<string, unknown>;
try { result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); }
catch (cause) { result = { passed: false, resultReadError: cause instanceof Error ? cause.message : String(cause) }; }
result.exitCode = exitCode; result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun); result.scope = "Actual BranchSelector and WorkspaceState in hidden isolated Electron with a controlled host transport. Checks owner target, revision, one-use receipt, focus, cancellation and owner changes; not actual Git or native App routing."; result.passed = result.passed === true && exitCode === 0 && result.sourceHashesStable;
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
if (!result.passed) throw new Error(`Branch selector acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed:true, output }));
