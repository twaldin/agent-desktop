import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { unpackHostArtifact } from "./install-host";
import { admitPackagedRendererDocument, rendererTargetSummary, selectPackagedRendererTarget,
  type RendererDocumentEvidence, type RendererTarget } from "./smoke-release-renderer";

type Connection = { origin: string; token: string; pid: number; hostId: string; protocolVersion: number };
type SmokeResult = { kind: "host" | "desktop"; version: string; platform: string; sessionId: string; messages: number;
  hostStopped: boolean; workerPids: number[]; workersStopped: boolean; bridge?: "production-main-preload" };

const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const hostArchive = value("--host"), desktopArchive = value("--desktop"), expectedVersion = value("--expect-version");
if (!hostArchive || !expectedVersion || !args.includes("--platform")) {
  throw new Error("Usage: smoke-release-artifacts.ts --host HOST.tar.gz --expect-version VERSION --platform PLATFORM [--desktop DESKTOP.zip]");
}
const expectedPlatform = value("--platform");
if (expectedPlatform !== `${process.platform}-${process.arch}`) throw new Error(`Smoke runner ${process.platform}-${process.arch} cannot verify ${expectedPlatform}.`);
if (desktopArchive && expectedPlatform !== "darwin-arm64") throw new Error("The packaged desktop smoke requires macOS ARM64.");

async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, () => false); }
async function waitUntil<T>(operation: () => Promise<T | undefined>, description: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const result = await operation(); if (result !== undefined) return result; } catch (error) { last = error; }
    await Bun.sleep(100);
  }
  throw new Error(`${description} did not complete within ${timeout}ms${last instanceof Error ? `: ${last.message}` : ""}.`);
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitForExit(pid: number, description: string): Promise<void> {
  await waitUntil(async () => alive(pid) ? undefined : true, description, 15_000);
}
function descendants(pid: number): number[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) return [];
  const rows = new TextDecoder().decode(result.stdout).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number))
    .filter((row): row is [number, number] => row.length === 2 && row.every(Number.isSafeInteger));
  const found: number[] = [], pending = [pid];
  for (let index = 0; index < pending.length; index++) for (const [child, parent] of rows) if (parent === pending[index]) {
    found.push(child); pending.push(child);
  }
  return found;
}
async function readConnection(path: string): Promise<Connection | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Connection;
    if (!value.origin?.startsWith("http://127.0.0.1:") || !value.token || !Number.isSafeInteger(value.pid) || !value.hostId || value.protocolVersion !== 1) return;
    const response = await fetch(`${value.origin}/v1/health`, { headers: { Authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1_000) });
    const health = await response.json() as { hostId?: string };
    return response.ok && health.hostId === value.hostId ? value : undefined;
  } catch { return; }
}
async function request(connection: Connection, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(connection.origin + path, { ...init, headers: { Authorization: `Bearer ${connection.token}`,
    "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body);
}
async function exerciseHost(connection: Connection, cwd: string): Promise<{ sessionId: string; messages: number; workerPids: number[] }> {
  cwd = await realpath(cwd);
  const unauthenticated = await fetch(`${connection.origin}/v1/state`, { signal: AbortSignal.timeout(2_000) });
  assert.equal(unauthenticated.status, 401, "The packaged host accepted unauthenticated state access.");
  const state = await request(connection, "/v1/state");
  assert.equal(state.host.id, connection.hostId); assert.deepEqual(state.sessions, []);
  const created = await request(connection, "/v1/commands", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(),
    command: { type: "session.create", projectId: null, cwd } }) });
  assert.equal(created.ok, true); assert.equal(created.value.hostId, connection.hostId); assert.equal(created.value.cwd, cwd);
  const transcript = await request(connection, `/v1/sessions/${encodeURIComponent(created.value.id)}/messages`);
  assert.deepEqual(transcript, []);
  const refreshed = await request(connection, "/v1/state");
  assert.equal(refreshed.sessions.some((session: { id: string }) => session.id === created.value.id), true);
  const workerPids = descendants(connection.pid); assert(workerPids.length > 0, "The native session did not retain an owned worker process.");
  return { sessionId: created.value.id, messages: transcript.length, workerPids };
}
async function installHost(archive: string, root: string): Promise<{ directory: string; version: string }> {
  const directory = join(root, "host"); await mkdir(directory);
  const artifact = await unpackHostArtifact(resolve(archive), directory);
  assert.equal(artifact.version, expectedVersion, `Expected host ${expectedVersion}, received ${artifact.version}.`);
  assert.equal(artifact.runtimeEntrypoint, "apps/host/src/packaged-entry.ts");
  assert.equal(artifact.nativeTerminals?.platforms.includes(expectedPlatform as "darwin-arm64" | "linux-x64"), true,
    `Host ${artifact.version} does not contain ${expectedPlatform}.`);
  await mkdir(join(directory, "bin")); await copyFile(process.execPath, join(directory, "bin/bun"));
  const install = Bun.spawn([join(directory, "bin/bun"), "install", "--production", "--frozen-lockfile", "--backend=copyfile"], {
    cwd: directory, stdout: "inherit", stderr: "inherit",
  });
  assert.equal(await install.exited, 0, "Packaged host dependency installation failed.");
  return { directory, version: artifact.version };
}
function isolatedEnvironment(root: string, data: string, agent: string): Record<string, string | undefined> {
  return { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "xdg-data"),
    AGENT_DESKTOP_DATA_DIR: data, AGENT_DESKTOP_PROFILE_DIR: join(root, "profile"), PI_CODING_AGENT_DIR: agent,
    PI_DISABLE_DOTENV: "1", NO_COLOR: "1" };
}
async function stopOwnedHost(connection: Connection, locator: string, workerPids: number[]): Promise<{ hostStopped: boolean; workersStopped: boolean }> {
  if (alive(connection.pid)) process.kill(connection.pid, "SIGTERM");
  await waitForExit(connection.pid, "packaged host shutdown");
  await waitUntil(async () => await exists(locator) ? undefined : true, "connection locator removal", 5_000);
  for (const pid of workerPids) if (alive(pid)) await waitForExit(pid, `worker ${pid} shutdown`);
  return { hostStopped: !alive(connection.pid), workersStopped: workerPids.every(pid => !alive(pid)) };
}
async function hostSmoke(): Promise<SmokeResult> {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-host-smoke-"));
  let connection: Connection | undefined; let workerPids: number[] = []; let hostProcess: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const installed = await installHost(hostArchive!, root), data = join(root, "data"), agent = join(root, "agent"), workspace = join(root, "workspace");
    await Promise.all([mkdir(join(root, "home")), mkdir(data), mkdir(agent), mkdir(workspace)]);
    hostProcess = Bun.spawn([join(installed.directory, "bin/bun"), "--no-env-file", "apps/host/src/packaged-entry.ts"], {
      cwd: installed.directory, env: isolatedEnvironment(root, data, agent), stdout: "inherit", stderr: "inherit",
    });
    connection = await waitUntil(() => readConnection(join(data, "connection.json")), "packaged host startup");
    assert.equal(connection.pid, hostProcess.pid, "The locator belongs to a different host process.");
    const exercised = await exerciseHost(connection, workspace); workerPids = exercised.workerPids;
    const stopped = await stopOwnedHost(connection, join(data, "connection.json"), workerPids);
    const exitCode = await hostProcess.exited;
    assert([0, 143].includes(exitCode), `Packaged host exited with ${exitCode}.`);
    connection = undefined;
    return { kind: "host", version: installed.version, platform: expectedPlatform!, sessionId: exercised.sessionId,
      messages: exercised.messages, workerPids, ...stopped };
  } finally {
    if (connection && alive(connection.pid)) { process.kill(connection.pid, "SIGTERM"); await waitForExit(connection.pid, "failed packaged host cleanup").catch(() => {}); }
    if (hostProcess && alive(hostProcess.pid)) { hostProcess.kill("SIGTERM"); await waitForExit(hostProcess.pid, "failed packaged host process cleanup").catch(() => {}); }
    await rm(root, { recursive: true, force: true });
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
class Cdp {
  #id = 0; #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout> }>();
  rendererException: Error | undefined;
  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", event => { const message = JSON.parse(String(event.data)); const pending = this.#pending.get(message.id);
      if (!pending) {
        if (message.method === "Runtime.exceptionThrown") this.rendererException = new Error(
          message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? "The packaged renderer threw an exception.");
        return;
      }
      this.#pending.delete(message.id); clearTimeout(pending.timeout);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); });
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.#id; this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP ${method} did not complete within 30000ms.`)); }, 30_000);
      this.#pending.set(id, { resolve, reject, timeout });
    });
  }
  notify(method: string, params: object = {}): void { this.socket.send(JSON.stringify({ id: ++this.#id, method, params })); }
  async evaluate(expression: string): Promise<any> {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}
async function waitForRendererCloseReadiness(cdp: Cdp): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (cdp.rendererException) throw cdp.rendererException;
    if (await cdp.evaluate("document.querySelector('.app-shell')?.dataset.windowCloseReady === 'true'")) return;
    await Bun.sleep(100);
  }
  throw new Error("The packaged desktop renderer did not register its window-close handler within 30000ms.");
}
async function waitForPackagedRendererDocument(cdp: Cdp, targetUrl: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  let last: RendererDocumentEvidence | undefined;
  while (Date.now() < deadline) {
    if (cdp.rendererException) throw new Error(`The packaged renderer threw for CDP target ${targetUrl}: ${cdp.rendererException.message}`);
    const evidence = await cdp.evaluate(`(() => ({href:location.href,readyState:document.readyState,rootPresent:document.querySelector('#root') !== null,moduleScripts:[...document.querySelectorAll('script[type=module][src]')].map(script => script.src)}))()`) as RendererDocumentEvidence;
    last = evidence;
    const moduleSource = admitPackagedRendererDocument(targetUrl, evidence);
    if (moduleSource) return moduleSource;
    await Bun.sleep(100);
  }
  throw new Error(`The packaged desktop app document did not become ready within 30000ms: ${JSON.stringify(last)}.`);
}
async function desktopSmoke(): Promise<SmokeResult> {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-desktop-smoke-"));
  let appProcess: ReturnType<typeof Bun.spawn> | undefined; let connection: Connection | undefined; let cdp: Cdp | undefined;
  try {
    const expanded = join(root, "expanded"); await mkdir(expanded);
    const unzip = Bun.spawn(["/usr/bin/ditto", "-x", "-k", resolve(desktopArchive!), expanded], { stdout: "inherit", stderr: "inherit" });
    assert.equal(await unzip.exited, 0, "Desktop archive extraction failed.");
    const applications = (await readdir(expanded)).filter(name => name.endsWith(".app"));
    assert.equal(applications.length, 1, "Desktop archive must contain exactly one application.");
    const application = join(expanded, applications[0]!); const executable = join(application, "Contents/MacOS/Agent Desktop");
    const embeddedManifest = JSON.parse(await readFile(join(application, "Contents/Resources/host/host-artifact.json"), "utf8"));
    assert.equal(embeddedManifest.version, expectedVersion, `Expected desktop ${expectedVersion}, received ${embeddedManifest.version}.`);
    const desktopManifest = JSON.parse(await readFile(join(application, "Contents/Resources/app/package.json"), "utf8"));
    assert.equal(desktopManifest.version, expectedVersion, "The desktop shell and embedded host versions differ.");
    const signature = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--deep", "--strict", application], { stdout: "pipe", stderr: "pipe" });
    assert.equal(signature.success, true, "The extracted desktop signature is invalid.");
    const data = join(root, "data"), agent = join(root, "agent"), workspace = join(root, "workspace");
    await Promise.all([mkdir(join(root, "home")), mkdir(data), mkdir(agent), mkdir(workspace), mkdir(join(root, "profile"))]);
    const port = await unusedPort();
    appProcess = Bun.spawn([executable, `--remote-debugging-port=${port}`], { cwd: root,
      env: isolatedEnvironment(root, data, agent),
      stdout: "inherit", stderr: "inherit" });
    const target = await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
      const targets = await response.json() as RendererTarget[];
      const selected = selectPackagedRendererTarget(targets);
      if (!selected) throw new Error(`Observed CDP targets: ${rendererTargetSummary(targets)}`);
      return selected;
    }, "packaged desktop renderer startup", 30_000);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP connection did not open within 30000ms.")), 30_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP connection failed.")); }, { once: true });
    });
    cdp = new Cdp(socket);
    await cdp.send("Runtime.enable");
    const moduleSource = await waitForPackagedRendererDocument(cdp, target.url);
    const rendererImportError = await cdp.evaluate(`import(${JSON.stringify(moduleSource)}).then(() => null, error => String(error?.stack ?? error))`);
    assert.equal(rendererImportError, null, `The packaged renderer failed to load: ${rendererImportError}`);
    await waitForRendererCloseReadiness(cdp);
    const bridge = await cdp.evaluate("typeof window.agentDesktop === 'object' && typeof window.agentDesktop.command === 'function' && typeof window.agentDesktop.getMessages === 'function'");
    assert.equal(bridge, true, "The production preload bridge is unavailable.");
    const state = await cdp.evaluate("window.agentDesktop.getState()"); assert.deepEqual(state.sessions, []);
    const canonicalWorkspace = await realpath(workspace);
    const result = await cdp.evaluate(`window.agentDesktop.command({id:crypto.randomUUID(),command:{type:'session.create',projectId:null,cwd:${JSON.stringify(canonicalWorkspace)}}})`);
    assert.equal(result.ok, true); assert.equal(result.value.cwd, canonicalWorkspace); assert.equal(result.value.hostId, state.host.id);
    const transcript = await cdp.evaluate(`window.agentDesktop.getMessages(${JSON.stringify(result.value.id)},${JSON.stringify(state.host.id)})`);
    assert.deepEqual(transcript, []);
    connection = await waitUntil(() => readConnection(join(data, "connection.json")), "desktop-owned packaged host startup");
    const unauthenticated = await fetch(`${connection.origin}/v1/state`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(unauthenticated.status, 401, "The desktop-owned host accepted unauthenticated state access.");
    const workerPids = descendants(connection.pid); assert(workerPids.length > 0, "The desktop-owned session did not retain a worker process.");
    // Browser.close normally tears down the transport before its response can be
    // observed. Send it without waiting on a reply, then bound the owned PID.
    cdp.notify("Browser.close");
    await waitForExit(appProcess.pid, "packaged desktop shutdown");
    assert.equal(await appProcess.exited, 0, "The packaged desktop did not complete a graceful shutdown.");
    const stopped = await stopOwnedHost(connection, join(data, "connection.json"), workerPids); connection = undefined;
    return { kind: "desktop", version: embeddedManifest.version, platform: expectedPlatform!, sessionId: result.value.id,
      messages: transcript.length, workerPids, ...stopped, bridge: "production-main-preload" };
  } finally {
    cdp?.socket.close();
    if (appProcess && alive(appProcess.pid)) { appProcess.kill("SIGTERM"); await waitForExit(appProcess.pid, "failed desktop cleanup").catch(() => {}); }
    if (!connection) connection = await readConnection(join(root, "data", "connection.json"));
    if (connection && alive(connection.pid)) { process.kill(connection.pid, "SIGTERM"); await waitForExit(connection.pid, "failed desktop host cleanup").catch(() => {}); }
    await rm(root, { recursive: true, force: true });
  }
}

const results = [await hostSmoke()];
if (desktopArchive) results.push(await desktopSmoke());
console.log(JSON.stringify({ result: "PASS", results }));
