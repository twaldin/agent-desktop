import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkspaceService } from "../workspace/service";
import { resolveWorktreeDirectoryContext, verifyWorktreeDirectories } from "./worktree-directory-resolution";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-worktree-directories-"))); roots.push(root);
  const source = join(root, "source"), project = join(source, "apps", "web"), worktreeRoot = join(root, "managed");
  await mkdir(source);
  const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  git("config", "user.name", "Directory fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(source, "README.md"), "root file\n");
  git("add", "."); git("commit", "-m", "Root"); git("branch", "without-project");
  await mkdir(project, { recursive: true }); await writeFile(join(project, "README.md"), "project file\n");
  const config = async (owner: string, namespace: string) => {
    const path = join(owner, namespace, "environments", "environment.toml");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'version = 1\nname = "Directory fixture"\n[setup]\nscript = "exit 0"\n');
    return path;
  };
  const inherited = await config(source, ".codex"), local = await config(project, ".agent-desktop");
  const sibling = await config(join(source, "apps", "api"), ".codex");
  git("add", "."); git("commit", "-m", "Nested projects");
  const workspace = new WorkspaceService(project, { worktreeRoot });
  return { root, source, project, worktreeRoot, git, workspace, inherited, local, sibling };
}

test("real checkout preserves the project prefix independently from inherited and local script directories", async () => {
  const f = await fixture();
  const before = { index: await readFile(join(f.source, ".git", "index")), head: f.git("rev-parse", "HEAD"), status: f.git("status", "--porcelain=v1") };
  const inherited = await resolveWorktreeDirectoryContext(f.workspace, f.inherited);
  const local = await resolveWorktreeDirectoryContext(f.workspace, f.local);
  expect(inherited).toEqual({ sourceGitRoot: f.source, sourceWorkspaceRoot: f.project, workspaceRelativePath: "apps/web", configCwdRelativePath: "" });
  expect(local.configCwdRelativePath).toBe("apps/web");
  const rootService = await f.workspace.gitRootService();
  const created = await rootService.createSessionWorktree("nested", { type: "branch", branchName: "main" });
  const directories = await verifyWorktreeDirectories(inherited, created.path);
  expect(directories).toEqual({ worktreeGitRoot: created.path, worktreeWorkspaceRoot: join(created.path, "apps", "web"), scriptCwd: created.path, sourceWorkspaceRoot: f.project });
  expect((await verifyWorktreeDirectories(local, created.path)).scriptCwd).toBe(directories.worktreeWorkspaceRoot);
  expect(await readFile(join(directories.worktreeWorkspaceRoot, "README.md"), "utf8")).toBe("project file\n");
  expect(await readFile(join(f.source, ".git", "index"))).toEqual(before.index);
  expect(f.git("rev-parse", "HEAD")).toBe(before.head);
  expect(f.git("status", "--porcelain=v1")).toBe(before.status);
  await expect(resolveWorktreeDirectoryContext(f.workspace, f.sibling)).rejects.toThrow("outside");
}, 30_000);

test("missing or redirected nested directories never become a root fallback", async () => {
  const f = await fixture();
  const context = await resolveWorktreeDirectoryContext(f.workspace, null);
  const rootService = await f.workspace.gitRootService();
  const missing = await rootService.createSessionWorktree("missing", { type: "branch", branchName: "without-project" });
  await expect(verifyWorktreeDirectories(context, missing.path)).rejects.toThrow("missing");
  expect((await rootService.worktrees()).some(item => item.path === missing.path)).toBe(true);
  const redirected = await rootService.createSessionWorktree("redirected", { type: "branch", branchName: "main" });
  const selected = join(redirected.path, "apps", "web");
  await rm(selected, { recursive: true }); await symlink(f.project, selected);
  await expect(verifyWorktreeDirectories(context, redirected.path)).rejects.toThrow("symbolic");
  expect(await readFile(join(f.project, "README.md"), "utf8")).toBe("project file\n");
}, 30_000);

test("config storage symlinks and non-root target directories are rejected", async () => {
  const f = await fixture();
  await rm(dirname(f.local), { recursive: true });
  await symlink(dirname(f.inherited), dirname(f.local));
  await expect(resolveWorktreeDirectoryContext(f.workspace, f.local)).rejects.toThrow("owned directory");
  const context = await resolveWorktreeDirectoryContext(new WorkspaceService(f.source), null);
  await expect(verifyWorktreeDirectories(context, f.project)).rejects.toThrow("captured Git root");
});

test("a captured source workspace redirected after checkout cannot supply source path variables", async () => {
  const f = await fixture();
  const context = await resolveWorktreeDirectoryContext(f.workspace, f.inherited);
  const rootService = await f.workspace.gitRootService();
  const created = await rootService.createSessionWorktree("source-changed", { type: "branch", branchName: "main" });
  await rename(f.project, `${f.project}-original`);
  await symlink(join(f.source, "apps", "api"), f.project);
  await expect(verifyWorktreeDirectories(context, created.path)).rejects.toThrow("symbolic");
  expect(await readFile(join(created.path, "apps", "web", "README.md"), "utf8")).toBe("project file\n");
}, 30_000);
