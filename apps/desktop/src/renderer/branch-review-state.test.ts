import { expect, test } from "bun:test";
import { BranchReviewState, branchReviewState, TurnReviewState } from "./branch-review-state";
import type { BranchReview } from "../../../../packages/shared/src/branch-review";
import type { WorkspaceQuery, WorkspaceQueryResult } from "../../../../packages/shared/src/workspace-protocol";
import type { TurnReview } from "../../../../packages/shared/src/turn-review";
function fixture() {
  const listeners = new Set<() => void>();
  const requests: { query: WorkspaceQuery; resolve(value: WorkspaceQueryResult): void; reject(cause: unknown): void }[] = [];
  const workspace = { connected: true, repositoryInvalidation: 0, diffSelection: { staged: false },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    query(query: WorkspaceQuery) { return new Promise<WorkspaceQueryResult>((resolve, reject) => requests.push({ query, resolve, reject })); } };
  const state = new BranchReviewState(workspace);
  const notify = () => { for (const listener of listeners) listener(); };
  const reply = (index: number, patch = "native patch") => {
    const request = requests[index]!; if (request.query.type !== "git.branch-review") throw new Error("Wrong query");
    const review: BranchReview = { state: "available", requestedBase: request.query.baseBranch ?? null, baseBranch: request.query.baseBranch ?? "origin/main", currentBranch: "feature", path: request.query.path,
      revision: "a".repeat(64), head: "b".repeat(40), baseCommit: "c".repeat(40), mergeBase: "d".repeat(40), files: [], patch, binary: false };
    request.resolve({ type: "git.branch-review", review });
  };
  state.configure(true); state.selectSource("branch");
  return { state, workspace, requests, notify, reply };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test("base changes retire held reads and preserve the exact remote identity", async () => {
  const f = fixture(); expect(f.requests[0]!.query).toEqual({ type: "git.branch-review" });
  f.state.selectBase("refs/remotes/other/main"); f.reply(0, "old"); await tick();
  expect(f.state.getSnapshot().result).toBeUndefined();
  expect(f.requests[1]!.query).toEqual({ type: "git.branch-review", baseBranch: "refs/remotes/other/main" });
  f.reply(1, "right"); await tick(); expect(f.state.getSnapshot().result).toMatchObject({ patch: "right" });
});
test("source changes reject late success and late failure; reopening keeps base intent", async () => {
  const f = fixture(); f.state.selectBase("release"); f.state.selectSource("staged"); f.requests[0]!.reject(new Error("old failure")); await tick();
  expect(f.state.getSnapshot()).toMatchObject({ source: "staged", loading: false, baseBranch: "release" });
  expect(f.state.getSnapshot().error).toBeUndefined(); expect(f.requests).toHaveLength(1);
  f.state.configure(false); f.state.configure(true); f.state.selectSource("branch");
  expect(f.requests[1]!.query).toEqual({ type: "git.branch-review", baseBranch: "release" });
});
for (const boundary of ["connection", "repository", "closed"] as const) test(`${boundary} retirement rejects old response`, async () => {
  const f = fixture();
  if (boundary === "connection") { f.workspace.connected = false; f.notify(); f.workspace.connected = true; f.notify(); }
  if (boundary === "repository") { f.workspace.repositoryInvalidation++; f.notify(); }
  if (boundary === "closed") f.state.configure(false);
  f.reply(0, "obsolete"); await tick(); expect(f.state.getSnapshot().result).toBeUndefined();
  if (boundary !== "closed") { expect(f.requests).toHaveLength(2); f.reply(1, "fresh"); await tick(); expect(f.state.getSnapshot().result).toMatchObject({ patch: "fresh" }); }
});
test("path reads retain selected intent and reject mismatched response identity", async () => {
  const f = fixture(); f.reply(0); await tick(); f.state.selectPath("renamed.ts");
  expect(f.requests[1]!.query).toEqual({ type: "git.branch-review", path: "renamed.ts" });
  f.requests[1]!.resolve({ type: "git.branch-review", review: { state: "available", requestedBase: "other", baseBranch: "other", currentBranch: "feature", revision: "a", head: "b", baseCommit: "c", mergeBase: "d", files: [], patch: "wrong", binary: false } });
  await tick(); expect(f.state.getSnapshot().error).toContain("different branch comparison"); expect(f.state.getSnapshot().result).toBeUndefined();
});
test("selection remains local to its owning window workspace instance", () => {
  const first = fixture().workspace, second = fixture().workspace;
  const state = branchReviewState(first); state.selectBase("topic");
  expect(branchReviewState(first)).toBe(state); expect(branchReviewState(second).getSnapshot().baseBranch).toBeUndefined();
});

test("Last turn retires visible evidence immediately when its current conversation changes", async () => {
  const requests: Array<{ sessionId: string; resolve(value: TurnReview): void }> = [];
  const state = new TurnReviewState(sessionId => new Promise(resolve => requests.push({ sessionId, resolve })));
  const options = { active: true, sourceActive: true, connected: true, current: { hostId: "host", conversationId: "first" } };
  const reply = (index: number, patch: string) => requests[index]!.resolve({ sessionId: requests[index]!.sessionId, revision: patch, state: "pending", reason: "Running", selected: null, files: [], patch });
  state.configure(options); reply(0, "first evidence"); await tick();
  state.selectPath("first-only.txt");
  state.configure({ ...options, current: { hostId: "host", conversationId: "second" } });
  expect(state.getSnapshot().review).toBeUndefined();
  expect(state.getSnapshot().path).toBeUndefined();
  state.open({ conversationId: "historical", path: "recorded.txt" }, "other-host");
  reply(1, "retired second evidence"); await tick();
  expect(state.getSnapshot().review).toBeUndefined();
  expect(state.getSnapshot().path).toBe("recorded.txt");
  reply(2, "historical evidence"); await tick();
  expect(state.getSnapshot().review?.patch).toBe("historical evidence");
  state.configure({ ...options, current: { hostId: "host", conversationId: "third" } });
  expect(state.getSnapshot().review?.patch).toBe("historical evidence");
  state.useCurrent();
  expect(state.getSnapshot().review).toBeUndefined();
  expect(state.getSnapshot().path).toBeUndefined();
  reply(3, "third evidence"); await tick();
  expect(state.getSnapshot().review?.sessionId).toBe("third");
});
