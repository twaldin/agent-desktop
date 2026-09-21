import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGitCommitReviewFixture } from "../../../../scripts/acceptance/git-commit-review-fixture";
import { parseGitCommitReviewPath, parseGitCommitReviewSelection, reconcileCommitReviewSelection } from "../../../../packages/shared/src/git-commit-review";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(format: "sha1" | "sha256" = "sha1") { const value = await createGitCommitReviewFixture(format); roots.push(value.root); return value; }

test("Commit picker uses the merge-base range, includes side history, and caps at the newest100", async () => {
  const f = await fixture(), list = await f.reader.commits(f.first, f.merge);
  expect(list.commits.map(row => row.commit)).toEqual([f.merge, f.firstParent, f.side, f.empty, f.changed]);
  expect(list.commits.find(row => row.commit === f.changed)).toMatchObject({ subject: "Historical changes", message: "Historical changes\n\nFull commit message\n" });
  expect((await f.reader.commits(f.merge, f.merge)).commits).toEqual([]);
  expect((await f.reader.commits(null, f.merge)).commits).toEqual([]);
  expect((await f.reader.commits(null, null)).commits).toEqual([]);
  let head = f.merge;
  for (let index = 0; index < 105; index++) {
    head = f.git(["commit-tree", `${f.merge}^{tree}`, "-p", head, "-m", `Boundary ${index}`], 7);
  }
  const capped = await f.reader.commits(f.first, head);
  expect(capped.commits.map(row => row.subject)).toEqual(Array.from({ length: 100 }, (_, index) => `Boundary ${104 - index}`));
});

for (const format of ["sha1", "sha256"] as const) test(`${format} roots use their empty tree; merges use only first parent; empty commits stay empty`, async () => {
  const f = await fixture(format), root = await f.reader.inspect(f.selection(f.first));
  expect(root.parent).toBeNull();
  expect(root.files.map(file => [file.path, file.change])).toEqual(["src/binary.dat", "src/deleted.txt", "src/mode.sh", f.oldPath].sort((a, b) => a.localeCompare(b)).map(path => [path, "A"]));
  expect(root.files.every(file => file.oldOid === "0".repeat(f.first.length))).toBe(true);
  const merge = await f.reader.inspect(f.selection(f.merge));
  expect(merge.parent).toBe(f.firstParent);
  expect(merge.files.map(file => file.path)).toEqual(["src/side.txt"]);
  const patch = await f.reader.file(f.selection(f.merge), { path: "src/side.txt" });
  expect(patch.patch).toContain("+from second parent");
  expect(patch.patch).not.toContain("staged work");
  expect((await f.reader.inspect(f.selection(f.empty))).files).toEqual([]);
});

test("historical rename, deletion, binary, mode and symlink paths ignore dirty work and external converters", async () => {
  const f = await fixture(), converter = join(f.root, "converter"), marker = join(f.root, "converter-ran");
  await writeFile(converter, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o700 });
  f.git(["config", "diff.external", converter]); f.git(["config", "diff.fixture.textconv", converter]);
  await writeFile(join(f.cwd, ".gitattributes"), "* diff=fixture\n");
  const before = await f.snapshot(), snapshot = await f.reader.inspect(f.selection(f.changed));
  expect(snapshot.parent).toBe(f.first);
  const renamed = snapshot.files.find(file => file.path === f.path)!;
  expect(renamed).toMatchObject({ previousPath: f.oldPath, change: "R", additions: 1, deletions: 1 });
  expect(snapshot.files.find(file => file.path === "src/binary.dat")).toMatchObject({ additions: null, deletions: null });
  expect(snapshot.files.find(file => file.path === "src/mode.sh")).toMatchObject({ oldMode: "100644", newMode: "100755", additions: 0, deletions: 0 });
  expect(snapshot.files.find(file => file.path === "src/empty.txt")).toMatchObject({ change: "A", additions: 0, deletions: 0 });
  const diff = await f.reader.file(snapshot.selection, { path: renamed.path, previousPath: renamed.previousPath! });
  expect(diff.patch).toContain("rename from "); expect(diff.patch).toContain("rename to ");
  expect(diff.patch).toContain("+original updated line 20"); expect(diff.patch).not.toContain("dirty work");
  expect((await f.reader.file(snapshot.selection, { path: "src/deleted.txt" })).patch).toContain("-deleted historical content");
  expect((await f.reader.file(snapshot.selection, { path: "src/link" })).patch).toContain("+../../outside-secret");
  expect((await f.reader.file(snapshot.selection, { path: "src/link" })).patch).not.toContain("must never enter");
  expect((await f.reader.file(snapshot.selection, { path: "src/untracked.txt" })).patch).toBe("");
  expect(await f.snapshot()).toEqual(before);
});

test("selection survives pending lists but clears on owner changes or authoritative list removal", async () => {
  const f = await fixture(), selection = f.selection(f.changed), list = await f.reader.commits(f.first, f.merge);
  expect(reconcileCommitReviewSelection(selection, selection.repositoryId, undefined)).toEqual(selection);
  expect(reconcileCommitReviewSelection(selection, selection.repositoryId, list.commits)).toEqual(selection);
  expect(reconcileCommitReviewSelection(selection, selection.repositoryId, [])).toBeNull();
  expect(reconcileCommitReviewSelection(selection, "d".repeat(64), list.commits)).toBeNull();
  expect(reconcileCommitReviewSelection(null, selection.repositoryId, list.commits)).toBeNull();
  await expect(f.reader.inspect({ ...selection, repositoryId: "d".repeat(64) })).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  expect(() => parseGitCommitReviewSelection({ ...selection, commit: "HEAD" })).toThrow();
  for (const path of ["../outside", "/absolute", "src/../other", ":(top)/../outside", "src\0bad"])
    expect(() => parseGitCommitReviewPath({ path })).toThrow();
});

test("missing promisor objects remain errors without fetches or working-file fallbacks", async () => {
  const f = await fixture(), snapshot = await f.reader.inspect(f.selection(f.changed)), oid = snapshot.files.find(file => file.path === f.path)!.newOid;
  f.git(["remote", "add", "origin", join(f.root, "unavailable-remote")]);
  f.git(["config", "remote.origin.promisor", "true"]);
  const trace = join(f.root, "git-read-trace.jsonl");
  f.readEnvironment.GIT_TRACE2_EVENT = trace;
  await rm(join(f.cwd, ".git/objects", oid.slice(0, 2), oid.slice(2)));
  await expect(f.reader.inspect(snapshot.selection)).rejects.toThrow();
  await expect(f.reader.file(snapshot.selection, { path: f.path, previousPath: f.oldPath })).rejects.toThrow();
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(events.some(event => event.event === "error" && event.msg?.includes(oid))).toBe(true);
  expect(events.filter(event => event.event === "child_start" && event.argv?.some((arg: string) => arg === "fetch" || arg.startsWith("fetch-")))).toEqual([]);
});
