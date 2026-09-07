import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalEnvironmentRunResult } from "./local-environments/runner";
import type { LocalEnvironmentPreparation, LocalEnvironmentPreparationInput } from "./local-environments/preparations";
import { HostStore } from "./store";

const roots: string[] = [];
const stores = new Set<HostStore>();
const databases = new Set<Database>();

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "agent-desktop-store-environments-"));
  roots.push(value);
  return value;
}

function open(path: string): HostStore {
  const store = new HostStore(path);
  stores.add(store);
  return store;
}

function close(store: HostStore): void {
  store.close();
  stores.delete(store);
}

function inspect(path: string): Database {
  const database = new Database(join(path, "state.sqlite"), { strict: true });
  databases.add(database);
  return database;
}

function version(database: Database): number {
  return database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
}

function preparation(store: HostStore, path: string, environment = true): LocalEnvironmentPreparationInput {
  const sourceRoot = join(path, "project");
  mkdirSync(sourceRoot, { recursive: true });
  const project = store.addProject({ path: sourceRoot });
  const raw = 'version = 1\nname = "Store environment"\n[setup]\nscript = "export CONTRACT_VALUE=private"\n';
  return {
    id: `preparation-${crypto.randomUUID()}`,
    projectId: project.id,
    sourceRoot: project.path,
    worktreePath: join(path, "worktrees", crypto.randomUUID()),
    startingState: { type: "branch", branchName: "main" },
    draft: { id: "new-conversation", revision: 3 },
    environment: environment ? {
      configPath: join(project.path, ".agent-desktop", "environments", "store.toml"),
      revision: createHash("sha256").update(raw).digest("hex"),
      raw,
    } : null,
  };
}

function nestedPreparation(store: HostStore, path: string): LocalEnvironmentPreparationInput {
  const fixtureGitRoot = join(path, "nested-repository"), sourceRoot = join(fixtureGitRoot, "apps", "web");
  mkdirSync(sourceRoot, { recursive: true });
  const project = store.addProject({ path: sourceRoot });
  const sourceGitRoot = join(project.path, "..", "..");
  const raw = 'version = 1\nname = "Inherited environment"\n[setup]\nscript = "export CONTRACT_VALUE=nested"\n';
  return {
    id: `preparation-${crypto.randomUUID()}`, projectId: project.id, sourceRoot: project.path,
    worktreePath: join(path, "worktrees", crypto.randomUUID()), startingState: { type: "branch", branchName: "main" },
    draft: { id: "nested-conversation", revision: 4 },
    environment: { configPath: join(sourceGitRoot, ".codex", "environments", "inherited.toml"),
      revision: createHash("sha256").update(raw).digest("hex"), raw },
    directories: { sourceGitRoot, sourceWorkspaceRoot: project.path, workspaceRelativePath: "apps/web", configCwdRelativePath: "" },
  };
}

function runResult(status: "succeeded" | "failed", withDelta = false): LocalEnvironmentRunResult {
  return {
    status,
    exitCode: status === "succeeded" ? 0 : 9,
    signal: null,
    startedAt: 10,
    finishedAt: 20,
    stdout: "private lifecycle output",
    stderr: "",
    outputTruncated: false,
    environmentDelta: withDelta ? { version: 1, set: { CONTRACT_VALUE: "private" }, unset: ["OLD_CONTRACT_VALUE"] } : null,
  };
}

function transition(store: HostStore, record: LocalEnvironmentPreparation, value: Parameters<HostStore["environmentPreparations"]["transition"]>[2]): LocalEnvironmentPreparation {
  return store.environmentPreparations.transition(record.id, record.revision, value);
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const store of stores) store.close();
  stores.clear();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("HostStore local-environment persistence", () => {
  test("opens schemas 1 through 8 without changing their version and rejects newer state", () => {
    for (const schema of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const path = root();
      const seeded = new Database(join(path, "state.sqlite"), { create: true, strict: true });
      seeded.exec(`PRAGMA user_version = ${schema}`);
      seeded.close();
      const store = open(path);
      const database = inspect(path);
      expect(version(database)).toBe(schema);
      expect(database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_environment_preparations'").get()?.name)
        .toBe("local_environment_preparations");
      close(store);
    }

    const future = root();
    const database = new Database(join(future, "state.sqlite"), { create: true, strict: true });
    database.exec("PRAGMA user_version = 9");
    database.close();
    expect(() => open(future)).toThrow("Unsupported host state schema version 9");
  });

  test("raises schema 5 only when the first owned preparation commits", () => {
    const path = root();
    const store = open(path);
    const database = inspect(path);
    expect(version(database)).toBe(1);
    const input = preparation(store, path);
    expect(version(database)).toBe(1);

    expect(() => store.createEnvironmentPreparation({ ...input, projectId: "foreign-project" })).toThrow("Unknown");
    expect(version(database)).toBe(1);
    expect(store.environmentPreparations.list()).toEqual([]);

    const created = store.createEnvironmentPreparation(input);
    expect(version(database)).toBe(5);
    expect(created).toMatchObject({ hostId: store.host.id, projectId: input.projectId, phase: "validated", revision: 1 });
    close(store);

    const reopened = open(path);
    expect(version(database)).toBe(5);
    expect(reopened.environmentPreparations.get(created.id)).toEqual(created);
  });

  test("raises schema 6 atomically for the first version-2 preparation and reopens its directory context", () => {
    const path = root(), store = open(path), database = inspect(path);
    const input = nestedPreparation(store, path);
    expect(version(database)).toBe(1);
    expect(() => store.createEnvironmentPreparation({ ...input, directories: { ...input.directories!, sourceWorkspaceRoot: join(path, "wrong") } }))
      .toThrow("Source workspace root does not match");
    expect(version(database)).toBe(1);
    expect(store.environmentPreparations.list()).toEqual([]);

    const created = store.createEnvironmentPreparation(input);
    expect(version(database)).toBe(6);
    expect(created).toMatchObject({ version: 2, directories: input.directories, selectedEnvironment: input.environment });
    close(store);
    const reopened = open(path);
    expect(version(database)).toBe(6);
    expect(reopened.environmentPreparations.get(created.id)).toEqual(created);
  });

  test("startup marks an interrupted dispatched phase unknown exactly once", () => {
    const path = root();
    let store = open(path);
    let record = store.createEnvironmentPreparation(preparation(store, path, false));
    record = transition(store, record, { type: "worktree-create.started" });
    close(store);

    store = open(path);
    const recovered = store.environmentPreparations.get(record.id)!;
    expect(recovered).toMatchObject({ phase: "unknown", uncertainOperation: "worktree-create", revision: record.revision + 1 });
    close(store);

    store = open(path);
    expect(store.environmentPreparations.get(record.id)).toEqual(recovered);
  });

  test("reopens a private session environment binding without projecting it into host state", () => {
    const path = root();
    let store = open(path);
    let record = store.createEnvironmentPreparation(preparation(store, path));
    record = transition(store, record, { type: "worktree-create.started" });
    record = transition(store, record, { type: "worktree-create.succeeded", worktreePath: record.worktreePath });
    record = transition(store, record, { type: "setup.started" });
    record = transition(store, record, { type: "setup.succeeded", result: runResult("succeeded", true) });
    record = transition(store, record, { type: "native-create.started" });
    record = transition(store, record, { type: "native-create.succeeded", sessionId: "native-session" });
    close(store);

    store = open(path);
    expect(store.getSessionEnvironment("native-session")).toEqual({
      sourceRoot: record.sourceRoot,
      worktreeRoot: record.worktreePath,
      environmentDelta: { version: 1, set: { CONTRACT_VALUE: "private" }, unset: ["OLD_CONTRACT_VALUE"] },
    });
    expect(store.getSessionEnvironment("another-session")).toBeUndefined();
    expect(store.listSessions()).toEqual([]);
    expect(JSON.stringify({ host: store.host, projects: store.listProjects(), sessions: store.listSessions() })).not.toContain("CONTRACT_VALUE");
  });

  test("finishes a command and preparation phase in one rollback-safe transaction", () => {
    const path = root();
    const store = open(path);
    let record = store.createEnvironmentPreparation(preparation(store, path));
    record = transition(store, record, { type: "worktree-create.started" });
    record = transition(store, record, { type: "worktree-create.succeeded", worktreePath: record.worktreePath });
    record = transition(store, record, { type: "setup.started" });
    store.claimCommand("create-command", "request-hash");
    const result = { ok: false as const, commandId: "create-command", error: { code: "SETUP_FAILED", message: "Setup failed" } };
    const database = inspect(path);
    database.exec("CREATE TRIGGER reject_environment_command_receipt BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");

    expect(() => store.finishCommandWithEnvironmentTransition("create-command", "request-hash", result, {
      id: record.id,
      expectedRevision: record.revision,
      transition: { type: "setup.failed", result: runResult("failed") },
    })).toThrow("fixture receipt failure");
    expect(store.getCommand("create-command")?.state).toBe("pending");
    expect(store.environmentPreparations.get(record.id)).toEqual(record);

    database.exec("DROP TRIGGER reject_environment_command_receipt");
    const committed = store.finishCommandWithEnvironmentTransition("create-command", "request-hash", result, {
      id: record.id,
      expectedRevision: record.revision,
      transition: { type: "setup.failed", result: runResult("failed") },
    });
    expect(committed.command).toMatchObject({ state: "done", result });
    expect(committed.preparation).toMatchObject({ phase: "setup-failed", revision: record.revision + 1 });
    expect(store.finishCommandWithEnvironmentTransition("create-command", "request-hash", result, {
      id: record.id,
      expectedRevision: record.revision,
      transition: { type: "setup.failed", result: runResult("failed") },
    })).toEqual(committed);
    expect(store.environmentPreparations.get(record.id)?.revision).toBe(record.revision + 1);
  });

  test("native session binding and successful receipt commit together; failed cleanup retains private exports", () => {
    const path = root(), store = open(path);
    let record = store.createEnvironmentPreparation(preparation(store, path));
    record = transition(store, record, { type: 'worktree-create.started' });
    record = transition(store, record, { type: 'worktree-create.succeeded', worktreePath: record.worktreePath });
    record = transition(store, record, { type: 'setup.started' });
    record = transition(store, record, { type: 'setup.succeeded', result: runResult('succeeded', true) });
    record = transition(store, record, { type: 'native-create.started' });
    const session = { id: 'native', hostId: store.host.id, projectId: record.projectId, cwd: record.worktreePath,
      title: 'Fixture', status: 'idle' as const, model: null, sessionFile: join(path, 'native.jsonl'), createdAt: 1, updatedAt: 1, archived: false };
    const target = { id: record.id, expectedRevision: record.revision };
    store.claimCommand('admit-native', 'hash');
    expect(() => store.finishEnvironmentSessionCreation('admit-native', 'wrong', session, target)).toThrow('identity');
    expect(() => store.finishEnvironmentSessionCreation('admit-native', 'hash', { ...session, cwd: record.sourceRoot }, target)).toThrow('captured');
    const db = inspect(path);
    db.exec("CREATE TRIGGER reject_binding_receipt BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'binding receipt failure'); END");
    expect(() => store.finishEnvironmentSessionCreation('admit-native', 'hash', session, target)).toThrow('binding receipt failure');
    expect(store.listSessions()).toHaveLength(0);
    expect(store.environmentPreparations.get(record.id)).toEqual(record);
    expect(store.getCommand('admit-native')?.state).toBe('pending');
    db.exec('DROP TRIGGER reject_binding_receipt');
    const result = store.finishEnvironmentSessionCreation('admit-native', 'hash', session, target);
    expect(result).toMatchObject({ ok: true, value: session });
    expect(store.finishEnvironmentSessionCreation('admit-native', 'hash', { ...session, title: 'must not overwrite' }, target)).toEqual(result);
    expect(store.getSession('native')?.title).toBe('Fixture');
    const originalExports = store.getSessionEnvironment('native');
    record = store.environmentPreparations.get(record.id)!;
    record = transition(store, record, { type: 'cleanup.started' });
    transition(store, record, { type: 'cleanup.failed', result: runResult('failed') });
    expect(store.getSessionEnvironment('native')).toEqual(originalExports);
    expect(originalExports?.environmentDelta?.set).toEqual({ CONTRACT_VALUE: 'private' });
  });

  test("version-2 session and private environment bind to the mapped nested workspace", () => {
    const path = root(), store = open(path);
    const input = nestedPreparation(store, path);
    let record = store.createEnvironmentPreparation(input);
    record = transition(store, record, { type: "worktree-create.started" });
    const materialized = { ...input.environment!, configPath: join(record.worktreePath, ".codex", "environments", "inherited.toml") };
    record = transition(store, record, { type: "worktree-create.succeeded", worktreePath: record.worktreePath, materializedEnvironment: materialized });
    record = transition(store, record, { type: "setup.started" });
    record = transition(store, record, { type: "setup.succeeded", result: runResult("succeeded", true) });
    record = transition(store, record, { type: "native-create.started" });
    const nestedCwd = join(record.worktreePath, "apps", "web");
    const session = { id: "nested-native", hostId: store.host.id, projectId: record.projectId, cwd: nestedCwd,
      title: "Nested", status: "idle" as const, model: null, sessionFile: join(path, "nested.jsonl"), createdAt: 1, updatedAt: 1, archived: false };
    const target = { id: record.id, expectedRevision: record.revision };
    store.claimCommand("nested-admit", "nested-hash");
    expect(() => store.finishEnvironmentSessionCreation("nested-admit", "nested-hash", { ...session, cwd: record.worktreePath }, target)).toThrow("captured");
    expect(store.finishEnvironmentSessionCreation("nested-admit", "nested-hash", session, target)).toMatchObject({ ok: true, value: session });
    expect(store.getSessionEnvironment(session.id)).toEqual({ sourceRoot: input.sourceRoot, worktreeRoot: nestedCwd,
      environmentDelta: { version: 1, set: { CONTRACT_VALUE: "private" }, unset: ["OLD_CONTRACT_VALUE"] } });
  });
});
