import { mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { startHost } from "../../../apps/host/src/server";
import { HostStore } from "../../../apps/host/src/store";
import { WindowStateStore } from "../../../apps/desktop/src/main/window-state";
import { defaultWindowView } from "../../../apps/desktop/src/window-state";
import type { CommandEnvelope } from "../../../packages/shared/src/protocol";
const root = resolve(import.meta.dir, "../../..");
const out = resolve(process.argv[2] ?? `.data/sidebar-rendered-${Date.now()}`);
await mkdir(out, { recursive: true });
const hosts: Awaited<ReturnType<typeof startHost>>[] = [];
const calls: { host: string; command: string; sessionId?: string; archived?: boolean; accepted: boolean }[] = [];
const names = new Map<string, string>();
const windowStore = new WindowStateStore(join(out, "window"), "fixture");
let failureHost: string | undefined;
let fixtureServer: ReturnType<typeof Bun.serve> | undefined;
try {
  for (const [index, name] of ["Home", "Work"].entries()) {
    const dir = join(out, name), projectDir = join(dir, "project");
    await mkdir(projectDir, { recursive: true }); await mkdir(join(dir, "omp"), { recursive: true });
    const store = new HostStore(join(dir, "data"));
    const project = store.addProject({ path: projectDir, name: name === "Home" ? "Zebra project" : "Alpha project" });
    names.set(store.host.id, name);
    for (let i = 0; i < 3; i++) store.upsertSession({ id: crypto.randomUUID(), hostId: store.host.id, projectId: i < 2 ? project.id : null, cwd: projectDir,
      title: `${name} ${["older", "newer", "loose"][i]}`, status: "idle", sessionFile: join(dir, `session-${i}.jsonl`), model: null, createdAt: 1000+i, updatedAt: 1000+index*100+i*10, archived: false });
    store.close();
    hosts.push(await startHost({ dataDirectory: join(dir,"data"), agentDirectory: join(dir,"omp"), discoveryDirectory: projectDir, port: 0, tailscale: false }));
  }
  const fetchHost = async (hostId: string, path: string, body?: unknown) => {
    const host = hosts.find(host => host.connection.hostId === hostId); if (!host) throw Error("Unknown fixture owner");
    const response = await fetch(`${host.connection.origin}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error(`Fixture host HTTP ${response.status}`); return response.json();
  };
  fixtureServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
      const { method, args = [] } = await request.json() as { method: string; args: any[] };
      if (method === "bootstrap") return Response.json({ groups: await Promise.all(hosts.map(async host => ({ state: await fetchHost(host.connection.hostId, "/v1/state"), name: names.get(host.connection.hostId) }))), view: windowStore.bootstrap().state ?? defaultWindowView() });
      if (method === "preferences") return Response.json(await fetchHost(args[0], "/v1/preferences"));
      if (method === "saveView") return Response.json(windowStore.saveView(args[0]));
      if (method === "failNextArchive") { failureHost = args[0]; return Response.json({}); }
      if (method === "command") {
        const [envelope, host] = args as [CommandEnvelope, string];
        const failed = envelope.command.type === "session.archive" && host === failureHost;
        calls.push({ host, command: envelope.command.type, ...(envelope.command.type === "session.archive" ? { sessionId: envelope.command.sessionId, archived: envelope.command.archived } : {}), accepted: !failed });
        if (failed) { failureHost = undefined; return Response.json({ ok: false, commandId: envelope.id, error: { code: "FIXTURE_FAILURE", message: "Fixture archive refusal" } }); }
        return Response.json(await fetchHost(host, "/v1/commands", envelope));
      }
      if (method === "evidence") return Response.json({ calls, view: windowStore.bootstrap(), persisted: await Promise.all(hosts.map(async host => ({ state: await fetchHost(host.connection.hostId,"/v1/state"), preferences: await fetchHost(host.connection.hostId,"/v1/preferences") }))) });
      throw Error(`Unexpected fixture method ${method}`);
    } catch (cause) { return Response.json({ fixtureError: String(cause) }, { status: 500 }); }
  } });
  await writeFile(join(out, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="/scripts/acceptance/sidebar-organization-fixture/browser.tsx"></script>');
  await build({ configFile: false, plugins: [react(), tailwindcss()], root, base: "./", build: { target: "esnext", outDir: join(out,"web"), rollupOptions: { input: join(out,"index.html") } } });
  await writeFile(join(out,"preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('sidebarFixture',{invoke:(method,args)=>ipcRenderer.invoke('sidebar-fixture',method,args)});`);
  const html = (await readdir(join(out,"web"), { recursive: true })).find(file => file.endsWith("index.html"));
  if (!html) throw Error("Missing fixture HTML");
  const electron = createRequire(import.meta.url)("electron") as string;
  const child = Bun.spawn([electron, resolve(import.meta.dir,"electron.cjs"), out, join(out,"web",html), fixtureServer.url.toString()], { stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
  try { const exit = await child.exited; if (exit !== 0) process.exitCode = 1; }
  finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
} finally {
  fixtureServer?.stop(true);
  const drained = await Promise.allSettled(hosts.map(host => host.stop()));
  if (drained.some(result => result.status === "rejected")) throw new AggregateError(drained.flatMap(result => result.status === "rejected" ? [result.reason] : []), "Fixture hosts failed to stop");
}
