import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGit } from "../../../../scripts/acceptance/git-file-fixture";
import { composeRecordedTextChanges, RecordedDiffError, type RecordedTextFile } from "./recorded-diff";

const file = (path: string, text: string, mode: RecordedTextFile["mode"] = "100644"): RecordedTextFile => ({ path, text, mode });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: RecordedTextFile[]) {
  const cwd = await mkdtemp(join(tmpdir(), "recorded-diff-test-")); roots.push(cwd);
  const git = (args: string[]) => fixtureGit(cwd, args);
  git(["init", "--quiet", "--initial-branch=main"]);
  for (const item of files) {
    if (item.mode === "120000") await symlink(item.text, join(cwd, item.path));
    else await writeFile(join(cwd, item.path), item.text, { mode: item.mode === "100755" ? 0o755 : 0o644 });
  }
  git(["add", "."]); git(["commit", "--quiet", "--allow-empty", "-m", "Recorded bytes"]);
  return { cwd, apply: async (patch: string) => { const path = join(cwd, ".git", "recorded.patch"); await writeFile(path, patch); git(["apply", "--check", path]); git(["apply", path]); } };
}
function expectCode(action: () => unknown, code: RecordedDiffError["code"]) {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(RecordedDiffError);
  expect((caught as RecordedDiffError).code).toBe(code);
}

test("create/delete and edit/revert cancel, including a rename round trip", () => {
  const a = file("a", "original\n"), b = file("b", "changed\n"), temporary = file("temporary", "temporary\n");
  expect(composeRecordedTextChanges([
    { before: null, after: temporary }, { before: temporary, after: null },
    { before: a, after: b }, { before: b, after: a },
  ])).toEqual({ files: [], patch: "" });
});

test("missing intermediate bytes or a changed mode cannot silently join recorded history", () => {
  const a = file("a", "before\n"), b = file("a", "after\n");
  expectCode(() => composeRecordedTextChanges([{ before: a, after: b }, { before: a, after: null }]), "DISCONTINUOUS_HISTORY");
  expectCode(() => composeRecordedTextChanges([{ before: a, after: b }, { before: { ...b, mode: "100755" }, after: null }]), "DISCONTINUOUS_HISTORY");
});

test("an observed occupied rename destination cannot be overwritten without its deletion evidence", () => {
  const a = file("a", "one\n"), b = file("b", "two\n");
  expectCode(() => composeRecordedTextChanges([{ before: b, after: b }, { before: a, after: { ...a, path: "b" } }]), "DISCONTINUOUS_HISTORY");
});

test("binary, missing text and escaping paths are unavailable evidence rather than empty changes", () => {
  expectCode(() => composeRecordedTextChanges([{ before: null, after: file("binary", "\0bytes") }]), "INVALID_EVIDENCE");
  expectCode(() => composeRecordedTextChanges([{ before: null, after: { path: "missing", mode: "100644" } as RecordedTextFile }]), "INVALID_EVIDENCE");
  expectCode(() => composeRecordedTextChanges([{ before: null, after: file("../outside", "bytes") }]), "INVALID_EVIDENCE");
  expectCode(() => composeRecordedTextChanges([{ before: null, after: null }]), "INVALID_EVIDENCE");
  expectCode(() => composeRecordedTextChanges([{ before: null, after: file("text", "\uD800") }]), "INVALID_EVIDENCE");
});

test("rename chains plus recreation of the vacated path apply to the original recorded bytes", async () => {
  const a = file("original", "dirty initial bytes\n"), b = file("middle", "intermediate\n"), c = file('café\\tab\tquote"line\n', "final without newline"), replacement = file("original", "new independent file\n");
  const result = composeRecordedTextChanges([{ before: a, after: b }, { before: b, after: c }, { before: null, after: replacement }]);
  const repo = await repository([a]); await repo.apply(result.patch);
  expect(await readFile(join(repo.cwd, c.path), "utf8")).toBe(c.text);
  expect(await readFile(join(repo.cwd, replacement.path), "utf8")).toBe(replacement.text);
  expect(await lstat(join(repo.cwd, "middle")).catch(() => null)).toBeNull();
  expect(result.files.map(item => [item.path, item.previousPath, item.additions, item.deletions])).toEqual([[c.path, a.path, 1, 1], [replacement.path, null, 1, 0]]);
});

test("deletion followed by rename into that path preserves both original files' effects", async () => {
  const a = file("a", "survives\n"), b = file("b", "removed destination\n"), moved = { ...a, path: "b" };
  const result = composeRecordedTextChanges([{ before: b, after: null }, { before: a, after: moved }]);
  const repo = await repository([a, b]); await repo.apply(result.patch);
  expect(await readFile(join(repo.cwd, "b"), "utf8")).toBe(a.text);
  expect(await lstat(join(repo.cwd, "a")).catch(() => null)).toBeNull();
});

test("file-type replacement produces applicable Git changes without following symlinks", async () => {
  const regular = file("regular", "old regular\n"), link = file("link", "missing-target", "120000");
  const nextLink = file("regular", "other-target", "120000"), nextRegular = file("link", "replacement regular\n", "100755");
  const result = composeRecordedTextChanges([{ before: regular, after: nextLink }, { before: link, after: nextRegular }]);
  const repo = await repository([regular, link]); await repo.apply(result.patch);
  expect(await readlink(join(repo.cwd, "regular"))).toBe("other-target");
  expect(await readFile(join(repo.cwd, "link"), "utf8")).toBe(nextRegular.text);
  expect((await lstat(join(repo.cwd, "link"))).mode & 0o111).not.toBe(0);
});

test("delete/recreate composes against the original bytes instead of emitting an independent addition", async () => {
  const before = file("file", "before\n"), after = file("file", "after\n");
  const result = composeRecordedTextChanges([{ before, after: null }, { before: null, after }]);
  const repo = await repository([before]); await repo.apply(result.patch);
  expect(await readFile(join(repo.cwd, "file"), "utf8")).toBe(after.text);
  expect(result.files.map(item => item.kind)).toEqual(["M"]);
});
