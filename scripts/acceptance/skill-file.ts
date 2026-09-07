import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/skill-file-acceptance-${Date.now()}`);
const sources = [
  "apps/desktop/src/renderer/RichMarkdownEditor.tsx", "apps/desktop/src/renderer/rich-markdown-editor.css",
  "apps/desktop/src/renderer/PierreSourceEditor.tsx", "apps/desktop/src/renderer/pierre-source-editor.css", "apps/desktop/src/renderer/markdown-file-model.ts",
  "apps/desktop/package.json", "bun.lock",
  "apps/desktop/src/renderer/NativePluginDirectory.tsx", "apps/desktop/src/renderer/NativeSkillDialog.tsx",
  "apps/desktop/src/renderer/native-skill-dialog.css",
  "apps/desktop/src/renderer/native-skill-file-state.ts", "apps/desktop/src/renderer/NativeSkillFilePanel.tsx",
  "apps/desktop/src/renderer/native-skill-file-panel.css", "apps/desktop/src/renderer/use-workbench-dock.tsx",
  "apps/desktop/src/renderer/DockPanel.tsx", "apps/desktop/src/renderer/dock-state.ts", "apps/desktop/src/window-state.ts",
  "apps/desktop/src/renderer/styles.css", "apps/desktop/src/renderer/theme.css",
  "apps/host/src/skill-files.ts", "apps/host/src/composer-actions-http.ts", "apps/host/src/omp/composer-actions.ts",
  "apps/host/src/validation.ts", "apps/host/src/store.ts", "apps/host/src/server.ts",
  "packages/shared/src/composer-actions.ts", "packages/shared/src/protocol.ts",
  "scripts/acceptance/skill-file.ts", "scripts/acceptance/skill-file-host.ts",
  "scripts/acceptance/skill-file-browser.tsx", "scripts/acceptance/skill-file-electron.cjs",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty");
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-skill-file-")));
const host = Bun.spawn([process.execPath, join(import.meta.dir, "skill-file-host.ts"), fixture], {
  cwd: fixture,
  env: { HOME: fixture, PATH: process.env.PATH, TMPDIR: fixture, PI_CODING_AGENT_DIR: join(fixture, "agent"), TERM: "dumb", AGENT_DESKTOP_NATIVE_TERMINALS: "0",
    XDG_DATA_HOME: join(fixture, "xdg-data"), XDG_STATE_HOME: join(fixture, "xdg-state"), XDG_CONFIG_HOME: join(fixture, "xdg-config"), XDG_CACHE_HOME: join(fixture, "xdg-cache") },
  ipc: () => {}, stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")),
});
let proxy: ReturnType<typeof Bun.serve> | undefined, eventsSocket: WebSocket | undefined;
try {
  for (let i = 0; !(await Bun.file(join(fixture, "ready.json")).exists()); i++) { if (i > 700 || host.exitCode !== null) throw new Error("Native host fixture did not become ready"); await Bun.sleep(50); }
  const ready = JSON.parse(await readFile(join(fixture, "ready.json"), "utf8"));
  const sourceAtBuild = await hashes();
  const calls: Array<{ route: string; command?: string }> = [];
  const nativeEvents: unknown[] = [], pendingEvents: unknown[] = [];
  eventsSocket = new WebSocket(ready.connection.origin.replace("http:", "ws:") + "/v1/events", ["agent-desktop", ready.connection.token]);
  eventsSocket.addEventListener("message", event => { const value = JSON.parse(String(event.data)); nativeEvents.push(value); pendingEvents.push({ ...value, hostId: ready.connection.hostId }); });
  await new Promise<void>((resolve, reject) => { eventsSocket!.addEventListener("open", () => resolve(), { once: true }); eventsSocket!.addEventListener("error", () => reject(new Error("Native event stream unavailable")), { once: true }); });
  let revealAttempts = 0;
  let holdNextWrite=false, dropNextReceipt=false, releaseWrite:(()=>void)|undefined;

  const capability = crypto.randomUUID(), cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" };
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(`/${capability}/`)) return new Response(null, { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const route = path.slice(capability.length + 1), input = await request.json() as any;
    if (route === "/test/events") return Response.json(pendingEvents.splice(0), { headers: cors });
    if (route === "/test/file") return Response.json({ text: await readFile(ready.skillPath, "utf8"), sha256: createHash("sha256").update(await readFile(ready.skillPath)).digest("hex") }, { headers: cors });
    if (route === "/test/external-write") { if (typeof input.text !== "string" || input.text.length > 1024 * 1024) return new Response(null, { status: 400 }); await writeFile(ready.skillPath, input.text, { mode: 0o600 }); return Response.json({ written: true }, { headers: cors }); }
    if (route === "/test/save-gate") {
      if(input.action==="hold")holdNextWrite=true;
      else if(input.action==="release"){releaseWrite?.();releaseWrite=undefined;}
      else if(input.action==="drop")dropNextReceipt=true;
      else return new Response(null,{status:400,headers:cors});
      return Response.json({held:Boolean(releaseWrite)}, {headers:cors});
    }
    if (route === "/test/state") return Response.json({ calls, revealAttempts }, { headers: cors });
    if (route === "/v5/commands") {
      const type = input.command?.type;
      if (type === "skill.file.reveal") { revealAttempts++; return Response.json({ error: { message: "OS reveal is blocked in this fixture" } }, { status: 403, headers: cors }); }
      if (type !== "skill.file.write") return new Response(null, { status: 403, headers: cors });
      if (input.owner !== ready.connection.hostId) return new Response(null, { status: 403, headers: cors });
      delete input.owner;
    }
    const allowed = /^\/v1\/(integrations\/(plugins\/read|acquisition\/catalog)|settings\/read|composer\/(actions|skill-inventory|skill-detail|skill-file))$/;
    if (route !== "/v5/commands" && !allowed.test(route)) return new Response(null, { status: 403, headers: cors });
    if (input.owner !== undefined && input.owner !== ready.connection.hostId) return new Response(null, { status: 403, headers: cors });
    delete input.owner;
    calls.push({ route, command: route === "/v5/commands" ? input.command?.type : undefined });
    const isWrite=route==="/v5/commands"&&input.command?.type==="skill.file.write";
    if(isWrite&&holdNextWrite){holdNextWrite=false;await new Promise<void>(resolve=>{releaseWrite=resolve;});}
    const drop=isWrite&&dropNextReceipt;if(drop)dropNextReceipt=false;
    const response = await fetch(ready.connection.origin + route, { method: "POST", headers: {
      Authorization: `Bearer ${ready.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": ready.connection.hostId,
    }, body: JSON.stringify(input) });
    const bytes=await response.arrayBuffer();
    if(drop)return Response.json({error:{message:"Fixture withheld the actual host write receipt"}},{status:503,headers:cors});
    return new Response(bytes, { status: response.status, headers: { ...cors, "Content-Type": "application/json" } });
  }});
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>.skill-file-fixture{display:flex!important;height:100vh}.skill-file-directory{width:55%;min-width:480px}.dock-panel-right{flex:1;position:relative!important}</style><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "skill-file-browser.tsx"))}"></script>`);
  await build({ configFile: false, root: output, plugins: [react(), tailwindcss()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
  const initialSkillSha256 = createHash("sha256").update(await readFile(ready.skillPath)).digest("hex");
  await writeFile(join(output, "launch.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${proxy.port}/${capability}`, target: ready.target, hostId: ready.connection.hostId,
    ref: ready.ref, initialText: ready.initialText, profile: join(fixture, "electron-profile") }), { mode: 0o600 });
  const electron = Bun.spawn([String((await import("electron")).default), join(import.meta.dir, "skill-file-electron.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 120_000), code = await electron.exited; clearTimeout(timer);
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
  const finalStateResponse = await fetch(ready.connection.origin + "/v1/state", { headers: { Authorization: `Bearer ${ready.connection.token}` } });
  if (!finalStateResponse.ok) throw new Error("Final native state read failed");
  const finalState = await finalStateResponse.json() as any;
  const finalDraft = finalState.drafts.find((draft: any) => draft.id === "new-conversation");
  result.sessionCount = finalState.sessions.length;
  result.draftPersisted = finalDraft?.text === "EXISTING_UNSENT_SKILL_DRAFT" && finalDraft?.projectId === ready.target.projectId && finalDraft?.model === null && finalDraft?.revision === 1;
  result.skillOutsideProject = !ready.skillPath.startsWith(join(fixture, "project") + "/");
  result.revealAttempts = revealAttempts;
  result.calls = calls;
  result.nativeEvents = nativeEvents;
  result.initialSkillSha256 = initialSkillSha256;
  result.finalSkillSha256 = createHash("sha256").update(await readFile(ready.skillPath)).digest("hex");
  result.sourceAtBuild = sourceAtBuild;
  result.sourceAfterRun = await hashes();
  result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun);
  result.scope = "Production renderer/runtime acceptance in hidden Electron against an authenticated isolated host and native OMP user-skill discovery. It verifies actual file reads and writes, debounce, offline cache, read-detected external revision conflict, and an explicit resolution write against the refreshed revision. Stale-write CAS is covered by the backend unit suite. Native OS reveal, installed-main/preload routing and pixel parity are outside this harness.";
  result.passed &&= code === 0 && result.sessionCount === 0 && result.draftPersisted && result.skillOutsideProject && revealAttempts === 0 && result.sourceHashesStable;
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error(`Skill file acceptance failed; inspect ${join(output, "result.json")}`);
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  eventsSocket?.close();
  proxy?.stop(true);
  if (host.exitCode === null) { try { host.send({ stop: true }); } catch {} }
  await host.exited;
  await rm(fixture, { recursive: true, force: true });
  await rm(join(output, "launch.json"), { force: true });
}
