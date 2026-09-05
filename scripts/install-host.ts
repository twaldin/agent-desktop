import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { HostArtifact } from "./package-host";
import { assertNoLiveTerminals, assertNoNativeTerminalOwnership } from "./terminal-upgrade-guard";
import { verifyTmuxBundle } from "../apps/host/src/terminals/bundle";
import { checkHostStateCompatibility, supportedHostStateSchemaVersions } from "./host-state-compatibility";

export const HOST_SERVICE = "agent-desktop-host";
export const MAC_HOST_LABEL = "com.agent-desktop.host";
const BUN_VERSION = "1.3.14";

export interface ServiceLayout {
  platform: "darwin" | "linux";
  homeDirectory: string;
  installDirectory: string;
  dataDirectory: string;
  logDirectory: string;
  serviceFile: string;
}

function absolute(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Installation paths must be absolute and contain no control characters.");
  return path;
}

export function serviceLayout(options: { platform?: string; homeDirectory?: string; installDirectory?: string; dataDirectory?: string } = {}): ServiceLayout {
  const targetPlatform = options.platform ?? platform();
  if (targetPlatform !== "darwin" && targetPlatform !== "linux") throw new Error("Host services support macOS and Linux only.");
  const homeDirectory = absolute(options.homeDirectory ?? homedir());
  const installDirectory = absolute(options.installDirectory ?? join(homeDirectory, ".local/share/agent-desktop-host"));
  const dataDirectory = absolute(options.dataDirectory ?? (targetPlatform === "darwin"
    ? join(homeDirectory, "Library/Application Support/Agent Desktop") : join(homeDirectory, ".local/share/agent-desktop")));
  return {
    platform: targetPlatform, homeDirectory, installDirectory, dataDirectory, logDirectory: join(installDirectory, "logs"),
    serviceFile: targetPlatform === "darwin" ? join(homeDirectory, "Library/LaunchAgents", `${MAC_HOST_LABEL}.plist`)
      : join(homeDirectory, ".config/systemd/user", `${HOST_SERVICE}.service`),
  };
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const systemd = (value: string, exec = false) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, exec ? "$$$$" : "$")}"`;
const executable = (layout: ServiceLayout) => join(layout.installDirectory, "current/bin/bun");
const entry = (layout: ServiceLayout) => join(layout.installDirectory, "current/apps/host/src/server.ts");
const servicePath = (layout: ServiceLayout) => [join(layout.installDirectory, "current/bin"), join(layout.homeDirectory, ".bun/bin"),
  join(layout.homeDirectory, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

export function renderLaunchAgent(layout: ServiceLayout): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MAC_HOST_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(executable(layout))}</string><string>${xml(entry(layout))}</string></array>
  <key>WorkingDirectory</key><string>${xml(layout.homeDirectory)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(servicePath(layout))}</string><key>AGENT_DESKTOP_DATA_DIR</key><string>${xml(layout.dataDirectory)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(layout.logDirectory, "host.stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(layout.logDirectory, "host.stderr.log"))}</string>
</dict></plist>
`;
}

export function renderSystemdUnit(layout: ServiceLayout): string {
  return `[Unit]
Description=Agent Desktop host

[Service]
Type=simple
ExecStart=${systemd(executable(layout), true)} ${systemd(entry(layout), true)}
WorkingDirectory=~
Environment=${systemd(`PATH=${servicePath(layout)}`)}
Environment=${systemd(`AGENT_DESKTOP_DATA_DIR=${layout.dataDirectory}`)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
`;
}

class InstallCommandError extends Error {
  constructor(message: string, readonly diagnostic: string) { super(message); }
}

async function run(args: string[], options: { cwd?: string; allowFailure?: boolean } = {}): Promise<{ success: boolean; stdout: string }> {
  const child = Bun.spawn(args, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0 && !options.allowFailure) throw new InstallCommandError(`${basename(args[0]!)} ${args[1] ?? ""} failed (exit ${code}).`, stdout + "\n" + stderr);
  return { success: code === 0, stdout };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

async function replaceCurrent(layout: ServiceLayout, target: string): Promise<void> {
  const temporary = join(layout.installDirectory, `current.${randomUUID()}.tmp`);
  try { await symlink(target, temporary); await rename(temporary, join(layout.installDirectory, "current")); }
  finally { await rm(temporary, { force: true }); }
}

async function currentVersion(layout: ServiceLayout): Promise<string | undefined> {
  const current = join(layout.installDirectory, "current");
  if (!await exists(current)) return undefined;
  if (!(await lstat(current)).isSymbolicLink()) throw new Error("The current release path is not an installer-owned symlink.");
  const target = await readlink(current);
  if (!/^versions\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(target)) throw new Error("Unexpected current release target.");
  return target.slice("versions/".length);
}

async function stopService(layout: ServiceLayout): Promise<void> {
  if (layout.platform === "darwin") {
    const target = `gui/${process.getuid!()}/${MAC_HOST_LABEL}`;
    const loaded = await run(["/bin/launchctl", "print", target], { allowFailure: true });
    if (loaded.success) {
      const pid = Number(loaded.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1]);
      await run(["/bin/launchctl", "bootout", target]);
      // bootout accepts the unload request before launchd has finished removing the job.
      const deadline = Date.now() + 35_000;
      for (;;) {
        const stillLoaded = (await run(["/bin/launchctl", "print", target], { allowFailure: true })).success;
        let stillRunning = false;
        if (pid) { try { process.kill(pid, 0); stillRunning = true; } catch { /* The old service exited. */ } }
        if (!stillLoaded && !stillRunning) break;
        if (Date.now() >= deadline) throw new Error("launchd did not finish stopping the previous host service.");
        await Bun.sleep(200);
      }
    }
  } else if (await exists(layout.serviceFile)) {
    const state = await run(["/usr/bin/systemctl", "--user", "show", `${HOST_SERVICE}.service`, "--property=ActiveState", "--value"]);
    if (["active", "activating", "deactivating", "reloading"].includes(state.stdout.trim())) {
      await run(["/usr/bin/systemctl", "--user", "stop", `${HOST_SERVICE}.service`]);
    }
  }
}

async function startService(layout: ServiceLayout): Promise<void> {
  if (layout.platform === "darwin") {
    await run(["/usr/bin/plutil", "-lint", layout.serviceFile]);
    await run(["/bin/launchctl", "bootstrap", `gui/${process.getuid!()}`, layout.serviceFile]);
  }
  else {
    await run(["/usr/bin/systemd-analyze", "verify", layout.serviceFile]);
    await run(["/usr/bin/systemctl", "--user", "daemon-reload"]);
    await run(["/usr/bin/systemctl", "--user", "enable", "--now", `${HOST_SERVICE}.service`]);
  }
}

async function healthy(layout: ServiceLayout, timeoutMs = 20_000): Promise<{ hostId: string }> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const connection = JSON.parse(await readFile(join(layout.dataDirectory, "connection.json"), "utf8"));
      if (typeof connection.token !== "string" || typeof connection.origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.origin)) throw new Error("Invalid local connection metadata.");
      const managed = layout.platform === "darwin"
        ? Number((await run(["/bin/launchctl", "print", `gui/${process.getuid!()}/${MAC_HOST_LABEL}`], { allowFailure: true })).stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1])
        : Number((await run(["/usr/bin/systemctl", "--user", "show", `${HOST_SERVICE}.service`, "--property=MainPID", "--value"], { allowFailure: true })).stdout.trim());
      if (!managed || managed !== connection.pid) throw new Error("Connection metadata does not belong to the managed service.");
      const response = await fetch(`${connection.origin}/v1/health`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(1000) });
      const result = await response.json() as { protocolVersion?: number; hostId?: string; host?: { id?: string } };
      if (response.ok && result.protocolVersion === 1 && (result.hostId ?? result.host?.id) === connection.hostId) return { hostId: connection.hostId };
    } catch { /* Wait for this service's locator and health endpoint. */ }
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  throw new Error("The installed host did not become healthy. Inspect its private service logs.");
}

/** The service boundary is injectable for isolated installer lifecycle tests. */
export interface HostServiceLifecycle {
  stop(layout: ServiceLayout): Promise<void>;
  start(layout: ServiceLayout): Promise<void>;
  healthy(layout: ServiceLayout, timeoutMs?: number): Promise<{ hostId: string }>;
}
const nativeLifecycle: HostServiceLifecycle = { stop: stopService, start: startService, healthy };

function checkBeforeStop(manifest: HostArtifact, layout: ServiceLayout): void {
  try { checkHostStateCompatibility(manifest, layout.dataDirectory); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : "Cannot verify host state compatibility."} Refusing to stop or replace the current host; keep the compatible release running.`); }
}

async function stopForCompatibleRelease(manifest: HostArtifact, layout: ServiceLayout, lifecycle: HostServiceLifecycle, hasCurrent: boolean): Promise<void> {
  checkBeforeStop(manifest, layout);
  await lifecycle.stop(layout);
  // A live writer can promote the schema after the pre-stop check. Never activate the
  // incompatible target; restart the still-selected current release when there is one.
  try { checkHostStateCompatibility(manifest, layout.dataDirectory); }
  catch (error) {
    if (hasCurrent) {
      try { await lifecycle.start(layout); await lifecycle.healthy(layout); }
      catch (restartError) { throw new Error(`${error instanceof Error ? error.message : "Host state compatibility changed."} Current release was not replaced, but restarting it failed: ${restartError instanceof Error ? restartError.message : "unknown service error"}`); }
    }
    throw new Error(`${error instanceof Error ? error.message : "Host state compatibility changed."} Current release was not replaced${hasCurrent ? "; its service was restarted" : ""}.`);
  }
}

export async function assertNoRunningWork(layout: ServiceLayout): Promise<void> {
  assertNoNativeTerminalOwnership(layout.dataDirectory, { allowRetainedFinalScreens: true });
  const path = join(layout.dataDirectory, "state.sqlite");
  if (await exists(path)) {
    const db = new Database(path, { readonly: true });
    try {
      const rows = db.query<{ data: string }, []>("SELECT data FROM sessions").all();
      if (rows.some(row => JSON.parse(row.data).status === "running")) throw new Error("A host session is running. Stop or finish its turn before changing the installation.");
    } finally { db.close(); }
  }
  const locator = join(layout.dataDirectory, "connection.json");
  if (!await exists(locator)) { assertNoNativeTerminalOwnership(layout.dataDirectory); return; }
  const connection = JSON.parse(await readFile(locator, "utf8"));
  if (!Number.isSafeInteger(connection.pid) || connection.pid < 1 || typeof connection.token !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.origin)) throw new Error("Cannot verify active terminal ownership from the local connection metadata.");
  try { process.kill(connection.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { assertNoNativeTerminalOwnership(layout.dataDirectory); return; } throw error; }
  await assertNoLiveTerminals(connection, layout.dataDirectory);
}

async function backupState(layout: ServiceLayout): Promise<string | undefined> {
  if (!await exists(join(layout.dataDirectory, "state.sqlite"))) return undefined;
  const directory = join(layout.dataDirectory, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
    const source = join(layout.dataDirectory, name);
    if (await exists(source)) { await copyFile(source, join(directory, name)); await chmod(join(directory, name), 0o600); }
  }
  return directory;
}

async function verifyArtifact(directory: string): Promise<HostArtifact> {
  const manifest = JSON.parse(await readFile(join(directory, "host-artifact.json"), "utf8")) as HostArtifact;
  if (manifest.format !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(manifest.version)
    || manifest.bunVersion !== BUN_VERSION || manifest.ompVersion !== "18.1.10" || !manifest.files || typeof manifest.files !== "object") throw new Error("Unsupported host artifact manifest.");
  supportedHostStateSchemaVersions(manifest);
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (isAbsolute(file) || file.split("/").includes("..") || file.includes("\0") || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid artifact file manifest.");
    const path = join(directory, file);
    if (!(await lstat(path)).isFile() || createHash("sha256").update(await readFile(path)).digest("hex") !== hash) throw new Error(`Artifact verification failed: ${file}`);
  }
  for (const required of ["package.json", "bun.lock", "apps/host/src/server.ts", "scripts/install-host.ts"]) {
    if (!manifest.files[required]) throw new Error(`Artifact is missing ${required}`);
  }
  if (manifest.nativeTerminals) {
    const target = `${platform()}-${arch()}`;
    if (manifest.nativeTerminals.protocol !== "tmux-v1" || !Array.isArray(manifest.nativeTerminals.platforms)
      || !(manifest.nativeTerminals.platforms as string[]).includes(target)) throw new Error("This archive does not include the native terminal runtime for this host.");
    const bundle = verifyTmuxBundle(join(directory, "runtime/tmux", target));
    if (manifest.files[`runtime/tmux/${target}/manifest.json`] !== bundle.digest) throw new Error("The native terminal runtime is not covered by the host artifact manifest.");
  }
  return manifest;
}

async function unpack(archive: string, directory: string): Promise<HostArtifact> {
  const listing = (await run(["tar", "-tzf", archive])).stdout.split("\n").filter(Boolean);
  if (listing.some(path => isAbsolute(path) || path.split("/").includes("..") || /[\x00-\x1f\x7f]/.test(path))) throw new Error("Unsafe archive path.");
  const types = (await run(["tar", "-tvzf", archive])).stdout.split("\n").filter(Boolean);
  if (types.some(line => !["-", "d"].includes(line[0]!))) throw new Error("Host artifacts may contain only files and directories.");
  await run(["tar", "-xzf", archive, "-C", directory]);
  return verifyArtifact(directory);
}

export async function installHost(options: { archive: string; bun?: string; layout?: ServiceLayout; lifecycle?: HostServiceLifecycle }): Promise<object> {
  if (!options.archive) throw new Error("An explicit --package archive path is required.");
  const layout = options.layout ?? serviceLayout({ dataDirectory: process.env.AGENT_DESKTOP_DATA_DIR });
  const lifecycle = options.lifecycle ?? nativeLifecycle;
  const bun = absolute(options.bun ?? process.execPath);
  if ((await run([bun, "--version"])).stdout.trim() !== BUN_VERSION) throw new Error(`Installation requires Bun ${BUN_VERSION}.`);
  await mkdir(layout.installDirectory, { recursive: true, mode: 0o700 });
  const staging = join(layout.installDirectory, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  let newRelease: string | undefined;
  try {
    const manifest = await unpack(resolve(options.archive), staging);
    checkBeforeStop(manifest, layout);
    const previous = await currentVersion(layout);
    if (await exists(layout.serviceFile) && !previous) throw new Error("An existing service file has no matching installation; refusing to overwrite it.");
    newRelease = join(layout.installDirectory, "versions", manifest.version);
    if (await exists(newRelease)) throw new Error("This immutable release version is already installed. Choose a new version or use rollback.");
    await mkdir(join(staging, "bin"));
    await copyFile(bun, join(staging, "bin/bun"));
    await chmod(join(staging, "bin/bun"), 0o700);
    const installedBun = join(staging, "bin/bun");
    await run([installedBun, "install", "--production", "--frozen-lockfile"], { cwd: staging });
    await run([installedBun, "--eval", 'await import("./apps/host/src/server.ts"); const native = await import("@oh-my-pi/pi-natives"); if (typeof native.FileLock.tryAcquire !== "function") throw new Error("Native lock missing");'], { cwd: staging });
    if (manifest.nativeTerminals) {
      const bundle = verifyTmuxBundle(join(staging, "runtime/tmux", `${platform()}-${arch()}`));
      if ((await run([bundle.binary, "-V"])).stdout.trim() !== "tmux 3.7c") throw new Error("The bundled native terminal failed its runtime check.");
    }
    await writeFile(join(staging, "installed-platform.json"), JSON.stringify({ platform: platform(), architecture: arch(), bunVersion: BUN_VERSION,
      bunSha256: createHash("sha256").update(await readFile(installedBun)).digest("hex") }, null, 2), { mode: 0o600 });
    await assertNoRunningWork(layout);
    await mkdir(dirname(newRelease), { recursive: true, mode: 0o700 });
    await rename(staging, newRelease);
    await mkdir(layout.logDirectory, { recursive: true, mode: 0o700 });
    for (const name of ["host.stdout.log", "host.stderr.log"]) {
      const path = join(layout.logDirectory, name);
      if (!await exists(path)) await writeFile(path, "", { mode: 0o600 });
    }
    await stopForCompatibleRelease(manifest, layout, lifecycle, Boolean(previous));
    assertNoNativeTerminalOwnership(layout.dataDirectory);
    const backup = await backupState(layout);
    const oldService = await exists(layout.serviceFile) ? await readFile(layout.serviceFile, "utf8") : undefined;
    try {
      await replaceCurrent(layout, `versions/${manifest.version}`);
      await writeAtomic(layout.serviceFile, layout.platform === "darwin" ? renderLaunchAgent(layout) : renderSystemdUnit(layout));
      await lifecycle.start(layout);
      const health = await lifecycle.healthy(layout);
      await writeAtomic(join(layout.installDirectory, "installation.json"), JSON.stringify({ version: manifest.version, previousVersion: previous,
        installedAt: new Date().toISOString(), dataDirectory: layout.dataDirectory, serviceFile: layout.serviceFile, backup }, null, 2));
      return { installed: true, version: manifest.version, previousVersion: previous, hostId: health.hostId, platform: layout.platform, architecture: arch(), backup };
    } catch (error) {
      if (previous) {
        try {
          const previousManifest = await verifyArtifact(join(layout.installDirectory, "versions", previous));
          await stopForCompatibleRelease(previousManifest, layout, lifecycle, true);
        } catch (recoveryError) {
          throw new Error(`Target host failed: ${error instanceof Error ? error.message : "unknown service error"}. Automatic recovery to ${previous} was not completed: ${recoveryError instanceof Error ? recoveryError.message : "unknown recovery error"}`);
        }
        await replaceCurrent(layout, `versions/${previous}`);
        if (oldService !== undefined) await writeAtomic(layout.serviceFile, oldService);
        await lifecycle.start(layout);
      } else {
        await lifecycle.stop(layout);
        await rm(join(layout.installDirectory, "current"), { force: true });
        await rm(layout.serviceFile, { force: true });
        if (layout.platform === "linux") await run(["/usr/bin/systemctl", "--user", "daemon-reload"]);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof InstallCommandError) {
      await mkdir(layout.logDirectory, { recursive: true, mode: 0o700 });
      const diagnostic = join(layout.logDirectory, `install-failure-${Date.now()}.log`);
      await writeFile(diagnostic, error.diagnostic, { mode: 0o600 });
      throw new Error(`${error.message} Private diagnostics: ${diagnostic}`);
    }
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function manageHost(action: string, layout: ServiceLayout, version?: string, lifecycle: HostServiceLifecycle = nativeLifecycle): Promise<object> {
  if (action === "stop") { await lifecycle.stop(layout); return { stopped: true }; }
  if (action === "start") { await lifecycle.stop(layout); await lifecycle.start(layout); return { started: true, ...await lifecycle.healthy(layout) }; }
  if (action === "status") {
    let health: object;
    try { health = { running: true, ...await lifecycle.healthy(layout, 1000) }; }
    catch { health = { running: false }; }
    return { version: await currentVersion(layout), ...health };
  }
  if (action === "rollback") {
    const record = JSON.parse(await readFile(join(layout.installDirectory, "installation.json"), "utf8"));
    const target = version ?? record.previousVersion;
    if (typeof target !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(target)) throw new Error("No valid rollback version is available.");
    const release = join(layout.installDirectory, "versions", target);
    const manifest = await verifyArtifact(release);
    checkBeforeStop(manifest, layout);
    await assertNoRunningWork(layout);
    const previous = await currentVersion(layout);
    await stopForCompatibleRelease(manifest, layout, lifecycle, Boolean(previous));
    assertNoNativeTerminalOwnership(layout.dataDirectory);
    const backup = await backupState(layout);
    await replaceCurrent(layout, `versions/${target}`);
    try { await lifecycle.start(layout); await lifecycle.healthy(layout); }
    catch (error) {
      if (previous) {
        try {
          const previousManifest = await verifyArtifact(join(layout.installDirectory, "versions", previous));
          await stopForCompatibleRelease(previousManifest, layout, lifecycle, true);
        } catch (recoveryError) {
          throw new Error(`Target host failed: ${error instanceof Error ? error.message : "unknown service error"}. Automatic recovery to ${previous} was not completed: ${recoveryError instanceof Error ? recoveryError.message : "unknown recovery error"}`);
        }
        await replaceCurrent(layout, `versions/${previous}`); await lifecycle.start(layout);
      } else await lifecycle.stop(layout);
      throw error;
    }
    await writeAtomic(join(layout.installDirectory, "installation.json"), JSON.stringify({ ...record, version: target, previousVersion: previous, backup }, null, 2));
    return { rolledBack: true, version: target, dataPreserved: true, backup };
  }
  if (action === "uninstall") {
    await assertNoRunningWork(layout);
    await lifecycle.stop(layout);
    assertNoNativeTerminalOwnership(layout.dataDirectory);
    if (layout.platform === "linux") await run(["/usr/bin/systemctl", "--user", "disable", `${HOST_SERVICE}.service`]);
    await rm(layout.serviceFile, { force: true });
    if (layout.platform === "linux") await run(["/usr/bin/systemctl", "--user", "daemon-reload"]);
    return { uninstalled: true, dataPreserved: layout.dataDirectory, releasesPreserved: layout.installDirectory };
  }
  throw new Error("Usage: install-host.ts install --package ARCHIVE [--bun PATH] | status | start | stop | rollback [--version VERSION] | uninstall");
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    const value = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const layout = serviceLayout({ installDirectory: value("--root"), dataDirectory: value("--data-dir") ?? process.env.AGENT_DESKTOP_DATA_DIR });
    const result = args[0] === "install" ? await installHost({ archive: value("--package") ?? "", bun: value("--bun"), layout })
      : await manageHost(args[0] ?? "", layout, value("--version"));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Host installation failed."}\n`);
    process.exit(1);
  }
}
