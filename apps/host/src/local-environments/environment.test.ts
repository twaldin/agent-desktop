import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "../omp-workers/runtime";
import { localEnvironmentForWorker, type LocalEnvironmentWorkerEnvironment } from "./environment";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Worker environment cleanup failed");
});

describe("localEnvironmentForWorker", () => {
  test("applies an isolated bounded delta while retaining protected ownership", () => {
    const base = {
      HOME: "/users/owner",
      CODEX_HOME: "/profiles/codex",
      PI_CODING_AGENT_DIR: "/profiles/omp",
      AGENT_DESKTOP_PROFILE_DIR: "/profiles/desktop",
      KEEP: "base",
      REMOVE: "base",
    };
    const input: LocalEnvironmentWorkerEnvironment = {
      sourceRoot: "/projects/source",
      worktreeRoot: "/projects/worktree",
      environmentDelta: {
        version: 1,
        set: {
          HOME: "/untrusted/home",
          CODEX_HOME: "/untrusted/codex",
          PI_CODING_AGENT_DIR: "/untrusted/omp",
          AGENT_DESKTOP_PROFILE_DIR: "/untrusted/profile",
          CODEX_SOURCE_TREE_PATH: "/untrusted/source",
          AGENT_WORKTREE_PATH: "/untrusted/worktree",
          KEEP: "changed",
          ADDED: "value",
        },
        unset: ["REMOVE"],
      },
    };
    const environment = localEnvironmentForWorker(base, input);

    expect(environment).toMatchObject({
      HOME: base.HOME,
      CODEX_HOME: base.CODEX_HOME,
      PI_CODING_AGENT_DIR: base.PI_CODING_AGENT_DIR,
      AGENT_DESKTOP_PROFILE_DIR: base.AGENT_DESKTOP_PROFILE_DIR,
      KEEP: "changed",
      ADDED: "value",
      CODEX_SOURCE_TREE_PATH: input.sourceRoot,
      AGENT_SOURCE_TREE_PATH: input.sourceRoot,
      CODEX_WORKTREE_PATH: input.worktreeRoot,
      AGENT_WORKTREE_PATH: input.worktreeRoot,
    });
    expect(environment.REMOVE).toBeUndefined();
    expect(base).toEqual({ HOME: "/users/owner", CODEX_HOME: "/profiles/codex", PI_CODING_AGENT_DIR: "/profiles/omp", AGENT_DESKTOP_PROFILE_DIR: "/profiles/desktop", KEEP: "base", REMOVE: "base" });
    expect(input.environmentDelta?.set.KEEP).toBe("changed");
  });

  test("rejects malformed, overlapping, oversized, and non-owned inputs", () => {
    const owned = { sourceRoot: "/source", worktreeRoot: "/worktree" };
    expect(() => localEnvironmentForWorker({}, { ...owned, environmentDelta: { version: 1, set: { "BAD=KEY": "value" }, unset: [] } })).toThrow("Invalid");
    expect(() => localEnvironmentForWorker({}, { ...owned, environmentDelta: { version: 1, set: { SAME: "value" }, unset: ["SAME"] } })).toThrow("duplicate");
    expect(() => localEnvironmentForWorker({}, { ...owned, environmentDelta: { version: 1, set: { LARGE: "x".repeat(4 * 1024 * 1024 + 1) }, unset: [] } })).toThrow("4 MiB");
    expect(() => localEnvironmentForWorker({}, { sourceRoot: "relative", worktreeRoot: "/worktree", environmentDelta: null })).toThrow("absolute path");
  });
});

describe("WorkerRuntime local environment", () => {
  test("applies it only to the selected create and reopen workers, never discovery or another session", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-worker-environment-")));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const agentDir = path.join(directory, "agent");
    const sourceRoot = path.join(directory, "source");
    const worktreeRoot = path.join(directory, "worktree");
    const profileDir = path.join(directory, "profile");
    await Promise.all([mkdir(agentDir), mkdir(sourceRoot), mkdir(worktreeRoot), mkdir(profileDir)]);
    await writeFile(path.join(agentDir, "config.yml"), "extensions: []\n");

    const observations = path.join(directory, "worker-environments.jsonl");
    const productionFixture = fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url));
    const workerPath = path.join(directory, "observed-worker.ts");
    const observedKeys = [
      "SESSION_ONLY", "REMOVE_FROM_SESSION", "HOME", "CODEX_HOME", "PI_CODING_AGENT_DIR", "AGENT_DESKTOP_PROFILE_DIR",
      "CODEX_SOURCE_TREE_PATH", "AGENT_SOURCE_TREE_PATH", "CODEX_WORKTREE_PATH", "AGENT_WORKTREE_PATH",
    ];
    await writeFile(workerPath, `import { appendFileSync } from "node:fs";
const keys = ${JSON.stringify(observedKeys)};
appendFileSync(${JSON.stringify(observations)}, JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]))) + "\\n");
await import(${JSON.stringify(productionFixture)});
`);

    const runtime = new WorkerRuntime({
      agentDir,
      workerPath,
      environment: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TMPDIR: tmpdir(),
        TERM: "dumb",
        PI_CODING_AGENT_DIR: agentDir,
        AGENT_DESKTOP_PROFILE_DIR: profileDir,
        REMOVE_FROM_SESSION: "base-value",
      },
      startupTimeoutMs: 30_000,
    });
    cleanups.push(() => runtime.dispose());
    const localEnvironment: LocalEnvironmentWorkerEnvironment = {
      sourceRoot,
      worktreeRoot,
      environmentDelta: {
        version: 1,
        set: {
          SESSION_ONLY: "isolated-value",
          HOME: "/must-not-replace-home",
          CODEX_HOME: "/must-not-create-codex-home",
          PI_CODING_AGENT_DIR: "/must-not-replace-agent",
          AGENT_DESKTOP_PROFILE_DIR: "/must-not-replace-profile",
          CODEX_SOURCE_TREE_PATH: "/must-not-replace-source",
        },
        unset: ["REMOVE_FROM_SESSION"],
      },
    };
    const daemonBefore = Object.fromEntries(observedKeys.map(key => [key, process.env[key]]));

    const created = await runtime.create({ cwd: worktreeRoot }, localEnvironment);
    const sessionFile = created.sessionFile;
    await created.dispose();
    const reopened = await runtime.open({ sessionFile }, localEnvironment);
    const ordinary = await runtime.create({ cwd: worktreeRoot });
    await runtime.listModels(worktreeRoot);

    const records = (await readFile(observations, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, string | null>);
    expect(records).toHaveLength(4);
    for (const record of records.slice(0, 2)) {
      expect(record).toMatchObject({
        SESSION_ONLY: "isolated-value",
        REMOVE_FROM_SESSION: null,
        HOME: process.env.HOME ?? null,
        CODEX_HOME: null,
        PI_CODING_AGENT_DIR: agentDir,
        AGENT_DESKTOP_PROFILE_DIR: profileDir,
        CODEX_SOURCE_TREE_PATH: sourceRoot,
        AGENT_SOURCE_TREE_PATH: sourceRoot,
        CODEX_WORKTREE_PATH: worktreeRoot,
        AGENT_WORKTREE_PATH: worktreeRoot,
      });
    }
    for (const record of records.slice(2)) {
      expect(record.SESSION_ONLY).toBeNull();
      expect(record.REMOVE_FROM_SESSION).toBe("base-value");
      expect(record.CODEX_SOURCE_TREE_PATH).toBeNull();
      expect(record.AGENT_WORKTREE_PATH).toBeNull();
    }
    expect(Object.fromEntries(observedKeys.map(key => [key, process.env[key]]))).toEqual(daemonBefore);
    expect(reopened.id).toBe(created.id);
    expect(ordinary.id).not.toBe(created.id);
  }, 60_000);
});
