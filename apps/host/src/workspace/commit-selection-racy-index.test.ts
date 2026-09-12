import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

test("include-unstaged preserves a same-size racy working edit when copying the index", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-racy-index-")); roots.push(cwd);
  const hooks = join(cwd, "empty-hooks"); await mkdir(hooks);
  git(cwd, "init", "-q", "--initial-branch=main");
  git(cwd, "config", "user.name", "Racy Index Fixture");
  git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "config", "core.hooksPath", hooks);
  git(cwd, "config", "commit.gpgSign", "false");
  git(cwd, "config", "core.checkStat", "minimal");
  git(cwd, "config", "core.trustctime", "false");
  const file = join(cwd, "tracked.txt"), epoch = new Date("2020-01-01T00:00:00.000Z");
  await writeFile(file, "AAA\n"); await utimes(file, epoch, epoch);
  git(cwd, "add", "tracked.txt"); git(cwd, "commit", "-qm", "base");
  const index = resolve(cwd, git(cwd, "rev-parse", "--git-path", "index"));
  // Equal index/file timestamps force Git to hash rather than trust cached stat
  // data. Giving a copied index a newer timestamp must not erase that safeguard.
  await utimes(index, epoch, epoch);
  await writeFile(file, "BBB\n"); await utimes(file, epoch, epoch);
  const before = { head: git(cwd, "rev-parse", "HEAD"), index: await readFile(index) };
  const service = new WorkspaceService(cwd), status = await service.gitStatus();
  expect(status.entries).toMatchObject([{ path: "tracked.txt", worktreeStatus: "M" }]);
  const selection = await service.prepareCommitSelection("include-unstaged", status.revision);
  try {
    expect(selection.selectedPaths).toEqual(["tracked.txt"]);
    expect(git(cwd, "show", `${selection.selectedTree}:tracked.txt`)).toBe("BBB");
    expect(selection.numstat).toContain("1\t1\ttracked.txt");
    expect(await readFile(index)).toEqual(before.index);
    expect(await readFile(file, "utf8")).toBe("BBB\n");
    expect(git(cwd, "rev-parse", "HEAD")).toBe(before.head);
  } finally { await selection.dispose(); }
});
