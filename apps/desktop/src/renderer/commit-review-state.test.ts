import { expect, test } from "bun:test";
import { CommitReviewState, type CommitReviewOptions } from "./commit-review-state";
import type { GitCommitReviewFile, GitCommitReviewSelection, GitReviewCommit } from "../../../../packages/shared/src/git-commit-review";
import type { WorkspaceQuery, WorkspaceQueryResult } from "../../../../packages/shared/src/workspace-protocol";

const OWNER = "a".repeat(64), OTHER_OWNER = "b".repeat(64);
const row = (commit: string): GitReviewCommit => ({ commit, committedAt: "2026-01-01T00:00:00Z", subject: `Subject ${commit}`, message: `Subject ${commit}\n\nBody` });
const file = (path: string, previousPath: string | null = null): GitCommitReviewFile => ({ path, previousPath, change: previousPath ? "R" : "M", oldMode: "100644", newMode: "100644", oldOid: "1".repeat(40), newOid: "2".repeat(40), additions: 1, deletions: 0 });
/** Each transport reply settles through a fixed number of awaits; drain those microtasks without a clock. */
const tick = async () => { for (let hop = 0; hop < 8; hop++) await Promise.resolve(); };
function fixture(options: Partial<CommitReviewOptions> = {}) {
  const listeners = new Set<() => void>();
  const requests: { query: WorkspaceQuery; resolve(value: WorkspaceQueryResult): void; reject(cause: unknown): void }[] = [];
  const workspace = { connected: true, repositoryInvalidation: 0,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    query(query: WorkspaceQuery) { const { promise, resolve, reject } = Promise.withResolvers<WorkspaceQueryResult>(); requests.push({ query, resolve, reject }); return promise; } };
  let invalidations = 0;
  const state = new CommitReviewState(workspace, () => { invalidations++; });
  const current: CommitReviewOptions = { active: true, sourceActive: false, pickerOpen: false, ...options };
  const configure = (patch: Partial<CommitReviewOptions>) => { Object.assign(current, patch); state.configure({ ...current }); };
  const notify = () => { for (const listener of listeners) listener(); };
  const replyList = (index: number, commits: string[], repositoryId = OWNER) => {
    const request = requests[index]!; if (request.query.type !== "git.commit-review-commits") throw new Error(`Request ${index} is ${request.query.type}`);
    request.resolve({ type: "git.commit-review-commits", list: { repositoryId, head: commits[0] ?? null, mergeBase: "m".repeat(40), commits: commits.map(row) } });
  };
  const replyReview = (index: number, files: GitCommitReviewFile[], selection?: GitCommitReviewSelection) => {
    const request = requests[index]!; if (request.query.type !== "git.commit-review") throw new Error(`Request ${index} is ${request.query.type}`);
    const actual = selection ?? request.query.selection;
    request.resolve({ type: "git.commit-review", review: { selection: actual, commit: row(actual.commit), parent: "p".repeat(40), files } });
  };
  const replyDiff = (index: number, patch: string, override: Partial<{ path: string; selection: GitCommitReviewSelection }> = {}) => {
    const request = requests[index]!; if (request.query.type !== "git.commit-review-diff") throw new Error(`Request ${index} is ${request.query.type}`);
    request.resolve({ type: "git.commit-review-diff", diff: { selection: override.selection ?? request.query.selection, parent: "p".repeat(40), path: override.path ?? request.query.file.path, patch } });
  };
  state.configure({ ...current });
  return { state, workspace, requests, configure, notify, replyList, replyReview, replyDiff, invalidations: () => invalidations };
}
/** Loads the picker, selects `commit`, switches the shared source to Commit and answers the snapshot. */
async function selected(files: GitCommitReviewFile[] = [file("src/a.ts")], commit = "c1") {
  const f = fixture({ pickerOpen: true }); f.replyList(0, ["c1", "c2"]); await tick();
  f.state.selectCommit(row(commit)); f.configure({ sourceActive: true, pickerOpen: false });
  f.replyReview(1, files); await tick();
  return f;
}

test("the list loads only for an open picker or Commit source, and a base change replaces membership without touching the selected snapshot", async () => {
  const f = fixture(); expect(f.requests).toHaveLength(0);
  f.configure({ pickerOpen: true }); expect(f.state.getSnapshot()).toMatchObject({ listLoading: true });
  f.replyList(0, ["c1", "c2"]); await tick();
  f.state.selectCommit(row("c2")); f.configure({ sourceActive: true, pickerOpen: false });
  expect(f.requests[1]!.query).toEqual({ type: "git.commit-review", selection: { repositoryId: OWNER, commit: "c2" } });
  f.configure({ baseBranch: "release" });
  expect(f.requests[2]!.query).toEqual({ type: "git.commit-review-commits", baseBranch: "release" });
  expect(f.state.getSnapshot()).toMatchObject({ list: undefined, listLoading: true, loading: true, selection: { commit: "c2" } });
  f.replyReview(1, [file("src/a.ts")]); await tick();
  expect(f.state.getSnapshot().review?.commit.commit).toBe("c2");
  f.replyList(2, ["c2", "c3"]); await tick();
  expect(f.state.getSnapshot().list?.commits.map(row => row.commit)).toEqual(["c2", "c3"]);
  expect(f.state.getSnapshot().review?.commit.commit).toBe("c2"); expect(f.requests).toHaveLength(3);
  f.configure({ sourceActive: false }); expect(f.state.getSnapshot()).toMatchObject({ list: undefined, listLoading: false, selection: { commit: "c2" }, review: undefined });
});
test("a stale list reply for the previous base cannot replace the newer read", async () => {
  const f = fixture({ pickerOpen: true }); f.configure({ baseBranch: "release" });
  f.replyList(0, ["old"]); await tick(); expect(f.state.getSnapshot()).toMatchObject({ list: undefined, listLoading: true });
  f.replyList(1, ["new"]); await tick(); expect(f.state.getSnapshot().list?.commits.map(row => row.commit)).toEqual(["new"]);
});
test("list failure is retryable and distinct from an empty authoritative list; only the latter clears the selection", async () => {
  const f = await selected();
  f.workspace.repositoryInvalidation++; f.notify();
  f.requests[2]!.reject(new Error("git failed")); await tick();
  expect(f.state.getSnapshot()).toMatchObject({ list: undefined, listLoading: false, listError: "git failed", selection: { commit: "c1" } });
  expect(f.state.getSnapshot().review?.commit.commit).toBe("c1"); expect(f.invalidations()).toBe(0);
  f.state.retryCommits(); expect(f.state.getSnapshot()).toMatchObject({ listLoading: true, listError: undefined });
  f.replyList(3, []); await tick();
  expect(f.state.getSnapshot()).toMatchObject({ selection: null, review: undefined, loading: false, listError: undefined });
  expect(f.state.getSnapshot().list?.commits).toEqual([]); expect(f.invalidations()).toBe(1);
});
test("an authoritative list from another owner invalidates the selection while a silent removal outside Commit mode only clears it", async () => {
  const f = await selected();
  f.workspace.repositoryInvalidation++; f.notify(); f.replyList(2, ["c1", "c2"], OTHER_OWNER); await tick();
  expect(f.state.getSnapshot()).toMatchObject({ selection: null, review: undefined }); expect(f.invalidations()).toBe(1);
  const g = await selected(); g.configure({ sourceActive: false, pickerOpen: true }); expect(g.requests).toHaveLength(2);
  g.workspace.repositoryInvalidation++; g.notify(); g.replyList(2, ["c2"]); await tick();
  expect(g.state.getSnapshot().selection).toBeNull(); expect(g.invalidations()).toBe(0);
});
test("leaving Commit retires the snapshot read but keeps the SHA; returning re-reads and the old reply is dropped", async () => {
  const f = fixture({ pickerOpen: true }); f.replyList(0, ["c1"]); await tick();
  f.state.selectCommit(row("c1")); f.configure({ sourceActive: true, pickerOpen: false });
  f.configure({ sourceActive: false }); f.replyReview(1, [file("old.ts")]); await tick();
  expect(f.state.getSnapshot()).toMatchObject({ selection: { commit: "c1" }, review: undefined, loading: false }); expect(f.requests).toHaveLength(2);
  f.configure({ sourceActive: true }); expect(f.requests[2]!.query).toMatchObject({ type: "git.commit-review" });
  f.replyReview(2, [file("new.ts")]); await tick();
  expect(f.state.getSnapshot().review?.files.map(file => file.path)).toEqual(["new.ts"]);
});
test("a newer selection rejects the previous commit's late snapshot and file patches", async () => {
  const f = await selected([file("src/a.ts")]);
  f.state.requestFile(file("src/a.ts")); f.state.selectPath("src/a.ts");
  f.state.selectCommit(row("c2"));
  expect(f.state.getSnapshot()).toMatchObject({ selection: { commit: "c2" }, path: undefined, review: undefined, loading: true });
  f.replyDiff(2, "old patch"); await tick(); expect(f.state.getSnapshot().diffs.size).toBe(0);
  expect(f.requests[3]!.query).toEqual({ type: "git.commit-review", selection: { repositoryId: OWNER, commit: "c2" } });
  f.replyReview(3, [file("src/b.ts")], { repositoryId: OWNER, commit: "c1" }); await tick();
  expect(f.state.getSnapshot()).toMatchObject({ review: undefined, loading: false, error: "The host returned a different commit." });
  f.state.refresh(); f.replyReview(4, [file("src/b.ts")]); await tick();
  expect(f.state.getSnapshot().review?.selection.commit).toBe("c2");
});
test("file reads are deduplicated, bounded, rename-aware, and only errors re-request", async () => {
  const files = [file("a"), file("b"), file("c"), file("d"), file("e"), file("renamed.ts", "original.ts")];
  const f = await selected(files);
  for (const entry of files) f.state.requestFile(entry);
  f.state.requestFile(file("a")); f.state.requestFile(file("unknown"));
  expect(f.requests).toHaveLength(6); expect(f.state.getSnapshot().diffs.get("renamed.ts")).toEqual({ loading: true });
  f.replyDiff(2, "patch a"); await tick();
  expect(f.requests).toHaveLength(7); expect(f.requests[6]!.query).toMatchObject({ type: "git.commit-review-diff", file: { path: "e" } });
  f.replyDiff(3, "wrong", { path: "z" }); await tick();
  expect(f.state.getSnapshot().diffs.get("b")).toEqual({ loading: false, error: "The host returned a different file diff." });
  expect(f.requests[7]!.query).toMatchObject({ file: { path: "renamed.ts", previousPath: "original.ts" } });
  f.state.requestFile(file("a")); f.state.requestFile(file("b")); expect(f.requests).toHaveLength(8);
  expect(f.state.getSnapshot().diffs.get("b")).toEqual({ loading: true });
  f.replyDiff(4, "patch c"); await tick();
  expect(f.requests).toHaveLength(9); expect(f.requests[8]!.query).toMatchObject({ file: { path: "b" } });
  f.replyDiff(8, "patch b"); await tick();
  expect(f.state.getSnapshot().diffs.get("a")).toEqual({ loading: false, patch: "patch a" });
  expect(f.state.getSnapshot().diffs.get("b")).toEqual({ loading: false, patch: "patch b" });
});
test("disconnect retires every read and keeps the SHA; reconnect re-reads and drops replies from the old connection", async () => {
  const f = await selected([file("src/a.ts")]);
  f.state.requestFile(file("src/a.ts"));
  f.workspace.connected = false; f.notify();
  expect(f.state.getSnapshot()).toMatchObject({ selection: { commit: "c1" }, review: undefined, listError: "Reconnect to refresh commits.", error: "Reconnect to refresh commit changes." });
  expect(f.state.getSnapshot().diffs.size).toBe(0);
  f.workspace.connected = true; f.notify();
  f.replyDiff(2, "stale"); f.replyList(0, ["c1"]); await tick();
  expect(f.state.getSnapshot().diffs.size).toBe(0);
  const types = f.requests.slice(3).map(request => request.query.type).sort();
  expect(types).toEqual(["git.commit-review", "git.commit-review-commits"]);
  f.replyReview(f.requests.findIndex((request, index) => index >= 3 && request.query.type === "git.commit-review"), [file("src/a.ts")]); await tick();
  expect(f.state.getSnapshot()).toMatchObject({ loading: false, error: undefined }); expect(f.state.getSnapshot().review?.commit.commit).toBe("c1");
});
