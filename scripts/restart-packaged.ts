import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import type { HostState } from "../packages/shared/src/protocol";
import { acquireHostLease } from "../apps/host/src/lease";
import type { LocalConnection } from "../apps/host/src/paths";
import { assertNoLiveTerminals, assertNoNativeTerminalOwnership } from "./terminal-upgrade-guard";
import { checkHostStateCompatibility } from "./host-state-compatibility";

// Replaces the one development acceptance window without interrupting user work.
// The next desktop must start its host from its bundled runtime, preserving data.
const args = process.argv.slice(2).filter(value => value !== "--resume-stopped");
const bundle = resolve(args[0] ?? "out/desktop-next/Agent Desktop.app");
const dataDirectory = resolve(args[1] ?? ".data/dev");
if (!await Bun.file(join(bundle, "Contents/MacOS/Agent Desktop")).exists()) throw new Error("The next packaged desktop executable is missing.");
const targetManifest = await Bun.file(join(bundle, "Contents/Resources/host/host-artifact.json")).json();
// Check before even inspecting/quitting the current app or stopping its host.
checkHostStateCompatibility(targetManifest, dataDirectory);
const connectionFile = join(dataDirectory, "connection.json");
const prior = await Bun.file(connectionFile).json() as LocalConnection;
const resumeStopped = process.argv.includes("--resume-stopped");
const yabai = join(homedir(), "Applications/Yabai.app/Contents/MacOS/yabai");
const inventory = spawnSync(yabai, ["-m", "query", "--windows"], { encoding: "utf8" });
if (inventory.status !== 0) throw new Error("Yabai could not verify the current desktop window.");
const ownWindows = (JSON.parse(inventory.stdout) as Array<{ app: string; subrole: string; pid: number }>).filter(window => window.app === "Agent Desktop" && window.subrole === "AXStandardWindow");
if (ownWindows.length !== (resumeStopped ? 0 : 1)) throw new Error("Resolve duplicate or unexpected Agent Desktop windows before replacing the app.");
const shutdownStarted = Date.now();
assertNoNativeTerminalOwnership(dataDirectory, { allowRetainedFinalScreens: !resumeStopped });
let staleLocatorArchived: string | undefined;
let previousBundle: string | undefined;
if (!resumeStopped) {
const state = await (await fetch(prior.origin + "/v1/state", { headers: { Authorization: `Bearer ${prior.token}` }, signal: AbortSignal.timeout(3000) })).json() as HostState;
if (state.host.id !== prior.hostId || state.sessions.some(session => session.status === "running")) throw new Error("Finish active work before replacing its host.");
await assertNoLiveTerminals(prior, dataDirectory);
const command = spawnSync("/bin/ps", ["-p", String(prior.pid), "-o", "command="], { encoding: "utf8" }).stdout;
if (!command.includes("apps/host/src/server.ts")) throw new Error("The discovered PID is not the expected app host.");
const desktopCommand = spawnSync("/bin/ps", ["-p", String(ownWindows[0]!.pid), "-o", "command="], { encoding: "utf8" }).stdout.trim();
const currentBundle = /^(\/.*\.app)\/Contents\/MacOS\/Agent Desktop$/.exec(desktopCommand)?.[1];
if (!currentBundle) throw new Error("The visible window is not the expected packaged desktop executable.");
previousBundle = currentBundle;
checkHostStateCompatibility(targetManifest, dataDirectory);
const script = 'on run argv\n tell application (item 1 of argv) to quit\nend run';
const quit = spawnSync("/usr/bin/osascript", ["-e", script, currentBundle], { encoding: "utf8" });
if (quit.status !== 0) throw new Error("Could not close the previous Agent Desktop window.");
process.kill(prior.pid, "SIGTERM");
}
const stopDeadline = Date.now() + 25_000;
for (;;) {
  let exited = false;
  try { process.kill(prior.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") exited = true; else throw error; }
  if (exited) {
    const lease = acquireHostLease(dataDirectory);
    try {
      if (await Bun.file(connectionFile).exists()) {
        const stale = await Bun.file(connectionFile).json() as LocalConnection;
        if (stale.pid !== prior.pid || stale.hostId !== prior.hostId) throw new Error("Another host replaced the locator; recheck its state before replacing it.");
        await mkdir(join(dataDirectory, "backups"), { recursive: true, mode: 0o700 });
        staleLocatorArchived = join(dataDirectory, "backups", `stale-locator-${Date.now()}.json`);
        await rename(connectionFile, staleLocatorArchived);
      }
    } finally { lease.release(); }
    break;
  }
  if (Date.now() > stopDeadline) throw new Error("The previous host has not finished shutdown; it was not force-killed.");
  await Bun.sleep(100);
}
const shutdownMs = Date.now() - shutdownStarted;
assertNoNativeTerminalOwnership(dataDirectory);
// A client can commit a schema-requiring edit during graceful shutdown. In
// that case reopen the previous compatible app with the same data/profile.
let launchBundle = bundle;
let refusedUpgrade: string | undefined;
try { checkHostStateCompatibility(targetManifest, dataDirectory); }
catch (error) {
  if (!previousBundle) throw error;
  checkHostStateCompatibility(await Bun.file(join(previousBundle, "Contents/Resources/host/host-artifact.json")).json(), dataDirectory);
  launchBundle = previousBundle;
  refusedUpgrade = error instanceof Error ? error.message : "Host state changed during shutdown.";
}
await mkdir(join(dataDirectory, "backups"), { recursive: true, mode: 0o700 });
const backup = join(dataDirectory, "backups", `before-packaged-${Date.now()}.sqlite`);
const database = new Database(join(dataDirectory, "state.sqlite"), { readonly: true });
try { database.query("VACUUM INTO ?").run(backup); } finally { database.close(); }
await chmod(backup, 0o600);
const env: NodeJS.ProcessEnv = { ...process.env, AGENT_DESKTOP_DATA_DIR: dataDirectory,
  AGENT_DESKTOP_PROFILE_DIR: resolve(args[2] ?? join(dataDirectory, "../packaged-profile")) };
for (const key of ["AGENT_DESKTOP_PROJECT_ROOT", "AGENT_DESKTOP_RENDERER_URL", "AGENT_DESKTOP_CAPTURE", "AGENT_DESKTOP_BUN"]) delete env[key];
const output = openSync(join(dataDirectory, "packaged-desktop.log"), "a", 0o600);
const child = spawn(join(launchBundle, "Contents/MacOS/Agent Desktop"), [], { env, detached: true, stdio: ["ignore", output, output] });
closeSync(output);
child.on("error", () => { process.stderr.write("Packaged desktop launch failed. The stopped data and backup are preserved.\n"); process.exitCode = 1; });
child.unref();
const deadline = Date.now() + 40_000;
let startupError = "The host did not respond.";
while (Date.now() < deadline) {
  try {
    const next = await Bun.file(connectionFile).json() as LocalConnection;
    const health = await (await fetch(next.origin + "/v1/health", { headers: { Authorization: `Bearer ${next.token}` }, signal: AbortSignal.timeout(1000) })).json() as { hostId: string };
    if (health.hostId !== prior.hostId) throw new Error("Host identity changed.");
    const processCommand = spawnSync("/bin/ps", ["-p", String(next.pid), "-o", "command="], { encoding: "utf8" }).stdout.trim();
    if (!processCommand.includes(join(launchBundle, "Contents/Resources/runtime/bun")) || !processCommand.includes(join(launchBundle, "Contents/Resources/host/apps/host/src/server.ts"))) throw new Error("The new host did not use bundled runtime paths.");
    const inventory = spawnSync(yabai, ["-m", "query", "--windows"], { encoding: "utf8" });
    if (inventory.status !== 0) throw new Error("Yabai could not verify the new desktop window.");
    const desktopWindows = (JSON.parse(inventory.stdout) as Array<{ id: number; pid: number; app: string; subrole: string; space: number }>).filter(window => window.app === "Agent Desktop" && window.subrole === "AXStandardWindow");
    if (desktopWindows.length !== 1 || desktopWindows[0]!.pid !== child.pid) throw new Error("Waiting for exactly one window from the new packaged desktop.");
    const desktopWindow = desktopWindows[0]!;
    if (desktopWindow.space !== 9) {
      const moved = spawnSync(yabai, ["-m", "window", String(desktopWindow.id), "--space", "9"], { encoding: "utf8" });
      if (moved.status !== 0) throw new Error("Could not isolate the acceptance window in space 9.");
    }
    const focused = spawnSync(yabai, ["-m", "window", "--focus", String(desktopWindow.id)], { encoding: "utf8" });
    if (focused.status !== 0) throw new Error("Could not focus the isolated acceptance window.");
    console.log(JSON.stringify({ desktopPid: child.pid, hostPid: next.pid, hostId: next.hostId, bundle: launchBundle, backup, bundledRuntimeVerified: true, priorPidExited: true, shutdownMs, staleLocatorArchived: staleLocatorArchived ?? null, windowId: desktopWindow.id, space: 9,
      ...(refusedUpgrade ? { requestedBundle: bundle, refusedUpgrade, previousBundleRestored: true } : {}) }));
    process.exit(refusedUpgrade ? 1 : 0);
  } catch (error) { startupError = error instanceof Error ? error.message : "Host startup failed."; await Bun.sleep(200); }
}
throw new Error(`The packaged acceptance check failed: ${startupError} Data and backup are preserved.`);
