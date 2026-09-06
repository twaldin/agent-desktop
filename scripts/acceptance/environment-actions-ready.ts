import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import { startHost } from "../../apps/host/src/server";
import { LocalEnvironmentStore } from "../../apps/host/src/local-environments";
import { serializeLocalEnvironment, type CommandEnvelope, type CommandResult, type Project } from "../../packages/shared/src/protocol";

const root = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/environment29/actions-ready-${Date.now()}`);
const nativeBundle = process.env.AGENT_TEST_TMUX_BUNDLE;
if (!nativeBundle) throw new Error("AGENT_TEST_TMUX_BUNDLE must name the reviewed bundled tmux runtime.");
const componentOverride = process.env.AGENT_ACTIONS_READY_COMPONENT_OVERRIDE
  ? await realpath(process.env.AGENT_ACTIONS_READY_COMPONENT_OVERRIDE)
  : undefined;
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error(`Refusing to replace nonempty acceptance evidence: ${output}`);
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-actions-ready-")));
const dataDirectory = join(fixture, "data"), agentDirectory = join(fixture, "agent"), source = join(fixture, "source");
await Promise.all([dataDirectory, agentDirectory, source].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
let host: Awaited<ReturnType<typeof startHost>> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;
const sources = [
  "apps/desktop/src/renderer/EnvironmentActions.tsx",
  "apps/desktop/src/renderer/environment-actions.css",
  "apps/desktop/src/renderer/workspace-state.ts",
  "apps/desktop/src/renderer/Icons.tsx",
  "scripts/acceptance/environment-actions-ready.ts",
  "scripts/acceptance/environment-actions-ready-browser.tsx",
];
const hashes = () => Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])).then(Object.fromEntries);

try {
  const saved = await new LocalEnvironmentStore(source).save({ expectedRevision: null, raw: serializeLocalEnvironment({
    version: 1, name: "Ready environment", setup: { script: "" }, actions: [{ name: "Count run", icon: "run", command: "true" }],
  }) });
  if (saved.type !== "saved") throw new Error("Environment fixture was not saved.");
  host = await startHost({ dataDirectory, agentDirectory, discoveryDirectory: source,
    workerPath: join(root, "apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), nativeTerminalBundle: await realpath(nativeBundle), tailscale: false, port: 0 });
  const hostRequest = (path: string, body?: unknown) => fetch(host!.connection.origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${host!.connection.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const send = async (envelope: CommandEnvelope) => {
    const response = await hostRequest("/v5/commands", envelope);
    if (!response.ok) throw new Error(`Host command HTTP ${response.status}`);
    return response.json() as Promise<CommandResult>;
  };
  const added = await send({ id: crypto.randomUUID(), command: { type: "project.add", path: source, name: "Ready fixture" } });
  if (!added.ok || !added.value || !("path" in added.value)) throw new Error("Project add failed.");
  const project = added.value as Project;

  const capability = crypto.randomUUID();
  let authenticatedQueries = 0;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`/${capability}/`)) return new Response(null, { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Headers": "content-type" } });
    const path = url.pathname.slice(capability.length + 1);
    if (request.method !== "POST" || path !== "/v1/workspace/query") return new Response(null, { status: 403, headers: { "Access-Control-Allow-Origin": "null" } });
    const body = await request.json();
    if ((body as any)?.query?.type === "environment.actions") authenticatedQueries++;
    const response = await hostRequest(path, body), bytes = await response.arrayBuffer();
    return new Response(bytes, { status: response.status, headers: { "Access-Control-Allow-Origin": "null", "content-type": response.headers.get("content-type") ?? "application/json" } });
  }});

  const before = await hashes();
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src http://127.0.0.1:${proxy.port}"><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "environment-actions-ready-browser.tsx"))}"></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", worker: { format: "es" },
    plugins: componentOverride ? [{ name: "actions-ready-component-override", enforce: "pre", resolveId(id) {
      return id === "../../apps/desktop/src/renderer/EnvironmentActions" ? componentOverride : undefined;
    } }] : [],
    build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  const endpoint = `http://127.0.0.1:${proxy.port}/${capability}`;
  await writeFile(join(output, "main.cjs"), `const{app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setPath('userData',${JSON.stringify(join(fixture, "profile"))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:760,height:500,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});const read=s=>win.webContents.executeJavaScript(s,true);let step='load';try{await win.loadFile(path.join(__dirname,'web/index.html'),{query:{endpoint:${JSON.stringify(endpoint)},host:${JSON.stringify(host.store.host.id)},project:${JSON.stringify(project.id)}}});step='mounted';const before=await read('window.awaitMountedBeforeOwner()');step='connect';const connected=await read('window.connectOwner()');const image=await win.webContents.capturePage();fs.writeFileSync(path.join(__dirname,'connected.png'),image.toPNG());step='reconnect';const reconnected=await read('window.reconnectOwner()');fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:true,hidden:true,electron:process.versions.electron,before,connected,reconnected,raster:image.getSize()},null,2));app.exit(0)}catch(error){fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:false,step,error:String(error),state:await read('window.actionsReadyState?.()').catch(()=>null)},null,2));app.exit(1)}});`);
  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000), exitCode = await child.exited; clearTimeout(timer);
  const result = await Bun.file(join(output, "result.json")).json().catch(() => ({ passed: false, error: "Electron exited without a result." }));
  const after = await hashes();
  Object.assign(result, { exitCode, authenticatedQueries, sourceAtBuild: before, sourceAfterBuild: after, sourceHashesStable: JSON.stringify(before) === JSON.stringify(after), componentOverride: componentOverride ? { path: componentOverride, sha256: createHash("sha256").update(await readFile(componentOverride)).digest("hex") } : null,
    scope: "Mounted production EnvironmentActions and WorkspaceState in hidden Electron against a real authenticated owning host. The UI connection prop remains true while owner workspace connectivity is delayed and reconnected." });
  result.passed &&= exitCode === 0 && authenticatedQueries >= 2 && result.before?.environmentQueries === 0 && result.connected?.environmentQueries >= 1
    && result.reconnected?.environmentQueries > result.reconnected?.beforeReconnect && result.sourceHashesStable;
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, result: join(output, "result.json") }));
  if (!result.passed) throw new Error(`Environment actions readiness acceptance failed; inspect ${join(output, "result.json")}`);
} finally {
  proxy?.stop(); await host?.stop(); await rm(fixture, { recursive: true, force: true });
}
