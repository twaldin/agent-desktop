import { expect, test } from "bun:test";
import type { GitActionContext, GitPushDestination } from "@agent-desktop/shared";
import { gitActionReasons, readGitSelectionSummary } from "./git-submission-view";

const destination: GitPushDestination = { remote: "origin", targetRef: "refs/heads/main", revision: "destination", requiresUpstreamSetup: false, localTrackingRef: "refs/remotes/origin/main", commitsAhead: 0, commitsBehind: 0 };
const context: GitActionContext = { revision: "context", status: { revision: "status", branch: "main", head: "abc", upstream: "origin/main", ahead: 0, behind: 0, entries: [{ path: "mixed", indexStatus: "M", worktreeStatus: "M", kind: "tracked", submodule: false }] }, push: { state: "available", destination, alternatives: [], freshness: "local-config-and-refs" } };

test("new commit can push despite zero ahead; clean push and first-upstream states remain distinct", () => {
  expect(gitActionReasons({ context, destination, includeUnstaged: false })).toEqual({ commit: undefined, "commit-and-push": undefined, push: "No commits to push." });
  const clean = { ...context, status: { ...context.status, entries: [] } };
  expect(gitActionReasons({ context: clean, destination: { ...destination, commitsAhead: 2 }, includeUnstaged: true })).toEqual({ commit: "No changes to commit.", "commit-and-push": "No changes to commit.", push: undefined });
  expect(gitActionReasons({ context: clean, destination: { ...destination, requiresUpstreamSetup: true, commitsAhead: null, localTrackingRef: null }, includeUnstaged: true }).push).toBeUndefined();
});

test("unstaged selection, conflicts and failed reads cannot masquerade as a committable staged snapshot", () => {
  const unstaged = { ...context, status: { ...context.status, entries: [{ ...context.status.entries[0]!, indexStatus: "." }] } };
  expect(gitActionReasons({ context: unstaged, destination, includeUnstaged: false }).commit).toBe("No changes to commit.");
  expect(gitActionReasons({ context: unstaged, destination, includeUnstaged: true }).commit).toBeUndefined();
  const conflicted: GitActionContext = { ...context, status: { ...context.status, entries: [{ ...context.status.entries[0]!, kind: "conflict" }] } };
  expect(gitActionReasons({ context: conflicted, destination, includeUnstaged: true }).commit).toContain("Resolve conflicts");
  expect(gitActionReasons({ context, destination, includeUnstaged: true, selectionUnavailable: "Diff read failed" })["commit-and-push"]).toBe("Diff read failed");
});

test("selection totals come from one matching host summary, including net-zero mixed changes", async () => {
  const calls: unknown[] = [];
  const summary = { selectionMode: "include-unstaged" as const, reviewedRevision: context.status.revision, selectedTree: "tree", additions: 0, deletions: 0, binaryFiles: 0, files: 0 };
  const data: Parameters<typeof readGitSelectionSummary>[0] = { query: async query => {
    calls.push(query);
    return { type: "git.selection-summary", contextRevision: context.revision, summary };
  } };
  expect(await readGitSelectionSummary(data, context, true)).toEqual(summary);
  expect(calls).toEqual([{ type: "git.selection-summary", contextRevision: context.revision, selectionMode: "include-unstaged" }]);
});

test("wrong revision, mode, malformed totals and unavailable host summary cannot become display totals", async () => {
  const summary = { selectionMode: "staged" as const, reviewedRevision: context.status.revision, selectedTree: "tree", additions: 1, deletions: 1, binaryFiles: 0, files: 1 };
  for (const result of [
    { type: "git.selection-summary" as const, contextRevision: "stale", summary },
    { type: "git.selection-summary" as const, contextRevision: context.revision, summary: { ...summary, reviewedRevision: "stale" } },
    { type: "git.selection-summary" as const, contextRevision: context.revision, summary: { ...summary, selectionMode: "include-unstaged" as const } },
    { type: "git.selection-summary" as const, contextRevision: context.revision, summary: { ...summary, additions: -1 } },
  ]) await expect(readGitSelectionSummary({ query: async () => result }, context, false)).rejects.toThrow();
  let calls = 0;
  await expect(readGitSelectionSummary({ query: async () => { calls++; throw new Error("Summary unavailable"); } }, context, false)).rejects.toThrow("Summary unavailable");
  expect(calls).toBe(1);
});

test("cancelled summary reads never publish a delayed response or issue a fallback query", async () => {
  const abort = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const pending = readGitSelectionSummary({ query: async () => {
    calls++;
    await gate;
    return { type: "git.selection-summary", contextRevision: context.revision, summary: { selectionMode: "staged", reviewedRevision: context.status.revision, selectedTree: "tree", additions: 1, deletions: 0, binaryFiles: 0, files: 1 } };
  } }, context, false, abort.signal);
  abort.abort(new Error("Selection changed")); release();
  await expect(pending).rejects.toThrow("Selection changed");
  expect(calls).toBe(1);
  await expect(readGitSelectionSummary({ query: async () => { calls++; throw new Error("must not read"); } }, context, false, abort.signal)).rejects.toThrow("Selection changed");
  expect(calls).toBe(1);
});
