import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  serializeLocalEnvironment,
  type CommandEnvelope,
  type HostCommand,
} from "@agent-desktop/shared";
import { EnvironmentSessions } from "./environment-sessions";
import { LocalEnvironmentStore } from "./local-environments";
import { WorkerRuntime, type WorkerSession } from "./omp-workers/runtime";
import { HostStore } from "./store";
import { HostWorkspaces } from "./workspace-http";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const hash = (command: HostCommand) =>
  createHash("sha256").update(JSON.stringify(command)).digest("hex");

async function fixture(setupScript: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-environment-session-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const data = join(root, "data");
  const agent = join(root, "agent");
  await Promise.all([mkdir(source), mkdir(agent)]);
  const git = (...args: string[]) =>
    exec("git", ["--no-optional-locks", "-C", source, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Environment fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(source, "README.md"), "source content\n");
  await git("add", "README.md");
  await git("commit", "-m", "Initial fixture");

  const store = new HostStore(data);
  cleanups.push(() => store.close());
  const project = store.addProject({ path: source, name: "Environment fixture" });
  const saved = await new LocalEnvironmentStore(source).save({
    expectedRevision: null,
    raw: serializeLocalEnvironment({
      version: 1,
      name: "Fixture",
      setup: { script: setupScript },
      cleanup: { script: "" },
    }),
  });
  if (saved.type !== "saved") throw new Error("Could not save fixture environment");
  const environment = {
    projectId: project.id,
    configPath: saved.configPath,
    revision: saved.revision,
  };
  const execution = {
    type: "worktree" as const,
    startingState: { type: "branch" as const, branchName: "main" },
  };
  const draftWrite = store.putDraft(
    {
      id: "new-conversation",
      projectId: project.id,
      text: "Prompt remains durable until admission",
      model: null,
      execution,
      environment,
      attachments: [],
    },
    0,
  );
  if (!draftWrite.ok) throw new Error("Could not save fixture draft");
  const command: Extract<HostCommand, { type: "session.create" }> = {
    type: "session.create",
    projectId: project.id,
    worktree: execution.startingState,
    environment,
    draft: { id: draftWrite.draft.id, revision: draftWrite.draft.revision },
  };
  const envelope: CommandEnvelope & { command: typeof command } = {
    id: crypto.randomUUID(),
    commandVersion: 5,
    command,
  };
  store.claimCommand(envelope.id, hash(command), command);

  const runtime = new WorkerRuntime({
    agentDir: agent,
    workerPath: fileURLToPath(
      new URL("./omp-workers/fixtures/no-provider-worker.ts", import.meta.url),
    ),
    environment: {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      TERM: "dumb",
      PI_CODING_AGENT_DIR: agent,
    },
    startupTimeoutMs: 15_000,
    shutdownTimeoutMs: 1_000,
  });
  cleanups.push(() => runtime.dispose());
  const handles: WorkerSession[] = [];
  const reserved = new Set<string>();
  let changed = 0;
  const workspaces = new HostWorkspaces(store, data, () => () => {});
  const sessions = new EnvironmentSessions({
    store,
    workspaces,
    runtime,
    reserve: (path) => {
      if (reserved.has(path)) throw new Error("Workspace already reserved");
      reserved.add(path);
      return () => reserved.delete(path);
    },
    onEvent: () => {},
    onHandle: (handle) => handles.push(handle),
    changed: () => { changed++; },
  });
  return { root, source, data, saved, store, project, command, envelope, runtime, handles, reserved, sessions, changed: () => changed };
}

test("real Git, setup exports, native creation, and receipt commit keep exact ownership", async () => {
  const f = await fixture('printf "setup\\n" >> setup-count\nexport SESSION_FIXTURE_VALUE=private-value');
  const sourceIndex = await readFile(join(f.source, ".git", "index"));
  const result = await f.sessions.create(f.envelope);
  expect(result).toMatchObject({ ok: true, commandId: f.envelope.id, value: {
    hostId: f.store.host.id,
    projectId: f.project.id,
    status: "idle",
  } });
  if (!result.ok || !result.value || !("sessionFile" in result.value)) throw new Error("Native session missing");
  const preparation = f.store.environmentPreparations.get(f.envelope.id)!;
  expect(preparation).toMatchObject({ phase: "session-created", sessionId: result.value.id });
  expect(f.store.getSessionEnvironment(result.value.id)).toMatchObject({
    sourceRoot: f.source,
    worktreeRoot: preparation.worktreePath,
    environmentDelta: { set: { SESSION_FIXTURE_VALUE: "private-value" } },
  });
  expect(JSON.stringify(f.store.environmentPreparations.public(preparation))).not.toContain("private-value");
  expect(await readFile(join(preparation.worktreePath, "setup-count"), "utf8")).toBe("setup\n");
  expect(await readFile(join(f.source, ".git", "index"))).toEqual(sourceIndex);
  expect(await readFile(join(f.source, "README.md"), "utf8")).toBe("source content\n");
  expect(f.handles).toHaveLength(1);
  expect(f.reserved.size).toBe(0);
  expect(f.store.getDraft("new-conversation")?.text).toBe("Prompt remains durable until admission");
  expect(f.changed()).toBeGreaterThan(1);
  await f.handles[0]!.dispose();
}, 30_000);

test("failed setup preserves one worktree and only an exact explicit resume reaches native creation", async () => {
  const f = await fixture('printf "attempt\\n" >> setup-count\n[ -f allow-setup ]');
  const failedResult = await f.sessions.create(f.envelope);
  expect(failedResult).toMatchObject({ ok: true, value: {
    type: "environment.preparation",
    preparation: { phase: "setup-failed", needsAttention: true },
  } });
  const failed = f.store.environmentPreparations.get(f.envelope.id)!;
  expect(await readFile(join(failed.worktreePath, "setup-count"), "utf8")).toBe("attempt\n");
  expect(f.handles).toHaveLength(0);
  expect(f.store.listSessions()).toHaveLength(0);
  expect(f.store.getDraft("new-conversation")?.text).toBe("Prompt remains durable until admission");

  const staleCommand: Extract<HostCommand, { type: "session.environment.resume" }> = {
    type: "session.environment.resume",
    preparationId: failed.id,
    expectedRevision: failed.revision - 1,
  };
  f.store.claimCommand("stale-resume", hash(staleCommand), staleCommand);
  expect(await f.sessions.resume("stale-resume", failed.id, failed.revision - 1)).toMatchObject({
    ok: false,
    error: { code: "ENVIRONMENT_PREPARATION_CONFLICT" },
  });
  expect(await readFile(join(failed.worktreePath, "setup-count"), "utf8")).toBe("attempt\n");

  await writeFile(join(failed.worktreePath, "allow-setup"), "");
  const resumeCommand: Extract<HostCommand, { type: "session.environment.resume" }> = {
    type: "session.environment.resume",
    preparationId: failed.id,
    expectedRevision: failed.revision,
  };
  f.store.claimCommand("resume", hash(resumeCommand), resumeCommand);
  const resumed = await f.sessions.resume("resume", failed.id, failed.revision);
  expect(resumed).toMatchObject({ ok: true, value: { projectId: f.project.id, status: "idle" } });
  expect(await readFile(join(failed.worktreePath, "setup-count"), "utf8")).toBe("attempt\nattempt\n");
  expect(f.handles).toHaveLength(1);
  expect(f.store.environmentPreparations.list()).toHaveLength(1);
  expect(f.store.environmentPreparations.get(failed.id)?.phase).toBe("session-created");
  await f.handles[0]!.dispose();
}, 30_000);

test("draft mismatch is rejected before reservation, preparation, setup, or managed directory creation", async () => {
  const f = await fixture("touch setup-must-not-run");
  const changed = f.store.putDraft({
    ...f.store.getDraft("new-conversation")!,
    text: "newer unsent edit",
  }, 1);
  expect(changed.ok).toBe(true);
  await expect(f.sessions.create(f.envelope)).rejects.toThrow("captured draft revision");
  expect(f.store.environmentPreparations.list()).toHaveLength(0);
  expect(f.reserved.size).toBe(0);
  expect(await access(join(f.data, "worktrees")).then(() => true, () => false)).toBe(false);
  expect(await readFile(join(f.source, "README.md"), "utf8")).toBe("source content\n");
}, 30_000);

test("a stale captured config is rejected before acquiring a reservation or creating the managed parent", async () => {
  const f = await fixture("touch setup-must-not-run");
  const changed = await new LocalEnvironmentStore(f.source).save({
    configPath: f.saved.configPath,
    expectedRevision: f.saved.revision,
    raw: serializeLocalEnvironment({
      version: 1,
      name: "Changed externally",
      setup: { script: "exit 0" },
      cleanup: { script: "" },
    }),
  });
  expect(changed.type).toBe("saved");
  await expect(f.sessions.create(f.envelope)).rejects.toThrow("environment changed");
  expect(f.store.environmentPreparations.list()).toHaveLength(0);
  expect(f.reserved.size).toBe(0);
  expect(await access(join(f.data, "worktrees")).then(() => true, () => false)).toBe(false);
}, 30_000);

test("a lost native commit receipt disposes the uncommitted handle and becomes inspect-only", async () => {
  const f = await fixture("exit 0");
  const create = f.runtime.create.bind(f.runtime);
  let nativeCreates = 0;
  let uncommitted: WorkerSession | undefined;
  f.runtime.create = async (...args) => {
    nativeCreates++;
    uncommitted = await create(...args);
    return uncommitted;
  };
  const finish = f.store.finishEnvironmentSessionCreation.bind(f.store);
  f.store.finishEnvironmentSessionCreation = () => {
    throw new Error("Injected SQLite receipt loss");
  };
  const result = await f.sessions.create(f.envelope);
  expect(result).toMatchObject({ ok: true, value: {
    type: "environment.preparation",
    preparation: { phase: "unknown", uncertainOperation: "native-create", needsAttention: true },
  } });
  expect(nativeCreates).toBe(1);
  expect(uncommitted).toBeDefined();
  expect(f.handles).toHaveLength(0);
  expect(f.store.listSessions()).toHaveLength(0);
  expect(f.store.environmentPreparations.get(f.envelope.id)?.sessionId).toBeUndefined();

  // Re-observing the finished original command returns its durable inspection receipt.
  expect(await f.sessions.create(f.envelope)).toEqual(result);
  expect(nativeCreates).toBe(1);

  const unknown = f.store.environmentPreparations.get(f.envelope.id)!;
  const resumeCommand: Extract<HostCommand, { type: "session.environment.resume" }> = {
    type: "session.environment.resume",
    preparationId: unknown.id,
    expectedRevision: unknown.revision,
  };
  f.store.claimCommand("unknown-resume", hash(resumeCommand), resumeCommand);
  expect(await f.sessions.resume("unknown-resume", unknown.id, unknown.revision)).toMatchObject({
    ok: false,
    error: { code: "ENVIRONMENT_OUTCOME_UNKNOWN" },
  });
  expect(nativeCreates).toBe(1);
  f.store.finishEnvironmentSessionCreation = finish;
}, 30_000);
