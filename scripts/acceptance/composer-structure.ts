import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/composer-structure-${Date.now()}`);
const sources = [
  "apps/desktop/src/renderer/ComposerEditor.tsx", "apps/desktop/src/renderer/composer-editor.css",
  "apps/desktop/src/renderer/styles.css", "apps/desktop/src/renderer/theme.css",
  "scripts/acceptance/composer-structure.ts", "scripts/acceptance/composer-structure-browser.tsx",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty");
const before = await hashes();
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><title>Composer structure</title><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "composer-structure-browser.tsx"))}"></script>`);
await build({ configFile: join(repo, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
await writeFile(join(output, "main.cjs"), String.raw`
const {app,BrowserWindow}=require("electron"),fs=require("node:fs"),path=require("node:path");
const output=process.argv[2];app.setPath("userData",path.join(output,"profile"));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});const js=s=>win.webContents.executeJavaScript(s),sleep=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],snapshots=[];
const wait=async(s)=>{for(let i=0;i<320;i++){const value=await js(s);if(value)return value;await sleep(25)}throw Error("Timed out: "+s)};
try{await win.loadFile(path.join(output,"web/index.html"));await wait("window.composerStructureState?.()");
 const snap=async name=>{const state=await js("window.composerStructureState()");snapshots.push({name,state});return state};
 let empty=await snap("empty-wide");if(empty.input.height!==32||empty.inputStyle.lineHeight!=="24px"||empty.inputStyle.paddingBlock!=="0px"||empty.inputStyle.paddingInline!=="12px"||empty.placeholder.opacity!=="0.5"||empty.form.height!==76)throw Error("Empty geometry differs: "+JSON.stringify(empty));checks.push("wide empty composer uses the source-derived 32px editor floor, 24px leading, horizontal-only 12px inset, .5 placeholder opacity, and 76px composed surface");
 await js("window.setComposerText("+JSON.stringify("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\nfourteen\nfifteen")+")");await wait("window.composerStructureState().text.includes('fifteen')");let multiline=await snap("multiline-wide");if(multiline.scroll.clientHeight>=multiline.scroll.height||multiline.scroll.clientHeight>multiline.viewport.height*.25+1||multiline.scroll.width>multiline.scroll.clientWidth)throw Error("Multiline cap differs: "+JSON.stringify(multiline));checks.push("multiline content grows to the 25dvh cap, scrolls vertically, and does not overflow horizontally");
 win.setContentSize(520,520);await sleep(100);let narrow=await snap("multiline-narrow");if(narrow.region.width>488.5||narrow.region.x<15.5||narrow.scroll.width>narrow.scroll.clientWidth||narrow.inputStyle.paddingInline!=="12px")throw Error("Narrow geometry differs: "+JSON.stringify(narrow));checks.push("narrow layout retains the production 32px outer gutter, 12px input inset, and no horizontal editor overflow");
 fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,checks,snapshots,scope:"Actual production ComposerEditor and production composer/theme styles in isolated hidden Electron. Controlled local component state only; no full App, host, provider, OS-window, or pixel-parity claim."},null,2));app.exit(0)}catch(error){fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:false,error:String(error),checks,snapshots,state:await js("window.composerStructureState?.()").catch(()=>null)},null,2));app.exit(1)}});`);
const child = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(output, "main.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
const timer = setTimeout(() => child.kill("SIGTERM"), 60_000); const code = await child.exited; clearTimeout(timer);
const result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); result.sourceAtBuild = before; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(before) === JSON.stringify(result.sourceAfterRun); result.passed &&= code === 0 && result.sourceHashesStable; await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
if (!result.passed) throw new Error(`Composer structure acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed: true, checks: result.checks.length, output }));
