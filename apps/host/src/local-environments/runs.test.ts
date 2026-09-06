import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeLocalEnvironmentPreparations,
  LocalEnvironmentPreparations,
  type LocalEnvironmentPreparation,
} from "./preparations";
import { LocalEnvironmentRuns } from "./runs";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(id = "preparation-1") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-environment-runs-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source"), worktreePath = join(root, "worktree");
  await Promise.all([mkdir(sourceRoot), mkdir(worktreePath)]);
  const databasePath = join(root, "state.sqlite");
  const database = new Database(databasePath, { create: true, strict: true });
  cleanups.push(() => database.close());
  initializeLocalEnvironmentPreparations(database);
  const preparations = new LocalEnvironmentPreparations(database, "host-a");
  const raw = 'version = 1\nname = "Fixture"\n[setup]\nscript = "echo fixture"\n';
  let record = preparations.create({
    id, projectId: "project-a", sourceRoot, worktreePath,
    startingState: { type: "branch", branchName: "main" }, draft: { id: "draft-a", revision: 1 },
    environment: { configPath: join(sourceRoot, ".agent-desktop", "environments", "fixture.toml"), raw,
      revision: createHash("sha256").update(raw).digest("hex") },
  });
  record = preparations.transition(record.id, record.revision, { type: "worktree-create.started" });
  record = preparations.transition(record.id, record.revision, { type: "worktree-create.succeeded", worktreePath });
  record = preparations.transition(record.id, record.revision, { type: "setup.started" });
  return { root, sourceRoot, worktreePath, databasePath, database, preparations, record };
}

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture state.");
    await Bun.sleep(10);
  }
}

test("persists output while a real setup runs and finishes with a monotonic sequence", async () => {
  const f = await fixture();
  const runs = new LocalEnvironmentRuns(f.preparations);
  const running = runs.run(f.record, {
    cwd: f.worktreePath, sourceRoot: f.sourceRoot, worktreeRoot: f.worktreePath,
    lifecycle: "setup", script: 'printf "first-output\\n"; sleep 0.2; printf "second-output\\n"',
  });
  await until(() => f.preparations.getOutput(f.record.id)?.stdout.includes("first-output") === true);
  const during = f.preparations.getOutput(f.record.id)!;
  expect(during).toMatchObject({ lifecycle: "setup", runRevision: f.record.revision, finished: false, cancellationRequested: false });
  expect(during.sequence).toBeGreaterThan(0);
  const result = await running;
  expect(result.status).toBe("succeeded");
  const finished = f.preparations.getOutput(f.record.id)!;
  expect(finished).toMatchObject({ stdout: "first-output\nsecond-output\n", stderr: "", truncated: false, finished: true });
  expect(finished.sequence).toBeGreaterThan(during.sequence);
  expect(f.preparations.public(f.record)).not.toHaveProperty("output");
});

test("an exact active cancellation is durable, idempotent, and kills the real process group", async () => {
  const f = await fixture();
  const runs = new LocalEnvironmentRuns(f.preparations);
  const running = runs.run(f.record, {
    cwd: f.worktreePath, sourceRoot: f.sourceRoot, worktreeRoot: f.worktreePath,
    lifecycle: "setup", script: 'printf "ready\\n"; sleep 30', timeoutMs: 10_000,
  });
  await until(() => f.preparations.getOutput(f.record.id)?.stdout === "ready\n");
  expect(() => runs.cancel(f.record.id, f.record.revision + 1)).toThrow("not active at that revision");
  expect(runs.cancel(f.record.id, f.record.revision)).toBe(true);
  expect(runs.cancel(f.record.id, f.record.revision)).toBe(false);
  const result = await running;
  expect(result).toMatchObject({ status: "cancelled", cancelReason: "aborted" });
  expect(f.preparations.getOutput(f.record.id)).toMatchObject({ cancellationRequested: true, finished: true });
  expect(() => runs.cancel(f.record.id, f.record.revision)).toThrow("not active at that revision");
}, 5_000);

test("bounds durable output and records truncation from the actual runner", async () => {
  const f = await fixture();
  const runs = new LocalEnvironmentRuns(f.preparations);
  const result = await runs.run(f.record, {
    cwd: f.worktreePath, sourceRoot: f.sourceRoot, worktreeRoot: f.worktreePath,
    lifecycle: "setup", script: "printf 'abcdefghijklmnopqrstuvwxyz'; printf '0123456789' >&2", maxOutputBytes: 20,
  });
  expect(result.outputTruncated).toBe(true);
  const output = f.preparations.getOutput(f.record.id)!;
  expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBe(20);
  expect(output).toMatchObject({ truncated: true, finished: true });
});

test("a signal already aborted before dispatch leaves no stale active owner", async () => {
  const f = await fixture();
  const runs = new LocalEnvironmentRuns(f.preparations);
  const controller = new AbortController();
  controller.abort();
  const result = await runs.run(f.record, {
    cwd: f.worktreePath, sourceRoot: f.sourceRoot, worktreeRoot: f.worktreePath,
    lifecycle: "setup", script: "touch must-not-run", signal: controller.signal,
  });
  expect(result).toMatchObject({ status: "cancelled", cancelReason: "aborted" });
  expect(f.preparations.getOutput(f.record.id)).toMatchObject({ cancellationRequested: true, finished: true });
  expect(() => runs.cancel(f.record.id, f.record.revision)).toThrow("not active at that revision");
  expect(await Bun.file(join(f.worktreePath, "must-not-run")).exists()).toBe(false);
});

test("cancellation is refused once the process settles while result finalization remains active", async () => {
  const f = await fixture();
  const runs = new LocalEnvironmentRuns(f.preparations);
  let cancellationError: unknown;
  const result = await runs.run(f.record, {
    cwd: f.worktreePath, sourceRoot: f.sourceRoot, worktreeRoot: f.worktreePath,
    lifecycle: "setup", script: 'export CAPTURE_AFTER_EXIT="completed"; printf "complete\\n"',
    onProcessSettled: () => {
      try { runs.cancel(f.record.id, f.record.revision); }
      catch (error) { cancellationError = error; }
    },
  });
  expect(cancellationError).toBeInstanceOf(Error);
  expect((cancellationError as Error).message).toContain("not active at that revision");
  expect(result).toMatchObject({ status: "succeeded", stdout: "complete\n" });
  expect(result.environmentDelta?.set.CAPTURE_AFTER_EXIT).toBe("completed");
  expect(f.preparations.getOutput(f.record.id)).toMatchObject({ cancellationRequested: false, finished: true });
});

test("restart retains unfinished output but cannot cancel or replay its missing native owner", async () => {
  const f = await fixture();
  f.preparations.beginOutput(f.record, "setup");
  f.preparations.updateOutput(f.record.id, f.record.revision, current => ({
    ...current, sequence: current.sequence + 1, stdout: "persisted-before-crash\n",
  }));
  f.database.close();
  cleanups.pop();
  const reopenedDatabase = new Database(f.databasePath, { strict: true });
  cleanups.push(() => reopenedDatabase.close());
  initializeLocalEnvironmentPreparations(reopenedDatabase);
  const reopened = new LocalEnvironmentPreparations(reopenedDatabase, "host-a");
  expect(reopened.getOutput(f.record.id)).toMatchObject({ stdout: "persisted-before-crash\n", finished: false });
  const runs = new LocalEnvironmentRuns(reopened);
  expect(() => runs.cancel(f.record.id, f.record.revision)).toThrow("not active at that revision");
  await expect(runs.run(f.record, {
    cwd: f.worktreePath, sourceRoot: f.sourceRoot, worktreeRoot: f.worktreePath,
    lifecycle: "setup", script: "touch must-not-run",
  })).rejects.toThrow("already dispatched");
  expect(await Bun.file(join(f.worktreePath, "must-not-run")).exists()).toBe(false);
  expect(new LocalEnvironmentPreparations(reopenedDatabase, "host-b").getOutput(f.record.id)).toBeNull();
});
