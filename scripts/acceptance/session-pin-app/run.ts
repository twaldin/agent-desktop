import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WindowStateStore } from "../../../apps/desktop/src/main/window-state";
import { defaultWindowView } from "../../../apps/desktop/src/window-state";
import { createDockState } from "../../../apps/desktop/src/renderer/dock-state";

const repository = resolve(import.meta.dir, "../../..");
const output = resolve(process.argv[2] ?? ".data/session-pin-app-acceptance");
const manual = process.argv.includes("--manual");
const pauseForBrowser = process.argv.includes("--pause-for-browser");
for (const name of ["main.cjs", "preload.cjs", "renderer/index.html"]) await access(join(repository, "apps/desktop/dist", name));
const electronPackage = join(repository, "node_modules/electron");
const installed = (await readFile(join(electronPackage, "path.txt"), "utf8")).trim();
if (!installed || isAbsolute(installed)) throw new Error("Preinstalled Electron required; this runner never installs it.");
const dist = await realpath(join(electronPackage, "dist"));
const electronBinary = await realpath(resolve(dist, installed));
const owned = relative(dist, electronBinary);
if (!owned || owned === ".." || owned.startsWith(".." + sep) || isAbsolute(owned) || !(await stat(electronBinary)).isFile()) throw new Error("Electron binary escaped installed dist.");
await access(electronBinary, constants.X_OK);
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Refusing to overwrite prior acceptance evidence.");
await chmod(output, 0o700);
const root = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-session-pin-app-")));
await chmod(root, 0o700);
for (const name of ["bin", "profile"]) await mkdir(join(root, name), { mode: 0o700 });
await writeFile(join(root, "bin/tailscale"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const username = userInfo().username;
const environment = { HOME: root, USER: username, LOGNAME: username, PATH: join(root, "bin") + delimiter + (process.env.PATH ?? "/usr/bin:/bin"),
  TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: join(root, "agent"), PI_DISABLE_DOTENV: "1", AGENT_DESKTOP_NATIVE_TERMINALS: "0",
  AGENT_DESKTOP_DATA_DIR: join(root, "data"), AGENT_DESKTOP_PROFILE_DIR: join(root, "profile"), TERM: "dumb" };
const host = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "host.ts"), root], {
  cwd: root, env: environment, stdin: "pipe", stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")),
});
let electron: Bun.Subprocess | undefined;
let passed = false;
const failures: { stage: string; error: unknown }[] = [];
const localTokens: string[] = [];
function redact(text: string) {
  let safe = text.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.session-pin-not-a-signature/g, "[REDACTED_SYNTHETIC_ACCESS]")
    .replace(/session-pin-refresh[^\s"'\\]*/g, "[REDACTED_SYNTHETIC_REFRESH]")
    .replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer [REDACTED]");
  for (const token of localTokens) safe = safe.split(token).join("[REDACTED_LOCAL_TRANSPORT]");
  return safe;
}
function errorEvidence(error: unknown, seen = new Set<unknown>()): unknown {
  if (!(error instanceof Error)) return { name: "NonError", message: redact(String(error)) };
  if (seen.has(error)) return { name: error.name, message: "[circular error]" };
  seen.add(error);
  return { name: redact(error.name), message: redact(error.message), stack: error.stack && redact(error.stack),
    ...(error.cause === undefined ? {} : { cause: errorEvidence(error.cause, seen) }),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(value => errorEvidence(value, seen)) } : {}) };
}
async function ready(generation: number) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && host.exitCode === null) {
    const file = Bun.file(join(root, "ready.json"));
    if (await file.exists()) {
      const value = await file.json();
      if (value.generation === generation) {
        if (value.connection.pid !== host.pid || new URL(value.connection.origin).hostname !== "127.0.0.1") throw new Error("Private host owner mismatch.");
        if (typeof value.connection.token === "string" && value.connection.token) localTokens.push(value.connection.token);
        return value;
      }
    }
    await Bun.sleep(50);
  }
  throw new Error("Timed out awaiting private host readiness.");
}
try {
  let current = await ready(0);
  const candidate = join(root, "candidate"); await mkdir(candidate);
  await writeFile(join(candidate, "package.json"), JSON.stringify({ name: "native-session-pin-acceptance", version: "0.0.0", main: "main.cjs" }));
  await copyFile(join(import.meta.dir, "main.cjs"), join(candidate, "main.cjs"));
  await symlink(join(repository, "apps/desktop/dist"), join(candidate, "dist"), "dir");
  const state = new WindowStateStore(join(root, "profile"), "primary");
  const saved = state.saveView({ ...defaultWindowView(), route: { hostId: current.connection.hostId, sessionId: current.context.sessions.original.id },
    expandedProjects: [`${current.connection.hostId}:${current.context.projectId}`], collapsedSidebarSections: [], workspaceOpen: false,
    dock: { tabs: [], state: { ...createDockState(), right: { tabIds: [], open: false } } } });
  if (saved.error) throw new Error(saved.error);
  // A private operator locator, not a provider token or renderer bootstrap.
  await writeFile(join(output, "operator.json"), JSON.stringify({ root, hostPid: host.pid, readyFile: join(root, "ready.json"), candidate, electronBinary,
    author: { sessionId: "01a0bcd1-0cb5-770e-bbec-3b62b6c32a12", provider: "openai-codex", model: "gpt-6-astra", thinking: "high" } }, null, 2), { mode: 0o600 });
  for (const phase of manual ? ["manual"] : ["live", "cold"]) {
    if (phase === "cold") { host.stdin.write("restart\n"); current = await ready(1); }
    electron = Bun.spawn([electronBinary, candidate, output, root, repository, phase, ...(manual || pauseForBrowser ? ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"] : [])], {
      cwd: root, env: { ...environment, AGENT_DESKTOP_PROJECT_ROOT: repository, AGENT_DESKTOP_BUN: process.execPath,
        SESSION_PIN_PAUSE_FOR_BROWSER: pauseForBrowser && phase === "live" ? "1" : "0" },
      stdout: Bun.file(join(output, `electron-${phase}.log`)), stderr: Bun.file(join(output, `electron-${phase}-errors.log`)),
    });
    const timer = setTimeout(() => electron!.kill("SIGTERM"), manual ? 900_000 : pauseForBrowser && phase === "live" ? 480_000 : 180_000);
    const code = await electron.exited; clearTimeout(timer);
    if (code !== 0) throw new Error(`Actual App ${phase} exited ${code}; evidence retained.`);
    if (!manual && !(await Bun.file(join(output, `${phase}-result.json`)).json()).passed) throw new Error(`Actual App ${phase} did not pass.`);
  }
  passed = !manual;
} catch (error) {
  failures.push({ stage: "primary-run", error: errorEvidence(error) });
} finally {
  let electronDrainTimer: NodeJS.Timeout | undefined;
  try {
    if (electron?.exitCode === null) {
      const ownedElectron = electron;
      ownedElectron.kill("SIGTERM");
      electronDrainTimer = setTimeout(() => ownedElectron.kill("SIGKILL"), 5000);
      await ownedElectron.exited;
    }
  } catch (error) { failures.push({ stage: "electron-drain", error: errorEvidence(error) }); }
  finally { clearTimeout(electronDrainTimer); }
  try { if (host.exitCode === null) { host.stdin.write("stop\n"); host.stdin.end(); } }
  catch (error) { failures.push({ stage: "host-stop-request", error: errorEvidence(error) }); }
  let hostExit: number | undefined;
  const timer = setTimeout(() => host.kill("SIGKILL"), 15_000);
  try {
    hostExit = await host.exited;
    if (hostExit !== 0) failures.push({ stage: "host-drain", error: errorEvidence(new Error(`Host exited ${hostExit}; inspect host-errors.json and private root.`)) });
  } catch (error) { failures.push({ stage: "host-drain", error: errorEvidence(error) }); }
  finally { clearTimeout(timer); }
  try {
    if (await Bun.file(join(root, "host-errors.json")).exists()) await copyFile(join(root, "host-errors.json"), join(output, "host-errors.json"));
  } catch (error) { failures.push({ stage: "host-error-evidence-copy", error: errorEvidence(error) }); }
  try {
    const privateReady = Bun.file(join(root, "ready.json"));
    if (await privateReady.exists()) {
      const { context } = await privateReady.json();
      await writeFile(join(output, "owner.json"), JSON.stringify(context, null, 2));
      if (await Bun.file(context.requestsFile).exists()) await copyFile(context.requestsFile, join(output, "provider-requests.jsonl"));
      for (const [name, session] of Object.entries(context.sessions) as [string, { sessionFile: string }][]) {
        if (await Bun.file(session.sessionFile).exists()) await copyFile(session.sessionFile, join(output, `${name}-native.jsonl`));
      }
    }
  } catch (error) { failures.push({ stage: "native-evidence-copy", error: errorEvidence(error) }); }
  try { await writeFile(join(output, "run-errors.json"), JSON.stringify({ failures }, null, 2), { mode: 0o600 }); }
  catch (error) { failures.push({ stage: "error-evidence-write", error: errorEvidence(error) }); }
  let removed = false;
  if (passed && hostExit === 0 && failures.length === 0) {
    try { await rm(root, { recursive: true, force: true }); removed = true; }
    catch (error) { failures.push({ stage: "private-root-removal", error: errorEvidence(error) }); }
  }
  passed = passed && failures.length === 0;
  try { await writeFile(join(output, "cleanup.json"), JSON.stringify({ hostExit, electronExit: electron?.exitCode, root, removed, passed, failures }, null, 2), { mode: 0o600 }); }
  catch (error) { failures.push({ stage: "cleanup-evidence-write", error: errorEvidence(error) }); passed = false; }
  if (failures.length) {
    try { await writeFile(join(output, "run-errors.json"), JSON.stringify({ failures }, null, 2), { mode: 0o600 }); }
    catch (error) { failures.push({ stage: "final-error-evidence-write", error: errorEvidence(error) }); }
  }
}
if (failures.length) {
  console.error(JSON.stringify({ failures }));
  process.exitCode = 1;
}
