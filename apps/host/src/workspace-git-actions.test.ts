import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { HostWorkspaces, parseWorkspaceQuery } from "./workspace-http";

const roots: string[] = [], stores = new Set<HostStore>();
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]) {
  const process = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!process.success) throw new Error(new TextDecoder().decode(process.stderr));
  return new TextDecoder().decode(process.stdout).trim();
}

test("Git action context follows a nested project and its distinct session worktree without changing Git", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-git-context-"))); roots.push(root);
  const source = join(root, "source"), nested = join(source, "app"), sessionCwd = join(root, "session");
  await mkdir(nested, { recursive: true }); await mkdir(join(root, "hooks"));
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Git Context Fixture"); git(source, "config", "user.email", "context@example.invalid");
  git(source, "config", "commit.gpgSign", "false"); git(source, "config", "core.hooksPath", join(root, "hooks"));
  await writeFile(join(nested, "README.md"), "base\n"); git(source, "add", "app/README.md"); git(source, "commit", "-m", "fixture");
  git(source, "worktree", "add", "-b", "session-context", sessionCwd);
  await writeFile(join(source, "note.txt"), "unsent source changes\n");
  const data = join(root, "data"), store = new HostStore(data); stores.add(store);
  const project = store.addProject({ path: nested });
  store.upsertSession({ id: "context-session", hostId: store.host.id, projectId: project.id, cwd: join(sessionCwd, "app"), title: "Context", status: "idle", sessionFile: join(root, "unused.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false });
  const workspaces = new HostWorkspaces(store, data, () => { throw new Error("A read-only context reserved a mutation"); });
  const snapshot = async () => ({
    index: await readFile(join(source, ".git/index")), config: await readFile(join(source, ".git/config")),
    note: await readFile(join(source, "note.txt")), head: git(source, "rev-parse", "HEAD"),
    branch: git(source, "branch", "--show-current"), refs: git(source, "show-ref"), reflog: git(source, "reflog", "--all"),
  });
  const before = await snapshot();
  const query = parseWorkspaceQuery({ type: "git.action-context" });
  const projectResult = await workspaces.query({ projectId: project.id }, query);
  const sessionResult = await workspaces.query({ sessionId: "context-session" }, query);
  expect(projectResult).toMatchObject({ type: "git.action-context", context: { status: { branch: "main", head: before.head } } });
  expect(sessionResult).toMatchObject({ type: "git.action-context", context: { status: { branch: "session-context", head: before.head } } });
  await expect(workspaces.query({ filePath: join(nested, "README.md") }, query)).rejects.toThrow("standalone file");
  await expect(workspaces.query({ sessionId: "missing" }, query)).rejects.toThrow("does not exist");
  expect(await snapshot()).toEqual(before);
});
