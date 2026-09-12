import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceQuery } from "@agent-desktop/shared";
import { HostStore } from "../store";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import { WorkspaceService } from "./service";

const roots: string[] = [];
const stores = new Set<HostStore>();
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-files-search-"));
  roots.push(root);
  const cwd = join(root, "project"), data = join(root, "data");
  await mkdir(cwd);
  return { root, cwd, data, service: new WorkspaceService(cwd) };
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}

test("native filename search is bounded to previewable, non-hidden, non-ignored workspace files", async () => {
  const f = await fixture();
  git(f.cwd, "init", "-q");
  await Promise.all([
    writeFile(join(f.cwd, "needle-visible.ts"), "visible"),
    writeFile(join(f.cwd, ".needle-hidden.ts"), "hidden"),
    writeFile(join(f.cwd, "needle-ignored.ts"), "ignored"),
    writeFile(join(f.cwd, ".gitignore"), "needle-ignored.ts\n"),
    mkdir(join(f.cwd, "needle-directory")),
    writeFile(join(f.root, "needle-outside.ts"), "outside"),
  ]);
  await symlink("needle-visible.ts", join(f.cwd, "needle-inside-link.ts"));
  await symlink(join(f.root, "needle-outside.ts"), join(f.cwd, "needle-outside-link.ts"));
  await symlink("needle-missing.ts", join(f.cwd, "needle-missing-link.ts"));

  const result = await f.service.searchFiles(" needle ", 50);
  expect(result.status).toBe("complete");
  expect(result.nativeTotalMatches).toBeGreaterThanOrEqual(result.entries.length);
  expect(result.entries.map(entry => entry.path)).toContain("needle-visible.ts");
  expect(result.entries.map(entry => entry.path)).not.toContain(".needle-hidden.ts");
  expect(result.entries.map(entry => entry.path)).not.toContain("needle-ignored.ts");
  expect(result.entries.map(entry => entry.path)).not.toContain("needle-directory");
  expect(result.entries.map(entry => entry.path)).not.toContain("needle-outside-link.ts");
  expect(result.entries.map(entry => entry.path)).not.toContain("needle-missing-link.ts");
  for (const entry of result.entries) expect(entry.score).toBeNumber();
});

test("search rejects empty and oversized queries before scanning, and notices owner replacement", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "needle.ts"), "x");
  for (const query of ["", "   ", "needle\n", "x".repeat(513)])
    await expect(f.service.searchFiles(query)).rejects.toMatchObject({ code: "INVALID_SEARCH" });
  for (const limit of [0, 101, 1.5])
    await expect(f.service.searchFiles("needle", limit)).rejects.toMatchObject({ code: "INVALID_SEARCH" });
  await rename(f.cwd, join(f.root, "replaced"));
  await mkdir(f.cwd);
  await expect(f.service.searchFiles("needle")).rejects.toMatchObject({ code: "PATH_CHANGED" });
});

test("project-owned HTTP queries validate request bounds and deny directory search to standalone targets", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "needle.ts"), "x");
  const store = new HostStore(f.data); stores.add(store);
  const project = store.addProject({ path: f.cwd });
  const session = store.upsertSession({ id: "search-session", hostId: store.host.id, projectId: project.id, cwd: f.cwd,
    title: "Search fixture", status: "idle", sessionFile: join(f.data, "search-session.jsonl"), model: null,
    createdAt: 1, updatedAt: 1, archived: false });
  const workspaces = new HostWorkspaces(store, f.data, () => () => {});
  expect(parseWorkspaceQuery({ type: "files.search", query: " needle ", limit: 100 }))
    .toEqual({ type: "files.search", query: "needle", limit: 100 });
  for (const query of ["", " ", "x".repeat(513), "needle\n"])
    expect(() => parseWorkspaceQuery({ type: "files.search", query })).toThrow();
  for (const limit of [0, 101, 1.5])
    expect(() => parseWorkspaceQuery({ type: "files.search", query: "needle", limit })).toThrow();

  const result = await workspaces.query({ projectId: project.id }, { type: "files.search", query: "needle" });
  expect(result).toMatchObject({ type: "files.search", entries: [{ path: "needle.ts", kind: "file" }], status: "complete" });
  expect(await workspaces.query({ sessionId: session.id }, { type: "files.search", query: "needle" }))
    .toMatchObject({ type: "files.search", entries: [{ path: "needle.ts", kind: "file" }] });
  await expect(workspaces.query({ filePath: join(f.cwd, "needle.ts") }, { type: "files.search", query: "needle" } as WorkspaceQuery))
    .rejects.toThrow("standalone file target");
});
