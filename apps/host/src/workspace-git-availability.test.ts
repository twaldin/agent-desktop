import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { HostWorkspaces } from "./workspace-http";

const roots: string[] = [], stores = new Set<HostStore>();
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]) {
  const child = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!child.success) throw new Error(new TextDecoder().decode(child.stderr));
}

test("git status distinguishes an ordinary directory from a repository read failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-git-availability-")); roots.push(root);
  const plain = join(root, "plain"), repository = join(root, "repository"), nested = join(repository, "nested"), bare = join(root, "bare.git"), data = join(root, "data");
  await mkdir(plain); await mkdir(nested, { recursive: true });
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Availability Fixture");
  git(repository, "config", "user.email", "availability@example.invalid");
  await writeFile(join(nested, "README.md"), "fixture\n"); git(repository, "add", "nested/README.md"); git(repository, "commit", "-m", "fixture");
  git(root, "init", "--bare", bare);

  const store = new HostStore(data); stores.add(store);
  const plainProject = store.addProject({ path: plain }), gitProject = store.addProject({ path: nested }), bareProject = store.addProject({ path: bare });
  const workspaces = new HostWorkspaces(store, data, () => { throw new Error("status must not reserve a mutation"); });

  await expect(workspaces.query({ projectId: plainProject.id }, { type: "git.status" })).resolves.toEqual({ type: "git.status", availability: "not-repository" });
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = root;
  try { await expect(workspaces.query({ projectId: plainProject.id }, { type: "git.status" })).rejects.toThrow(); }
  finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  }
  await expect(workspaces.query({ projectId: gitProject.id }, { type: "git.status" })).resolves.toMatchObject({ type: "git.status", availability: "repository", status: { branch: "main" } });

  // Git reports malformed repository metadata with the same process exit class
  // as a directory outside a repository. The marker retains it as a real error.
  await writeFile(join(repository, ".git", "config"), "[broken\n");
  await expect(workspaces.query({ projectId: gitProject.id }, { type: "git.status" })).rejects.toThrow();
  await expect(workspaces.query({ projectId: bareProject.id }, { type: "git.status" })).rejects.toThrow();
});
