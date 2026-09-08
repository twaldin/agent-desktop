import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/file-preview-tabs-${Date.now()}`);
const sources = [
  "apps/desktop/src/renderer/dock-state.ts", "apps/desktop/src/renderer/file-preview-tabs.ts",
  "apps/desktop/src/renderer/use-workbench-dock.tsx", "apps/desktop/src/renderer/DockPanel.tsx",
  "apps/desktop/src/renderer/WorkspaceFileTreePane.tsx", "apps/desktop/src/renderer/WorkspaceFileBreadcrumbs.tsx", "apps/desktop/src/renderer/transcript-links.ts", "apps/desktop/src/renderer/App.tsx",
  "apps/desktop/src/renderer/WorkspacePanel.tsx", "apps/desktop/src/renderer/WorkspaceFileTree.tsx",
  "apps/desktop/src/renderer/TranscriptFileReference.tsx", "apps/desktop/src/renderer/workspace-state.ts",
  "apps/desktop/src/window-state.ts", "apps/desktop/src/renderer/dock-panel.css",
  "scripts/acceptance/file-preview-tabs.ts", "scripts/acceptance/file-preview-tabs-browser.tsx", "scripts/acceptance/file-preview-tabs-electron.cjs",
];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async source => [source, hash(await readFile(join(repo, source), "utf8"))])));
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output directory must be empty.");
const sourceAtBuild = await hashes();
try {
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><title>File preview tabs acceptance</title><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "file-preview-tabs-browser.tsx"))}"></script>`);
  await build({ configFile:false, root:output, logLevel:"warn", plugins:[react(),tailwindcss()], base:"./", build:{outDir:join(output,"web"),rollupOptions:{input:join(output,"index.html")}}});
  await writeFile(join(output,"launch.json"),JSON.stringify({profile:join(output,"electron-profile")}),{mode:0o600});
  const child = Bun.spawn([process.execPath,join(repo,"node_modules/electron/cli.js"),join(import.meta.dir,"file-preview-tabs-electron.cjs"),output],{stdout:Bun.file(join(output,"electron.log")),stderr:Bun.file(join(output,"electron-errors.log"))});
  const timer=setTimeout(()=>child.kill("SIGTERM"),90_000); const code=await child.exited; clearTimeout(timer);
  const result=JSON.parse(await readFile(join(output,"result.json"),"utf8"));
  result.sourceAtBuild=sourceAtBuild; result.sourceAfterRun=await hashes(); result.sourceHashesStable=JSON.stringify(result.sourceAtBuild)===JSON.stringify(result.sourceAfterRun); result.passed &&= code===0 && result.sourceHashesStable;
  await writeFile(join(output,"result.json"),JSON.stringify(result,null,2));
  if(!result.passed) throw new Error(`Preview-tab acceptance failed; inspect ${join(output,"result.json")}`);
  console.log(JSON.stringify({passed:true,output}));
} finally { await rm(join(output,"launch.json"),{force:true}); }
