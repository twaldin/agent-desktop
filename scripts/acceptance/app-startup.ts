import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { build } from "vite";
import { createHash } from "node:crypto";
import { writeAppStartupSummary } from "./app-startup-summary";

const root = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? ".data/app-startup-acceptance");
await mkdir(output, { recursive: true, mode: 0o700 });
const sourcePaths = ["apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/ComposerPermissions.tsx", "apps/desktop/src/renderer/submissions.ts", "apps/desktop/src/renderer/drafts.ts", "apps/desktop/src/renderer/PendingInteractions.tsx", "apps/desktop/src/main/command-endpoints.ts", "apps/host/src/server.ts", "apps/host/src/omp-workers/runtime.ts", "scripts/acceptance/app-startup-browser.tsx", "scripts/acceptance/app-startup-main.ts", "scripts/acceptance/app-startup-host.ts", "scripts/acceptance/app-startup-extension.ts"];
const sourceAtBuild = { recordedAt: new Date().toISOString(), sha256: Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")]))) };
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-app-startup-")));
const host = Bun.spawn([process.execPath, join(import.meta.dir, "app-startup-host.ts"), fixture], {
  env: { HOME: fixture, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: join(fixture, "agent"), TERM: "dumb", AGENT_DESKTOP_NATIVE_TERMINALS: "0" },
  stdin: "pipe", stdout: Bun.file(join(output, "host.stdout.log")), stderr: Bun.file(join(output, "host.stderr.log")),
});
let electron: Bun.Subprocess | undefined;
try {
  const readyAt = Date.now();
  while (!await Bun.file(join(fixture, "fixture-connection.json")).exists()) {
    if (host.exitCode !== null) throw new Error(`Native fixture exited (${host.exitCode}); inspect host.stderr.log`);
    if (Date.now() - readyAt > 35_000) throw new Error("Native host fixture did not start in time");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const connection = JSON.parse(await readFile(join(fixture, "fixture-connection.json"), "utf8"));
  const request = async (command: unknown) => {
    const response = await fetch(connection.origin + "/v1/commands", { method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), command }) });
    const result = await response.json() as any; if (!response.ok || !result.ok) throw new Error(`Fixture preparation failed: ${JSON.stringify(result)}`); return result.value;
  };
  const project = await request({ type: "project.add", path: join(fixture, "project"), name: "Native startup acceptance project with a long name" });
  await request({ type: "draft.put", expectedRevision: 0, draft: { id: "new-conversation", projectId: project.id, text: "", model: null } });
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><title>App native startup acceptance</title><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "app-startup-browser.tsx"))}"></script>`);
  await build({ configFile: join(root, "apps/desktop/vite.config.ts"), root: output, logLevel: "warn", build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } } });
  const compiled = await Bun.build({ entrypoints: [join(import.meta.dir, "app-startup-main.ts")], outdir: output, naming: "[name].mjs", target: "node", format: "esm", external: ["electron"] });
  if (!compiled.success) throw new Error(compiled.logs.join("\n"));
  await writeFile(join(output, "preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixtureApi',{call:(method,args)=>ipcRenderer.invoke('fixture-call',method,args),subscribe:listener=>{const handler=(_event,value)=>listener(value);ipcRenderer.on('fixture-event',handler);return()=>ipcRenderer.removeListener('fixture-event',handler);}});`);
  electron = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "app-startup-main.mjs"), output, fixture], { stdout: "inherit", stderr: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const timer = setTimeout(() => electron!.kill("SIGTERM"), 100_000); const code = await electron.exited; clearTimeout(timer);
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
  result.sourceAtBuild = sourceAtBuild;
  if (result.state) {
    result.nativeHistory = [];
    for (const session of result.state.sessions) {
      if (!session.sessionFile.startsWith(fixture + "/")) throw new Error("Fixture returned a native history outside its isolated directory");
      const text = await readFile(session.sessionFile, "utf8");
      const entries = text.trim().split("\n").map(line => JSON.parse(line));
      const answers = entries.filter(entry => entry.customType === "renderer-startup-answer"), dispatches = entries.filter(entry => entry.customType === "renderer-startup-dispatched");
      const filename = `${session.id}.jsonl`; await writeFile(join(output, filename), text, { mode: 0o600 });
      result.nativeHistory.push({ sessionId: session.id, file: filename, answers: answers.map(entry => entry.data), dispatchCount: dispatches.length });
      if (answers.length !== 1 || answers[0].data.confirmed !== true || dispatches.length !== 1) { result.passed = false; result.nativeError = "Native history did not record exactly one explicit true response and handled command"; }
    }
  }
  result.layoutPassed = result.captures.every((capture: any) => capture.fitting && !capture.horizontalOverflow && capture.questionVisible);
  if (!result.layoutPassed) result.passed = false;
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  await writeAppStartupSummary(output);
  if (code || !result.passed) throw new Error(`App startup acceptance failed; inspect ${join(output, "result.json")}`);
} finally {
  if (electron && electron.exitCode === null) { electron.kill("SIGTERM"); await electron.exited; }
  if (host.exitCode === null) { host.stdin.write("stop\n"); host.stdin.end(); }
  const timer = setTimeout(() => host.kill("SIGKILL"), 15_000); const code = await host.exited; clearTimeout(timer);
  await writeFile(join(output, "cleanup.json"), JSON.stringify({ hostExitCode: code, electronExitCode: electron?.exitCode, isolated: true, fixtureRemoved: code === 0 }));
  if (code === 0) await rm(fixture, { recursive: true, force: true });
  else throw new Error(`Native host fixture did not stop cleanly (${code}); retained isolated directory ${fixture}`);
}
