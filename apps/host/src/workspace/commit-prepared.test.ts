import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkspaceError, WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
async function fixture(timeout = 30_000) {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-prepared-commit-")); roots.push(root);
  const cwd = join(root, "repo"), hooks = join(root, "hooks"); await mkdir(cwd); await mkdir(hooks);
  git(cwd, "init", "-q", "--initial-branch=main"); git(cwd, "config", "user.name", "Prepared Owner");
  git(cwd, "config", "user.email", "prepared@example.invalid"); git(cwd, "config", "commit.gpgSign", "false");
  git(cwd, "config", "core.hooksPath", hooks); await writeFile(join(cwd, "a.txt"), "base\n");
  git(cwd, "add", "a.txt"); git(cwd, "commit", "-qm", "initial");
  return { root, cwd, hooks, service: new WorkspaceService(cwd, { gitTimeoutMs: timeout }) };
}
async function indexBytes(cwd: string) { return readFile(git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index")); }
async function hook(path: string, body: string) { await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`); await chmod(path, 0o755); }
async function code(operation: Promise<unknown>, expected: string) {
  try { await operation; throw new Error(`Expected ${expected}`); }
  catch (error) { expect(error).toBeInstanceOf(WorkspaceError); expect((error as WorkspaceError).code).toBe(expected); }
}

test("staged selection commits reviewed bytes and publishes an index that leaves later working bytes unstaged", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "a.txt"), "staged\n"); git(f.cwd, "add", "a.txt");
  await writeFile(join(f.cwd, "a.txt"), "working\n");
  const prepared = await f.service.prepareCommitSelection("staged", (await f.service.gitStatus()).revision);
  const result = await f.service.commitPreparedSelection(prepared, "partial staged");
  expect(git(f.cwd, "show", "HEAD:a.txt")).toBe("staged");
  expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe("working\n");
  expect(git(f.cwd, "diff", "--cached", "--name-only")).toBe("");
  expect(git(f.cwd, "diff", "--name-only")).toBe("a.txt");
  expect(result).toMatchObject({ reviewedTree: result.committedTree, publishedIndexTree: result.committedTree });
  expect(git(f.cwd, "show", "-s", "--format=%an <%ae>", "HEAD")).toBe("Prepared Owner <prepared@example.invalid>");
});

test("include-unstaged commits and publishes its full private selection", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "a.txt"), "working\n"); await writeFile(join(f.cwd, "b.txt"), "new\n");
  const prepared = await f.service.prepareCommitSelection("include-unstaged", (await f.service.gitStatus()).revision);
  const result = await f.service.commitPreparedSelection(prepared, "include all");
  expect(result.reviewedTree).toBe(result.committedTree); expect(result.publishedIndexTree).toBe(result.committedTree);
  expect(git(f.cwd, "show", "HEAD:a.txt")).toBe("working"); expect(git(f.cwd, "show", "HEAD:b.txt")).toBe("new");
  expect(git(f.cwd, "status", "--porcelain")).toBe("");
  await code(f.service.commitPreparedSelection(prepared, "replay"), "COMMIT_SELECTION_DISPOSED");
});

test("an unborn selection produces a verified root commit and first live index", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-prepared-root-")); roots.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd); git(cwd, "init", "-q", "--initial-branch=main");
  git(cwd, "config", "user.name", "Prepared Owner"); git(cwd, "config", "user.email", "prepared@example.invalid");
  await writeFile(join(cwd, "first.txt"), "first\n"); const service = new WorkspaceService(cwd);
  const prepared = await service.prepareCommitSelection("include-unstaged", (await service.gitStatus()).revision);
  const result = await service.commitPreparedSelection(prepared, "root commit");
  expect(git(cwd, "rev-list", "--parents", "-n", "1", result.commit).split(" ")).toEqual([result.commit]);
  expect(git(cwd, "show", "HEAD:first.txt")).toBe("first"); expect(git(cwd, "status", "--porcelain")).toBe("");
});

test("native hooks can change committed and post-commit staged trees and both are preserved", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "a.txt"), "selected\n"); git(f.cwd, "add", "a.txt");
  await hook(join(f.hooks, "pre-commit"), "printf 'pre\\n' > pre.txt\ngit add pre.txt");
  await hook(join(f.hooks, "post-commit"), "printf 'post\\n' > post.txt\ngit add post.txt");
  const prepared = await f.service.prepareCommitSelection("staged", (await f.service.gitStatus()).revision);
  const result = await f.service.commitPreparedSelection(prepared, "hook trees");
  expect(result.committedTree).not.toBe(result.reviewedTree);
  expect(result.publishedIndexTree).not.toBe(result.committedTree);
  expect(git(f.cwd, "show", "HEAD:pre.txt")).toBe("pre");
  expect(git(f.cwd, "diff", "--cached", "--name-only")).toBe("post.txt");
});

test("stale preparation and an existing live index lock fail before commit dispatch", async () => {
  const stale = await fixture(); await writeFile(join(stale.cwd, "a.txt"), "one\n"); git(stale.cwd, "add", "a.txt");
  await hook(join(stale.hooks, "pre-commit"), "printf dispatched > ../dispatched");
  const prepared = await stale.service.prepareCommitSelection("staged", (await stale.service.gitStatus()).revision);
  await writeFile(join(stale.cwd, "b.txt"), "two\n"); git(stale.cwd, "add", "b.txt");
  const head = git(stale.cwd, "rev-parse", "HEAD"); await code(stale.service.commitPreparedSelection(prepared, "stale"), "GIT_CHANGED");
  expect(git(stale.cwd, "rev-parse", "HEAD")).toBe(head); await expect(stat(join(stale.root, "dispatched"))).rejects.toMatchObject({ code: "ENOENT" });

  const busy = await fixture(); await writeFile(join(busy.cwd, "a.txt"), "busy\n"); git(busy.cwd, "add", "a.txt");
  const busyPrepared = await busy.service.prepareCommitSelection("staged", (await busy.service.gitStatus()).revision);
  const lockPath = `${git(busy.cwd, "rev-parse", "--path-format=absolute", "--git-path", "index")}.lock`; await writeFile(lockPath, "external");
  const busyHead = git(busy.cwd, "rev-parse", "HEAD"); await code(busy.service.commitPreparedSelection(busyPrepared, "busy"), "GIT_BUSY");
  expect(git(busy.cwd, "rev-parse", "HEAD")).toBe(busyHead); expect(await readFile(lockPath, "utf8")).toBe("external");
});

test("a rejecting hook preserves exact HEAD and live index bytes", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "a.txt"), "selected\n"); git(f.cwd, "add", "a.txt");
  await hook(join(f.hooks, "pre-commit"), "exit 7");
  const head = git(f.cwd, "rev-parse", "HEAD"), before = await indexBytes(f.cwd);
  const prepared = await f.service.prepareCommitSelection("staged", (await f.service.gitStatus()).revision);
  await code(f.service.commitPreparedSelection(prepared, "rejected"), "GIT_FAILED");
  expect(git(f.cwd, "rev-parse", "HEAD")).toBe(head); expect(await indexBytes(f.cwd)).toEqual(before);
});

test("a hook-replaced live lock is never published or removed and makes the applied outcome unknown", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "a.txt"), "selected\n"); git(f.cwd, "add", "a.txt");
  const indexPath = git(f.cwd, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const lockPath = `${indexPath}.lock`, before = await indexBytes(f.cwd), head = git(f.cwd, "rev-parse", "HEAD");
  await hook(join(f.hooks, "post-commit"), `unlink '${lockPath}'\nprintf foreign > '${lockPath}'`);
  const prepared = await f.service.prepareCommitSelection("staged", (await f.service.gitStatus()).revision);
  await code(f.service.commitPreparedSelection(prepared, "foreign lock"), "OUTCOME_UNKNOWN");
  expect(git(f.cwd, "rev-parse", "HEAD")).not.toBe(head);
  expect(await indexBytes(f.cwd)).toEqual(before); expect(await readFile(lockPath, "utf8")).toBe("foreign");
  await code(f.service.commitPreparedSelection(prepared, "replay"), "OUTCOME_UNKNOWN");
  await code(prepared.dispose(), "OUTCOME_UNKNOWN"); expect((await stat(prepared.privateIndexPath)).isFile()).toBe(true);
  await rm(dirname(prepared.privateIndexPath), { recursive: true, force: true });
});

test("a post-commit timeout is unknown, leaves live index unchanged, and retains recovery material", async () => {
  const f = await fixture(2_000); await writeFile(join(f.cwd, "a.txt"), "selected\n"); git(f.cwd, "add", "a.txt");
  const marker = join(f.root, "hook-finished"), release = join(f.root, "hook-release"), ready = join(f.root, "hook-ready");
  // Use the test runner's executable, with no Python/PATH bootstrap. The child
  // must exist before timeout and touch the retained private index only after
  // the test releases it, so elapsed sleeps cannot manufacture survival proof.
  const childPath = join(f.root, "hook-child.cjs"), parentPath = join(f.root, "hook-parent.cjs");
  await writeFile(childPath, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  fs.readFileSync(process.env.GIT_INDEX_FILE);
  fs.writeFileSync(${JSON.stringify(marker)}, 'done'); clearInterval(timer);
}, 20);`);
  await writeFile(parentPath, `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(childPath)}], { detached: true, stdio: 'ignore', env: process.env });
child.on('exit', code => process.exit(code ?? 1));`);
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await hook(join(f.hooks, "post-commit"), `exec ${quote(process.execPath)} ${quote(parentPath)}`);
  const head = git(f.cwd, "rev-parse", "HEAD"), before = await indexBytes(f.cwd);
  const prepared = await f.service.prepareCommitSelection("staged", (await f.service.gitStatus()).revision);
  try {
    await code(f.service.commitPreparedSelection(prepared, "timeout applied"), "OUTCOME_UNKNOWN");
    expect(git(f.cwd, "rev-parse", "HEAD")).not.toBe(head); expect(await indexBytes(f.cwd)).toEqual(before);
    expect(Number(await readFile(ready, "utf8"))).toBeGreaterThan(0);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await code(prepared.dispose(), "OUTCOME_UNKNOWN"); expect((await stat(prepared.privateIndexPath)).isFile()).toBe(true);
  } finally {
    await writeFile(release, "release");
    for (let attempt = 0; attempt < 60; attempt++) { if (await stat(marker).then(() => true, () => false)) break; await Bun.sleep(50); }
    const pid = Number(await readFile(ready, "utf8").catch(() => ""));
    if (pid > 0 && !await stat(marker).then(() => true, () => false)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  expect(await readFile(marker, "utf8")).toBe("done");
  await rm(dirname(prepared.privateIndexPath), { recursive: true, force: true });
}, 15_000);
