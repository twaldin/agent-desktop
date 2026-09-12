import { afterEach, expect, test } from "bun:test";
import type { BranchQueryRequest, BranchQueryView, RepositoryWatchRequest, RepositoryWatchView } from "@agent-desktop/shared";
import { BranchQueryConnection } from "./branch-query-connection";
import { RepositoryWatchConnection } from "./repository-watch-connection";
import { attachWorkspaceQueryEvents } from "./workspace-query-events";

const snapshot = () => ({ type: "state", sequence: 4, replayComplete: true, state: { host: { id: "host" }, branchQueries: { version: 1 }, repositoryWatches: { version: 1 } } });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const watches = new RepositoryWatchConnection("host"), branches = new BranchQueryConnection("host");
  cleanups.push(() => { watches.dispose(); branches.dispose(); });
  const watchViews: RepositoryWatchView[] = [], branchViews: BranchQueryView[] = [];
  let onWatch: ((view: RepositoryWatchView) => void) | undefined;
  watches.retain({ projectId: "project" }, view => { watchViews.push(view); onWatch?.(view); });
  const branch = branches.retain({ projectId: "project" }, { type: "git.recent-branches" }, view => branchViews.push(view));
  let epoch = 0;
  const connect = () => {
    const own = ++epoch, sent: (BranchQueryRequest | RepositoryWatchRequest)[] = [], closed: string[] = [];
    const router = attachWorkspaceQueryEvents(watches, branches, { isCurrent: () => own === epoch,
      send: value => sent.push(value), close: reason => closed.push(reason) });
    return { ...router, sent, closed };
  };
  return { watches, branches, branch, watchViews, branchViews, connect, set onWatch(value: typeof onWatch) { onWatch = value; } };
}
function ready(request: BranchQueryRequest | RepositoryWatchRequest) {
  const { action: _, ...identity } = request;
  return request.type === "branch-query" ? { ...identity, event: "status", phase: "ready" } : { ...identity, phase: "ready" };
}

test("connection-local frames are consumed while a valid state remains a durable event", () => {
  const f = fixture(), connection = f.connect();
  expect(connection.receive(snapshot())).toBe(false);
  expect(connection.sent.map(r => r.type)).toEqual(["repository-watch", "branch-query"]);
  for (const r of connection.sent) expect(connection.receive(ready(r))).toBe(true);
  expect(f.watchViews.at(-1)?.phase).toBe("ready"); expect(f.branchViews.at(-1)?.phase).toBe("ready");
  expect(connection.receive({ type: "preferences", sequence: 5 })).toBe(false);
});

for (const protocol of ["repository-watch", "branch-query"]) {
  test(`${protocol} fatal response synchronously retires both clients and blocks reentrant sends`, () => {
    const f = fixture(), connection = f.connect(); connection.receive(snapshot());
    for (const r of connection.sent) connection.receive(ready(r));
    f.onWatch = view => { if (view.phase === "disconnected") f.branch.inspect(); };
    const count = connection.sent.length;
    connection.receive({ type: protocol, version: 2 });
    expect(connection.closed).toHaveLength(1); expect(connection.sent).toHaveLength(count);
    expect(f.watchViews.at(-1)?.phase).toBe("disconnected"); expect(f.branchViews.at(-1)?.phase).toBe("disconnected");
    expect(connection.receive(snapshot())).toBe(true); expect(connection.sent).toHaveLength(count);
  });
}

test("ordinary capability contradiction suppresses state publication and both clients", () => {
  const f = fixture(), connection = f.connect(); connection.receive(snapshot());
  const state = snapshot(); state.state.branchQueries.version = 2; state.replayComplete = false;
  expect(connection.receive(state)).toBe(true);
  expect(connection.closed).toHaveLength(1);
  expect(f.watchViews.at(-1)?.phase).toBe("disconnected"); expect(f.branchViews.at(-1)?.phase).toBe("disconnected");
});

test("late frames and disconnect on the prior socket cannot retire a replacement", () => {
  const f = fixture(), old = f.connect(); old.receive(snapshot());
  const next = f.connect(); next.receive(snapshot());
  old.disconnected(); old.receive({ type: "branch-query", version: 2 });
  expect(f.watchViews.at(-1)?.phase).toBe("pending"); expect(f.branchViews.at(-1)?.phase).toBe("pending");
  expect(next.closed).toEqual([]);
  for (const request of next.sent) next.receive(ready(request));
  expect(f.watchViews.at(-1)?.phase).toBe("ready"); expect(f.branchViews.at(-1)?.phase).toBe("ready");
});

test("replacement during attachment cannot overwrite the newer branch attachment", () => {
  const f = fixture(); let replace = false;
  let replacement: ReturnType<typeof f.connect> | undefined;
  f.onWatch = view => { if (view.phase === "connecting" && !replace) { replace = true; replacement = f.connect(); replacement.receive(snapshot()); } };
  const old = f.connect();
  expect(old.receive(snapshot())).toBe(true); expect(old.sent).toEqual([]);
  expect(replacement?.sent.map(r => r.type)).toEqual(["repository-watch", "branch-query"]);
  f.branch.inspect(); expect(replacement?.sent.at(-1)?.action).toBe("inspect");
  expect(f.branchViews.at(-1)?.phase).toBe("pending");
});
