import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalEnvironmentRunResult } from "./runner";
import {
  initializeLocalEnvironmentPreparations,
  LocalEnvironmentPreparationConflict,
  LocalEnvironmentPreparations,
  type LocalEnvironmentPreparation,
  type LocalEnvironmentPreparationInput,
} from "./preparations";

const roots: string[] = [];
const databases = new Set<Database>();

function fixture(): { root: string; path: string; database: Database; preparations: LocalEnvironmentPreparations } {
  const root = mkdtempSync(join(tmpdir(), "agent-desktop-environment-preparation-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  const database = new Database(path, { create: true, strict: true });
  databases.add(database);
  initializeLocalEnvironmentPreparations(database);
  return { root, path, database, preparations: new LocalEnvironmentPreparations(database, "host-a") };
}

function reopen(path: string, hostId = "host-a"): LocalEnvironmentPreparations {
  const database = new Database(path, { create: true, strict: true });
  databases.add(database);
  return new LocalEnvironmentPreparations(database, hostId);
}

function input(root: string, id = "preparation-1", environment = true): LocalEnvironmentPreparationInput {
  const raw = 'version = 1\nname = "Private setup"\n[setup]\nscript = "export API_SECRET=hidden-config-value"\n';
  return {
    id,
    projectId: "project-a",
    sourceRoot: join(root, "source"),
    worktreePath: join(root, "worktrees", id),
    startingState: { type: "branch", branchName: "feature/exact" },
    draft: { id: "new-chat", revision: 7 },
    model: { provider: "provider-a", id: "reasoning-model" },
    approvalMode: "write",
    environment: environment ? {
      configPath: join(root, "source", ".agent-desktop", "environments", "private.toml"),
      revision: createHash("sha256").update(raw).digest("hex"),
      raw,
    } : null,
  };
}

function result(status: "succeeded" | "failed" | "cancelled", delta = false): LocalEnvironmentRunResult {
  return {
    status,
    ...(status === "cancelled" ? { cancelReason: "timed-out" as const } : {}),
    exitCode: status === "succeeded" ? 0 : 17,
    signal: null,
    startedAt: 100,
    finishedAt: 200,
    stdout: "private stdout API_SECRET=hidden-result-value",
    stderr: "private stderr",
    outputTruncated: false,
    environmentDelta: delta ? { version: 1, set: { API_SECRET: "hidden-delta-value" }, unset: ["OLD_SECRET"] } : null,
  };
}

function advance(
  preparations: LocalEnvironmentPreparations,
  record: LocalEnvironmentPreparation,
  transition: Parameters<LocalEnvironmentPreparations["transition"]>[2],
): LocalEnvironmentPreparation {
  return preparations.transition(record.id, record.revision, transition);
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalEnvironmentPreparations", () => {
  test("persists the exact private owner/config snapshot and exposes a value-redacted projection", () => {
    const { root, path, preparations } = fixture();
    let record = preparations.create(input(root));
    record = advance(preparations, record, { type: "worktree-create.started" });
    record = advance(preparations, record, { type: "worktree-create.succeeded", worktreePath: record.worktreePath });
    record = advance(preparations, record, { type: "setup.started" });
    record = advance(preparations, record, { type: "setup.succeeded", result: result("succeeded", true) });

    const reopened = reopen(path);
    const persisted = reopened.get(record.id)!;
    expect(persisted).toEqual(record);
    expect(persisted).toMatchObject({
      hostId: "host-a",
      projectId: "project-a",
      startingState: { type: "branch", branchName: "feature/exact" },
      draft: { id: "new-chat", revision: 7 },
      model: { provider: "provider-a", id: "reasoning-model" },
      approvalMode: "write",
      environmentDelta: { set: { API_SECRET: "hidden-delta-value" }, unset: ["OLD_SECRET"] },
    });
    expect(persisted.environment?.raw).toContain("hidden-config-value");
    expect(persisted.setupResult?.stdout).toContain("hidden-result-value");

    const projection = reopened.public(persisted);
    expect(projection).toMatchObject({
      id: record.id,
      phase: "setup-succeeded",
      environment: { name: "Private setup", configPath: input(root).environment!.configPath },
      setup: { status: "succeeded", exitCode: 0, outputTruncated: false },
      needsAttention: false,
    });
    const serialized = JSON.stringify(projection);
    for (const privateValue of ["hidden-config-value", "hidden-result-value", "hidden-delta-value", "API_SECRET", "OLD_SECRET", "private stderr"])
      expect(serialized).not.toContain(privateValue);
    const foreignHost = new LocalEnvironmentPreparations((databases.values().next().value)!, "host-b");
    expect(foreignHost.get(persisted.id)).toBeUndefined();
    expect(foreignHost.list()).toEqual([]);
    expect(() => foreignHost.public(persisted)).toThrow("another host");
  });

  test("enforces expected revisions across independent database connections", () => {
    const { root, path, preparations } = fixture();
    const created = preparations.create(input(root));
    const competing = reopen(path);
    const stale = competing.get(created.id)!;
    const won = advance(preparations, created, { type: "worktree-create.started" });

    try {
      advance(competing, stale, { type: "worktree-create.started" });
      throw new Error("Expected stale transition to conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalEnvironmentPreparationConflict);
      expect((error as LocalEnvironmentPreparationConflict).current).toEqual(won);
    }
    expect(competing.get(created.id)).toEqual(won);
  });

  test("joins an outer host transaction so a receipt failure rolls back its transition", () => {
    const { root, database, preparations } = fixture();
    database.exec("CREATE TABLE fixture_command_receipts (id TEXT PRIMARY KEY, result TEXT NOT NULL)");
    const created = preparations.create(input(root));

    expect(() => database.transaction(() => {
      database.query("INSERT INTO fixture_command_receipts (id, result) VALUES (?, ?)").run("command-1", "dispatching");
      preparations.transition(created.id, created.revision, { type: "worktree-create.started" });
      throw new Error("fixture receipt commit failed");
    }).immediate()).toThrow("fixture receipt commit failed");

    expect(database.query("SELECT * FROM fixture_command_receipts").all()).toEqual([]);
    expect(preparations.get(created.id)).toEqual(created);

    const committed = database.transaction(() => {
      database.query("INSERT INTO fixture_command_receipts (id, result) VALUES (?, ?)").run("command-1", "dispatching");
      return preparations.transition(created.id, created.revision, { type: "worktree-create.started" });
    }).immediate();
    expect(committed.phase).toBe("worktree-creating");
    expect(database.query("SELECT * FROM fixture_command_receipts").all()).toEqual([{ id: "command-1", result: "dispatching" }]);
  });

  test("reconciles only explicitly and records dispatched effects as unknown without replay", () => {
    const { root, path, preparations } = fixture();
    const running: LocalEnvironmentPreparation[] = [];

    let worktree = preparations.create(input(root, "worktree"));
    running.push(advance(preparations, worktree, { type: "worktree-create.started" }));

    let setup = preparations.create(input(root, "setup"));
    setup = advance(preparations, setup, { type: "worktree-create.started" });
    setup = advance(preparations, setup, { type: "worktree-create.succeeded", worktreePath: setup.worktreePath });
    running.push(advance(preparations, setup, { type: "setup.started" }));

    let native = preparations.create(input(root, "native", false));
    native = advance(preparations, native, { type: "worktree-create.started" });
    native = advance(preparations, native, { type: "worktree-create.succeeded", worktreePath: native.worktreePath });
    running.push(advance(preparations, native, { type: "native-create.started" }));

    let cleanup = preparations.create(input(root, "cleanup", false));
    cleanup = advance(preparations, cleanup, { type: "worktree-create.started" });
    cleanup = advance(preparations, cleanup, { type: "worktree-create.succeeded", worktreePath: cleanup.worktreePath });
    running.push(advance(preparations, cleanup, { type: "cleanup.started" }));
    const stable = preparations.create(input(root, "stable", false));

    const restarted = reopen(path);
    for (const prior of running) expect(restarted.get(prior.id)).toEqual(prior);
    expect(restarted.get(stable.id)).toEqual(stable);

    const reconciled = restarted.reconcileInterrupted();
    expect(reconciled.map(item => [item.id, item.phase, item.uncertainOperation])).toEqual([
      ["worktree", "unknown", "worktree-create"],
      ["setup", "unknown", "setup"],
      ["native", "unknown", "native-create"],
      ["cleanup", "unknown", "cleanup"],
    ]);
    for (const changed of reconciled) {
      const prior = running.find(item => item.id === changed.id)!;
      expect(changed.revision).toBe(prior.revision + 1);
      expect(restarted.public(changed).needsAttention).toBe(true);
    }
    expect(restarted.get(stable.id)).toEqual(stable);
    expect(restarted.reconcileInterrupted()).toEqual([]);
  });

  test("keeps failure, retry, native admission, cleanup, and removal transitions explicit", () => {
    const { root, preparations } = fixture();
    let record = preparations.create(input(root));
    expect(() => advance(preparations, record, { type: "setup.started" })).toThrow("validated");
    record = advance(preparations, record, { type: "worktree-create.started" });
    record = advance(preparations, record, { type: "worktree-create.succeeded", worktreePath: record.worktreePath });
    record = advance(preparations, record, { type: "setup.started" });
    record = advance(preparations, record, { type: "setup.failed", result: result("failed") });
    expect(preparations.public(record).needsAttention).toBe(true);
    record = advance(preparations, record, { type: "setup.started" });
    record = advance(preparations, record, { type: "setup.succeeded", result: result("succeeded", true) });
    record = advance(preparations, record, { type: "native-create.started" });
    record = advance(preparations, record, { type: "native-create.succeeded", sessionId: "native-session" });
    record = advance(preparations, record, { type: "cleanup.started" });
    record = advance(preparations, record, { type: "cleanup.failed", result: result("cancelled") });
    expect(record.phase).toBe("cleanup-failed");
    record = advance(preparations, record, { type: "cleanup.started" });
    record = advance(preparations, record, { type: "cleanup.succeeded", result: result("succeeded") });
    record = advance(preparations, record, { type: "removed" });
    expect(record).toMatchObject({ phase: "removed", sessionId: "native-session" });
  });

  test("rejects mismatched config bytes, foreign paths, target drift, and invalid deltas before persistence", () => {
    const { root, preparations } = fixture();
    const badRevision = input(root, "bad-revision");
    badRevision.environment = { ...badRevision.environment!, revision: "0".repeat(64) };
    expect(() => preparations.create(badRevision)).toThrow("exact bytes");
    const foreign = input(root, "foreign");
    foreign.environment = { ...foreign.environment!, configPath: join(root, "other", "private.toml") };
    expect(() => preparations.create(foreign)).toThrow("source project");
    expect(preparations.list()).toEqual([]);

    let record = preparations.create(input(root));
    record = advance(preparations, record, { type: "worktree-create.started" });
    expect(() => advance(preparations, record, { type: "worktree-create.succeeded", worktreePath: join(root, "wrong") })).toThrow("captured target");
    record = advance(preparations, record, { type: "worktree-create.succeeded", worktreePath: record.worktreePath });
    record = advance(preparations, record, { type: "setup.started" });
    const invalidDelta = result("succeeded", true);
    invalidDelta.environmentDelta!.unset = ["BAD=VALUE"];
    expect(() => advance(preparations, record, { type: "setup.succeeded", result: invalidDelta })).toThrow("Invalid environment delta");
    expect(preparations.get(record.id)).toEqual(record);
  });
});
