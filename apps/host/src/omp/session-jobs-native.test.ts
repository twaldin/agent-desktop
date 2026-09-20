import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JOBS_FIXTURE_INDEPENDENT_OWNER } from "./fixtures/jobs-controlled";

async function run(mode: "direct" | "worker") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-session-jobs-native-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./fixtures/jobs-native.ts", import.meta.url)), directory, mode], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: directory, TERM: "dumb", NO_COLOR: "1", PI_DISABLE_DOTENV: "1", PI_CODEX_WEBSOCKET: "0",
        PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
    });
    // Real clock on purpose: it bounds a separate native child process, which fake timers cannot drive.
    deadline = setTimeout(() => child.kill(), 110_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (process.env.NATIVE_JOBS_EVIDENCE) {
      const evidence = path.join(process.env.NATIVE_JOBS_EVIDENCE, `${mode}-${path.basename(directory)}`);
      await mkdir(evidence, { recursive: true });
      await Promise.all([
        writeFile(path.join(evidence, "stdout.raw"), stdout),
        writeFile(path.join(evidence, "stderr.raw"), stderr),
        writeFile(path.join(evidence, "receipt.json"), JSON.stringify({ code, directory, mode, disposableHome: true }, null, 2)),
      ]);
    }
    if (code !== 0) throw new Error(`Native jobs ${mode} fixture failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.blocked).toEqual([]);
    return result;
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}

test("original-session adapter over real detached task children: identities, queueing, guarded cancel, non-consuming inspect, owner loss and cold manager", async () => {
  const result = await run("direct");
  expect(result.identity).toMatchObject({ agentId: "Main", ownerMatches: true, initiallyEmpty: true });
  expect(result.identity.epochLength).toBeGreaterThan(0);
  expect(result.unavailable).toMatchObject({ availability: "unavailable", ownerDiffers: true });
  expect(result.idReuse).toMatchObject({ sameId: true, differentStart: true, differentGuard: true, firstGenerationResult: "first generation output",
    staleCancel: "STALE_JOB", staleInspect: "STALE_JOB", freshCancelRequested: true, freshStatus: "cancelled" });
  expect(result.independentOwner).toMatchObject({ hiddenFromRead: true, visibleUnfiltered: true, cancel: "STALE_JOB", stillRunning: true });
  expect(result.children.a).toEqual({ id: "child-a", type: "task", status: "running", queued: false, label: "child-a", agentId: "child-a" });
  expect(result.children.b).toEqual({ id: "child-b", type: "task", status: "running", queued: true, label: "child-b", agentId: "child-b" });
  expect(result.children.ownerIds).toEqual({ a: "Main", b: "Main" });
  expect(result.children.childSession).toMatchObject({ agentId: "child-a", differsFromRoot: true, parentId: "Main" });
  expect(result.children.readsDoNotConsume).toBe(true);
  expect(result.cancellation.b).toMatchObject({ requested: true, atCancel: { status: "cancelled", queued: true, settled: false }, finalStatus: "cancelled", consumed: false });
  expect(result.cancellation.b.errorText).toMatch(/Aborted before execution/);
  expect(result.cancellation.a).toMatchObject({ requested: true, atCancel: { status: "cancelled", settled: false }, finalStatus: "cancelled", consumedAfterTwoInspects: false, inferenceAborted: "aborted" });
  expect(result.cancellation).toMatchObject({ neverDelivered: true, settledCancelRequested: false });
  expect(result.cancellation.c.queued).toBe(true);
  expect(result.cancellation.cRunning).toMatchObject({ status: "running", queued: false });
  expect(result.completion).toMatchObject({ row: { id: "child-c", status: "completed", queued: false }, resultIncludesChildOutput: true, consumedAtInspect: false, consumedAfterInspects: false,
    deliveryQueuedAtCompletion: 1, consumedAfterNativeDelivery: true });
  expect(result.completion.rootFollowUpTurns).toBeGreaterThanOrEqual(1);
  expect(result.failure).toMatchObject({ row: { id: "child-d", status: "failed" }, errorIncludesChildFailure: true });
  expect(result.beforeOwnerLoss.running).toEqual([]);
  expect(result.beforeOwnerLoss.recent.map((row: { id: string; status: string }) => [row.id, row.status]).sort()).toEqual([["child-a", "cancelled"], ["child-b", "cancelled"], ["child-c", "completed"], ["child-d", "failed"], ["jobs-reuse", "cancelled"]]);
  expect(result.ownerLoss).toEqual({ adapter: "STALE_OWNER", sessionDisposed: true, managerInstanceCleared: true, retainedRows: 0 });
  expect(result.cold).toEqual({ freshOwnerDiffers: true, freshEmpty: true, freshManagerIsNew: true, reopenedSameNativeId: true, reopenedAvailability: "available", reopenedEmpty: true });
}, 120_000);

test("production worker RPC over the original captured native session: real spawns, guarded cancel, inspect, independent owner and cold restart", async () => {
  const result = await run("worker");
  expect(result.identity).toMatchObject({ capturedAgentId: "Main", ownerMatches: true, initiallyEmpty: true });
  expect(result.identity.capturedSessionId).toBe(result.identity.sessionId);
  expect(result.identity.capturedPid).toBe(result.identity.workerPid);
  expect(result.identity.capturedFile).toBe(result.identity.sessionFile);
  expect(result.children.a).toEqual({ id: "w-a", type: "task", status: "running", queued: false, label: "w-a", agentId: "w-a" });
  expect(result.children.b).toEqual({ id: "w-b", type: "task", status: "running", queued: true, label: "w-b", agentId: "w-b" });
  expect(result.children.ownerIds).toEqual({ a: "Main", b: "Main" });
  expect(result.children.childSessions).toContainEqual(expect.objectContaining({ id: "w-a", agentId: "w-a" }));
  expect(result.cancellation).toMatchObject({ requested: true, finalStatus: "cancelled", consumed: false, settledCancelRequested: false });
  expect(result.cancellation.fabricatedGuard).toMatch(/STALE_JOB/);
  expect(result.cancellation.staleOwner).toMatch(/STALE_OWNER/);
  expect(result.completion).toMatchObject({ row: { id: "w-a", status: "completed" }, resultIncludesChildOutput: true, independentHidden: true, independentOwner: JOBS_FIXTURE_INDEPENDENT_OWNER,
    ownedQueued: { type: "eval", status: "running", queued: true } });
  expect(result.completion.consumedAtInspect).toBe(result.completion.managerConsumedAtInspect);
  expect(result.failure).toMatchObject({ seededStatus: "failed", seededError: "seeded failure", childStatus: "failed", childErrorIncludesFailure: true });
  expect(result.beforeOwnerLoss.blockedInWorker).toEqual([]);
  expect(result.ownerLoss.disposedRead).not.toMatch(/^read:/);
  expect(result.ownerLoss.oldSocketGone).toBe(true);
  expect(result.cold).toEqual({ freshOwnerDiffers: true, freshEmpty: true, freshPidDiffers: true, freshManager: true, freshJobs: 0 });
  expect(result.cleanupFailures).toEqual([]);
}, 120_000);
