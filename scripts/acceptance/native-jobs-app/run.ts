// Native Jobs production-App acceptance runner. Launches the already-built
// production Electron App/main/preload against the disposable real host from
// `host.ts` (production worker + transparent jobs-worker capture + loopback
// inference) and drives it with the single Electron driver `main.cjs`.
// Usage:
//   bun --no-env-file scripts/acceptance/native-jobs-app/run.ts <new-empty-output-dir> [--pause-for-browser]
// `--pause-for-browser` keeps the SAME automatic run, but once the real
// running+queued state is on screen the driver enables Chromium remote
// debugging (switches are appended AFTER the fixture positional arguments),
// writes `<output>/pause-ready.json` (the DevTools locator plus the resume
// marker path) and waits until `<output>/resume` exists before continuing.
// Nothing is installed or built here; the pinned Electron binary must exist.
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { LocalConnection } from "../../../apps/host/src/paths";
import { WindowStateStore } from "../../../apps/desktop/src/main/window-state";
import { defaultWindowView } from "../../../apps/desktop/src/window-state";
import { createDockState } from "../../../apps/desktop/src/renderer/dock-state";

interface ReadyContext {
  projectId: string; projectPath: string; sessions: Record<string, { id: string; sessionFile: string }>; model: { provider: string; id: string };
  childResult: string; control: { origin: string; token: string }; inferenceOrigin: string; controlDirectory: string;
}
const flags = new Set(process.argv.slice(2).filter(argument => argument.startsWith("--")));
const positional = process.argv.slice(2).filter(argument => !argument.startsWith("--"));
const pauseForBrowser = flags.has("--pause-for-browser");
for (const flag of flags) if (flag !== "--pause-for-browser") throw new Error(`Unknown flag ${flag}; only --pause-for-browser is supported.`);
const repository = resolve(import.meta.dir, "../../.."), output = resolve(positional[0] ?? ".data/native-jobs-app-acceptance");
await access(join(repository, "apps/desktop/dist/main.cjs"));
await access(join(repository, "apps/desktop/dist/preload.cjs"));
await access(join(repository, "apps/desktop/dist/renderer/index.html"));
// Electron's CLI auto-installs when path.txt or its executable is missing.
// Resolve and check the already-installed binary ourselves and launch it directly.
const electronPackage = join(repository, "node_modules/electron");
let electronBinary: string;
try {
  const installedPath = await readFile(join(electronPackage, "path.txt"), "utf8");
  const dist = await realpath(join(electronPackage, "dist"));
  if (!installedPath || isAbsolute(installedPath)) throw new Error("Invalid installed Electron path.");
  electronBinary = await realpath(resolve(dist, installedPath));
  const owned = relative(dist, electronBinary);
  if (!owned || owned === ".." || owned.startsWith(`..${sep}`) || isAbsolute(owned) || !(await stat(electronBinary)).isFile()) throw new Error("Electron executable is outside its installed dist.");
  await access(electronBinary, constants.X_OK);
} catch (cause) {
  throw new Error("Install prerequisite: the pinned Electron package must have path.txt and its executable installed before native Jobs acceptance. The runner will not install it.", { cause });
}
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Refusing to overwrite prior native Jobs acceptance evidence.");
await writeFile(join(output, "electron-preflight.json"), JSON.stringify({ binary: electronBinary,
  sha256: createHash("sha256").update(await readFile(electronBinary)).digest("hex"), pathFile: join(electronPackage, "path.txt"),
  launchMethod: "direct installed binary; no Electron CLI or installer", pauseForBrowser }, null, 2));

const fixedSources = [
  "apps/desktop/dist/main.cjs", "apps/desktop/dist/preload.cjs", "apps/desktop/dist/renderer/index.html", "package.json", "bun.lock",
  ...["host.ts", "main.cjs", "run.ts", "README.md"].map(name => `scripts/acceptance/native-jobs-app/${name}`),
  "apps/host/src/omp/fixtures/jobs-controlled.ts", "apps/host/src/omp/fixtures/jobs-worker.ts",
];
// Re-inventory maintained sources at BOTH boundaries so added/deleted files also
// change the fence. Regular files only; nested symlinks and node_modules skipped.
const sourcePaths = async (): Promise<string[]> => {
  const sources = new Set(fixedSources);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) sources.add(path);
    }
  };
  for (const directory of ["apps/host/src", "packages/shared/src", "apps/desktop/src", "apps/desktop/dist/renderer", "node_modules/@oh-my-pi/pi-coding-agent/src/async", "node_modules/@oh-my-pi/pi-coding-agent/src/task"]) await walk(directory);
  return [...sources].sort();
};
const hashes = async () => Object.fromEntries(await Promise.all((await sourcePaths()).map(async path => [path, createHash("sha256").update(await readFile(join(repository, path))).digest("hex")])));
const before = await hashes(); await writeFile(join(output, "source-before.json"), JSON.stringify(before, null, 2));

// Disposable private root: HOME, native agent directory, host data, profile and a refusing tailscale.
const root = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-native-jobs-app-")));
const privateBin = join(root, "bin"); await mkdir(privateBin, { mode: 0o700 });
await writeFile(join(privateBin, "tailscale"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const username = userInfo().username;
const environment = { HOME: root, USER: username, LOGNAME: username, PATH: privateBin + delimiter + (process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"), TMPDIR: root,
  PI_CODING_AGENT_DIR: join(root, "agent"), PI_DISABLE_DOTENV: "1", PI_CODEX_WEBSOCKET: "0", TERM: "dumb", NO_COLOR: "1",
  AGENT_DESKTOP_NATIVE_TERMINALS: "0", AGENT_DESKTOP_DATA_DIR: join(root, "data"), AGENT_DESKTOP_PROFILE_DIR: join(root, "profile") };
const host = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "host.ts"), root], { cwd: root, env: environment,
  stdin: "pipe", stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")) });
let electron: Bun.Subprocess | undefined;
let passed = false;
const failures: unknown[] = [];
try {
  const deadline = Date.now() + 90_000;
  while (!await Bun.file(join(root, "ready.json")).exists()) {
    if (host.exitCode !== null || Date.now() > deadline) throw new Error(`Jobs fixture host did not start; inspect ${output}/host*.log`);
    await Bun.sleep(50);
  }
  const { connection, context } = JSON.parse(await readFile(join(root, "ready.json"), "utf8")) as { connection: LocalConnection; context: ReadyContext };
  if (connection.pid !== host.pid || new URL(connection.origin).hostname !== "127.0.0.1") throw new Error("The jobs fixture host identity does not match its owned child.");
  const profile = join(root, "profile"), candidate = join(output, "candidate-app");
  await mkdir(profile, { recursive: true }); await mkdir(candidate);
  const state = new WindowStateStore(profile, "primary");
  const saved = state.saveView({ ...defaultWindowView(), route: { hostId: connection.hostId, sessionId: context.sessions.primary!.id },
    expandedProjects: [`${connection.hostId}:${context.projectId}`], collapsedSidebarSections: [], workspaceOpen: false, environmentOpen: false,
    dock: { tabs: [], state: { ...createDockState(), right: { tabIds: [], open: false } } } });
  if (saved.error) throw new Error(saved.error);
  await writeFile(join(candidate, "package.json"), JSON.stringify({ name: "agent-desktop-native-jobs-acceptance", version: "0.0.0", main: "main.cjs" }));
  await copyFile(join(import.meta.dir, "main.cjs"), join(candidate, "main.cjs"));
  await symlink(join(repository, "apps/desktop/dist"), join(candidate, "dist"), "dir");
  // Electron debug switches come AFTER the fixture positional arguments so the
  // driver's argv layout is identical with and without the pause.
  const debugSwitches: string[] = [];
  if (pauseForBrowser) {
    const probe = createServer(); const listening = Promise.withResolvers<void>();
    probe.once("error", listening.reject); probe.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
    const port = (probe.address() as { port: number }).port;
    const closed = Promise.withResolvers<void>(); probe.close(() => closed.resolve()); await closed.promise;
    debugSwitches.push("--pause-for-browser", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1");
  }
  electron = Bun.spawn([electronBinary, candidate, output, root, repository, ...debugSwitches], {
    cwd: root, env: { ...environment, AGENT_DESKTOP_PROJECT_ROOT: repository, AGENT_DESKTOP_BUN: process.execPath },
    stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")),
  });
  const timer = setTimeout(() => electron!.kill("SIGTERM"), pauseForBrowser ? 3_600_000 : 420_000), code = await electron.exited; clearTimeout(timer);
  if (code !== 0) throw new Error(`Actual native Jobs App scenario failed (${code}); inspect ${output}`);
  const resultFile = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
  if (!resultFile.passed) throw new Error(`Native Jobs App did not accept its scenario; inspect ${output}`);
  passed = true;
} catch (cause) {
  failures.push(cause);
} finally {
  try { if (electron?.exitCode === null) { electron.kill("SIGTERM"); await electron.exited; } } catch (cause) { failures.push(cause); }
  let hostExit: number | undefined;
  try {
    if (host.exitCode === null) { host.stdin.write("stop\n"); host.stdin.end(); }
    const timer = setTimeout(() => host.kill("SIGKILL"), 20_000); hostExit = await host.exited; clearTimeout(timer);
    if (hostExit !== 0) throw new Error(`Jobs fixture host shutdown failed (${hostExit}); private root retained: ${root}`);
  } catch (cause) { failures.push(cause); }
  // Safe evidence only: native session journals/markdown after the real worker
  // drained. ready.json (host token, control token), agent.db and profiles stay private.
  try {
    const capture = async (relativePath = ""): Promise<void> => {
      for (const entry of await readdir(join(root, "agent", relativePath), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("Unexpected symlink in native jobs evidence.");
        const path = join(relativePath, entry.name);
        if (entry.isDirectory()) await capture(path);
        else if (entry.isFile() && /\.(jsonl|md)$/.test(entry.name)) {
          const target = join(output, "native-after-stop", path);
          await mkdir(join(target, ".."), { recursive: true });
          await copyFile(join(root, "agent", path), target);
        }
      }
    };
    await capture();
  } catch (cause) { failures.push(cause); }
  try {
    const after = await hashes(); await writeFile(join(output, "source-after.json"), JSON.stringify(after, null, 2));
    if (JSON.stringify(before) !== JSON.stringify(after)) failures.push(new Error("Source changed during native Jobs acceptance; this is not a frozen result."));
  } catch (cause) { failures.push(cause); }
  const clean = passed && failures.length === 0;
  if (clean) { try { await rm(root, { recursive: true, force: true }); } catch (cause) { failures.push(cause); } }
  else await writeFile(join(output, "retained-fixture.json"), JSON.stringify({ root, reason: "Failed acceptance or cleanup; private root retained for diagnosis. It contains host/control tokens and a native auth database: do not publish." }), { mode: 0o600 });
  await writeFile(join(output, "cleanup.json"), JSON.stringify({ passed, electronExit: electron?.exitCode ?? null, hostExit: hostExit ?? null, fixtureRemoved: clean, pauseForBrowser, errors: failures.map(error => error instanceof Error ? error.stack ?? error.message : String(error)) }, null, 2));
  if (failures.length) throw new AggregateError(failures, "Native Jobs App acceptance failed or its cleanup/source fence failed.");
  console.log(JSON.stringify({ passed, output, scope: "actual production App/main/preload/host/worker over real detached native task jobs; controlled loopback inference; no provider spend" }));
}
