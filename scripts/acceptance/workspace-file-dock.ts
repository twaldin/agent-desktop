import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/workspace-file-dock-acceptance-${Date.now()}`);
const sources = [
  "apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/DockPanel.tsx", "apps/desktop/src/renderer/Icons.tsx", "apps/desktop/src/renderer/dock-state.ts", "apps/desktop/src/renderer/use-workbench-dock.tsx", "apps/desktop/src/window-state.ts",
  "apps/desktop/src/renderer/WorkspacePanel.tsx", "apps/desktop/src/renderer/WorkspaceFileBreadcrumbs.tsx", "apps/desktop/src/renderer/workspace-file-breadcrumbs.css",
  "apps/desktop/src/renderer/WorkspaceFileTree.tsx", "apps/desktop/src/renderer/workspace-file-tree.css", "apps/desktop/src/renderer/WorkspaceFileTreePane.tsx", "apps/desktop/src/renderer/workspace-file-tree-pane.css", "apps/desktop/src/renderer/file-tree-layout.ts",
  "apps/desktop/src/renderer/workspace-state.ts", "apps/desktop/src/renderer/workspace-lease.ts", "apps/desktop/src/renderer/PierreSourceEditor.tsx", "apps/desktop/src/renderer/pierre-source-editor.css",
  "apps/desktop/src/renderer/styles.css", "apps/desktop/src/renderer/theme.css", "apps/desktop/src/renderer/dock-panel.css", "apps/desktop/src/renderer/offline-cache.ts",
  "apps/host/src/workspace/service.ts", "apps/host/src/workspace-http.ts", "apps/host/src/server.ts", "packages/shared/src/workspace.ts", "packages/shared/src/workspace-protocol.ts", "packages/shared/src/protocol.ts",
  "scripts/acceptance/workspace-file-host.ts", "scripts/acceptance/workspace-file-dock.ts", "scripts/acceptance/workspace-file-dock-browser.tsx", "scripts/acceptance/workspace-file-dock-electron.cjs",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty");
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-workspace-file-dock-")));
const host = Bun.spawn([process.execPath, join(import.meta.dir, "workspace-file-host.ts"), fixture], { cwd: fixture,
  env: { HOME: fixture, PATH: process.env.PATH, TMPDIR: fixture, PI_CODING_AGENT_DIR: join(fixture, "agent"), TERM: "dumb", AGENT_DESKTOP_NATIVE_TERMINALS: "0",
    XDG_DATA_HOME: join(fixture, "xdg-data"), XDG_STATE_HOME: join(fixture, "xdg-state"), XDG_CONFIG_HOME: join(fixture, "xdg-config"), XDG_CACHE_HOME: join(fixture, "xdg-cache") },
  ipc: () => {}, stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")) });
let proxy: ReturnType<typeof Bun.serve> | undefined, eventsSocket: WebSocket | undefined;
try {
  for (let i = 0; !(await Bun.file(join(fixture, "ready.json")).exists()); i++) { if (i > 700 || host.exitCode !== null) throw new Error("Native host fixture did not become ready"); await Bun.sleep(50); }
  const ready = JSON.parse(await readFile(join(fixture, "ready.json"), "utf8"));
  await mkdir(join(ready.project, "empty"), { mode: 0o700 }); await mkdir(join(ready.project, "nested", "deeper"), { recursive: true, mode: 0o700 });
  const nestedText = "export const nested = 'unchanged';\n"; await writeFile(join(ready.project, "nested", "nested.ts"), nestedText, { mode: 0o600 }); ready.files["nested/nested.ts"] = nestedText;
  const deepText = "export const deeplyNested = 'unchanged';\n"; await writeFile(join(ready.project, "nested", "deeper", "deep.ts"), deepText, { mode: 0o600 }); ready.files["nested/deeper/deep.ts"] = deepText;
  const sourceAtBuild = await hashes(), calls: Array<{ route: string; command?: string; action?: string }> = [], pendingEvents: unknown[] = [];
  eventsSocket = new WebSocket(ready.connection.origin.replace("http:", "ws:") + "/v1/events", ["agent-desktop", ready.connection.token]);
  eventsSocket.addEventListener("message", event => pendingEvents.push({ ...JSON.parse(String(event.data)), hostId: ready.connection.hostId }));
  await new Promise<void>((done, reject) => { eventsSocket!.addEventListener("open", () => done(), { once: true }); eventsSocket!.addEventListener("error", () => reject(new Error("Native event stream unavailable")), { once: true }); });
  const capability = crypto.randomUUID(), cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" };
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname; if (!pathname.startsWith(`/${capability}/`)) return new Response(null, { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const route = pathname.slice(capability.length + 1), input = await request.json() as any;
    if (route === "/test/events") return Response.json(pendingEvents.splice(0), { headers: cors });
    const fixturePath = (file: unknown) => { if (file !== "first.ts" && file !== "second.ts" && file !== "nested/nested.ts" && file !== "nested/deeper/deep.ts") throw new Error("Unknown fixture file"); return join(ready.project, file); };
    if (route === "/test/file") return Response.json({ text: await readFile(fixturePath(input.file), "utf8") }, { headers: cors });
    if (route === "/test/state") {
      const response = await fetch(ready.connection.origin + "/v1/state", { headers: { Authorization: `Bearer ${ready.connection.token}` } }); const native = await response.json() as any;
      return Response.json({ calls, workspaceWrites: calls.filter(call => call.command === "workspace.mutate" && call.action === "file.write").length, sessions: native.sessions?.length,
        draft: native.drafts?.find((draft: any) => draft.id === "new-conversation") }, { headers: cors });
    }
    if (route !== "/v1/workspace/query" && route !== "/v1/commands") return new Response(null, { status: 403, headers: cors });
    if (input.owner !== ready.connection.hostId) return new Response(null, { status: 403, headers: cors }); delete input.owner;
    if (route === "/v1/commands" && (input.command?.type !== "workspace.mutate" || input.command?.action?.type !== "file.write")) return new Response(null, { status: 403, headers: cors });
    calls.push({ route, command: input.command?.type, action: input.command?.action?.type });
    const response = await fetch(ready.connection.origin + route, { method: "POST", headers: { Authorization: `Bearer ${ready.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": ready.connection.hostId }, body: JSON.stringify(input) });
    return new Response(await response.arrayBuffer(), { status: response.status, headers: { ...cors, "Content-Type": "application/json" } });
  }});
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.workspace-file-dock-fixture{display:grid;height:100vh;grid-template-columns:minmax(320px,1fr) minmax(620px,46%);grid-template-rows:40px minmax(0,1fr) 420px;background:var(--app-surface)}.fixture-actions{grid-column:1;grid-row:1;display:flex;gap:8px;padding:5px 8px}.dock-slot{display:flex;min-width:0;min-height:0}.dock-slot>.dock-panel{flex:1}.dock-slot-right{grid-column:2;grid-row:1/4}.dock-slot-bottom{grid-column:1;grid-row:3}.workspace-panel{position:relative;flex:1;width:auto;min-width:0}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "workspace-file-dock-browser.tsx"))}"></script>`);
  await build({ configFile: false, root: output, plugins: [react(), tailwindcss()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
  await writeFile(join(output, "launch.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${proxy.port}/${capability}`, target: ready.target, hostId: ready.connection.hostId, files: ready.files, profile: join(fixture, "electron-profile") }), { mode: 0o600 });
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(import.meta.dir, "workspace-file-dock-electron.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 120_000), code = await electron.exited; clearTimeout(timer);
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8")); const final = await (await fetch(ready.connection.origin + "/v1/state", { headers: { Authorization: `Bearer ${ready.connection.token}` } })).json() as any;
  const draft = final.drafts?.find((value: any) => value.id === "new-conversation"); result.finalHost = { sessionCount: final.sessions?.length, draft, workspaceWrites: result.proxy?.workspaceWrites };
  result.draftUnchanged = draft?.text === "EXISTING_UNSENT_WORKSPACE_DRAFT" && draft?.projectId === ready.target.projectId && draft?.model === null && draft?.revision === 1;
  result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun);
  result.scope = "Actual useWorkbenchDock, DockPanel, WorkspacePanel, WorkspaceState and PierreSourceEditor in hidden Electron against an authenticated isolated native host. Native keyboard input and workspace file reads/writes are exercised. Installed App/main/preload routing, visible/native-window behavior, physical input, providers, OS actions and matched screenshot/pixel parity are outside this harness.";
  result.passed &&= code === 0 && result.finalHost.sessionCount === 0 && result.draftUnchanged && result.finalHost.workspaceWrites === 2 && result.sourceHashesStable;
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2)); if (!result.passed) throw new Error(`Workspace file dock acceptance failed; inspect ${join(output, "result.json")}`); console.log(JSON.stringify({ passed: true, output }));
} finally { eventsSocket?.close(); proxy?.stop(true); if (host.exitCode === null) { try { host.send({ stop: true }); } catch {} } await host.exited; await rm(fixture, { recursive: true, force: true }); await rm(join(output, "launch.json"), { force: true }); }
