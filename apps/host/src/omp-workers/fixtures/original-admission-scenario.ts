// Actual acceptance for admitted cooperative originals. Nothing is mocked: the
// originals are minted by the real native module, the admitted writer is the
// production worker entry in its own process, and every lease transition is an
// observable consequence of real native ownership. This fixture process is the
// competing cooperating writer, so "busy" really means another process holds
// the original.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRuntime as HostWorkerRuntime, WorkerSession } from "../runtime";

const [root, scenario] = process.argv.slice(2);
assert.ok(root && scenario);
assert.equal(process.env.HOME, root);

// Host-side network is blocked and recorded rather than assumed absent.
const hostNetwork: string[] = [];
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  hostNetwork.push(String(input instanceof Request ? input.url : input));
  throw new Error("Original admission fixture attempted host network access");
}, { preconnect() {} }) as typeof fetch;

// Every worker is pointed at this loopback sinkhole. Attempts are counted, not
// presumed to be zero: whatever the real native startup tries is reported.
const proxyAttempts: Array<{ at: number }> = [];
const sinkhole = createServer(socket => { proxyAttempts.push({ at: Date.now() }); socket.destroy(); });
await new Promise<void>(resolve => sinkhole.listen(0, "127.0.0.1", resolve));
const address: AddressInfo | string | null = sinkhole.address();
assert.ok(address && typeof address === "object", "sinkhole did not bind a port");
const proxy = `http://127.0.0.1:${address.port}`;

// Deferred deliberately: the fetch block above must be installed before the
// host runtime and the native SDK are evaluated, so nothing in their module
// initialization can reach the network through the original global.
const { WorkerRuntime } = await import("../runtime");
const { createCooperativeOriginal, observeEnrolledOriginal } = await import("@oh-my-pi/pi-coding-agent/session/original-session-ownership");

const agentDir = path.join(root, "agent");
const project = path.join(root, "project");
const sessions = path.join(root, "sessions");
const ownershipDirectory = path.join(root, "ownership");
const temporary = path.join(root, "tmp");
const pidLog = path.join(root, "owned-pids.jsonl");
const workerPath = path.join(root, "blocked-production-worker.ts");
const workerNetworkLog = path.join(root, "blocked-worker-fetches.jsonl");
const productionEntry = fileURLToPath(new URL("../entry.ts", import.meta.url));
const HISTORY_TEXT = `original history ${randomUUID()}`;
const MODELS = JSON.stringify({ providers: { "original-admission-runtime": {
  api: "openai-completions", baseUrl: "https://original-admission-runtime.invalid/v1", auth: "none",
  models: [{ id: "controlled", name: "Controlled original admission runtime", reasoning: false, input: ["text"],
    contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } });

function describe(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const reason = "reason" in error && typeof error.reason === "string" ? error.reason : undefined;
  return { name: error.name, message: error.message, ...(code ? { code } : {}), ...(reason ? { reason } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(describe) } : {}),
    ...(error.cause instanceof Error ? { cause: describe(error.cause) } : {}) };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}

/** Disposal must reap the actual child, not merely resolve its promise. The
 * OS reaps the process on its own clock, so this polls the real condition
 * instead of guessing a duration; a fake clock cannot advance it. */
async function reaped(pid: number): Promise<{ alive: boolean; waitedMs: number }> {
  const started = Date.now();
  while (alive(pid) && Date.now() - started < 5_000) await Bun.sleep(25);
  return { alive: alive(pid), waitedMs: Date.now() - started };
}

async function fileFacts(file: string): Promise<Record<string, unknown>> {
  const [bytes, stats] = await Promise.all([readFile(file), stat(file)]);
  return { size: stats.size, dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}

const result: Record<string, unknown> = { scenario };
const runtimes: HostWorkerRuntime[] = [];

function newRuntime(): HostWorkerRuntime {
  // The wrapper only blocks transport before importing the unchanged production entry.
  const runtime = new WorkerRuntime({ agentDir, workerPath, startupTimeoutMs: 60_000, shutdownTimeoutMs: 20_000,
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: temporary, TERM: "dumb", NO_COLOR: "1",
      PI_DISABLE_DOTENV: "1", PI_NO_TITLE: "1", PI_TELEMETRY_DISABLED: "1", PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"), XDG_STATE_HOME: path.join(root, "xdg-state"),
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: "" } });
  runtimes.push(runtime);
  return runtime;
}

function recordPid(session: WorkerSession): void {
  appendFileSync(pidLog, `${JSON.stringify({ pid: session.workerPid, directory: root })}\n`);
}

async function main(): Promise<void> {
  await Promise.all([agentDir, project, sessions, temporary].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(workerPath, `import { appendFileSync } from "node:fs";\nfunction block(input: unknown) { appendFileSync(${JSON.stringify(workerNetworkLog)}, JSON.stringify({ target: String(input instanceof Request ? input.url : input) }) + "\\n"); throw new Error("Original admission worker blocks network before transport"); }\nglobalThis.fetch = Object.assign(async (input: RequestInfo | URL) => block(input), { preconnect: block }) as typeof fetch;\nawait import(${JSON.stringify(productionEntry)});\n`);
  await writeFile(path.join(agentDir, "config.yml"), ["extensions: []", "modelRoles:",
    "  default: [original-admission-runtime/controlled]", ""].join("\n"));
  await writeFile(path.join(agentDir, "models.yml"), MODELS);

  // Enrollment happens before this original's first header, inside the real
  // native module. The returned manager owns the writer lease in THIS process.
  const created = await createCooperativeOriginal({ ownershipDirectory, cwd: project, sessionDirectory: sessions });
  const binding = created.binding;
  created.manager.appendMessage({ role: "user", content: [{ type: "text", text: HISTORY_TEXT }], timestamp: 1 });
  created.manager.flushSync();
  result.binding = { ...binding };

  const runtime = newRuntime();
  const held = await observeEnrolledOriginal(ownershipDirectory, binding);
  const before = await fileFacts(binding.originalFile);
  result.before = before;

  // A competing process holds the original. Admission must refuse before it
  // writes anything at all.
  try {
    const session = await runtime.openOriginal({ ownershipDirectory, binding, source: held, commandId: randomUUID() });
    recordPid(session);
    result.busy = { admitted: true, id: session.id, workerPid: session.workerPid };
    await session.dispose();
  } catch (error) { result.busy = { admitted: false, error: describe(error) }; }
  result.afterBusy = await fileFacts(binding.originalFile);

  if (scenario === "busy-refusal") {
    // The competing writer still owns it after the refusal, and can still work.
    created.manager.appendMessage({ role: "user", content: [{ type: "text", text: "still owned" }], timestamp: 2 });
    created.manager.flushSync();
    result.ownerStillWritable = await fileFacts(binding.originalFile);
    created.manager.seal();
    await created.manager.close();
    return;
  }

  // Terminal close is what actually returns native ownership.
  created.manager.seal();
  await created.manager.close();
  result.released = await fileFacts(binding.originalFile);

  if (scenario === "stale-source") {
    const stale = { ...await observeEnrolledOriginal(ownershipDirectory, binding),
      contentSha256: "0".repeat(64) };
    try {
      const session = await runtime.openOriginal({ ownershipDirectory, binding, source: stale, commandId: randomUUID() });
      recordPid(session);
      result.stale = { admitted: true, workerPid: session.workerPid };
      await session.dispose();
    } catch (error) { result.stale = { admitted: false, error: describe(error) }; }
    result.afterStale = await fileFacts(binding.originalFile);
  }

  if (scenario === "race-disposal") {
    // Runtime disposal lands while admission is already in flight. The
    // in-flight attempt must refuse before it can spawn an admitted writer,
    // and disposal must join it rather than leave an owner behind.
    const racing = newRuntime();
    const pending = racing.openOriginal({ ownershipDirectory, binding,
      source: await observeEnrolledOriginal(ownershipDirectory, binding), commandId: randomUUID() });
    const disposal = racing.dispose();
    try {
      const session = await pending;
      recordPid(session);
      result.race = { admitted: true, workerPid: session.workerPid };
      await session.dispose();
    } catch (error) { result.race = { admitted: false, error: describe(error) }; }
    await disposal;
    result.afterRace = await fileFacts(binding.originalFile);
  }

  if (scenario === "setup-failure") {
    // A real native context failure after the writer lease has already been
    // taken: the profile this session must load is unparseable. The truth
    // reported has to be an unknown outcome, and ownership must still come
    // back through the actual close.
    await writeFile(path.join(agentDir, "models.yml"), "{ not valid json");
    await writeFile(path.join(agentDir, "config.yml"), "extensions: [\nmodelRoles: {{\n");
    try {
      const session = await runtime.openOriginal({ ownershipDirectory, binding,
        source: await observeEnrolledOriginal(ownershipDirectory, binding), commandId: randomUUID() });
      recordPid(session);
      result.setupFailure = { admitted: true, workerPid: session.workerPid, id: session.id,
        sessionFile: session.sessionFile, cwd: session.cwd };
      await session.dispose();
    } catch (error) { result.setupFailure = { admitted: false, error: describe(error) }; }
    result.afterSetupFailure = await fileFacts(binding.originalFile);
    await writeFile(path.join(agentDir, "models.yml"), MODELS);
    await writeFile(path.join(agentDir, "config.yml"), ["extensions: []", "modelRoles:",
      "  default: [original-admission-runtime/controlled]", ""].join("\n"));
  }

  // The released original is admitted by the production worker in its own
  // process, keeping its native id, file, recorded cwd and history.
  const first = await runtime.openOriginal({ ownershipDirectory, binding,
    source: await observeEnrolledOriginal(ownershipDirectory, binding), commandId: randomUUID() });
  recordPid(first);
  const todoMarker = randomUUID();
  const todoMarkdown = `# Todos\n- [ ] admitted native write ${todoMarker}\n`;
  result.admitted = { id: first.id, sessionFile: first.sessionFile, cwd: first.cwd, workerPid: first.workerPid,
    current: runtime.isOriginalHandleCurrent(first),
    messages: JSON.stringify(await first.getMessages()).includes(HISTORY_TEXT) };
  const todos = await first.getTodos();
  const mutation = await first.mutateTodos(randomUUID(),
    { sessionId: first.id, ticket: todos.ticket, mutation: { action: "edit", markdown: todoMarkdown } });
  result.mutation = { markdown: mutation.state.markdown, requested: todoMarkdown, marker: todoMarker };
  result.afterWrite = await fileFacts(binding.originalFile);

  // An identity transition is refused at its owning operation boundary, before
  // any native relocation work, and leaves the live session usable.
  const elsewhere = path.join(root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  try {
    const moved = await first.moveSession(elsewhere);
    result.transition = { moved: true, ...moved };
  } catch (error) { result.transition = { moved: false, error: describe(error) }; }
  result.afterTransition = { ...await fileFacts(binding.originalFile),
    id: first.id, sessionFile: first.sessionFile, cwd: first.cwd,
    todos: (await first.getTodos()).markdown };

  assert.ok(first.enableBrowserRecovery);
  await assert.rejects(first.enableBrowserRecovery(path.join(root, "forbidden-recovery.sock"), randomUUID(), randomUUID()),
    error => !!error && typeof error === "object" && "code" in error && error.code === "ORIGINAL_SESSION_NOT_SUBMITTED");
  assert.equal(await Bun.file(path.join(root, "forbidden-recovery.sock")).exists(), false);
  const firstPid = first.workerPid;
  await runtime.dispose({ preserveReconnect: true });
  result.disposal = { ...await reaped(firstPid), current: runtime.isOriginalHandleCurrent(first) };

  // Disposal returned native ownership: the same original is admissible again,
  // and the non-provider write above is durably in that same file.
  const second = await newRuntime().openOriginal({ ownershipDirectory, binding,
    source: await observeEnrolledOriginal(ownershipDirectory, binding), commandId: randomUUID() });
  recordPid(second);
  result.readmitted = { id: second.id, sessionFile: second.sessionFile, cwd: second.cwd,
    todos: (await second.getTodos()).markdown,
    messages: JSON.stringify(await second.getMessages()).includes(HISTORY_TEXT) };
  const secondPid = second.workerPid;
  await second.dispose();
  result.readmittedDisposal = await reaped(secondPid);
}

let failure: unknown;
try { await main(); }
catch (error) { failure = error; result.failure = describe(error); }
finally {
  const cleanup: unknown[] = [];
  for (const runtime of runtimes) {
    try { await runtime.dispose(); } catch (error) { cleanup.push(describe(error)); }
  }
  sinkhole.close();
  result.cleanupErrors = cleanup;
  result.hostNetwork = hostNetwork;
  result.proxyAttempts = proxyAttempts.length;
  result.blockedWorkerAttempts = await Bun.file(workerNetworkLog).exists()
    ? (await readFile(workerNetworkLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}
if (failure) process.exit(1);
process.exit(0);
