import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Disposable repositories only. Author identity is command-local, never machine Git configuration. */
export function fixtureGit(cwd: string, args: string[], author = "First Author", day = 1): string {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C",
      GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author === "First Author" ? "first" : "second"}@example.invalid`,
      GIT_COMMITTER_NAME: "Git File Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: `2020-01-${String(day).padStart(2, "0")}T12:00:00Z`, GIT_COMMITTER_DATE: `2020-01-${String(day).padStart(2, "0")}T12:00:00Z` },
  });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}
export async function createGitFileFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-git-file-"))), cwd = join(root, "project");
  await mkdir(join(cwd, "src"), { recursive: true });
  fixtureGit(cwd, ["init", "--initial-branch=main"]);
  const originalText = Array.from({ length: 120 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n") + "\n";
  await writeFile(join(cwd, "src/original.ts"), originalText);
  await writeFile(join(cwd, "src/deleted.ts"), "export const deleted = true;\n");
  await writeFile(join(cwd, "src/empty.ts"), "");
  await writeFile(join(cwd, "src/binary.dat"), Buffer.from([255, 0, 128, 1]));
  await writeFile(join(cwd, "src/tab\tquote\"line\n.ts"), "unusual name\n");
  fixtureGit(cwd, ["add", "."]); fixtureGit(cwd, ["commit", "-m", "Initial file contents"]);
  const first = fixtureGit(cwd, ["rev-parse", "HEAD"]);
  const changedText = originalText.replace("line60 = 60", "line60 = 600");
  await writeFile(join(cwd, "src/original.ts"), changedText);
  fixtureGit(cwd, ["commit", "-am", "Second author edits line sixty"], "Second Author", 2);
  const edited = fixtureGit(cwd, ["rev-parse", "HEAD"]);
  fixtureGit(cwd, ["mv", "src/original.ts", "src/renamed.ts"]);
  fixtureGit(cwd, ["commit", "-m", "Rename the selected source"], "Second Author", 3);
  const renamed = fixtureGit(cwd, ["rev-parse", "HEAD"]);
  fixtureGit(cwd, ["rm", "src/deleted.ts"]); fixtureGit(cwd, ["commit", "-m", "Delete obsolete source"], "Second Author", 4);
  const head = fixtureGit(cwd, ["rev-parse", "HEAD"]);
  await writeFile(join(cwd, "src/untracked.ts"), "export const untracked = true;\n");
  const snapshot = async () => ({ head: await readFile(join(cwd, ".git/HEAD"), "utf8"), index: (await readFile(join(cwd, ".git/index"))).toString("base64"),
    config: await readFile(join(cwd, ".git/config"), "utf8"), reflog: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"),
    refs: fixtureGit(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)"]), text: await readFile(join(cwd, "src/renamed.ts"), "utf8") });
  return { root, cwd, first, edited, renamed, head, originalText, changedText, snapshot };
}
