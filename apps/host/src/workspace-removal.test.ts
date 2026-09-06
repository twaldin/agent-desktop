import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@agent-desktop/shared";
import { HostStore } from "./store";
import { HostWorkspaces } from "./workspace-http";

const roots: string[] = [];
const stores = new Set<HostStore>();
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-removal-receipt-")); roots.push(root);
  const data = join(root, "data"), source = join(root, "source"); await mkdir(source);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Removal Test"); git(source, "config", "user.email", "removal@example.invalid");
  git(source, "config", "commit.gpgSign", "false"); git(source, "config", "core.hooksPath", join(root, "no-hooks")); await mkdir(join(root, "no-hooks"));
  await writeFile(join(source, "tracked.txt"), "base\n"); git(source, "add", "tracked.txt"); git(source, "commit", "-m", "base");
  const store = new HostStore(data); stores.add(store);
  const project = store.addProject({ path: source });
  const committed: string[][] = [];
  const workspaces = new HostWorkspaces(store, data, () => () => {}, {
    before: async () => {}, committed: sessions => committed.push(sessions.map(session => session.id)),
  });
  const created = await workspaces.mutate({ projectId: project.id }, { type: "worktree.create", options: { path: "owned", newBranch: "owned" } });
  if (created.type !== "worktree.create") throw new Error("Expected worktree fixture");
  const session: SessionSummary = { id: "linked", hostId: store.host.id, projectId: project.id, cwd: created.worktree.path,
    title: "Linked", status: "idle", sessionFile: join(root, "session.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false };
  store.upsertSession(session);
  return { root, data, source, store, project, workspaces, worktree: created.worktree, committed };
}

describe("durable worktree removal receipts", () => {
  test("a post-Git metadata failure rolls back linked state and restart only observes before finalizing", async () => {
    const f = await fixture();
    let preparation = f.store.createEnvironmentPreparation({ id: "linked-preparation", projectId: f.project.id, sourceRoot: f.project.path,
      worktreePath: f.worktree.path, startingState: { type: "branch", branchName: "main" }, draft: { id: "new-chat", revision: 1 }, environment: null });
    preparation = f.store.environmentPreparations.transition(preparation.id, preparation.revision, { type: "worktree-create.started" });
    preparation = f.store.environmentPreparations.transition(preparation.id, preparation.revision, { type: "worktree-create.succeeded", worktreePath: f.worktree.path });
    preparation = f.store.environmentPreparations.transition(preparation.id, preparation.revision, { type: "cleanup.started" });
    preparation = f.store.environmentPreparations.transition(preparation.id, preparation.revision, { type: "cleanup.succeeded" });
    const commandId = "remove-once";
    f.store.claimCommand(commandId, "request-hash");
    const inspection = new Database(join(f.data, "state.sqlite"), { strict: true });
    inspection.exec(`CREATE TRIGGER fail_removal_finalize BEFORE UPDATE ON metadata
      WHEN OLD.key LIKE 'worktree-removal.v1:%' BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END`);

    await expect(f.workspaces.mutate({ projectId: f.project.id }, { type: "worktree.remove", path: f.worktree.managedRelativePath! }, commandId))
      .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(await lstat(f.worktree.path).then(() => true, () => false)).toBe(false);
    expect(f.store.getSession("linked")?.archived).toBe(false);
    expect(f.store.environmentPreparations.get(preparation.id)?.phase).toBe("cleanup-succeeded");
    expect(f.store.getCommand(commandId)?.state).toBe("pending");
    const intent = f.store.listWorktreeRemovalIntents()[0]!;
    expect(intent).toMatchObject({ commandId, projectId: f.project.id, worktreePath: f.worktree.path, state: "pending" });
    expect(inspection.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(6);
    expect(f.committed).toEqual([]);

    // Production dispatch records this uncertain response after the handler
    // returns. The intent is the only authority allowed to reconcile it.
    f.store.finishCommand(commandId, "request-hash", { ok: false, commandId,
      error: { code: "OUTCOME_UNKNOWN", message: "Git completed; host metadata did not." } });

    await expect(f.workspaces.reconcileWorktreeRemovals()).resolves.toBeUndefined();
    expect(f.store.listWorktreeRemovalIntents()).toHaveLength(1);
    expect(f.store.getSession("linked")?.archived).toBe(false);
    expect(f.store.getCommand(commandId)?.result).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });

    inspection.exec("DROP TRIGGER fail_removal_finalize"); inspection.close();
    f.store.close(); stores.delete(f.store);
    const reopened = new HostStore(f.data); stores.add(reopened);
    const notifications: string[][] = [];
    const recovering = new HostWorkspaces(reopened, f.data, () => () => {}, {
      before: async () => { throw new Error("restart must not run cleanup"); },
      committed: sessions => notifications.push(sessions.map(session => session.id)),
    });
    await recovering.reconcileWorktreeRemovals();

    expect(reopened.listWorktreeRemovalIntents()).toEqual([]);
    expect(reopened.getWorktreeRemovalIntent(f.worktree.path)?.state).toBe("finalized");
    expect(reopened.getSession("linked")?.archived).toBe(true);
    expect(reopened.environmentPreparations.get(preparation.id)?.phase).toBe("removed");
    expect(reopened.getCommand(commandId)?.result).toEqual({ ok: true, commandId, value: { type: "worktree.remove" } });
    expect(notifications).toEqual([["linked"]]);
    expect(git(f.source, "worktree", "list", "--porcelain")).not.toContain(f.worktree.path);
    await recovering.reconcileWorktreeRemovals();
    expect(notifications).toHaveLength(1);
  });

  test("an unresolved intent with an existing target is retained and blocks a new removal", async () => {
    const f = await fixture(), commandId = "never-dispatched";
    f.store.claimCommand(commandId, "request-hash");
    // Capture through the owning service without dispatching removal.
    const { WorkspaceService } = await import("./workspace/service");
    const service = new WorkspaceService(f.source, { worktreeRoot: join(f.data, "worktrees", f.project.id) });
    const snapshot = await service.snapshotWorktreeForRemoval(f.worktree.managedRelativePath!);
    f.store.createWorktreeRemovalIntent({ id: "pending-existing", commandId, projectId: f.project.id, sourceRoot: f.project.path,
      worktreePath: f.worktree.path, snapshot });
    const blocked = new HostWorkspaces(f.store, f.data, () => { throw new Error("active workspace mutation"); }, {
      before: async () => {}, committed: () => {},
    });
    await expect(blocked.reconcileWorktreeRemovals()).resolves.toBeUndefined();
    await f.workspaces.reconcileWorktreeRemovals();
    expect(f.store.listWorktreeRemovalIntents()).toHaveLength(1);
    await expect(f.workspaces.mutate({ projectId: f.project.id }, { type: "worktree.remove", path: f.worktree.managedRelativePath! }, "another"))
      .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(await Bun.file(join(f.worktree.path, "tracked.txt")).text()).toBe("base\n");
    git(f.source, "update-ref", "-d", snapshot.snapshotRef);
    await expect(f.workspaces.reconcileWorktreeRemovals()).resolves.toBeUndefined();
    expect(f.store.listWorktreeRemovalIntents()).toHaveLength(1);
    await rename(f.source, join(f.root, "source-offline"));
    await expect(f.workspaces.reconcileWorktreeRemovals()).resolves.toBeUndefined();
    expect(f.store.listWorktreeRemovalIntents()).toHaveLength(1);
    expect(f.store.getCommand(commandId)?.state).toBe("pending");
  });

  test("a generic managed worktree uses the same durable receipt without an environment preparation", async () => {
    const f = await fixture(), commandId = "generic-removal";
    f.store.claimCommand(commandId, "request-hash");
    await expect(f.workspaces.mutate({ projectId: f.project.id }, { type: "worktree.remove", path: f.worktree.managedRelativePath! }, commandId))
      .resolves.toEqual({ type: "worktree.remove" });
    expect(f.store.environmentPreparations.list()).toEqual([]);
    expect(f.store.getWorktreeRemovalIntent(f.worktree.path)?.state).toBe("finalized");
    expect(f.store.getSession("linked")?.archived).toBe(true);
    expect(f.store.getCommand(commandId)?.result).toEqual({ ok: true, commandId, value: { type: "worktree.remove" } });
    expect(f.committed).toEqual([["linked"]]);
  });
});
