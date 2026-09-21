import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fixtureGit } from "./git-file-fixture";
import { GitCommitReviewReader } from "../../apps/host/src/workspace/git-commit-review";

const execute = promisify(execFile);
export const commitFixtureRepositoryId = "c".repeat(64);
/** Every write/checkout below belongs to this disposable real repository, not the source checkout. */
export async function createGitCommitReviewFixture(objectFormat: "sha1" | "sha256" = "sha1") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-commit-review-"))), cwd = join(root, "project");
  await mkdir(join(cwd, "src"), { recursive: true });
  const git = (args: string[], day = 1) => fixtureGit(cwd, args, "First Author", day);
  git(["init", "--initial-branch=main", `--object-format=${objectFormat}`]);
  const oldPath = "src/old\tname\n.txt", path = "src/café [literal]\\name\tnew\n.txt";
  const original = Array.from({ length: 40 }, (_, n) => `original line ${n}\n`).join("");
  await writeFile(join(cwd, oldPath), original);
  await writeFile(join(cwd, "src/deleted.txt"), "deleted historical content\n");
  await writeFile(join(cwd, "src/mode.sh"), "#!/bin/sh\necho original\n");
  await writeFile(join(cwd, "src/binary.dat"), Buffer.from([0, 255, 1]));
  git(["add", "."]); git(["commit", "-m", "Root commit"]);
  const first = git(["rev-parse", "HEAD"]);
  git(["checkout", "-b", "topic"]);
  git(["mv", oldPath, path]); await writeFile(join(cwd, path), original.replace("line 20", "updated line 20"));
  git(["rm", "src/deleted.txt"]);
  await chmod(join(cwd, "src/mode.sh"), 0o755);
  await writeFile(join(cwd, "src/binary.dat"), Buffer.from([0, 255, 2]));
  await writeFile(join(cwd, "src/empty.txt"), "");
  await symlink("../../outside-secret", join(cwd, "src/link"));
  await writeFile(join(root, "outside-secret"), "must never enter a historical diff\n");
  git(["add", "."]); git(["commit", "-m", "Historical changes\n\nFull commit message"], 2);
  const changed = git(["rev-parse", "HEAD"]);
  git(["commit", "--allow-empty", "-m", "Empty commit"], 3);
  const empty = git(["rev-parse", "HEAD"]);
  git(["checkout", "-b", "side"]);
  await writeFile(join(cwd, "src/side.txt"), "from second parent\n");
  git(["add", "."]); git(["commit", "-m", "Side history"], 4);
  const side = git(["rev-parse", "HEAD"]);
  git(["checkout", "topic"]);
  await writeFile(join(cwd, "src/topic.txt"), "from first parent\n");
  git(["add", "."]); git(["commit", "-m", "First parent history"], 5);
  const firstParent = git(["rev-parse", "HEAD"]);
  git(["merge", "--no-ff", "side", "-m", "Merge side"], 6);
  const merge = git(["rev-parse", "HEAD"]);
  await writeFile(join(cwd, "src/side.txt"), "staged work\n"); git(["add", "src/side.txt"]);
  await writeFile(join(cwd, path), "dirty work must not enter review\n");
  await writeFile(join(cwd, "src/untracked.txt"), "untracked work must not enter review\n");
  const readEnvironment: Record<string, string> = {};
  const reader = new GitCommitReviewReader({ text: async args => {
    const result = await execute("git", ["--no-pager", "-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...readEnvironment } });
    return result.stdout;
  } }, commitFixtureRepositoryId);
  // Covers working files, symlinks, index, refs, reflogs, config AND the object store.
  const snapshot = async () => {
    const values: Array<[string, string, number]> = [];
    const visit = async (directory: string, prefix: string) => {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name), relative = `${prefix}${name}`, info = await lstat(path);
        if (info.isDirectory()) await visit(path, `${relative}/`);
        else values.push([relative, info.isSymbolicLink() ? await readlink(path) : createHash("sha256").update(await readFile(path)).digest("hex"), info.mode]);
      }
    };
    await visit(root, ""); return values;
  };
  return { root, cwd, git, reader, readEnvironment, first, changed, empty, side, firstParent, merge, oldPath, path, original, snapshot,
    selection: (commit: string) => ({ repositoryId: commitFixtureRepositoryId, commit }) };
}
