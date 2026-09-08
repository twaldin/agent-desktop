import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/transcript-markdown-images-${Date.now()}`);
const sources = ["apps/desktop/package.json", "bun.lock", "apps/desktop/src/main/workspace-image.ts", "apps/desktop/src/main/workspace-save-copy.ts", "apps/desktop/src/main/preload.ts", "apps/desktop/src/main/main.ts",
  "apps/desktop/src/renderer/MarkdownText.tsx", "apps/desktop/src/renderer/TranscriptMarkdownImage.tsx", "apps/desktop/src/renderer/transcript-markdown-image.css", "apps/desktop/src/renderer/transcript-image-source.ts", "apps/desktop/src/renderer/markdown-images.ts", "apps/desktop/src/renderer/markdown.css", "apps/desktop/src/renderer/Transcript.tsx", "apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/styles.css", "apps/desktop/src/renderer/theme.css", "packages/shared/src/protocol.ts", "packages/shared/src/workspace-protocol.ts", "packages/shared/src/workspace.ts", "apps/host/src/server.ts", "apps/host/src/workspace-http.ts", "apps/host/src/workspace/service.ts",
  "scripts/acceptance/transcript-markdown-images.ts", "scripts/acceptance/transcript-markdown-images-host.ts", "scripts/acceptance/transcript-markdown-images-browser.tsx", "scripts/acceptance/transcript-markdown-images-electron.cjs"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
await mkdir(output, { recursive: true, mode: 0o700 }); if ((await readdir(output)).length) throw new Error("Output must be empty");
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-transcript-markdown-images-")));
const host = Bun.spawn([process.execPath, join(import.meta.dir, "transcript-markdown-images-host.ts"), fixture], { cwd: fixture, env: { HOME: fixture, PATH: process.env.PATH, TMPDIR: fixture, PI_CODING_AGENT_DIR: join(fixture, "agent"), TERM: "dumb", AGENT_DESKTOP_NATIVE_TERMINALS: "0", XDG_DATA_HOME: join(fixture, "xdg-data"), XDG_STATE_HOME: join(fixture, "xdg-state"), XDG_CONFIG_HOME: join(fixture, "xdg-config"), XDG_CACHE_HOME: join(fixture, "xdg-cache") }, ipc: () => {}, stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")) });
try {
  for (let i = 0; !(await Bun.file(join(fixture, "ready.json")).exists()); i++) { if (i > 700 || host.exitCode !== null) throw new Error("Native host fixture did not become ready"); await Bun.sleep(50); }
  const ready = JSON.parse(await readFile(join(fixture, "ready.json"), "utf8")); const sourceAtBuild = await hashes();
  await mkdir(join(fixture, "downloads"), { mode: 0o700 });
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: agent-workspace-image:; connect-src 'none'"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:auto}.transcript-image-fixture{min-height:100vh;padding:28px}.transcript-markdown{max-width:900px}.fixture-focus{position:fixed;right:16px;bottom:16px}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "transcript-markdown-images-browser.tsx"))}"></script>`);
  await build({ configFile: false, logLevel: "warn", root: output, plugins: [react(), tailwindcss()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
  const bundled = await Bun.build({ entrypoints: [join(repo, "apps/desktop/src/main/workspace-image.ts"), join(repo, "apps/desktop/src/main/workspace-save-copy.ts"), join(repo, "apps/desktop/src/main/preload.ts")], external: ["electron"], outdir: output, target: "node", format: "cjs", naming: "[name].cjs" });
  if (!bundled.success) throw new Error("Main image/copy/preload build failed");
  await writeFile(join(output, "launch.json"), JSON.stringify({ ...ready, hostId: ready.connection.hostId, downloads: join(fixture, "downloads"), profile: join(fixture, "electron-profile") }), { mode: 0o600 });
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(import.meta.dir, "transcript-markdown-images-electron.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 120_000), code = await electron.exited; clearTimeout(timer);
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun); result.passed &&= code === 0 && result.sourceHashesStable; await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error(`Transcript Markdown images acceptance failed; inspect ${join(output, "result.json")}`); console.log(JSON.stringify({ passed: true, output }));
} finally {
  if (host.exitCode === null) { try { host.send({ stop: true }); } catch {} } await host.exited;
  await rm(fixture, { recursive: true, force: true }); await rm(join(output, "launch.json"), { force: true });
}
