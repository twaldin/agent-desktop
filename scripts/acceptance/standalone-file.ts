import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/standalone-file-${Date.now()}`);
const sources = [
  "apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/use-workbench-dock.tsx", "apps/desktop/src/renderer/dock-state.ts", "apps/desktop/src/window-state.ts",
  "apps/desktop/src/renderer/ComposerEditor.tsx", "apps/desktop/src/renderer/composer-document.ts", "apps/desktop/src/renderer/composer-editor.css",
  "apps/desktop/src/renderer/WorkspacePanel.tsx", "apps/desktop/src/renderer/workspace-state.ts", "apps/desktop/src/renderer/offline-cache.ts",
  "apps/desktop/src/renderer/whole-file-composer.ts", "apps/desktop/src/renderer/TranscriptFileReference.tsx",
  "apps/desktop/src/renderer/PierreSourceEditor.tsx", "apps/desktop/src/renderer/pierre-source-editor.css", "apps/desktop/src/renderer/styles.css", "apps/desktop/src/renderer/theme.css",
  "apps/host/src/server.ts", "apps/host/src/workspace-http.ts", "apps/host/src/workspace/service.ts",
  "packages/shared/src/protocol.ts", "packages/shared/src/workspace-protocol.ts", "packages/shared/src/workspace.ts",
  "scripts/acceptance/standalone-file.ts", "scripts/acceptance/standalone-file-host.ts", "scripts/acceptance/standalone-file-browser.tsx", "scripts/acceptance/standalone-file-electron.cjs",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));

await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty");
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-standalone-file-ui-")));
const host = Bun.spawn([process.execPath, join(import.meta.dir, "standalone-file-host.ts"), fixture], {
  cwd: fixture,
  env: { HOME: fixture, PATH: process.env.PATH, TMPDIR: fixture, PI_CODING_AGENT_DIR: join(fixture, "agent"), TERM: "dumb", AGENT_DESKTOP_NATIVE_TERMINALS: "0", XDG_DATA_HOME: join(fixture, "xdg-data"), XDG_STATE_HOME: join(fixture, "xdg-state"), XDG_CONFIG_HOME: join(fixture, "xdg-config"), XDG_CACHE_HOME: join(fixture, "xdg-cache") },
  ipc: () => {}, stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")),
});
let proxy: ReturnType<typeof Bun.serve> | undefined;
let eventsSocket: WebSocket | undefined;
try {
  for (let i = 0; !(await Bun.file(join(fixture, "ready.json")).exists()); i++) { if (i > 700 || host.exitCode !== null) throw new Error("Native host fixture did not become ready"); await Bun.sleep(50); }
  const ready = JSON.parse(await readFile(join(fixture, "ready.json"), "utf8"));
  const sourceAtBuild = await hashes();
  const calls: any[] = [], rejected: any[] = [], pendingEvents: unknown[] = [];
  eventsSocket = new WebSocket(ready.connection.origin.replace("http:", "ws:") + "/v1/events", ["agent-desktop", ready.connection.token]);
  eventsSocket.addEventListener("message", event => pendingEvents.push({ ...JSON.parse(String(event.data)), hostId: ready.connection.hostId }));
  await new Promise<void>((done, reject) => { eventsSocket!.addEventListener("open", () => done(), { once: true }); eventsSocket!.addEventListener("error", () => reject(new Error("Native event stream unavailable")), { once: true }); });
  const capability = crypto.randomUUID();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" };
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith(`/${capability}/`)) return new Response(null, { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const route = pathname.slice(capability.length + 1);
    const input = await request.json() as any;
    if (route === "/test/events") return Response.json(pendingEvents.splice(0), { headers: cors });
    if (route === "/test/file") return Response.json({ text: await readFile(ready.filePath, "utf8") }, { headers: cors });
    if (route === "/test/remove") { await unlink(ready.filePath); return Response.json({ removed: true }, { headers: cors }); }
    if (route === "/test/state") {
      const native = await (await fetch(ready.connection.origin + "/v1/state", { headers: { Authorization: `Bearer ${ready.connection.token}` } })).json() as any;
      return Response.json({ calls, rejected, projects: native.projects?.length, sessions: native.sessions?.length, drafts: native.drafts?.length, isolatedAgentConfig: "extensions: []", providerWorker: "no-provider-worker" }, { headers: cors });
    }
    const allowedQuery = route === "/v1/workspace/query" && ["file.read", "file.open-options"].includes(input.query?.type);
    const allowedCommand = route === "/v1/commands" && input.command?.type === "workspace.mutate" && input.command?.action?.type === "file.write";
    if (!allowedQuery && !allowedCommand) { rejected.push({ route, input }); return new Response(null, { status: 403, headers: cors }); }
    if (input.owner !== ready.connection.hostId || JSON.stringify(input.target ?? input.command?.target) !== JSON.stringify(ready.target)) { rejected.push({ route, input, reason: "owner or target" }); return new Response(null, { status: 403, headers: cors }); }
    delete input.owner;
    calls.push({ route, query: input.query?.type, command: input.command?.type, action: input.command?.action?.type, path: input.query?.path ?? input.command?.action?.path });
    const response = await fetch(ready.connection.origin + route, { method: "POST", headers: { Authorization: `Bearer ${ready.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": ready.connection.hostId }, body: JSON.stringify(input) });
    return new Response(await response.arrayBuffer(), { status: response.status, headers: { ...cors, "Content-Type": "application/json" } });
  }});
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.standalone-file-fixture{display:flex;height:100vh;min-width:0}.standalone-file-fixture>.workspace-panel{position:relative;flex:1;width:auto;min-width:0}.standalone-composer{position:absolute;left:24px;bottom:16px;width:440px;padding:12px;border-radius:16px;background:var(--composer-surface);z-index:20}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "standalone-file-browser.tsx"))}"></script>`);
  await build({ configFile: false, logLevel: "warn", root: output, plugins: [react(), tailwindcss()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
  await writeFile(join(output, "launch.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${proxy.port}/${capability}`, target: ready.target, hostId: ready.connection.hostId, filePath: ready.filePath, fileName: ready.fileName, initialText: ready.initialText, profile: join(fixture, "electron-profile") }), { mode: 0o600 });
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(import.meta.dir, "standalone-file-electron.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 120_000);
  const code = await electron.exited;
  clearTimeout(timer);
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
  result.sourceAtBuild = sourceAtBuild;
  result.sourceAfterRun = await hashes();
  result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun);
  result.passed &&= code === 0 && result.sourceHashesStable;
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error(`Standalone file acceptance failed; inspect ${join(output, "result.json")}`);
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  eventsSocket?.close();
  proxy?.stop(true);
  if (host.exitCode === null) { try { host.send({ stop: true }); } catch {} }
  await host.exited;
  await rm(fixture, { recursive: true, force: true });
  await rm(join(output, "launch.json"), { force: true });
}
