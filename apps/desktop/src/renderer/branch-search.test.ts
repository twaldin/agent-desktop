import { expect, test } from "bun:test";
import type { GitBranch, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { BranchSearch, BRANCH_SEARCH_DELAY_MS, type BranchSearchWorkspace } from "./branch-search";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const branch = (name: string): GitBranch => ({ name, ref: `refs/heads/${name}`, commit: "a".repeat(40), current: false, remote: false, upstream: null, symbolicTarget: null });
const result = (names: string[], limitReached = false): WorkspaceQueryResult => ({ type: "git.search-branches", branches: names.map(branch), limitReached });
function fixture() {
  const requests: { query: WorkspaceQuery; response: ReturnType<typeof deferred<WorkspaceQueryResult>> }[] = [];
  const listeners = new Set<() => void>(); let entered = deferred<void>();
  const workspace: BranchSearchWorkspace = { connected: true, repositoryQueryRevision() { return 0; }, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    query(query) { const response = deferred<WorkspaceQueryResult>(); requests.push({ query, response }); entered.resolve(); return response.promise; } };
  const search = new BranchSearch(workspace);
  return { search, requests,
    async next(count: number) { while (requests.length < count) { await entered.promise; entered = deferred<void>(); } return requests[count - 1]!; },
    connection(connected: boolean) { workspace.connected = connected; for (const listener of listeners) listener(); },
    stop() { search.configure("", false); }, listeners };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

test("picker debounces host search terms and replaces results without cached local filtering", async () => {
  const f = fixture();
  try {
    f.search.configure("t", true); f.search.configure(" topic ", true);
    expect(f.requests).toHaveLength(0); expect(f.search.getSnapshot()).toMatchObject({ query: "topic", loading: true, branches: [] });
    const request = await f.next(1); expect(request.query).toEqual({ type: "git.search-branches", query: "topic", limit: 20 });
    request.response.resolve(result(["topic", "topic-two"], true)); await settle();
    expect(f.search.getSnapshot()).toMatchObject({ loading: false, branches: [branch("topic"), branch("topic-two")], limitReached: true });
    f.search.configure("different", true); expect(f.search.getSnapshot().branches).toEqual([]);
  } finally { f.stop(); }
});

test("picker rejects a legacy search response without the cap contract rather than treating it as empty success", async () => {
  const f = fixture();
  try {
    f.search.configure("topic", true); const request = await f.next(1);
    request.response.resolve({ type: "git.search-branches", branches: [branch("topic")], hasMore: false } as unknown as WorkspaceQueryResult);
    await settle();
    expect(f.search.getSnapshot()).toMatchObject({ loading: false, branches: [], error: "The host returned the wrong branch search response." });
    expect(f.requests).toHaveLength(1);
  } finally { f.stop(); }
});

test("one background read stays in flight and only the latest debounced query follows it", async () => {
  const f = fixture();
  try {
    f.search.configure("a", true); const a = await f.next(1);
    f.search.configure("b", true); await Bun.sleep(BRANCH_SEARCH_DELAY_MS + 10);
    expect(f.requests).toHaveLength(1);
    f.search.configure("c", true); await Bun.sleep(BRANCH_SEARCH_DELAY_MS + 10);
    expect(f.requests).toHaveLength(1);
    a.response.resolve(result(["a"])); const c = await f.next(2);
    expect(c.query).toMatchObject({ query: "c" }); expect(f.search.getSnapshot().branches).toEqual([]);
    c.response.resolve(result(["c"])); await settle(); expect(f.search.getSnapshot().branches).toEqual([branch("c")]);
  } finally { f.stop(); }
});

test("disconnect-return invalidates held results and requires a fresh read without a render", async () => {
  const f = fixture();
  try {
    f.search.configure("topic", true); const old = await f.next(1), version = f.search.version;
    f.connection(false); expect(f.search.isCurrent(version)).toBe(false); expect(f.search.getSnapshot().error).toContain("Reconnect");
    f.connection(true); old.response.resolve(result(["old"])); await settle();
    expect(f.search.getSnapshot().branches).toEqual([]);
    const fresh = await f.next(2); fresh.response.resolve(result(["new"])); await settle();
    expect(f.search.getSnapshot().branches).toEqual([branch("new")]);
    f.connection(true); expect(f.requests).toHaveLength(2);
  } finally { f.stop(); }
});

test("search error has explicit retry and close discards a late result and unsubscribes", async () => {
  const f = fixture();
  try {
    f.search.configure("topic", true); (await f.next(1)).response.reject(new Error("Host unavailable")); await settle();
    expect(f.search.getSnapshot()).toMatchObject({ loading: false, error: "Host unavailable", branches: [] });
    f.search.retry(); const retry = await f.next(2); expect(f.search.getSnapshot().error).toBeUndefined();
    f.stop(); retry.response.resolve(result(["late"])); await settle();
    expect(f.search.getSnapshot().branches).toEqual([]); expect(f.listeners.size).toBe(0);
  } finally { f.stop(); }
});

test("checkout resolution is independent of truncated presentation results and preserves host identity", async () => {
  const f = fixture();
  try {
    f.search.configure("topic", true); (await f.next(1)).response.resolve(result(["other"], true)); await settle();
    const selected = f.search.resolveCheckout("topic"), request = await f.next(2);
    expect(request.query).toEqual({ type: "git.resolve-checkout", expression: "topic" });
    const target = { kind: "branch" as const, expression: "topic", selection: { ref: "refs/remotes/upstream/topic", localBranch: "topic", commit: "a".repeat(40) } };
    request.response.resolve({ type: "git.resolve-checkout", target }); expect(await selected).toEqual(target);
    expect(f.requests).toHaveLength(2);
  } finally { f.stop(); }
});

test("idle row resolution can differ from the search field and full refs keep the host revision kind", async () => {
  const f = fixture();
  try {
    f.search.configure("", true); const selected = f.search.resolveCheckout("refs/heads/main");
    const request = await f.next(1); expect(request.query).toEqual({ type: "git.resolve-checkout", expression: "refs/heads/main" });
    const target = { kind: "revision" as const, expression: "refs/heads/main", commit: "a".repeat(40) };
    request.response.resolve({ type: "git.resolve-checkout", target }); expect(await selected).toEqual(target);
    f.stop(); expect(await f.search.resolveCheckout("main")).toBeUndefined(); expect(f.requests).toHaveLength(1);
  } finally { f.stop(); }
});

test("checkout resolution errors and missing target never trigger an alternate query", async () => {
  for (const outcome of ["error", "missing"] as const) {
    const f = fixture();
    try {
      f.search.configure("topic", true); const selected = f.search.resolveCheckout("topic").then(value => ({ value }), error => ({ error }));
      const request = await f.next(1);
      if (outcome === "error") request.response.reject(new Error("More than one remote branch matches"));
      else request.response.resolve({ type: "git.resolve-checkout", target: null });
      expect(await selected).toHaveProperty("error"); expect(f.requests).toHaveLength(1);
    } finally { f.stop(); }
  }
});

test("checkout target validation rejects wrong kinds, echoes and branch identities before admission", async () => {
  const valid = { kind: "branch", expression: "topic", selection: { ref: "refs/heads/topic", commit: "a".repeat(40) } };
  const remote = { ref: "refs/remotes/origin/topic", localBranch: "topic", commit: "a".repeat(40) };
  const invalid = [null, [], {}, { ...valid, kind: "other" }, { ...valid, expression: "other" },
    { ...valid, selection: { ...valid.selection, commit: "not-an-id" } },
    { ...valid, selection: { ...valid.selection, ref: "refs/heads/other" } },
    { ...valid, selection: { ...remote, localBranch: "other" } },
    { ...valid, selection: { ...remote, ref: "refs/remotes/origin/other" } },
    { ...valid, selection: { ...remote, localBranch: undefined } },
    { kind: "revision", expression: "topic", commit: "not-an-id" },
    { kind: "revision", expression: "other", commit: "a".repeat(40) },
  ];
  for (const response of [...invalid.map(target => ({ type: "git.resolve-checkout", target })), result([])]) {
    const f = fixture();
    try {
      f.search.configure("topic", true); const selected = f.search.resolveCheckout("topic").then(value => ({ value }), error => ({ error }));
      (await f.next(1)).response.resolve(response as WorkspaceQueryResult);
      expect(await selected).toHaveProperty("error"); expect(f.requests).toHaveLength(1);
    } finally { f.stop(); }
  }
});

test("checkout resolution success and error both lose authority on connection roundtrip, query change or close", async () => {
  for (const invalidation of ["connection", "query", "close"] as const) for (const outcome of ["success", "error"] as const) {
    const f = fixture();
    try {
      f.search.configure("topic", true); const selected = f.search.resolveCheckout("topic"), request = await f.next(1);
      if (invalidation === "connection") { f.connection(false); f.connection(true); }
      else if (invalidation === "query") f.search.configure("different", true); else f.stop();
      if (outcome === "success") request.response.resolve({ type: "git.resolve-checkout", target: { kind: "revision", expression: "topic", commit: "a".repeat(40) } });
      else request.response.reject(new Error("late failure"));
      expect(await selected).toBeUndefined();
    } finally { f.stop(); }
  }
});

test("checkout response retains the host's full remote identity without reparsing its owner name", async () => {
  const f = fixture();
  try {
    f.search.configure("topic", true); const selected = f.search.resolveCheckout("topic");
    const target = { kind: "branch" as const, expression: "topic", selection: { ref: "refs/remotes/team/upstream/topic", localBranch: "topic", commit: "a".repeat(40) } };
    (await f.next(1)).response.resolve({ type: "git.resolve-checkout", target }); expect(await selected).toEqual(target);
  } finally { f.stop(); }
});
