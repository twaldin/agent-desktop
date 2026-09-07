import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { HostWorkspaces, parseWorkspaceMutation, parseWorkspaceQuery } from "./workspace-http";
import { WorkspaceFileOpen, type WorkspaceFileOpenRuntime } from "./workspace-open";

const roots: string[] = [];
const stores = new Set<HostStore>();
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(launch?: WorkspaceFileOpenRuntime["launch"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-file-open-"))); roots.push(root);
  const cwd = join(root, "project"), data = join(root, "data"); await mkdir(cwd); await writeFile(join(cwd, "file name.ts"), "export {}\n");
  const store = new HostStore(data); stores.add(store); const project = store.addProject({ path: cwd });
  const present = new Set(["/usr/bin/open", "/Applications/Visual Studio Code.app", "/System/Applications/Utilities/Terminal.app"]);
  const launches: Array<{ executable: string; args: string[]; cwd: string }> = [];
  const runtime: WorkspaceFileOpenRuntime = {
    platform: "darwin", environment: {}, homeDirectory: join(root, "home"),
    available: async path => present.has(path),
    launch: launch ?? (async (executable, args, directory) => { launches.push({ executable, args, cwd: directory }); }),
  };
  const workspaces = new HostWorkspaces(store, data, () => () => {}, undefined, undefined, new WorkspaceFileOpen(runtime));
  return { root, cwd, project, workspaces, launches, present, runtime };
}

describe("host-owned external file opening", () => {
  test("discovers installed fixed targets and launches an exact canonical owner path", async () => {
    const f = await fixture();
    expect(parseWorkspaceQuery({ type: "file.open-options", path: "file name.ts" })).toEqual({ type: "file.open-options", path: "file name.ts" });
    expect(parseWorkspaceMutation({ type: "file.open", path: "file name.ts", targetId: "vscode" })).toEqual({ type: "file.open", path: "file name.ts", targetId: "vscode" });
    const options = await f.workspaces.query({ projectId: f.project.id }, { type: "file.open-options", path: "file name.ts" });
    expect(options).toEqual({ type: "file.open-options", path: "file name.ts", preferredTargetId: "fileManager", targets: [
      { id: "vscode", label: "VS Code", kind: "editor" },
      { id: "systemDefault", label: "Default app", kind: "editor" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
      { id: "fileManager", label: "Finder", kind: "file-manager" },
    ] });
    expect(await f.workspaces.mutate({ projectId: f.project.id }, { type: "file.open", path: "file name.ts", targetId: "vscode" }))
      .toEqual({ type: "file.open", targetId: "vscode" });
    expect(f.launches).toEqual([{ executable: "/usr/bin/open", args: ["-a", "/Applications/Visual Studio Code.app", join(f.cwd, "file name.ts")], cwd: f.cwd }]);
  });

  test("reveals the file, opens a terminal directory, and never places shell text in argv", async () => {
    const f = await fixture(), path = "file name.ts";
    await f.workspaces.mutate({ projectId: f.project.id }, { type: "file.open", path, targetId: "fileManager" });
    await f.workspaces.mutate({ projectId: f.project.id }, { type: "file.open", path, targetId: "terminal" });
    expect(f.launches).toEqual([
      { executable: "/usr/bin/open", args: ["-R", join(f.cwd, path)], cwd: f.cwd },
      { executable: "/usr/bin/open", args: ["-a", "/System/Applications/Utilities/Terminal.app", f.cwd], cwd: f.cwd },
    ]);
  });

  test("rejects missing, non-file, and escaped targets before any launch", async () => {
    const f = await fixture(); await mkdir(join(f.cwd, "folder")); await writeFile(join(f.root, "outside.ts"), "outside\n");
    await symlink(join(f.root, "outside.ts"), join(f.cwd, "outside-link.ts"));
    for (const path of ["missing.ts", "folder", "../outside.ts", "outside-link.ts"]) {
      await expect(f.workspaces.query({ projectId: f.project.id }, { type: "file.open-options", path })).rejects.toThrow();
    }
    await expect(f.workspaces.mutate({ projectId: f.project.id }, { type: "file.open", path: "file name.ts", targetId: "not-installed" }))
      .rejects.toMatchObject({ code: "OPEN_TARGET_UNAVAILABLE" });
    expect(f.launches).toEqual([]);
  });

  test("reports post-dispatch launch failure as an unknown outcome", async () => {
    const f = await fixture(async () => { throw new Error("fixture launcher lost its result"); });
    await expect(f.workspaces.mutate({ projectId: f.project.id }, { type: "file.open", path: "file name.ts", targetId: "systemDefault" }))
      .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  test("refreshes target availability and the canonical file immediately before launch", async () => {
    const f = await fixture();
    await f.workspaces.query({ projectId: f.project.id }, { type: "file.open-options", path: "file name.ts" });
    f.present.delete("/Applications/Visual Studio Code.app");
    await expect(f.workspaces.mutate({ projectId: f.project.id }, { type: "file.open", path: "file name.ts", targetId: "vscode" }))
      .rejects.toMatchObject({ code: "OPEN_TARGET_UNAVAILABLE" });
    const first = join(f.cwd, "first.ts"), second = join(f.cwd, "second.ts"), selected = join(f.cwd, "selected.ts");
    await writeFile(first, "first\n"); await writeFile(second, "second\n"); await symlink(first, selected);
    f.present.add("/Applications/Visual Studio Code.app");
    const originalAvailable = f.runtime.available; let swapped = false;
    f.runtime.available = async (path, kind) => {
      if (!swapped && path === "/Applications/Visual Studio Code.app") { swapped = true; await unlink(selected); await symlink(second, selected); }
      return originalAvailable(path, kind);
    };
    await f.workspaces.mutate({ projectId: f.project.id }, { type: "file.open", path: "selected.ts", targetId: "vscode" });
    expect(f.launches.at(-1)?.args.at(-1)).toBe(await realpath(second));
  });

  test("uses graphical Linux target argv without waiting on a resident application", async () => {
    const launches: Array<{ executable: string; args: string[]; cwd: string }> = [];
    const present = new Set(["/usr/bin/xdg-open", "/usr/bin/ghostty"]);
    const runtime: WorkspaceFileOpenRuntime = { platform: "linux", environment: { DISPLAY: ":1" }, homeDirectory: "/home/fixture",
      available: async path => present.has(path), launch: async (executable, args, cwd) => { launches.push({ executable, args, cwd }); } };
    const service = new WorkspaceFileOpen(runtime);
    expect((await service.options("src/file.ts")).targets.map(target => target.id)).toEqual(["systemDefault", "ghostty", "fileManager"]);
    await service.open("/workspace", "ghostty", async () => "/workspace/src/file.ts");
    expect(launches).toEqual([{ executable: "/usr/bin/ghostty", args: ["--working-directory=/workspace/src"], cwd: "/workspace" }]);
  });

  test("does not advertise macOS apps when the fixed opener is unavailable", async () => {
    const runtime: WorkspaceFileOpenRuntime = { platform: "darwin", environment: {}, homeDirectory: "/Users/fixture",
      available: async path => path.endsWith("Zed.app"), launch: async () => {} };
    expect(await new WorkspaceFileOpen(runtime).options("file.ts")).toMatchObject({ targets: [], availabilityReason: expect.any(String) });
  });

  test("returns a specific incomplete state on a headless Linux host", async () => {
    const runtime: WorkspaceFileOpenRuntime = { platform: "linux", environment: {}, homeDirectory: "/home/fixture", available: async () => true, launch: async () => {} };
    expect(await new WorkspaceFileOpen(runtime).options("file.ts")).toEqual({
      type: "file.open-options", path: "file.ts", targets: [], availabilityReason: "This Linux host has no graphical desktop session.",
    });
  });
});
