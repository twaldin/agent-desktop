import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { HostWorkspaces, parseWorkspaceQuery } from "./workspace-http";
import { WorkspaceService } from "./workspace/service";
import { readGitSelectionSummary } from "../../desktop/src/renderer/git-submission-view";

const roots: string[] = [], stores: HostStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString()); return result.stdout.toString().trim();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-owner-summary-"))); roots.push(root);
  const source = join(root, "source"), nested = join(source, "app"), sessionCwd = join(root, "session"), hooks = join(root, "hooks");
  await mkdir(nested, { recursive: true }); await mkdir(hooks); git(source, "init", "-q", "--initial-branch=main");
  git(source, "config", "user.name", "Owner Summary Fixture"); git(source, "config", "user.email", "owner@example.invalid");
  git(source, "config", "core.hooksPath", hooks); git(source, "config", "commit.gpgSign", "false");
  await writeFile(join(nested, "README.md"), "base\n"); git(source, "add", "."); git(source, "commit", "-qm", "base");
  git(source, "worktree", "add", "-qb", "session-branch", sessionCwd);
  await writeFile(join(source, "note.txt"), "source one\nsource two\nsource three\n");
  await writeFile(join(sessionCwd, "note.txt"), "session one\nsession two\n");
  const data = join(root, "data"), store = new HostStore(data); stores.push(store); const project = store.addProject({ path: nested });
  const session = { id: "summary-session", hostId: store.host.id, projectId: project.id, cwd: join(sessionCwd, "app"), title: "Summary", status: "idle" as const, sessionFile: join(root, "unused.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false };
  store.upsertSession(session);
  const workspaces = new HostWorkspaces(store, data, () => { throw new Error("Summary must not reserve a mutation"); });
  const snapshot = async () => ({ sourceIndex: await readFile(join(source, ".git/index")), sessionIndex: await readFile(git(sessionCwd, "rev-parse", "--path-format=absolute", "--git-path", "index")),
    refs: git(source, "show-ref"), config: await readFile(join(source, ".git/config")), sourceNote: await readFile(join(source, "note.txt")), sessionNote: await readFile(join(sessionCwd, "note.txt")) });
  return { source, sessionCwd, store, project, session, workspaces, snapshot };
}

test("summary query follows project and session owners, covers untracked content and preserves source state", async () => {
  const f = await fixture(), before = await f.snapshot();
  for (const [target, additions] of [[{ projectId: f.project.id }, 3], [{ sessionId: f.session.id }, 2]] as const) {
    const context = await f.workspaces.query(target, { type: "git.action-context" }); if (context.type !== "git.action-context") throw new Error("Wrong context");
    const query = parseWorkspaceQuery({ type: "git.selection-summary", selectionMode: "include-unstaged", contextRevision: context.context.revision });
    const result = await f.workspaces.query(target, query);
    expect(result).toMatchObject({ type: "git.selection-summary", contextRevision: context.context.revision, summary: { reviewedRevision: context.context.status.revision, selectionMode: "include-unstaged", additions, deletions: 0, files: 1 } });
  }
  expect(await f.snapshot()).toEqual(before);
  await expect(f.workspaces.query({ filePath: join(f.source, "app/README.md") }, { type: "git.selection-summary", selectionMode: "staged", contextRevision: "a".repeat(64) })).rejects.toThrow("standalone file");
});

test("stale context and malformed selection requests are unavailable, never successful zero totals", async () => {
  const f = await fixture(), target = { projectId: f.project.id };
  const context = await f.workspaces.query(target, { type: "git.action-context" }); if (context.type !== "git.action-context") throw new Error("Wrong context");
  git(f.source, "add", "note.txt");
  await expect(f.workspaces.query(target, { type: "git.selection-summary", selectionMode: "staged", contextRevision: context.context.revision })).rejects.toMatchObject({ code: "GIT_CHANGED" });
  for (const query of [{ contextRevision: "bad", selectionMode: "staged" }, { contextRevision: "a".repeat(64), selectionMode: "all" }, { selectionMode: "staged" }])
    expect(() => parseWorkspaceQuery({ type: "git.selection-summary", ...query })).toThrow("exact Git context");
});

test("renderer uses exact host totals for cancelling mixed edits instead of adding both diff views", async () => {
  const f = await fixture(), target = { sessionId: f.session.id };
  const file = join(f.sessionCwd, "app/README.md");
  await writeFile(file, "staged\n"); git(f.sessionCwd, "add", "app/README.md"); await writeFile(file, "base\n");
  const context = await f.workspaces.query(target, { type: "git.action-context" }); if (context.type !== "git.action-context") throw new Error("Wrong context");
  const queries: string[] = [];
  const summary = await readGitSelectionSummary({ query: query => { queries.push(query.type); return f.workspaces.query(target, query); } }, context.context, true);
  expect(summary).toMatchObject({ additions: 2, deletions: 0, files: 1, selectionMode: "include-unstaged" });
  expect(queries).toEqual(["git.selection-summary"]);
});

test("a session retargeted after actual selection preparation cannot receive its former owner's summary", async () => {
  const f = await fixture(), target = { sessionId: f.session.id };
  const context = await f.workspaces.query(target, { type: "git.action-context" }); if (context.type !== "git.action-context") throw new Error("Wrong context");
  let release!: () => void, prepared!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { prepared = resolve; });
  const original = WorkspaceService.prototype.summarizeCommitSelection;
  WorkspaceService.prototype.summarizeCommitSelection = async function (...args) {
    const result = await original.apply(this, args); prepared(); await gate; return result;
  };
  let pending: Promise<unknown> | undefined;
  try {
    pending = f.workspaces.query(target, { type: "git.selection-summary", selectionMode: "include-unstaged", contextRevision: context.context.revision });
    await entered;
    f.store.upsertSession({ ...f.session, cwd: join(f.source, "app"), updatedAt: 2 }); release();
    await expect(pending).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  } finally { release(); if (pending) await pending.catch(() => {}); WorkspaceService.prototype.summarizeCommitSelection = original; }
});
