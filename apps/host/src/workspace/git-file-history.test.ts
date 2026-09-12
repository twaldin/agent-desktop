import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceService, WorkspaceError } from "./service";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import type { HostStore } from "../store";
import { createGitFileFixture, fixtureGit } from "../../../../scripts/acceptance/git-file-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const value = await createGitFileFixture(); roots.push(value.root); return { ...value, service: new WorkspaceService(value.cwd) }; }

test("blame resolves real authors and original rename paths without changing repository or dirty working text", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "src/renamed.ts"), `${f.changedText}// unsaved on host\n`);
  const before = await f.snapshot(), inspection = await f.service.inspectGitFile("src/renamed.ts", "HEAD");
  expect(inspection.origin).toMatchObject({ workspacePath: "src/renamed.ts", path: "src/renamed.ts", expression: "HEAD", commit: f.head });
  expect(inspection.revision?.content).toMatchObject({ kind: "text", text: f.changedText });
  expect(inspection.working).toMatchObject({ kind: "text", text: `${f.changedText}// unsaved on host\n` });
  expect(inspection.revision?.blame[59]).toMatchObject({ line: 60, originalLine: 60, commit: f.edited, path: "src/original.ts", author: "Second Author" });
  expect(inspection.revision?.blame[0]).toMatchObject({ line: 1, commit: f.first, author: "First Author", path: "src/original.ts" });
  expect(inspection.history?.commits.map(row => [row.commit, row.path])).toEqual([[f.renamed, "src/renamed.ts"], [f.edited, "src/original.ts"], [f.first, "src/original.ts"]]);
  const revision = await f.service.gitFileRevision(inspection.origin!, { commit: f.first, path: "src/original.ts" });
  expect(revision.content).toMatchObject({ kind: "text", text: f.originalText });
  expect(revision.origin).toEqual(inspection.origin!);
  expect(await f.snapshot()).toEqual(before);
});

test("nested owner paths, deleted parent content, staged renames and unusual filenames retain exact identities", async () => {
  const f = await fixture(), nested = new WorkspaceService(join(f.cwd, "src"));
  const deleted = await nested.inspectGitFile("deleted.ts", "HEAD");
  expect(deleted.origin).toMatchObject({ workspacePath: "deleted.ts", path: "src/deleted.ts" });
  expect(deleted.revision?.content).toBeNull();
  const change = deleted.history!.commits[0]!;
  expect(change).toMatchObject({ commit: f.head, change: "D", previous: { commit: f.renamed, path: "src/deleted.ts" } });
  expect((await nested.gitFileRevision(deleted.origin!, change.previous!)).content).toMatchObject({ kind: "text", text: "export const deleted = true;\n" });
  fixtureGit(f.cwd, ["mv", "src/renamed.ts", "src/staged-name.ts"]);
  const staged = await nested.inspectGitFile("staged-name.ts", "HEAD");
  expect(staged.origin).toMatchObject({ workspacePath: "staged-name.ts", path: "src/staged-name.ts" });
  expect(staged.revision?.location).toEqual({ commit: f.head, path: "src/renamed.ts" });
  expect(staged.history?.start.pending[0]?.path).toBe("src/renamed.ts");
  const unusual = await nested.inspectGitFile("tab\tquote\"line\n.ts", "HEAD");
  expect(unusual.revision?.blame[0]?.path).toBe("src/tab\tquote\"line\n.ts");
  expect(unusual.history?.commits[0]?.path).toBe("src/tab\tquote\"line\n.ts");
});

test("empty, binary, untracked, absent reference and unborn repository are distinct observations", async () => {
  const f = await fixture();
  const empty = await f.service.inspectGitFile("src/empty.ts", "HEAD");
  expect(empty.revision?.content).toMatchObject({ kind: "text", text: "" }); expect(empty.revision?.blame).toEqual([]);
  const binary = await f.service.inspectGitFile("src/binary.dat", "HEAD");
  expect(binary.revision?.content?.kind).toBe("binary"); expect(binary.revision?.blame).toEqual([]);
  const untracked = await f.service.inspectGitFile("src/untracked.ts", "HEAD");
  expect(untracked.working?.kind).toBe("text"); expect(untracked.revision?.content).toBeNull(); expect(untracked.history?.commits).toEqual([]);
  expect((await f.service.inspectGitFile("src/renamed.ts", "missing-ref")).unavailable).toBe("revision-not-found");
  const unborn = join(f.root, "unborn"); await mkdir(unborn); fixtureGit(unborn, ["init", "--initial-branch=main"]); await writeFile(join(unborn, "new.ts"), "new\n");
  expect((await new WorkspaceService(unborn).inspectGitFile("new.ts", "HEAD")).unavailable).toBe("unborn-head");
});

test("older history pages continue before their boundary without losing original path or duplicating commits", async () => {
  const f = await fixture();
  let path = "src/paged.ts";
  for (let index = 0; index < 103; index++) {
    if (index === 50) {
      fixtureGit(f.cwd, ["mv", path, "src/paged-renamed.ts"]); path = "src/paged-renamed.ts";
    }
    await writeFile(join(f.cwd, path), `${f.changedText}// revision ${index}\n`);
    fixtureGit(f.cwd, ["add", "."]); fixtureGit(f.cwd, ["commit", "-m", `Page ${index}`]);
  }
  const inspection = await f.service.inspectGitFile(path, "HEAD"), page = inspection.history!;
  expect(page.commits[0]?.summary).toBe("Page 102"); expect(page.commits.at(-1)?.summary).toBe("Page 3");
  const older = await f.service.gitFileHistory(inspection.origin!, page.next!);
  expect(older.commits.map(row => row.summary)).toEqual(["Page 2", "Page 1", "Page 0"]); expect(older.next).toBeNull();
  expect(older.origin).toEqual(inspection.origin!);
  expect(older.commits.every(row => row.path === "src/paged.ts")).toBe(true);
});

test("protocol and repository identity reject path escape, mutable locations and replaced owners", async () => {
  const f = await fixture(), inspection = await f.service.inspectGitFile("src/renamed.ts", "HEAD");
  for (const path of ["../outside", "/absolute", "src/../other", "src\\other", ":/../escape"]) expect(() => parseWorkspaceQuery({ type: "git.file-inspect", path, expression: "HEAD" })).toThrow();
  expect(() => parseWorkspaceQuery({ type: "git.file-revision", origin: inspection.origin, location: { commit: "HEAD", path: "src/renamed.ts" } })).toThrow();
  await expect(f.service.gitFileRevision({ ...inspection.origin!, repositoryId: "f".repeat(64) }, inspection.origin!)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  fixtureGit(f.cwd, ["tag", "mutable", f.first]);
  const pinned = await f.service.inspectGitFile("src/original.ts", "mutable"); fixtureGit(f.cwd, ["tag", "-f", "mutable", f.head]);
  expect((await f.service.gitFileRevision(pinned.origin!, pinned.origin!)).content).toMatchObject({ kind: "text", text: f.originalText });
  await rename(f.cwd, `${f.cwd}-old`); await mkdir(f.cwd); fixtureGit(f.cwd, ["init", "--initial-branch=main"]);
  await expect(f.service.gitFileRevision(inspection.origin!, inspection.origin!)).rejects.toMatchObject({ code: "PATH_CHANGED" });
});

test("host dispatch preserves nested catalog ownership and rejects standalone or retargeted results", async () => {
  const f = await fixture();
  let project = { id: "project", hostId: "host", path: join(f.cwd, "src") };
  const store = { host: { id: "host" }, getProject: (id: string) => id === "project" ? project : undefined, getSession: () => undefined } as unknown as HostStore;
  const host = new HostWorkspaces(store, join(f.root, "data"), () => { throw new Error("Git file reads must not reserve mutations"); });
  try {
    const result = await host.query({ projectId: "project" }, { type: "git.file-inspect", path: "renamed.ts", expression: "HEAD" });
    expect(result.type === "git.file-inspect" && result.inspection.origin?.path).toBe("src/renamed.ts");
    await expect(host.query({ filePath: join(f.cwd, "src/renamed.ts") }, { type: "git.file-inspect", path: "renamed.ts", expression: "HEAD" })).rejects.toThrow();
    const original = WorkspaceService.prototype.inspectGitFile;
    WorkspaceService.prototype.inspectGitFile = async function (...args) { const value = await original.apply(this, args); project = { ...project, path: f.cwd }; return value; };
    try { await expect(host.query({ projectId: "project" }, { type: "git.file-inspect", path: "renamed.ts", expression: "HEAD" })).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" }); }
    finally { WorkspaceService.prototype.inspectGitFile = original; }
  } finally { await host.shutdownSubmissions(); }
});

test("local Git read errors remain errors and do not become empty history", async () => {
  const f = await fixture();
  const blob = fixtureGit(f.cwd, ["rev-parse", "HEAD:src/renamed.ts"]);
  await rm(join(f.cwd, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  await expect(f.service.inspectGitFile("src/renamed.ts", "HEAD")).rejects.toBeInstanceOf(WorkspaceError);
});

test("blame reads original Git blobs without executing repository-configured text conversion", async () => {
  const f = await fixture(), converter = join(f.root, "must-not-run");
  await writeFile(converter, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  await writeFile(join(f.cwd, ".gitattributes"), "src/renamed.ts diff=fixture\n");
  fixtureGit(f.cwd, ["config", "diff.fixture.textconv", converter]);
  fixtureGit(f.cwd, ["add", ".gitattributes"]); fixtureGit(f.cwd, ["commit", "-m", "Configure unsafe text conversion"]);
  const inspection = await f.service.inspectGitFile("src/renamed.ts", "HEAD");
  expect(inspection.revision?.content).toMatchObject({ kind: "text", text: f.changedText });
  expect(inspection.revision?.blame[59]).toMatchObject({ commit: f.edited, originalLine: 60 });
});

test("history crosses a re-add page boundary and retains the earlier file lifetime", async () => {
  const f = await fixture(), path = "src/lifetimes.ts";
  await writeFile(join(f.cwd, path), "old lifetime\n");
  fixtureGit(f.cwd, ["add", path]); fixtureGit(f.cwd, ["commit", "-m", "Old lifetime"]);
  const old = fixtureGit(f.cwd, ["rev-parse", "HEAD"]);
  fixtureGit(f.cwd, ["rm", path]); fixtureGit(f.cwd, ["commit", "-m", "Delete old lifetime"]);
  for (let index = 0; index < 100; index++) {
    await writeFile(join(f.cwd, path), `new lifetime ${index}\n`);
    fixtureGit(f.cwd, ["add", path]); fixtureGit(f.cwd, ["commit", "-m", `New lifetime ${index}`]);
  }
  const inspection = await f.service.inspectGitFile(path, "HEAD");
  expect(inspection.history!.commits.at(-1)?.summary).toBe("New lifetime 0");
  expect(inspection.history!.next).not.toBeNull();
  const older = await f.service.gitFileHistory(inspection.origin!, inspection.history!.next!);
  expect(older.commits.some(row => row.commit === old)).toBe(true);
});

test("merged side history retains rename ancestry and blame-origin immutable contents", async () => {
  const f = await fixture();
  fixtureGit(f.cwd, ["checkout", "-b", "side"]);
  fixtureGit(f.cwd, ["mv", "src/renamed.ts", "src/merged.ts"]);
  fixtureGit(f.cwd, ["commit", "-m", "Side rename"]);
  const renamed = fixtureGit(f.cwd, ["rev-parse", "HEAD"]);
  await writeFile(join(f.cwd, "src/merged.ts"), `${f.changedText}export const side = true;\n`);
  fixtureGit(f.cwd, ["add", "src/merged.ts"]); fixtureGit(f.cwd, ["commit", "-m", "Side edit"]);
  const side = fixtureGit(f.cwd, ["rev-parse", "HEAD"]);
  fixtureGit(f.cwd, ["checkout", "main"]);
  await writeFile(join(f.cwd, "unrelated.txt"), "main\n");
  fixtureGit(f.cwd, ["add", "unrelated.txt"]); fixtureGit(f.cwd, ["commit", "-m", "Main edit"]);
  fixtureGit(f.cwd, ["merge", "--no-ff", "side", "-m", "Merge side"]);
  const inspection = await f.service.inspectGitFile("src/merged.ts", "HEAD");
  expect(inspection.history!.commits.map(row => row.commit)).toContain(side);
  expect(inspection.history!.commits.map(row => row.commit)).toContain(renamed);
  expect(inspection.history!.commits.some(row => row.commit === f.first && row.path === "src/original.ts")).toBe(true);
  const blame = inspection.revision!.blame.at(-1)!;
  expect(blame.commit).toBe(side);
  expect((await f.service.gitFileRevision(inspection.origin!, blame)).content).toMatchObject({ kind: "text", text: `${f.changedText}export const side = true;\n` });
});

test("denied working text does not hide readable committed history", async () => {
  const f = await fixture(), path = join(f.cwd, "src/renamed.ts");
  await chmod(path, 0);
  try {
    const inspection = await f.service.inspectGitFile("src/renamed.ts", "HEAD");
    expect(inspection).toMatchObject({ working: null, workingUnavailable: "denied" });
    expect(inspection.revision?.content).toMatchObject({ kind: "text", text: f.changedText });
    expect(inspection.history!.commits.map(row => row.commit)).toContain(f.first);
  } finally { await chmod(path, 0o644); }
});

test("bounded empty history pages continue to real file changes", async () => {
  const f = await fixture();
  for (let index = 0; index < 105; index++) fixtureGit(f.cwd, ["commit", "--allow-empty", "-m", `Unrelated ${index}`]);
  const inspection = await f.service.inspectGitFile("src/renamed.ts", "HEAD");
  expect(inspection.history!.commits).toEqual([]);
  expect(inspection.history!.next).not.toBeNull();
  const page = await f.service.gitFileHistory(inspection.origin!, inspection.history!.next!);
  expect(page.commits.map(row => row.commit)).toEqual([f.renamed, f.edited, f.first]);
  expect(page.next).toBeNull();
});

test("merge change labels and parent links describe the same differing edge", async () => {
  const f = await fixture();
  fixtureGit(f.cwd, ["checkout", "-b", "other-edge"]);
  await writeFile(join(f.cwd, "src/renamed.ts"), `${f.changedText}export const other = true;\n`);
  fixtureGit(f.cwd, ["commit", "-am", "Other edge changes file"]);
  const side = fixtureGit(f.cwd, ["rev-parse", "HEAD"]);
  fixtureGit(f.cwd, ["checkout", "main"]);
  fixtureGit(f.cwd, ["merge", "--no-ff", "-s", "ours", "other-edge", "-m", "Keep first parent"]);
  const merged = fixtureGit(f.cwd, ["rev-parse", "HEAD"]);
  const inspection = await f.service.inspectGitFile("src/renamed.ts", "HEAD");
  const row = inspection.history!.commits.find(value => value.commit === merged)!;
  expect(row).toMatchObject({ change: "M", previous: { commit: side, path: "src/renamed.ts" } });
  expect((await f.service.gitFileRevision(inspection.origin!, row.previous!)).content).toMatchObject({ kind: "text", text: `${f.changedText}export const other = true;\n` });
  expect((await f.service.gitFileRevision(inspection.origin!, row)).content).toMatchObject({ kind: "text", text: f.changedText });
});

test("configured rename limits cannot silently truncate modified-rename ancestry", async () => {
  const f = await fixture();
  for (let index = 0; index < 3; index++) await writeFile(join(f.cwd, `src/before-${index}.ts`), Array.from({ length: 100 }, (_, line) => `export const item${index}Line${line} = ${line};`).join("\n") + "\n");
  fixtureGit(f.cwd, ["add", "."]); fixtureGit(f.cwd, ["commit", "-m", "Distinct originals"]);
  const original = fixtureGit(f.cwd, ["rev-parse", "HEAD"]);
  for (let index = 0; index < 3; index++) {
    fixtureGit(f.cwd, ["mv", `src/before-${index}.ts`, `src/after-${index}.ts`]);
    await writeFile(join(f.cwd, `src/after-${index}.ts`), Array.from({ length: 100 }, (_, line) => `export const item${index}Line${line} = ${line};`).join("\n") + "\n// modified during rename\n");
  }
  fixtureGit(f.cwd, ["add", "."]); fixtureGit(f.cwd, ["commit", "-m", "Several modified renames"]);
  fixtureGit(f.cwd, ["config", "diff.renameLimit", "1"]);
  const inspection = await f.service.inspectGitFile("src/after-1.ts", "HEAD");
  expect(inspection.history!.commits.some(row => row.commit === original && row.path === "src/before-1.ts")).toBe(true);
  expect(inspection.history!.commits[0]?.previous?.path).toBe("src/before-1.ts");
});
