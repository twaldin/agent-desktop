import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/transcript-tables-${Date.now()}`);
const sources = [
  "apps/desktop/package.json", "bun.lock", "apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/Transcript.tsx",
  "apps/desktop/src/renderer/MarkdownText.tsx", "apps/desktop/src/renderer/TranscriptMarkdownTable.tsx", "apps/desktop/src/renderer/TranscriptTableIcons.tsx", "apps/desktop/src/renderer/transcript-table-copy.ts", "apps/desktop/src/renderer/transcript-markdown-table.css", "apps/desktop/src/renderer/markdown.css", "apps/desktop/src/renderer/styles.css", "apps/desktop/src/renderer/theme.css",
  "scripts/acceptance/transcript-tables.ts", "scripts/acceptance/transcript-tables-browser.tsx", "scripts/acceptance/transcript-tables-electron.cjs",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty");
const sourceAtBuild = await hashes();
await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;min-height:100%;overflow-x:hidden}.transcript-tables-fixture{box-sizing:border-box;width:100%;min-height:100vh;padding:24px}.transcript-tables-fixture>section{max-width:100%;margin-bottom:28px}.fixture-focus{position:fixed;right:12px;bottom:12px}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "transcript-tables-browser.tsx"))}"></script>`);
await build({ configFile: false, logLevel: "warn", root: output, plugins: [react(), tailwindcss()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
await writeFile(join(output, "launch.json"), JSON.stringify({ profile: join(output, "profile") }), { mode: 0o600 });
const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(import.meta.dir, "transcript-tables-electron.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
const timer = setTimeout(() => electron.kill("SIGTERM"), 90_000), code = await electron.exited; clearTimeout(timer);
const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun); result.passed &&= code === 0 && result.sourceHashesStable;
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
await Bun.file(join(output, "launch.json")).delete();
if (!result.passed) throw new Error(`Transcript tables acceptance failed; inspect ${join(output, "result.json")}`);
console.log(JSON.stringify({ passed: true, output }));
