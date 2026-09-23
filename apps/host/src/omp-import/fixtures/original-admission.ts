import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
let parentFetchAttempts = 0;
globalThis.fetch = Object.assign(async () => { parentFetchAttempts++; throw new Error("No outbound transport in original admission fixture"); }, { preconnect() { parentFetchAttempts++; throw new Error("No preconnect"); } }) as typeof fetch;
const { createCooperativeOriginal, observeEnrolledOriginal, openAdmittedOriginal } = await import("@oh-my-pi/pi-coding-agent/session/original-session-ownership");
const { NativeSessionImports } = await import("../inspection");
const { NativeOriginalSessionAdmission } = await import("../admission");
const { WorkerRuntime } = await import("../../omp-workers/runtime");
const root = await realpath(process.argv[2]!), scenario = process.argv[3]!;
const cwd = path.join(root, "project"), sessions = path.join(root, "sessions"), agentDir = path.join(root, "agent");
const ownershipDirectory = path.join(root, "ownership"), dataDirectory = path.join(root, "receipts");
await Promise.all([cwd, sessions, agentDir].map(directory => mkdir(directory, { recursive: true })));
await writeFile(path.join(agentDir, "config.yml"), "extensions: []\nretry:\n  enabled: false\n");
const environment = { HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PATH: process.env.PATH!, TERM: "dumb" };
const workerPath = path.join(root, "blocked-production-worker.ts"), blockedWorkerLog = path.join(root, "blocked-worker-fetches");
const productionEntry = fileURLToPath(new URL("../../omp-workers/entry.ts", import.meta.url));
await writeFile(workerPath, `import {appendFileSync} from 'node:fs';\nfunction block(){appendFileSync(${JSON.stringify(blockedWorkerLog)},'blocked\\n');throw new Error('No outbound transport in original admission worker');}\nglobalThis.fetch=Object.assign(async()=>block(),{preconnect:block});\nawait import(${JSON.stringify(productionEntry)});\n`);
const runtime = new WorkerRuntime({ agentDir, workerPath, environment, startupTimeoutMs: 20_000, shutdownTimeoutMs: 5_000 });
const importer = new NativeSessionImports({ sessionDirectories: [sessions] });
const services: InstanceType<typeof NativeOriginalSessionAdmission>[] = [];
const pids = new Set<number>();
const options = {
  dataDirectory, ownershipDirectory, runtime,
  resolveReviewedSource: (candidateId: string, revision: string) => importer.resolveReviewedSource(candidateId, revision),
  // Root's separately-owned catalog reservation port is controlled here; the
  // source, native ownership, worker, command journal and process lifetime are real.
  reserveCatalogIdentity: async () => {},
};
function service(overrides: Partial<ConstructorParameters<typeof NativeOriginalSessionAdmission>[0]> = {}) {
  const value = new NativeOriginalSessionAdmission({ ...options, ...overrides }); services.push(value); return value;
}
async function reviewed() {
  const candidate = (await importer.scan()).find(candidate => !candidate.issue)!;
  assert.ok(candidate);
  const inspection = await importer.inspect(candidate.candidateId);
  return { candidateId: candidate.candidateId, expectedRevision: inspection.revision };
}
const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
const gone = (pid: number) => assert.throws(() => process.kill(pid, 0), "The actual owned process must be reaped");
let release = () => {};
try {
  if (scenario === "abandon-dispatcher") {
    const current = service({ reserveCatalogIdentity: async () => {
      process.send?.({ type: "pending", preparationId: prepared.ok ? prepared.preparationId : undefined,
        status: await current.status("lost-original-command") });
      await new Promise<void>(() => {});
    } });
    const prepared = await current.prepare(await reviewed()); if (!prepared.ok) throw new Error(prepared.message);
    await current.admit({ commandId: "lost-original-command", preparationId: prepared.preparationId });
    throw new Error("The held dispatcher must be terminated by the parent fixture");
  }
  const created = await createCooperativeOriginal({ ownershipDirectory, cwd, sessionDirectory: sessions });
  const binding = created.binding;
  created.manager.appendMessage({ role: "user", content: "Original admission history", timestamp: 1 });
  await created.manager.ensureOnDisk(); await created.manager.flush(); created.manager.seal(); await created.manager.close();
  if (scenario === "receipt-and-resume") {
    const current = service(), before = await hash(binding.originalFile);
    const prepared = await current.prepare(await reviewed()); if (!prepared.ok) throw new Error(prepared.message);
    assert.equal(await hash(binding.originalFile), before, "Preparation must not write the original");
    prepared.source.originalFile = path.join(root, "caller-mutated-source.jsonl");
    prepared.binding.nativeId = "caller-mutated-id";
    const request = { commandId: "original-import-command", preparationId: prepared.preparationId };
    const admitted = await current.admit(request);
    assert.equal(admitted.status.state, "admitted"); assert.ok(admitted.handle); const handle = admitted.handle;
    pids.add(handle.workerPid);
    assert.equal(handle.id, binding.nativeId); assert.equal(handle.sessionFile, binding.originalFile); assert.equal(handle.cwd, binding.recordedCwd);
    assert.equal(current.getRetainedHandle(request.commandId, binding), handle);
    assert.equal(current.getRetainedHandle(request.commandId, { ...binding, enrollmentId: "foreign-enrollment" }), undefined);
    const renamed = handle.startPrompt("/rename Same admitted original"); await renamed.accepted; await renamed.completion; await handle.flushSession();
    assert.ok((await readFile(binding.originalFile, "utf8")).includes("Same admitted original"));
    const after = await hash(binding.originalFile);
    const duplicate = await current.admit(request);
    assert.equal(duplicate.status.state, "admitted"); assert.equal(duplicate.handle, undefined);
    assert.equal(await hash(binding.originalFile), after, "Duplicate command inspection cannot reopen or write");
    await current.dispose(); gone(handle.workerPid);
    assert.equal(current.getRetainedHandle(request.commandId, binding), undefined);
    assert.equal((await current.status(request.commandId)).state, "admitted");
    const reopened = service(); assert.equal((await reopened.status(request.commandId)).state, "admitted");
    assert.equal(reopened.getRetainedHandle(request.commandId, binding), undefined);
    const foreign = await reopened.prepare({ binding: { ...binding, registryId: "foreign-registry" } });
    assert.equal(foreign.ok, false, "A cold reopen must never silently refresh its persisted binding");
    assert.equal(await hash(binding.originalFile), after);
    const replay = await reopened.admit(request); assert.equal(replay.status.state, "admitted"); assert.equal(replay.handle, undefined);
    const resume = await reopened.prepare({ binding }); if (!resume.ok) throw new Error(resume.message);
    await assert.rejects(reopened.admit({ commandId: request.commandId, preparationId: resume.preparationId }),
      error => !!error && typeof error === "object" && "code" in error && error.code === "ORIGINAL_SESSION_INPUT_MISMATCH");
    assert.equal((await reopened.status(request.commandId)).state, "admitted");
    const resumed = await reopened.admit({ commandId: "explicit-original-resume", preparationId: resume.preparationId });
    assert.equal(resumed.status.state, "admitted"); assert.ok(resumed.handle); pids.add(resumed.handle.workerPid);
    assert.equal(resumed.handle.id, binding.nativeId); assert.equal(resumed.handle.sessionFile, binding.originalFile);
    assert.ok((await resumed.handle.getMessages()).some(message => JSON.stringify(message).includes("Original admission history")));
    await resumed.handle.dispose();
    assert.equal(reopened.getRetainedHandle("explicit-original-resume", binding), undefined);
    const next = await reopened.prepare({ binding }); if (!next.ok) throw new Error(next.message);
    const again = await reopened.admit({ commandId: "same-service-original-resume", preparationId: next.preparationId });
    assert.equal(again.status.state, "admitted"); assert.ok(again.handle); pids.add(again.handle.workerPid);
    assert.equal(reopened.getRetainedHandle("same-service-original-resume", binding), again.handle);
    assert.equal(reopened.getRetainedHandle("explicit-original-resume", binding), undefined);
    assert.ok((await again.handle.getMessages()).some(message => JSON.stringify(message).includes("Original admission history")));
    console.log(JSON.stringify({ scenario, exactRetainedHandle: true, duplicateNeverReopens: true, coldReceiptHasNoLiveHandle: true, explicitSameOriginalResume: true }));
  } else if (scenario === "stale-preparation") {
    const current = service(), prepared = await current.prepare(await reviewed()); if (!prepared.ok) throw new Error(prepared.message);
    const source = await observeEnrolledOriginal(ownershipDirectory, binding);
    const writer = await openAdmittedOriginal({ ownershipDirectory, binding, source, commandId: "external-cooperative-update" });
    try { writer.appendMessage({ role: "user", content: "A real newer cooperative turn", timestamp: 2 }); await writer.flush(); }
    finally { writer.seal(); await writer.close(); }
    const updated = await hash(binding.originalFile);
    const result = await current.admit({ commandId: "stale-original-command", preparationId: prepared.preparationId });
    assert.equal(result.status.state, "refused");
    if (result.status.state === "refused") assert.equal(result.status.code, "ORIGINAL_SESSION_NOT_SUBMITTED");
    assert.equal(result.handle, undefined); assert.equal(await hash(binding.originalFile), updated);
    assert.equal((await current.status("stale-original-command")).state, "refused");
    console.log(JSON.stringify({ scenario, staleSourceRefusedBeforeWrite: true, originalNewerHistoryPreserved: true }));
  } else if (scenario === "lost-dispatcher") {
    const before = await hash(binding.originalFile), pending = Promise.withResolvers<{ preparationId: string; status: { state: string } }>();
    const actor = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), root, "abandon-dispatcher"], {
      cwd: root, env: environment, stdin: "ignore", stdout: "ignore", stderr: "pipe",
      ipc(value) {
        if (value && typeof value === "object" && "type" in value && value.type === "pending"
          && "preparationId" in value && typeof value.preparationId === "string"
          && "status" in value && value.status && typeof value.status === "object"
          && "state" in value.status && typeof value.status.state === "string") {
          pending.resolve({ preparationId: value.preparationId, status: { state: value.status.state } });
        }
      },
    });
    pids.add(actor.pid);
    const deadline = setTimeout(() => { actor.kill("SIGKILL"); pending.reject(new Error("The real dispatcher did not reach its durable pending boundary")); }, 20_000);
    let original: { preparationId: string; status: { state: string } };
    try { original = await pending.promise; assert.equal(original.status.state, "pending"); actor.kill("SIGKILL"); await actor.exited; }
    finally { clearTimeout(deadline); if (actor.exitCode === null) { actor.kill("SIGKILL"); await actor.exited; } }
    gone(actor.pid);
    const restored = service({ reserveCatalogIdentity: async () => { throw new Error("Receipt inspection must never replay original admission"); } });
    assert.equal((await restored.status("lost-original-command")).state, "unknown");
    const duplicate = await restored.admit({ commandId: "lost-original-command", preparationId: original.preparationId });
    assert.equal(duplicate.status.state, "unknown"); assert.equal(duplicate.handle, undefined);
    assert.equal(await hash(binding.originalFile), before);
    console.log(JSON.stringify({ scenario, actualDispatcherKilled: true, retainedUnknown: true, noAdmissionReplay: true }));
  } else if (scenario === "dispose-during-open") {
    const entered = Promise.withResolvers<Awaited<ReturnType<typeof runtime.openOriginal>>>(), gate = Promise.withResolvers<void>();
    release = () => gate.resolve();
    const actual = runtime;
    const current = service({ runtime: {
      isOriginalHandleCurrent: handle => actual.isOriginalHandleCurrent(handle),
      openOriginal: async input => { const handle = await actual.openOriginal(input); pids.add(handle.workerPid); entered.resolve(handle); await gate.promise; return handle; },
    } });
    const prepared = await current.prepare(await reviewed()); if (!prepared.ok) throw new Error(prepared.message);
    const attempt = current.admit({ commandId: "closing-original-command", preparationId: prepared.preparationId });
    const handle = await Promise.race([entered.promise, attempt.then(result => { throw new Error(`Native startup ended before the gate: ${JSON.stringify(result.status)}`); })]);
    let disposed = false; const closing = current.dispose().then(() => { disposed = true; });
    await Bun.sleep(20); assert.equal(disposed, false, "Service disposal must join actual admitted startup");
    assert.equal(current.getRetainedHandle("closing-original-command", binding), undefined);
    gate.resolve(); const result = await attempt; await closing;
    assert.equal(result.status.state, "unknown"); assert.equal(result.handle, undefined); gone(handle.workerPid);
    assert.equal((await current.status("closing-original-command")).state, "unknown");
    console.log(JSON.stringify({ scenario, disposalJoinedRealWorker: true, originalOutcomeRetainedUnknown: true, workerReaped: true }));
  } else throw new Error(`Unknown original admission fixture ${scenario}`);
} finally {
  release();
  const results = await Promise.allSettled(services.map(value => value.dispose()));
  await runtime.dispose();
  for (const pid of pids) gone(pid);
  assert.equal(parentFetchAttempts, 0);
  const blockedWorkerAttempts = await Bun.file(blockedWorkerLog).exists() ? (await readFile(blockedWorkerLog, "utf8")).trim().split("\n").length : 0;
  console.log(JSON.stringify({ cleanup: "complete", scenario, ownedProcessesReaped: pids.size, blockedWorkerAttempts, outboundRequestsAllowed: 0 }));
  const failed = results.filter((value): value is PromiseRejectedResult => value.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map(value => value.reason), "Original admission fixture cleanup failed");
}
