import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/shared-native-manual-admission.ts", import.meta.url));
const workerFixture = fileURLToPath(new URL("./fixtures/shared-native-manual-admission-worker.ts", import.meta.url));

// Actual SDK/worker/host acceptance. The disposable subprocess owns synthetic
// credentials and guarded loopback providers; the parent never loads a profile.
async function run(scenario: string): Promise<Record<string, any>> {
  const root = await realpath(await mkdtemp("/tmp/reset-shared-"));
  const child = Bun.spawn([process.execPath, "--no-env-file", fixture, root, scenario], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root, TERM: "dumb", NO_COLOR: "1", PI_DISABLE_DOTENV: "1", PI_NO_TITLE: "1",
      PI_TELEMETRY_DISABLED: "1", PI_CODING_AGENT_DIR: path.join(root, "agent"), XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "xdg-data"), XDG_CACHE_HOME: path.join(root, "xdg-cache"), XDG_STATE_HOME: path.join(root, "xdg-state") },
  });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 75_000);
  let stdout = "", stderr = "", code: number | undefined;
  try {
    [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Shared admission ${scenario} exited ${code}:\n${stdout}\n${stderr}`);
    const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
    expect(result.blockedHostNetwork).toEqual([]);
    if (scenario === "native-read-first") {
      // Revision refusal is durably invalidated and retained as a shutdown
      // diagnostic in this exact production composition, not clean success.
      const refused = result.wire.find((row: any) => row.error && row.request.operation.kind === "checkpoint" && row.request.operation.event.phase === "planned");
      expect(result.passes.find((pass: any) => pass.passId === refused.request.passId).record.closed.reason).toBe("invalidated");
      expect(JSON.stringify(result.cleanupErrors)).toContain(refused.error.replace(/^Error: /, ""));
    } else if (scenario === "cancelled-child-retirement") {
      // The actual SDK records the close-fenced checkpoint refusal before its
      // native drain. Whole-worker finish retains that same operational error.
      const original = result.final.statuses.native.resetDiagnostics.find((row: any) => row.error);
      expect(JSON.stringify(result.cleanupErrors)).toContain(original.error.replace(/^Error: /, ""));
      const child = result.final.statuses.native.sessionIds.child;
      expect(result.passes.filter((pass: any) => pass.record?.provenance.nativeSessionId === child && pass.record.provenance.trigger === "blocked")
        .map((pass: any) => pass.record.finish.state)).toEqual(["failed"]);
    } else expect(result.cleanupErrors).toEqual([]);
    expect(result.workerExit.map((worker: { alive: boolean }) => worker.alive)).toEqual([false, false]);
    return result;
  } finally {
    clearTimeout(deadline);
    // A failed watchdog must not leave actual-entry children alive. PID records
    // come only from this fixture's real WorkerRuntime; confirm the executable
    // still names this exact authored worker before signalling it.
    let records: Array<{ pid: number; directory: string }> = [];
    try { records = (await readFile(path.join(root, "owned-pids.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch {}
    for (const record of records) {
      if (!record.directory.startsWith(root + path.sep)) throw new Error("Unowned fixture PID record");
      const inspect = Bun.spawn(["/bin/ps", "-p", String(record.pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
      const command = await new Response(inspect.stdout).text(); await inspect.exited;
      if (command.includes(workerFixture)) { try { process.kill(record.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    }
    const evidence = process.env.SHARED_RESET_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      const destination = path.join(evidence, `${scenario}-${path.basename(root)}`);
      await cp(root, destination, { recursive: true, errorOnExist: true });
      await writeFile(path.join(destination, "process-output.json"), JSON.stringify({ scenario, code, stdout, stderr }, null, 2) + "\n");
    }
    await rm(root, { recursive: true, force: true });
  }
}

function expectOriginalReceipt(result: Record<string, any>, state: string) {
  expect(result.originalReceipt.reset.operationId).toBe(result.original.operationId);
  expect(result.originalReceipt.reset.confirmation).toEqual(result.original.confirmation);
  expect(result.originalReceipt.reset.state).toBe(state);
  expect(result.originalReceipt.command.id).toBe(result.commandIds.answerId);
  expect(result.final.statuses.native.originalRegistrationIntact).toBe(true);
  expect(result.final.statuses.manual.originalRegistrationIntact).toBe(true);
}
function expectNativeBlockedEntry(result: Record<string, any>) {
  // These facts are emitted by the real provider response, SDK message pipeline
  // and actual host pass, not by a test directly invoking owner callbacks.
  expect(result.final.statuses.native.transportRequests.some((row: any) => row.route === "inference" && row.responseStatus === 429)).toBe(true);
  expect(result.passes.some((pass: any) => pass.record?.provenance.trigger === "blocked" && pass.record.provenance.source === "blocked"
    && pass.record.provenance.nativeSessionId === result.final.statuses.native.sessionId)).toBe(true);
}

for (const scenario of ["native-read-first", "checkpoint-first-read", "native-decision-first", "checkpoint-first-decision"]) {
  test(`shared admission ${scenario}: held manual claim wins once without upgrading the original native contender`, async () => {
    const result = await run(scenario);
    expectNativeBlockedEntry(result);
    expect(result.held.account).toMatchObject({ kind: "manual", state: "dispatching", operationId: result.original.operationId });
    expect(result.held.statuses.manual.counts.consume).toBe(0);
    expect(result.held.statuses.native.counts.consume).toBe(0);
    expect(result.final.statuses.manual.counts.consume).toBe(1);
    expect(result.final.statuses.native.counts.consume).toBe(0);
    expect(result.final.account).toMatchObject({ kind: "manual", state: "settled", operationId: result.original.operationId });
    expectOriginalReceipt(result, "settled");
    expect(result.originalReceipt.reset.outcome).toBe("reset");
    const held = result.facts.find((row: any) => row.type === "manual.durable-checkpoint").seq;
    const boundary = result.facts.find((row: any) => scenario.includes("decision") ? row.type === "interaction.requested"
      : row.type === "native.request" && row.data.request.operation.kind === "checkpoint" && row.data.request.operation.event.phase === "started" && row.data.request.operation.event.pass.trigger === "blocked").seq;
    if (scenario.startsWith("native-")) expect(boundary).toBeLessThan(held);
    else expect(held).toBeLessThan(boundary);
  }, 90_000);
}

test("shared admission native claim first: original manual confirmation is rejected, not rebound to another consume", async () => {
  const result = await run("native-admission-first");
  expectNativeBlockedEntry(result); expectOriginalReceipt(result, "rejected");
  expect(result.final.statuses.native.counts.consume).toBe(1); expect(result.final.statuses.manual.counts.consume).toBe(0);
  expect(result.final.account).toMatchObject({ kind: "automatic", state: "settled", attemptId: result.held.account.attemptId });
  const attempt = result.final.attempts.find((row: any) => row.id === result.held.account.attemptId);
  const consume = result.final.statuses.native.consumes[0];
  expect(attempt.evidence.account.accountId).toBe("fixture-shared-account");
  expect(attempt.evidence.credit.id).toBe(consume.credit_id);
  expect(attempt.evidence.redeemRequestId).toBe(consume.redeem_request_id);
}, 90_000);

test("shared admission native consume failure: original automatic UNKNOWN fences the original manual receipt", async () => {
  const result = await run("native-consume-failure");
  expectNativeBlockedEntry(result); expectOriginalReceipt(result, "rejected");
  expect(result.final.statuses.native.counts.consume).toBe(1); expect(result.final.statuses.manual.counts.consume).toBe(0);
  expect(result.final.account).toMatchObject({ kind: "automatic", state: "unknown", attemptId: result.held.account.attemptId });
  const attempt = result.final.attempts.find((row: any) => row.id === result.held.account.attemptId);
  expect(attempt.observation.consumeBoundary).toBe("passed");
}, 90_000);

for (const scenario of ["manual-checkpoint-failure", "manual-consume-failure"]) {
  test(`shared admission ${scenario}: original manual UNKNOWN stays fenced against native entry`, async () => {
    const result = await run(scenario);
    expectNativeBlockedEntry(result); expectOriginalReceipt(result, "unknown");
    expect(result.final.account).toMatchObject({ kind: "manual", state: "unknown", operationId: result.original.operationId });
    expect(result.final.statuses.manual.counts.consume).toBe(scenario === "manual-consume-failure" ? 1 : 0);
    expect(result.final.statuses.native.counts.consume).toBe(0);
  }, 90_000);
}

test("shared admission exact child disposal preserves cancelled manual receipt and usable original root and sibling", async () => {
  const result = await run("cancelled-child-retirement");
  expectOriginalReceipt(result, "cancelled");
  const status = result.final.statuses.native;
  expect(status.sessions.child.isDisposed).toBe(true);
  expect(status.sessions.root.isDisposed).toBe(false); expect(status.sessions.sibling.isDisposed).toBe(false);
  expect(result.siblingPrompt.ok).toBe(true);
  expect(status.counts.consume).toBe(1); expect(result.final.statuses.manual.counts.consume).toBe(0);
  const originalChild = status.sessionIds.child;
  const drained = status.lifecycle.find((event: any) => event.target === "child" && event.phase === "drained").seq;
  expect(status.nativeEvents.filter((event: any) => event.target === "root" && event.seq > drained && event.type === "message_end")
    .map((event: any) => event.stopReason)).toEqual(["stop"]);
  expect(status.nativeEvents.filter((event: any) => event.target === "sibling" && event.seq > drained && event.type === "auto_retry_end")
    .map((event: any) => event.success)).toEqual([true]);
  expect(result.passes.filter((pass: any) => pass.record?.provenance.nativeSessionId === originalChild).flatMap((pass: any) => pass.attempts)).toEqual([]);
  const winner = result.final.attempts.find((attempt: any) => attempt.kind === "automatic");
  expect(winner.evidence.provenance.nativeSessionId).toBe(status.sessionIds.sibling);
}, 90_000);

test("shared admission original worker recovery keeps PID epoch and original receipt without replaying redemption", async () => {
  const result = await run("original-worker-recovery");
  expectNativeBlockedEntry(result); expectOriginalReceipt(result, "rejected");
  expect(result.recovery.pid).toBe(result.recovery.original.pid);
  expect(result.recovery.context).toMatchObject({ recovered: true, workerPid: result.recovery.original.pid, workerEpoch: result.recovery.original.resetPolicy.workerEpoch });
  expect(result.recovery.snapshot.id).toBe(result.recovery.original.resetPolicy.rootSessionId);
  expect(result.final.account).toMatchObject({ kind: "automatic", state: "settled", attemptId: result.held.account.attemptId });
  expect(result.final.statuses.native.counts.consume).toBe(1); expect(result.final.statuses.manual.counts.consume).toBe(0);
  expect(result.wire.filter((row: any) => row.worker === "recovered-native" && ["admit", "join"].includes(row.request.operation.kind))).toEqual([]);
}, 90_000);
