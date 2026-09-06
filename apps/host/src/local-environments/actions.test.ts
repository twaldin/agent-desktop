import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { serializeLocalEnvironment } from "@agent-desktop/shared";
import { HostStore } from "../store";
import { TmuxTerminalManager } from "../terminals/native-manager";
import { LocalEnvironmentActions } from "./actions";
import type { LocalEnvironmentPreparation } from "./preparations";

const roots: string[] = [];
const stores: HostStore[] = [];
const managers: TmuxTerminalManager[] = [];
const bundle = process.env.AGENT_TEST_TMUX_BUNDLE;
afterEach(async () => { await Promise.allSettled(managers.splice(0).map(manager => manager.shutdown())); for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 8000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await Bun.sleep(20); } }
const revision = (raw: string) => createHash("sha256").update(raw).digest("hex");
const advance = (store: HostStore, record: LocalEnvironmentPreparation, value: Parameters<HostStore["environmentPreparations"]["transition"]>[2]) =>
  store.environmentPreparations.transition(record.id, record.revision, value);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-actions-")); roots.push(root);
  const project = join(root, "project"); await mkdir(join(project, ".agent-desktop", "environments"), { recursive: true });
  await writeFile(join(project, ".agent-desktop", "environments", "environment.toml"), 'version = 1\nname = "Default"\n[setup]\nscript = "true"\n[[actions]]\nname = "Build"\ncommand = "printf build"\nicon = "run"\n');
  const store = new HostStore(join(root, "state")); stores.push(store); const record = store.addProject({ path: project });
  return { root, project, store, record, service: new LocalEnvironmentActions(store, () => undefined) };
}

describe("LocalEnvironmentActions", () => {
  test("catalogs the default config and preserves unavailable native state", async () => {
    const { service, record } = await fixture();
    await expect(service.catalog({ projectId: record.id })).resolves.toMatchObject({
      selectionRevision: 0, selectedConfigPath: join(record.path, ".agent-desktop/environments/environment.toml"),
      configRevision: expect.any(String), actions: [{ index: 0, name: "Build", icon: "run" }], available: false,
    });
  });

  test("selects native configs through project aliases without following storage symlinks", async () => {
    const { service, record, root, project } = await fixture();
    const directory = join(project, ".codex", "environments"); await mkdir(directory, { recursive: true });
    const path = join(directory, "native.toml");
    await writeFile(path, 'name="Native"\n[setup]\nscript=""\n[[actions]]\nname="Native action"\ncommand="printf native"\n');
    const alias = join(root, "alias"); await symlink(project, alias);
    const target = { projectId: record.id };
    const selected = await service.select(target, join(alias, ".codex", "environments", "native.toml"), 0);
    expect(selected).toMatchObject({ selectedConfigPath: await realpath(path), actions: [{ index: 0, name: "Native action" }] });
    await expect(service.run(target, { configPath: selected.selectedConfigPath!, configRevision: selected.configRevision!, selectionRevision: selected.selectionRevision, actionIndex: 0 }))
      .rejects.toMatchObject({ code: "NATIVE_TERMINAL_UNAVAILABLE" });
    await rm(directory, { recursive: true });
    await symlink(join(project, ".agent-desktop", "environments"), directory);
    await expect(service.select(target, join(directory, "environment.toml"), 1)).rejects.toMatchObject({ code: "INVALID_ENVIRONMENT_ACTION" });
  });

  test("uses CAS for selection and rejects stale action requests", async () => {
    const { service, record } = await fixture(); const target = { projectId: record.id };
    const state = await service.catalog(target);
    const selected = await service.select(target, state.selectedConfigPath, state.selectionRevision);
    await expect(service.select(target, null, state.selectionRevision)).rejects.toThrow("changed");
    await expect(service.run(target, { configPath: selected.selectedConfigPath!, configRevision: selected.configRevision!, selectionRevision: state.selectionRevision, actionIndex: 0 })).rejects.toMatchObject({ code: "STALE_ENVIRONMENT_SELECTION" });
  });

  test("does not fall back from a missing session target", async () => {
    const { service } = await fixture();
    await expect(service.catalog({ sessionId: crypto.randomUUID() })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  test("keeps a selected config visible as an error when it is deleted", async () => {
    const { service, record, project } = await fixture(); const target = { projectId: record.id };
    const initial = await service.catalog(target); await service.select(target, initial.selectedConfigPath, 0);
    await rm(initial.selectedConfigPath!, { force: true });
    await expect(service.catalog(target)).resolves.toMatchObject({
      selectedConfigPath: initial.selectedConfigPath,
      environments: [{ configPath: initial.selectedConfigPath, error: expect.any(String) }],
    });
    expect(project).toContain("project");
  });

  test("retains broken configs without exposing executable actions", async () => {
    const { service, record, project } = await fixture();
    const broken = join(project, ".agent-desktop/environments/broken.toml"); await writeFile(broken, "name = [broken");
    const state = await service.catalog({ projectId: record.id });
    await service.select({ projectId: record.id }, broken, state.selectionRevision);
    const canonicalBroken = await realpath(broken);
    const refreshed = await service.catalog({ projectId: record.id });
    expect(refreshed.selectedConfigPath).toBe(canonicalBroken); expect(refreshed.actions).toEqual([]);
    const brokenItem = refreshed.environments.find(item => item.configPath === canonicalBroken);
    expect(brokenItem?.error).toEqual(expect.any(String));
  });

  test("filters platform actions while preserving original indices", async () => {
    const { service, record, project } = await fixture();
    const path = join(project, ".agent-desktop/environments/environment.toml");
    const opposite = process.platform === "darwin" ? "linux" : "darwin";
    await writeFile(path, `version = 1\nname = "Platforms"\n[setup]\nscript = "true"\n[[actions]]\nname = "Other platform"\ncommand = "false"\nplatform = "${opposite}"\n[[actions]]\nname = "Current platform"\ncommand = "true"\n`);
    const state = await service.catalog({ projectId: record.id });
    expect(state.actions).toEqual([{ index: 1, name: "Current platform", icon: null }]);
  });

  test("persists explicit no-environment selection across store reopen", async () => {
    const { service, record, root, store } = await fixture(); const target = { projectId: record.id };
    const state = await service.catalog(target); await service.select(target, null, state.selectionRevision); store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new HostStore(join(root, "state")); stores.push(reopened);
    await expect(new LocalEnvironmentActions(reopened, () => undefined).catalog(target)).resolves.toMatchObject({ selectionRevision: 1, selectedConfigPath: null, actions: [] });
  });

  test("resolves a session through its owning project", async () => {
    const { service, record, store } = await fixture();
    const session = store.upsertSession({ id: crypto.randomUUID(), hostId: store.host.id, projectId: record.id, cwd: record.path, title: "session", status: "idle", sessionFile: join(record.path, "session.jsonl"), model: null, createdAt: Date.now(), updatedAt: Date.now(), archived: false });
    await expect(service.catalog({ sessionId: session.id })).resolves.toMatchObject({ available: false, selectedConfigPath: expect.any(String) });
  });
  test("projectless sessions resolve their own folder and symlink configs remain errors", async () => {
    const { service, record, store } = await fixture();
    const session = store.upsertSession({ id: crypto.randomUUID(), hostId: store.host.id, projectId: null, cwd: record.path, title: "projectless", status: "idle", sessionFile: join(record.path, "session.jsonl"), model: null, createdAt: Date.now(), updatedAt: Date.now(), archived: false });
    const target = { sessionId: session.id }, state = await service.catalog(target);
    expect(state.actions).toHaveLength(1);
    const link = join(record.path, ".agent-desktop/environments/linked.toml");
    await symlink(state.selectedConfigPath!, link);
    const linked = await service.select(target, link, 0);
    expect(linked.actions).toEqual([]);
    expect(linked.environments.find(item => item.configPath === linked.selectedConfigPath)?.error).toContain("symlink");
    await service.select(target, null, 1);
    await expect(service.run(target, { configPath: state.selectedConfigPath!, configRevision: state.configRevision!, selectionRevision: 2, actionIndex: 0 })).rejects.toMatchObject({ code: "STALE_ENVIRONMENT_SELECTION" });
  });

  test.skipIf(!bundle)("runs mapped and source-fallback actions in their actual nested Git owners with nested session exports", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agent-nested-actions-"))); roots.push(root);
    const source = join(root, "source"), projectPath = join(source, "apps", "web"), managed = join(root, "managed");
    await mkdir(projectPath, { recursive: true });
    git(source, "init", "-b", "main"); git(source, "config", "user.name", "Nested actions fixture"); git(source, "config", "user.email", "fixture@example.invalid");
    const observed = (name: string) => `printf '%s\\n%s\\n%s\\n%s\\n' "$PWD" "$CODEX_WORKTREE_PATH" "$AGENT_WORKTREE_PATH" "$CODEX_SOURCE_TREE_PATH" > ${name}`;
    const rootRaw = serializeLocalEnvironment({ version: 1, name: "Root action", setup: { script: "true" }, actions: [{ name: "Root", icon: "run", command: observed("root-observed") }] });
    const rootConfig = join(source, ".codex", "environments", "environment.toml"); await mkdir(dirname(rootConfig), { recursive: true }); await writeFile(rootConfig, rootRaw);
    await writeFile(join(projectPath, "README.md"), "nested\n"); git(source, "add", "."); git(source, "commit", "-m", "Base");
    git(source, "worktree", "add", "--detach", managed, "HEAD");
    const managedProject = join(managed, "apps", "web"), managedRootConfig = join(managed, ".codex", "environments", "environment.toml");
    const state = new HostStore(join(root, "state")); stores.push(state); const project = state.addProject({ path: projectPath });
    let prep = state.createEnvironmentPreparation({ id: crypto.randomUUID(), projectId: project.id, sourceRoot: project.path, worktreePath: managed,
      startingState: { type: "branch", branchName: "main" }, draft: { id: "nested-draft", revision: 1 },
      environment: { configPath: rootConfig, revision: revision(rootRaw), raw: rootRaw },
      directories: { sourceGitRoot: source, sourceWorkspaceRoot: project.path, workspaceRelativePath: "apps/web", configCwdRelativePath: "" } });
    prep = advance(state, prep, { type: "worktree-create.started" });
    prep = advance(state, prep, { type: "worktree-create.succeeded", worktreePath: managed,
      materializedEnvironment: { configPath: managedRootConfig, revision: revision(rootRaw), raw: rootRaw } });
    prep = advance(state, prep, { type: "setup.started" });
    prep = advance(state, prep, { type: "setup.succeeded", result: { status: "succeeded", exitCode: 0, signal: null, startedAt: 1, finishedAt: 2,
      stdout: "", stderr: "", outputTruncated: false, environmentDelta: { version: 1, set: { ACTION_SCOPE: "nested" }, unset: [] } } });
    prep = advance(state, prep, { type: "native-create.started" });
    const sessionId = crypto.randomUUID();
    prep = advance(state, prep, { type: "native-create.succeeded", sessionId });
    state.upsertSession({ id: sessionId, hostId: state.host.id, projectId: project.id, cwd: managedProject, title: "Nested", status: "idle",
      sessionFile: join(root, "session.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false });
    const manager = await TmuxTerminalManager.open({ dataDirectory: join(root, "terminals"), hostId: state.host.id, bundleDirectory: resolve(bundle!),
      shell: { application: "/bin/bash", args: ["--noprofile", "--norc", "-i"] }, pollIntervalMs: 100 }); managers.push(manager);
    const reservations: string[] = [];
    const service = new LocalEnvironmentActions(state, () => manager, cwd => { reservations.push(cwd); return () => {}; }), target = { sessionId };

    const initial = await service.catalog(target);
    expect(initial).toMatchObject({ selectedConfigPath: managedRootConfig, actions: [{ index: 0, name: "Root" }] });
    const rootTerminal = await service.run(target, { configPath: initial.selectedConfigPath!, configRevision: initial.configRevision!, selectionRevision: 0, actionIndex: 0 });
    await until(() => existsSync(join(managed, "root-observed")), "root action output");
    expect(rootTerminal.cwd).toBe(managed);
    expect(readFileSync(join(managed, "root-observed"), "utf8").trimEnd().split("\n")).toEqual([managed, managedProject, managedProject, project.path]);

    const nestedRaw = serializeLocalEnvironment({ version: 1, name: "Nested action", setup: { script: "true" }, actions: [{ name: "Nested", icon: "test", command: observed("nested-observed") }] });
    const nestedConfig = join(managedProject, ".agent-desktop", "environments", "nested.toml"); await mkdir(dirname(nestedConfig), { recursive: true }); await writeFile(nestedConfig, nestedRaw);
    const selected = await service.select(target, nestedConfig, 0);
    const nestedTerminal = await service.run(target, { configPath: selected.selectedConfigPath!, configRevision: selected.configRevision!, selectionRevision: 1, actionIndex: 0 });
    await until(() => existsSync(join(managedProject, "nested-observed")), "nested action output");
    expect(nestedTerminal.cwd).toBe(managedProject); expect(nestedTerminal.id).not.toBe(rootTerminal.id);
    expect(readFileSync(join(managedProject, "nested-observed"), "utf8").trimEnd().split("\n")).toEqual([managedProject, managedProject, managedProject, project.path]);
    const rootKey = createHash("sha256").update(JSON.stringify([state.host.id, `sessionId:${sessionId}`, managed, managedRootConfig, "0"])).digest("hex");
    const nestedKey = createHash("sha256").update(JSON.stringify([state.host.id, `sessionId:${sessionId}`, managedProject, nestedConfig, "0"])).digest("hex");
    expect(manager.getAction(rootKey)?.id).toBe(rootTerminal.id); expect(manager.getAction(nestedKey)?.id).toBe(nestedTerminal.id);
    expect(reservations).toEqual([managed, managed]);

    // An exact retained source config remains selectable, but its action cwd is translated into the managed checkout.
    const fallbackRaw = serializeLocalEnvironment({ version: 1, name: "Fallback", setup: { script: "true" }, actions: [{ name: "Fallback", icon: null, command: observed("fallback-observed") }] });
    const fallbackConfig = join(source, ".agent-desktop", "environments", "fallback.toml"); await mkdir(dirname(fallbackConfig), { recursive: true }); await writeFile(fallbackConfig, fallbackRaw);
    let fallback = state.createEnvironmentPreparation({ id: crypto.randomUUID(), projectId: project.id, sourceRoot: project.path, worktreePath: join(root, "managed-fallback"),
      startingState: { type: "branch", branchName: "main" }, draft: { id: "fallback-draft", revision: 1 },
      environment: { configPath: fallbackConfig, revision: revision(fallbackRaw), raw: fallbackRaw },
      directories: { sourceGitRoot: source, sourceWorkspaceRoot: project.path, workspaceRelativePath: "apps/web", configCwdRelativePath: "" } });
    git(source, "worktree", "add", "--detach", fallback.worktreePath, "HEAD");
    fallback = advance(state, fallback, { type: "worktree-create.started" });
    fallback = advance(state, fallback, { type: "worktree-create.succeeded", worktreePath: fallback.worktreePath, materializedEnvironment: fallback.environment });
    fallback = advance(state, fallback, { type: "setup.started" });
    fallback = advance(state, fallback, { type: "setup.succeeded", result: { status: "succeeded", exitCode: 0, signal: null, startedAt: 1, finishedAt: 2,
      stdout: "", stderr: "", outputTruncated: false, environmentDelta: null } });
    fallback = advance(state, fallback, { type: "native-create.started" });
    const fallbackSessionId = crypto.randomUUID(); fallback = advance(state, fallback, { type: "native-create.succeeded", sessionId: fallbackSessionId });
    const fallbackProject = join(fallback.worktreePath, "apps", "web");
    state.upsertSession({ id: fallbackSessionId, hostId: state.host.id, projectId: project.id, cwd: fallbackProject, title: "Fallback", status: "idle",
      sessionFile: join(root, "fallback.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false });
    const fallbackState = await service.catalog({ sessionId: fallbackSessionId });
    expect(fallbackState).toMatchObject({ selectedConfigPath: fallbackConfig, actions: [{ index: 0, name: "Fallback" }] });
    const fallbackTerminal = await service.run({ sessionId: fallbackSessionId }, { configPath: fallbackConfig,
      configRevision: fallbackState.configRevision!, selectionRevision: 0, actionIndex: 0 });
    await until(() => existsSync(join(fallback.worktreePath, "fallback-observed")), "source fallback action output");
    expect(fallbackTerminal.cwd).toBe(fallback.worktreePath);
    expect(readFileSync(join(fallback.worktreePath, "fallback-observed"), "utf8").trimEnd().split("\n"))
      .toEqual([fallback.worktreePath, fallbackProject, fallbackProject, project.path]);
    expect(reservations).toEqual([managed, managed, fallback.worktreePath]);

    git(source, "worktree", "lock", managed);
    await expect(service.catalog(target)).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    git(source, "worktree", "unlock", managed);

    const unrelated = join(root, "unrelated"), unrelatedProject = join(unrelated, "apps", "web");
    await mkdir(unrelatedProject, { recursive: true }); git(unrelated, "init", "-b", "main");
    git(unrelated, "config", "user.name", "Unrelated fixture"); git(unrelated, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(unrelatedProject, "README.md"), "unrelated\n"); git(unrelated, "add", "."); git(unrelated, "commit", "-m", "Base");
    let foreign = state.createEnvironmentPreparation({ id: crypto.randomUUID(), projectId: project.id, sourceRoot: project.path, worktreePath: unrelated,
      startingState: { type: "branch", branchName: "main" }, draft: { id: "foreign-draft", revision: 1 },
      environment: { configPath: fallbackConfig, revision: revision(fallbackRaw), raw: fallbackRaw },
      directories: { sourceGitRoot: source, sourceWorkspaceRoot: project.path, workspaceRelativePath: "apps/web", configCwdRelativePath: "" } });
    foreign = advance(state, foreign, { type: "worktree-create.started" });
    foreign = advance(state, foreign, { type: "worktree-create.succeeded", worktreePath: unrelated, materializedEnvironment: foreign.environment });
    foreign = advance(state, foreign, { type: "setup.started" });
    foreign = advance(state, foreign, { type: "setup.succeeded", result: { status: "succeeded", exitCode: 0, signal: null, startedAt: 1, finishedAt: 2,
      stdout: "", stderr: "", outputTruncated: false, environmentDelta: null } });
    foreign = advance(state, foreign, { type: "native-create.started" });
    const foreignSessionId = crypto.randomUUID(); advance(state, foreign, { type: "native-create.succeeded", sessionId: foreignSessionId });
    state.upsertSession({ id: foreignSessionId, hostId: state.host.id, projectId: project.id, cwd: unrelatedProject, title: "Foreign", status: "idle",
      sessionFile: join(root, "foreign.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false });
    await expect(service.catalog({ sessionId: foreignSessionId })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  }, 30_000);

});
