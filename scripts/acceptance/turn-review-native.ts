import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit } from "./git-file-fixture";
import type { TurnReview } from "../../packages/shared/src/turn-review";

export const TURN_FIXTURE_MODEL = { provider: "turn-review-fixture", id: "controlled" };
export async function createTurnReviewProject() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-turn-native-"))), cwd = join(root, "project"), agentDir = join(root, "agent"), sessions = join(root, "explicit-sessions");
  await mkdir(cwd); await mkdir(agentDir); await mkdir(sessions);
  await writeFile(join(cwd, "tracked.txt"), "HEAD BEFORE\n");
  fixtureGit(cwd, ["init", "--quiet", "--initial-branch=main"]); fixtureGit(cwd, ["add", "."]); fixtureGit(cwd, ["commit", "--quiet", "-m", "Turn fixture HEAD"]);
  await writeFile(join(cwd, "tracked.txt"), "DIRTY BEFORE\n");
  const producer = resolve(import.meta.dir, "turn-review-provider.ts"), producerLog = join(root, "producer.jsonl");
  await writeFile(join(agentDir, "config.yml"), `edit:\n  mode: replace\nextensions:\n  - ${JSON.stringify(producer)}\nretry:\n  enabled: false\n`);
  const environment = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_EDIT_VARIANT: "replace", PI_DISABLE_DOTENV: "1", TERM: "dumb", TURN_REVIEW_PRODUCER_LOG: producerLog,
    XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"), XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  return { root, cwd, agentDir, sessions, producerLog, environment };
}
export async function waitForTurnFixture(predicate: () => boolean | Promise<boolean>, description: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`); await Bun.sleep(20); }
}
function available(review: TurnReview): void { assert.equal(review.state, "available", review.reason ?? "Expected complete recorded foreground evidence"); assert(review.selected); }
export async function runTurnReviewNative(output: string) {
  await mkdir(output, { recursive: true });
  const fixture = await createTurnReviewProject();
  const { WorkerRuntime } = await import("../../apps/host/src/omp-workers/runtime");
  const runtime = new WorkerRuntime({ agentDir: fixture.agentDir, workerPath: resolve(import.meta.dir, "../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), environment: fixture.environment });
  const observations: Record<string, unknown> = { fixture: { root: fixture.root, cwd: fixture.cwd, sessions: fixture.sessions }, controlledModelOnly: true, outboundFetchRejectedByWorker: true };
  let session: Awaited<ReturnType<typeof runtime.create>> | undefined;
  try {
    session = await runtime.create({ cwd: fixture.cwd, sessionDirectory: fixture.sessions, interactions: true, approvalOverride: "yolo", model: TURN_FIXTURE_MODEL });
    const original = { id: session.id, sessionFile: session.sessionFile, head: fixtureGit(fixture.cwd, ["rev-parse", "HEAD"]), index: createHash("sha256").update(await readFile(join(fixture.cwd, ".git/index"))).digest("hex") };
    observations.original = original;
    const legacy = await session.getTurnReview(); assert.equal(legacy.state, "unavailable"); assert.equal(legacy.selected, null); observations.noEvidence = legacy;
    await session.prompt("turn-first: run actual read, edit, write and foreground shell", { model: TURN_FIXTURE_MODEL });
    const first = await session.getTurnReview(); available(first);
    assert.deepEqual(first.files.map(file => file.path).sort(), ["shell.txt", "tracked.txt", "written.txt"]);
    assert(first.patch.includes("-DIRTY BEFORE") && first.patch.includes("+EDIT RECORDED") && first.patch.includes("+WRITE RECORDED") && first.patch.includes("+SHELL RECORDED"));
    assert(!first.patch.includes("HEAD BEFORE")); observations.first = first;
    const entries = (await readFile(original.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const nativeResults = entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult");
    assert.deepEqual(nativeResults.map(entry => entry.message.toolName), ["read", "edit", "write", "bash"]);
    assert(nativeResults.every(entry => !entry.message.isError));
    for (const id of first.selected!.inputEntryIds) assert(entries.some(entry => entry.id === id && entry.type === "message" && entry.message.role === "user"));
    await session.prompt("turn-empty: no file changes", { model: TURN_FIXTURE_MODEL });
    const fallback = await session.getTurnReview(); available(fallback); assert.equal(fallback.selected!.turnId, first.selected!.turnId); assert.equal(fallback.patch, first.patch); observations.emptyFallback = fallback;
    await writeFile(join(fixture.cwd, "tracked.txt"), "LATER UNRELATED DISK\n");
    assert.equal((await session.getTurnReview()).patch, first.patch);
    await session.dispose(); session = await runtime.open({ sessionFile: original.sessionFile, interactions: true, approvalOverride: "yolo" });
    const reopened = await session.getTurnReview(); available(reopened); assert.equal(reopened.sessionId, original.id); assert.equal(reopened.patch, first.patch); assert.deepEqual(reopened.selected, first.selected); observations.reopened = reopened;
    await session.prompt("turn-second: change the same recorded written file", { model: TURN_FIXTURE_MODEL });
    const second = await session.getTurnReview(); available(second); assert.notEqual(second.selected!.turnId, first.selected!.turnId); assert.deepEqual(second.files.map(file => file.path), ["written.txt"]); assert(second.patch.includes("-WRITE RECORDED") && second.patch.includes("+SECOND TURN RECORDED")); observations.second = second;
    try { await session.prompt("turn-error: retain a real failing foreground shell mutation", { model: TURN_FIXTURE_MODEL }); } catch (error) { observations.errorCompletion = String(error); }
    const failed = await session.getTurnReview(); assert(failed.files.some(file => file.path === "errored.txt")); assert(failed.patch.includes("+ERROR RECORDED")); assert.equal(failed.selected?.outcome, "error"); observations.failed = failed;
    const interrupted = session.startPrompt("turn-abort: interrupt a real foreground shell after its write", { model: TURN_FIXTURE_MODEL });
    await interrupted.accepted;
    await waitForTurnFixture(async () => !!await stat(join(fixture.cwd, "aborted.txt")).catch(() => null), "foreground shell mutation before abort");
    await session.abort(); await interrupted.completion.catch(error => { observations.abortCompletion = String(error); });
    const aborted = await session.getTurnReview(); assert(aborted.files.some(file => file.path === "aborted.txt")); assert(aborted.patch.includes("+ABORT RECORDED")); assert.equal(aborted.selected?.outcome, "aborted"); observations.aborted = aborted;
    await session.prompt("turn-background: an unjoined native background writer cannot be complete", { model: TURN_FIXTURE_MODEL });
    const background = await session.getTurnReview(); assert.notEqual(background.state, "available"); assert.match(background.reason ?? "", /background|unjoined/i); observations.background = background;
    const jobs = await session.nativeJobs({ action: "read" });
    if (jobs.snapshot.availability === "available") for (const job of jobs.snapshot.running) await session.nativeJobs({ action: "cancel", owner: jobs.snapshot.owner, job: job.target });
    await waitForTurnFixture(async () => { const current = await session!.nativeJobs({ action: "read" }); return current.snapshot.availability === "available" && current.snapshot.running.length === 0; }, "owned background cancellation and body settlement");
    await session.dispose(); session = await runtime.open({ sessionFile: original.sessionFile, interactions: true, approvalOverride: "yolo" });
    const reopenedBackground = await session.getTurnReview();
    assert.notEqual(reopenedBackground.state, "available"); assert.equal(reopenedBackground.patch, background.patch);
    await session.prompt("turn-empty: a new owner cannot certify the previous owner's background writers", { model: TURN_FIXTURE_MODEL });
    const uncertainOwner = await session.getTurnReview();
    assert.notEqual(uncertainOwner.state, "available"); assert.match(uncertainOwner.reason ?? "", /previous native owner/);
    observations.backgroundOwnerReopened = uncertainOwner;
    assert.equal(fixtureGit(fixture.cwd, ["rev-parse", "HEAD"]), original.head);
    assert.equal(createHash("sha256").update(await readFile(join(fixture.cwd, ".git/index"))).digest("hex"), original.index);
    await writeFile(join(output, "native-session.jsonl"), await readFile(original.sessionFile));
    await writeFile(join(output, "producer.jsonl"), await readFile(fixture.producerLog));
    await session.dispose(); session = undefined; await runtime.dispose();
    observations.passed = true; observations.headIndexUnchanged = true; observations.cleanupJoined = true;
    await writeFile(join(output, "result.json"), JSON.stringify(observations, null, 2));
    await rm(fixture.root, { recursive: true });
    console.log("TURN_NATIVE_PASS", JSON.stringify({ dirtyEditWriteShell: true, persistedReopen: true, previousFallback: true, errorAbortRetained: true, backgroundNotComplete: true, cleanupJoined: true }));
  } catch (error) {
    observations.failure = { error: String(error), stack: error instanceof Error ? error.stack : undefined };
    if (session) { await writeFile(join(output, "native-session-at-failure.jsonl"), await readFile(session.sessionFile).catch(() => Buffer.from(""))); }
    await writeFile(join(output, "producer-at-failure.jsonl"), await readFile(fixture.producerLog).catch(() => Buffer.from("")));
    const cleanup = await Promise.allSettled([runtime.dispose()]); observations.cleanup = cleanup.map(result => result.status === "fulfilled" ? "fulfilled" : String(result.reason));
    await writeFile(join(output, "failure.json"), JSON.stringify(observations, null, 2));
    throw error;
  }
}
if (import.meta.main) { if (!process.argv[2]) throw new Error("An owned output directory is required."); await runTurnReviewNative(resolve(process.argv[2])); }
