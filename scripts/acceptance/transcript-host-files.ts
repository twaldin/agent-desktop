import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/transcript-host-files-${Date.now()}`);
const sources = [
  "apps/desktop/package.json", "bun.lock", "apps/desktop/src/main/workspace-save-copy.ts", "apps/desktop/src/main/preload.ts", "apps/desktop/src/main/main.ts",
  "apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/MarkdownText.tsx", "apps/desktop/src/renderer/TranscriptFileReference.tsx", "apps/desktop/src/renderer/transcript-links.ts", "apps/desktop/src/renderer/transcript-file-actions.ts",
  "apps/desktop/src/renderer/use-workbench-dock.tsx", "apps/desktop/src/renderer/dock-state.ts", "apps/desktop/src/renderer/file-preview-tabs.ts", "apps/desktop/src/renderer/DockPanel.tsx", "apps/desktop/src/window-state.ts",
  "apps/desktop/src/renderer/WorkspacePanel.tsx", "apps/desktop/src/renderer/workspace-state.ts", "apps/desktop/src/renderer/offline-cache.ts", "apps/desktop/src/renderer/PierreSourceEditor.tsx",
  "apps/desktop/src/renderer/markdown.css", "apps/desktop/src/renderer/transcript-file-reference.css", "apps/desktop/src/renderer/dock-panel.css", "apps/desktop/src/renderer/dock-layout.css", "apps/desktop/src/renderer/styles.css", "apps/desktop/src/renderer/theme.css",
  "apps/host/src/server.ts", "apps/host/src/workspace-http.ts", "apps/host/src/workspace/service.ts", "apps/host/src/workspace-open.ts",
  "packages/shared/src/protocol.ts", "packages/shared/src/workspace-protocol.ts", "packages/shared/src/workspace.ts",
  "scripts/acceptance/transcript-host-files.ts", "scripts/acceptance/transcript-host-files-host.ts", "scripts/acceptance/transcript-host-files-browser.tsx", "scripts/acceptance/transcript-host-files-electron.cjs",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));

await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty");
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-transcript-host-files-")));
const host = Bun.spawn([process.execPath, join(import.meta.dir, "transcript-host-files-host.ts"), fixture], {
  cwd: fixture,
  env: { HOME: fixture, PATH: process.env.PATH, TMPDIR: fixture, PI_CODING_AGENT_DIR: join(fixture, "agent"), TERM: "dumb", AGENT_DESKTOP_NATIVE_TERMINALS: "0", XDG_DATA_HOME: join(fixture, "xdg-data"), XDG_STATE_HOME: join(fixture, "xdg-state"), XDG_CONFIG_HOME: join(fixture, "xdg-config"), XDG_CACHE_HOME: join(fixture, "xdg-cache") },
  ipc: () => {}, stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")),
});
let proxy: ReturnType<typeof Bun.serve> | undefined, eventsSocket: WebSocket | undefined;
try {
  for (let i = 0; !(await Bun.file(join(fixture, "ready.json")).exists()); i++) { if (i > 700 || host.exitCode !== null) throw new Error("Native host fixture did not become ready"); await Bun.sleep(50); }
  const ready = JSON.parse(await readFile(join(fixture, "ready.json"), "utf8"));
  const sourceAtBuild = await hashes(), calls: any[] = [], rejected: any[] = [], pendingEvents: unknown[] = [];
  eventsSocket = new WebSocket(ready.connection.origin.replace("http:", "ws:") + "/v1/events", ["agent-desktop", ready.connection.token]);
  eventsSocket.addEventListener("message", event => pendingEvents.push({ ...JSON.parse(String(event.data)), hostId: ready.connection.hostId }));
  await new Promise<void>((done, reject) => { eventsSocket!.addEventListener("open", () => done(), { once: true }); eventsSocket!.addEventListener("error", () => reject(new Error("Native event stream unavailable")), { once: true }); });
  const allowed = new Map(Object.values(ready.paths as Record<string, string>).map(path => [path, basename(path)]));
  const capability = crypto.randomUUID(), cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" };
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith(`/${capability}/`)) return new Response(null, { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const route = pathname.slice(capability.length + 1), input = await request.json() as any;
    if (route === "/test/events") return Response.json(pendingEvents.splice(0), { headers: cors });
    if (route === "/test/state") {
      const native = await (await fetch(ready.connection.origin + "/v1/state", { headers: { Authorization: `Bearer ${ready.connection.token}` } })).json() as any;
      const launches = (await readFile(ready.launchesPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      return Response.json({ calls, rejected, launches, projects: native.projects?.length, sessions: native.sessions?.length, drafts: native.drafts?.length }, { headers: cors });
    }
    const target = input.target ?? input.command?.target, absolute = target?.filePath, expectedName = allowed.get(absolute);
    const queryType = input.query?.type, action = input.command?.action;
    const allowedQuery = route === "/v1/workspace/query" && ["file.read", "file.open-options"].includes(queryType);
    const allowedCommand = route === "/v1/commands" && input.command?.type === "workspace.mutate" && action?.type === "file.write";
    if (!allowedQuery && !allowedCommand || input.owner !== ready.connection.hostId || !expectedName || (input.query?.path ?? action?.path) !== expectedName) {
      rejected.push({ route, input }); return Response.json({ error: "Acceptance authority rejected request" }, { status: 403, headers: cors });
    }
    delete input.owner; calls.push({ route, target, query: queryType, action: action?.type, path: input.query?.path ?? action?.path });
    const response = await fetch(ready.connection.origin + route, { method: "POST", headers: { Authorization: `Bearer ${ready.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": ready.connection.hostId }, body: JSON.stringify(input) });
    return new Response(await response.arrayBuffer(), { status: response.status, headers: { ...cors, "Content-Type": "application/json" } });
  }});
  await mkdir(join(fixture, "downloads"), { mode: 0o700 });
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.transcript-host-files-fixture{height:100vh;background:var(--app-bg)}.fixture-transcript{padding:32px;overflow:auto}.dock-resize{display:none}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "transcript-host-files-browser.tsx"))}"></script>`);
  await build({ configFile: false, logLevel: "warn", root: output, plugins: [react(), tailwindcss()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
  const bundled = await Bun.build({ entrypoints: [join(repo, "apps/desktop/src/main/workspace-save-copy.ts"), join(repo, "apps/desktop/src/main/preload.ts")], external: ["electron"], outdir: output, target: "node", format: "cjs", naming: "[name].cjs" });
  if (!bundled.success) throw new Error("Main copy/preload build failed");
  await writeFile(join(output, "launch.json"), JSON.stringify({ ...ready, endpoint: `http://127.0.0.1:${proxy.port}/${capability}`, hostId: ready.connection.hostId, downloads: join(fixture, "downloads"), profile: join(fixture, "electron-profile") }), { mode: 0o600 });
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(import.meta.dir, "transcript-host-files-electron.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 120_000), code = await electron.exited; clearTimeout(timer);
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
  result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun); result.passed &&= code === 0 && result.sourceHashesStable;
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error(`Transcript host files acceptance failed; inspect ${join(output, "result.json")}`);
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  eventsSocket?.close(); proxy?.stop(true);
  if (host.exitCode === null) { try { host.send({ stop: true }); } catch {} }
  await host.exited; await rm(fixture, { recursive: true, force: true }); await rm(join(output, "launch.json"), { force: true });
}
