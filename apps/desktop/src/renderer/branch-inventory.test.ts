import { expect, test } from "bun:test";
import type { BranchQueryObserverStatus, BranchQueryObserverView, BranchQueryRequest, LiveBranchQuery, LiveBranchResult } from "@agent-desktop/shared";
import { BranchInventory, orderBranchNames } from "./branch-inventory";
import { BranchQueryObserver } from "./branch-query-observer";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
/** Real observer/parser and inventory; only transport delivery is controlled. */
function fixture(mode: "checkout" | "starting-state" = "checkout") {
  const requests: BranchQueryRequest[] = [], listeners = new Set<() => void>(), statuses = new Set<(status: BranchQueryObserverStatus) => void>();
  const releases = new Map<string, ReturnType<typeof deferred<void>>>();
  const workspace = { connected: true,
    createBranchQueryObserver(query: LiveBranchQuery, listener: (view: BranchQueryObserverView) => void) {
      return new BranchQueryObserver({ branchQuery: async request => { requests.push(request); if (request.action === "release") await releases.get(request.subscriptionId)?.promise; },
        subscribeBranchQuery(fn) { statuses.add(fn); return () => { statuses.delete(fn); }; } }, "host", { projectId: "project" }, query, listener);
    }, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  const inventory = new BranchInventory(workspace, mode);
  const retained = () => requests.filter(r => r.action === "retain");
  function status(request: BranchQueryRequest, view: BranchQueryObserverView) {
    for (const fn of [...statuses]) fn({ hostId: request.hostId, subscriptionId: request.subscriptionId, target: request.target, query: request.query, view });
  }
  return { inventory, requests, listeners, statuses, retained, status, releases,
    answer(request: BranchQueryRequest, result: LiveBranchResult, generation = 1, requiresRecovery = false) { status(request, { phase: "ready", update: { phase: "complete", generation, requiresRecovery, result } }); },
    connection(value: boolean) { workspace.connected = value; for (const fn of listeners) fn(); },
    redraw() { for (const fn of listeners) fn(); },
    async stop() { inventory.configure(false); await settle(); },
  };
}
const recent = (branches: string[]): LiveBranchResult => ({ type: "git.recent-branches", branches });
const defaultBranch = (branch: string | null): LiveBranchResult => ({ type: "git.default-branch", branch });

test("idle order is default, current, tip-date names with exact stable dedup", () => {
  expect(orderBranchNames(["tip-new", "main", "tip-old", "tip-new", "MAIN"], "main", "trunk")).toEqual(["trunk", "main", "tip-new", "tip-old", "MAIN"]);
  expect(orderBranchNames(["main"], "main", "main")).toEqual(["main"]);
  expect(orderBranchNames([], null)).toEqual([]);
});

test("committed activation admits two live methods; redraws allocate nothing; recent settles before default", async () => {
  const f = fixture();
  try {
    expect(f.requests).toEqual([]); f.inventory.configure(true); await settle();
    expect(f.retained().map(r => r.query)).toEqual([{ type: "git.recent-branches", limit: 100 }, { type: "git.default-branch" }]);
    expect(f.inventory.getSnapshot()).toMatchObject({ loading: true, loaded: false, recent: [] });
    const [r, d] = f.retained(); f.answer(r!, recent(["new", "old"]));
    expect(f.inventory.getSnapshot()).toMatchObject({ loading: false, loaded: true, recent: ["new", "old"] });
    f.redraw(); f.inventory.configure(true); await settle(); expect(f.retained()).toHaveLength(2);
    f.answer(d!, defaultBranch("trunk")); expect(f.inventory.getSnapshot().defaultBranch).toBe("trunk");
    f.answer(r!, recent(["next"]), 2); expect(f.inventory.getSnapshot()).toMatchObject({ recent: ["next"], defaultBranch: "trunk" });
    expect(f.retained()).toHaveLength(2);
  } finally { await f.stop(); }
});

test("loss-return waits each predecessor release, ignores old replies and admits only latest lifetime", async () => {
  const f = fixture();
  try {
    f.inventory.configure(true); await settle(); const [r, d] = f.retained();
    const rg = deferred<void>(), dg = deferred<void>(); f.releases.set(r!.subscriptionId, rg); f.releases.set(d!.subscriptionId, dg);
    f.connection(false); f.connection(true); f.connection(false); f.connection(true); await settle();
    expect(f.retained()).toHaveLength(2); f.answer(r!, recent(["stale"])); f.answer(d!, defaultBranch("stale"));
    expect(f.inventory.getSnapshot()).toMatchObject({ recent: [], loading: true });
    rg.resolve(); await settle(); expect(f.retained()).toHaveLength(3); f.answer(f.retained()[2]!, recent(["fresh"]));
    expect(f.inventory.getSnapshot().recent).toEqual(["fresh"]); expect(f.inventory.getSnapshot().defaultBranch).toBeUndefined();
    dg.resolve(); await settle(); expect(f.retained()).toHaveLength(4); f.answer(f.retained()[3]!, defaultBranch("main"));
    f.connection(true); await settle(); expect(f.retained()).toHaveLength(4);
  } finally { await f.stop(); }
});

test("rejected release fences retry and reopen without replacing the uncertain owner", async () => {
  const f = fixture();
  try {
    f.inventory.configure(true); await settle(); const r = f.retained()[0]!, gate = deferred<void>(); f.releases.set(r.subscriptionId, gate);
    f.connection(false); f.connection(true); await settle(); gate.reject(new Error("release not acknowledged")); await settle();
    expect(f.retained().filter(r => r.query.type === "git.recent-branches")).toHaveLength(1);
    expect(f.inventory.getSnapshot().error).toContain("release not acknowledged");
    f.inventory.retry(); await settle(); await f.stop(); f.inventory.configure(true); await settle();
    expect(f.retained().filter(r => r.query.type === "git.recent-branches")).toHaveLength(1);
    expect(f.inventory.getSnapshot().error).toContain("release not acknowledged");
  } finally { await f.stop(); }
});

test("ready query failure retains other method and explicit recovery uses same identities", async () => {
  const f = fixture();
  try {
    f.inventory.configure(true); await settle(); const [r, d] = f.retained(); f.answer(r!, recent(["tip"]), 1, true);
    f.status(d!, { phase: "ready", update: { phase: "failed", generation: 1, requiresRecovery: true, error: "Remote unavailable" } });
    expect(f.inventory.getSnapshot()).toMatchObject({ recent: ["tip"], defaultError: "Remote unavailable" });
    f.inventory.retry(); await settle(); expect(f.requests.filter(r => r.action === "recover").map(r => r.subscriptionId)).toEqual([r!.subscriptionId, d!.subscriptionId]);
    expect(f.retained()).toHaveLength(2); f.answer(d!, defaultBranch("main"), 2);
    expect(f.inventory.getSnapshot()).toMatchObject({ recent: ["tip"], defaultBranch: "main", defaultError: undefined });
  } finally { await f.stop(); }
});

test("degraded successful results remain visible and carry recoverable coverage warning", async () => {
  const f = fixture();
  try {
    f.inventory.configure(true); await settle(); const [r, d] = f.retained(); f.answer(r!, recent(["cached"]), 1, true);
    f.status(d!, { phase: "ready", error: "HEAD watch unavailable", update: { phase: "complete", generation: 1, requiresRecovery: true, result: defaultBranch("main") } });
    expect(f.inventory.getSnapshot()).toMatchObject({ recent: ["cached"], defaultBranch: "main", error: undefined, defaultError: undefined });
    expect(f.inventory.getSnapshot().warning).toContain("incomplete"); expect(f.inventory.getSnapshot().defaultWarning).toContain("HEAD watch unavailable");
    f.inventory.retry(); await settle(); expect(f.retained()).toHaveLength(2);
    f.answer(r!, recent(["current"]), 2); f.answer(d!, defaultBranch("main"), 2);
    expect(f.inventory.getSnapshot().warning).toBeUndefined(); expect(f.inventory.getSnapshot().defaultWarning).toBeUndefined();
  } finally { await f.stop(); }
});

test("close clears subscriptions and late error cannot repopulate; reopen gets fresh owners", async () => {
  const f = fixture(); f.inventory.configure(true); await settle(); const old = f.retained(); await f.stop();
  expect(f.listeners.size).toBe(0); expect(f.statuses.size).toBe(0);
  f.status(old[0]!, { phase: "failed", error: "late" }); expect(f.inventory.getSnapshot()).toEqual({ recent: [], loading: false, loaded: false });
  try { f.inventory.configure(true); await settle(); expect(f.retained()).toHaveLength(4); expect(f.statuses.size).toBe(2); }
  finally { await f.stop(); }
});

test("starting inventory consumes independently delivered remote base without changing its identity", async () => {
  const f = fixture("starting-state");
  try {
    f.inventory.configure(true); await settle(); expect(f.retained()[1]!.query).toEqual({ type: "git.base-branch" });
    f.answer(f.retained()[1]!, { type: "git.base-branch", base: { remote: "team/upstream", local: "feature/topic" } });
    expect(f.inventory.getSnapshot()).toMatchObject({ baseBranch: { remote: "team/upstream", local: "feature/topic" }, defaultBranch: "feature/topic", loading: true });
    f.answer(f.retained()[0]!, recent([])); expect(f.inventory.getSnapshot()).toMatchObject({ loaded: true, loading: false });
  } finally { await f.stop(); }
});

test("malformed live results fail visibly instead of loading invalid rows", async () => {
  for (const bad of [Array(101).fill("main"), ["bad\nname"], [3], null]) {
    const f = fixture();
    try {
      f.inventory.configure(true); await settle(); f.answer(f.retained()[0]!, { type: "git.recent-branches", branches: bad } as LiveBranchResult);
      expect(f.inventory.getSnapshot()).toMatchObject({ recent: [], loaded: false, loading: false }); expect(f.inventory.getSnapshot().error).toBeDefined();
    } finally { await f.stop(); }
  }
});

test("reentrant close while publishing cannot apply the rest of an obsolete result or start siblings", async () => {
  const f = fixture();
  const off = f.inventory.subscribe(() => { if (f.inventory.getSnapshot().recent.length) f.inventory.configure(false); });
  f.inventory.configure(true); await settle(); f.answer(f.retained()[0]!, recent(["close"])); await settle();
  expect(f.inventory.getSnapshot()).toEqual({ recent: [], loading: false, loaded: false }); expect(f.statuses.size).toBe(0); off();
  const g = fixture(); const cancel = g.inventory.subscribe(() => { if (g.inventory.getSnapshot().loading) g.inventory.configure(false); });
  g.inventory.configure(true); await settle(); expect(g.requests).toEqual([]); cancel(); await g.stop();
});

test("ordinary query failure uses fresh admission after release rather than a no-op coverage recovery", async () => {
  const f = fixture();
  try {
    f.inventory.configure(true); await settle(); const [r, d] = f.retained();
    f.status(r!, { phase: "ready", update: { phase: "failed", generation: 1, requiresRecovery: false, error: "Git failed" } });
    f.answer(d!, defaultBranch("main")); f.inventory.retry(); await settle();
    expect(f.requests.filter(r => r.action === "recover")).toEqual([]);
    expect(f.requests.map(r => r.action)).toEqual(["retain", "retain", "release", "release", "retain", "retain"]);
    f.answer(f.retained()[2]!, recent(["recovered"])); expect(f.inventory.getSnapshot().recent).toEqual(["recovered"]);
  } finally { await f.stop(); }
});
