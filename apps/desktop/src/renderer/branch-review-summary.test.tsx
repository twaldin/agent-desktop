import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitReviewSummary, GitStatus, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { BranchReview, combineBranchReview, branchReviewPath } from "./branch-review-summary";
import { BranchChangeDescription } from "./BranchSwitchChanges";

const controllers: BranchReview[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.configure(false); });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function summary(source: GitReviewSummary["source"], additions = 1, deletions = 0): GitReviewSummary {
  return { source, revision: "a".repeat(64), stagedCount: 1, unstagedCount: 1, untrackedCount: 0,
    files: [{ path: "new.txt", previousPath: source === "staged" ? "old.txt" : null, additions, deletions }] };
}
function fixture() {
  const requests: Array<{ query: WorkspaceQuery; deferred: ReturnType<typeof deferred<WorkspaceQueryResult>> }> = [], listeners = new Set<() => void>();
  const workspace = { connected: true, status: { revision: "a".repeat(64) } as GitStatus,
    query(query: WorkspaceQuery) { const d = deferred<WorkspaceQueryResult>(); requests.push({ query, deferred: d }); return d.promise; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const controller = new BranchReview(workspace); controllers.push(controller);
  const emit = () => { for (const listener of listeners) listener(); };
  function reply(index: number, value?: GitReviewSummary) { const request = requests[index]!; if (request.query.type !== "git.review-summary") throw new Error("Wrong query"); request.deferred.resolve({ type: "git.review-summary", summary: value ?? summary(request.query.source) }); }
  return { workspace, requests, controller, emit, reply, connection(value: boolean) { workspace.connected = value; emit(); } };
}

test("native two-source sums include cancellation, rename aliases, binary zero and max-count fallback", () => {
  const staged = summary("staged", 2, 0), unstaged = summary("unstaged", 0, 2);
  staged.stagedCount = unstaged.stagedCount = 2; staged.unstagedCount = unstaged.unstagedCount = 3;
  staged.untrackedCount = unstaged.untrackedCount = 4;
  unstaged.files.push({ path: "binary", previousPath: null, additions: null, deletions: null });
  const value = combineBranchReview(staged, unstaged);
  expect(value).toMatchObject({ additions: 2, deletions: 2, fileCount: 7 });
  expect(branchReviewPath(value, ' "./a/new.txt" ')).toEqual({ additions: 2, deletions: 2 });
  expect(branchReviewPath(value, "'b/old.txt'")).toEqual({ additions: 2, deletions: 0 });
  expect(branchReviewPath(value, "binary")).toEqual({ additions: 0, deletions: 0 });
  expect(branchReviewPath(value, "missing")).toBeUndefined();
});

test("actual controller publishes only the complete validated pair and copies response rows", async () => {
  const f = fixture(); f.controller.configure(true); await flush(); expect(f.requests.map(row => row.query)).toEqual([
    { type: "git.review-summary", source: "staged" }, { type: "git.review-summary", source: "unstaged" }]);
  const response = summary("staged", 3, 0); f.reply(0, response); await flush(); expect(f.controller.getSnapshot()).toEqual({ loading: true, error: undefined });
  f.reply(1, summary("unstaged", 0, 2)); await flush();
  expect(f.controller.getSnapshot()).toMatchObject({ loading: false, value: { additions: 3, deletions: 2, fileCount: 1 } });
  response.files[0]!.additions = 999; expect(f.controller.getSnapshot().value!.additions).toBe(3);
  f.emit(); f.emit(); await flush(); expect(f.requests).toHaveLength(2);
});

for (const boundary of ["first", "second"] as const) test(`disconnect/reconnect while ${boundary} source is held discards both old results`, async () => {
  const f = fixture(); f.controller.configure(true); await flush();
  const ready = boundary === "first" ? 1 : 0; f.reply(ready); await flush();
  f.connection(false); f.connection(true); await flush();
  expect(f.requests).toHaveLength(2); expect(f.controller.getSnapshot().value).toBeUndefined();
  f.reply(1 - ready); await flush(); expect(f.requests).toHaveLength(4);
  expect(f.controller.getSnapshot().value).toBeUndefined();
  f.reply(2, summary("staged", 7, 0)); f.reply(3, summary("unstaged", 0, 8)); await flush();
  expect(f.controller.getSnapshot().value).toMatchObject({ additions: 7, deletions: 8 });
});

test("status object refresh invalidates same-index working statistics and drains before replacement", async () => {
  const f = fixture(); f.controller.configure(true); await flush();
  f.workspace.status = { ...f.workspace.status }; f.emit(); await flush(); expect(f.requests).toHaveLength(2);
  f.reply(0, summary("staged", 99)); f.reply(1, summary("unstaged", 98)); await flush();
  expect(f.requests).toHaveLength(4); expect(f.controller.getSnapshot().value).toBeUndefined();
  f.reply(2); f.reply(3); await flush(); expect(f.controller.getSnapshot().value!.additions).toBe(2);
});

test("early error and repeated retry never exceed the original two in-flight reads", async () => {
  const f = fixture(); f.controller.configure(true); await flush();
  f.requests[0]!.deferred.reject(new Error("early failure")); await flush();
  f.controller.retry(); f.controller.retry(); await flush(); expect(f.requests).toHaveLength(2);
  f.reply(1); await flush(); expect(f.requests).toHaveLength(4);
  f.reply(2); f.reply(3); await flush(); expect(f.controller.getSnapshot().error).toBeUndefined();
});

test("close and owner replacement discard late success/error; reopen starts a fresh pair", async () => {
  const old = fixture(), next = fixture(); old.controller.configure(true); await flush();
  old.controller.configure(false); next.controller.configure(true); await flush();
  old.reply(0); old.requests[1]!.deferred.reject(new Error("old owner")); await flush();
  expect(old.controller.getSnapshot()).toEqual({ loading: false }); expect(next.controller.getSnapshot().value).toBeUndefined();
  next.reply(0); next.reply(1); await flush(); expect(next.controller.getSnapshot().value!.additions).toBe(2);
  old.controller.configure(true); await flush(); expect(old.requests).toHaveLength(4);
});

test("closing before deferred query dispatch sends neither source", async () => {
  const f = fixture(); f.controller.configure(true); f.controller.configure(false); await flush();
  expect(f.requests).toEqual([]); expect(f.controller.getSnapshot()).toEqual({ loading: false });
});

for (const invalid of ["wrong-source", "wrong-type", "different-revision", "different-counts", "null-summary", "negative", "mixed-null", "invalid-path", "overflow"] as const)
  test(`reject ${invalid} instead of publishing false statistics`, async () => {
    const f = fixture(); f.controller.configure(true); await flush(); f.reply(0);
    const value = summary("unstaged");
    if (invalid === "wrong-source") value.source = "staged";
    if (invalid === "different-revision") value.revision = "b".repeat(64);
    if (invalid === "different-counts") value.stagedCount = 2;
    if (invalid === "negative") value.files[0]!.additions = -1;
    if (invalid === "mixed-null") value.files[0]!.additions = null;
    if (invalid === "invalid-path") value.files[0]!.path = "bad\0path";
    if (invalid === "overflow") value.files[0]!.additions = Number.MAX_SAFE_INTEGER;
    if (invalid === "wrong-type") f.requests[1]!.deferred.resolve({ type: "git.branches", branches: [] });
    else if (invalid === "null-summary") f.requests[1]!.deferred.resolve({ type: "git.review-summary", summary: null } as unknown as WorkspaceQueryResult);
    else f.reply(1, value);
    await flush(); expect(f.controller.getSnapshot().value).toBeUndefined(); expect(f.controller.getSnapshot().error).toBeTruthy();
  });

test("actual description renders path/rename stats and authoritative max file count; unknown is not zero", () => {
  const value = combineBranchReview(summary("staged", 4, 0), summary("unstaged", 0, 3));
  const row = renderToStaticMarkup(<BranchChangeDescription paths={["old.txt", "new.txt", "missing"]} branch="feature" snapshot={{ loading: false, value }} retry={() => {}}/>);
  expect(row).toContain("old.txt"); expect(row).toContain("+4"); expect(row).toContain("-3"); expect(row.match(/branch-switch-statistics/g)).toHaveLength(2);
  const fallback = renderToStaticMarkup(<BranchChangeDescription paths={[]} branch="feature" snapshot={{ loading: false, value }} retry={() => {}}/>);
  expect(fallback).toContain("changes in 1 file to check out feature."); expect(fallback).toContain("+4");
  const loading = renderToStaticMarkup(<BranchChangeDescription paths={[]} branch="feature" snapshot={{ loading: true }} retry={() => {}}/>);
  expect(loading).toContain("Loading change statistics"); expect(loading).not.toContain("0 files");
  const failed = renderToStaticMarkup(<BranchChangeDescription paths={[]} branch="feature" snapshot={{ loading: false, error: "Host unavailable" }} retry={() => {}}/>);
  expect(failed).toContain("Host unavailable"); expect(failed).toContain("Refresh statistics"); expect(failed).not.toContain("0 files");
});
