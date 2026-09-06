import { expect, test } from "bun:test";
import { mapWorktreeDirectories, validateWorktreeDirectoryContext, type WorktreeDirectoryContext } from "./worktree-directories";

const context = (patch: Partial<WorktreeDirectoryContext> = {}): WorktreeDirectoryContext => ({
  sourceGitRoot: "/repo", sourceWorkspaceRoot: "/repo/apps/web", workspaceRelativePath: "apps/web", configCwdRelativePath: "apps", ...patch,
});

test("maps nested workspace and inherited config cwd without I/O", () => {
  expect(mapWorktreeDirectories(context(), "/managed/abcd/repo")).toEqual({
    worktreeGitRoot: "/managed/abcd/repo", worktreeWorkspaceRoot: "/managed/abcd/repo/apps/web",
    scriptCwd: "/managed/abcd/repo/apps", sourceWorkspaceRoot: "/repo/apps/web",
  });
  expect(mapWorktreeDirectories(context({ workspaceRelativePath: "", sourceWorkspaceRoot: "/repo", configCwdRelativePath: "" }), "/managed/repo").scriptCwd).toBe("/managed/repo");
});

test("rejects mismatched roots and path confusion", () => {
  for (const invalid of [
    context({ sourceWorkspaceRoot: "/repo/apps/api" }),
    context({ workspaceRelativePath: "/apps/web" }),
    context({ workspaceRelativePath: "../web" }),
    context({ workspaceRelativePath: "apps\\web" }),
    context({ configCwdRelativePath: "apps/web/generated" }),
    context({ configCwdRelativePath: "apps/api" }),
    context({ workspaceRelativePath: "apps/../apps/web" }),
    context({ configCwdRelativePath: "apps/.." }),
    context({ configCwdRelativePath: "./" }),
    context({ configCwdRelativePath: "." }),
    context({ configCwdRelativePath: "apps//web" }),
    context({ configCwdRelativePath: "apps/" }),
    context({ configCwdRelativePath: "apps\0" }),
  ]) expect(() => validateWorktreeDirectoryContext(invalid)).toThrow();
});

test("accepts Git-root and workspace config identities", () => {
  expect(validateWorktreeDirectoryContext(context({ workspaceRelativePath: "", sourceWorkspaceRoot: "/repo", configCwdRelativePath: null }))).toEqual({
    sourceGitRoot: "/repo", sourceWorkspaceRoot: "/repo", workspaceRelativePath: "", configCwdRelativePath: null,
  });
  expect(validateWorktreeDirectoryContext(context({ configCwdRelativePath: "apps/web" })).configCwdRelativePath).toBe("apps/web");
  expect(() => mapWorktreeDirectories(context(), "/managed/../escape")).toThrow("normalized absolute");
  expect(() => mapWorktreeDirectories(context(), "/repo")).toThrow("differ from the source");
});
