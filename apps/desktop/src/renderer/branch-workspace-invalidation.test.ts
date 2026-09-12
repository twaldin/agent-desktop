import { expect, test } from "bun:test";
import type { BranchQueryRequest, BranchQueryObserverStatus, LiveBranchResult, DesktopEvent, GitBranch, GitStatus, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { WorkspaceState } from "./workspace-state";
import { BranchInventory } from "./branch-inventory";
import { BranchSearch } from "./branch-search";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const branch = (name: string): GitBranch => ({ name, ref: `refs/heads/${name}`, commit: "a".repeat(40), current: false, remote: false, upstream: null, symbolicTarget: null });
async function settle() { for (let i = 0; i < 24; i++) await Promise.resolve(); }

/** Actual workspace event subscription and branch consumers, with controlled
 * bridge replies/timer admission. No server, React mount or native watch. */
async function fixture(hostId = "remote", mode: "checkout" | "starting-state" = "starting-state") {
  const listeners = new Set<(event: DesktopEvent) => void>(), requests: { input: WorkspaceQuery; result: ReturnType<typeof deferred<WorkspaceQueryResult>> }[] = [];
  const live: BranchQueryRequest[] = [], liveListeners = new Set<(status: BranchQueryObserverStatus) => void>(); let generation = 0;
  function publish(request: BranchQueryRequest, result: LiveBranchResult) {
    for (const fn of liveListeners) fn({ hostId, subscriptionId: request.subscriptionId, target: request.target, query: request.query,
      view: { phase: "ready", update: { generation: ++generation, requiresRecovery: false, phase: "complete", result } } });
  }
  const timers = new Map<number, () => void>(); let timer = 0, mutations = 0;
  const beforeSet = globalThis.setTimeout, beforeClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void) => { const id = ++timer; timers.set(id, fn); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const status = { revision: "b".repeat(64), head: "a".repeat(40), branch: "main", entries: [] } as unknown as GitStatus;
  const cache = new Map<string, string>();
  const data = new WorkspaceState({
    branchQuery: async request => { live.push(request); },
    subscribeBranchQuery(fn) { liveListeners.add(fn); return () => { liveListeners.delete(fn); }; },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async workspaceQuery(_target, input, owner) {
      if (owner !== hostId) throw new Error("Wrong owning host");
      if (input.type === "git.status") return { type: input.type, status };
      if (input.type === "files.list") return { type: input.type, entries: [] };
      if (!["git.base-branch", "git.default-branch", "git.recent-branches", "git.search-branches", "git.search-starting-branches", "git.resolve-checkout"].includes(input.type)) throw new Error(`Unexpected read ${input.type}`);
      const result = deferred<WorkspaceQueryResult>(); requests.push({ input, result }); return result.promise;
    },
    async command() { mutations++; throw new Error("Invalidation must not mutate"); },
    async saveWorkspaceCopy() { throw new Error("No copy expected"); }, async acquireWorkspaceImage() { throw new Error("No image expected"); }, async releaseWorkspaceImage() {},
  }, hostId, { projectId: "project" }, { read: async key => cache.get(key) ?? null, write: async (key, value) => { cache.set(key, value); } }, "local");
  await data.restore(); data.status = status; data.setConnected(true); data.start();
  const inventory = new BranchInventory(data, mode), search = new BranchSearch(data, mode);
  return { data, status, requests, live, publish, inventory, search, get mutations() { return mutations; },
    event(event: DesktopEvent = { hostId, sequence: 1, type: "workspace", target: { projectId: "project" } }) { for (const fn of listeners) fn(event); },
    tick() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); },
    answer(name: string) {
      for (const request of live.filter(r => r.action === "retain")) {
        if (request.query.type === "git.recent-branches") publish(request, { type: request.query.type, branches: [name] });
        else if (request.query.type === "git.default-branch") publish(request, { type: request.query.type, branch: name });
        else publish(request, { type: "git.base-branch", base: { remote: "origin", local: name } });
      }
      for (const { input, result } of requests) {
      if (input.type === "git.base-branch") result.resolve({ type: input.type, base: { remote: "origin", local: name } });
      else if (input.type === "git.recent-branches") result.resolve({ type: input.type, branches: [name] });
      else if (input.type === "git.default-branch") result.resolve({ type: input.type, branch: name });
      else if (input.type === "git.search-starting-branches" || input.type === "git.search-branches") result.resolve({ type: input.type, branches: [branch(name)], limitReached: false });
    } },
    dispose() { inventory.configure(false); search.configure("", false); data.stop(); globalThis.setTimeout = beforeSet; globalThis.clearTimeout = beforeClear; },
  };
}

test("same-HEAD/index owner event invalidates branch results before the status refresh settles", async () => {
  const f = await fixture();
  try {
    f.inventory.configure(true); f.search.configure("topic", true); f.tick(); await settle();
    f.answer("before"); await settle();
    const version = f.search.version, revision = f.data.status!.revision;
    expect(f.search.getSnapshot().branches.map(b => b.name)).toEqual(["before"]);
    f.event();
    expect(f.search.isCurrent(version)).toBe(false);
    expect(f.search.getSnapshot().branches).toEqual([]);
    expect(f.inventory.getSnapshot().loading).toBe(false); expect(f.live.filter(r => r.action === "retain")).toHaveLength(2);
    f.tick(); expect(f.requests).toHaveLength(2);
    f.answer("after"); await settle();
    expect(f.inventory.getSnapshot().recent).toEqual(["after"]);
    expect(f.inventory.getSnapshot().baseBranch).toEqual({ remote: "origin", local: "after" });
    expect(f.search.getSnapshot().branches.map(b => b.name)).toEqual(["after"]);
    expect(f.data.status!.revision).toBe(revision); expect(f.data.status!.head).toBe("a".repeat(40)); expect(f.mutations).toBe(0);
  } finally { f.dispose(); }
});

test("host and exact workspace routing exclude unrelated events, stop excludes later delivery", async () => {
  const f = await fixture();
  try {
    f.inventory.configure(true); f.search.configure("topic", true); f.tick(); await settle(); f.answer("before"); await settle();
    const version = f.search.version;
    for (const event of [
      { hostId: "other", sequence: 1, type: "workspace", target: { projectId: "project" } },
      { sequence: 2, type: "workspace", target: { projectId: "project" } },
      { hostId: "remote", sequence: 3, type: "workspace", target: { projectId: "other" } },
      { hostId: "remote", sequence: 4, type: "workspace", target: { sessionId: "project" } },
      { hostId: "remote", sequence: 5, type: "accounts" },
    ] as DesktopEvent[]) f.event(event);
    await settle(); expect(f.search.isCurrent(version)).toBe(true); expect(f.requests).toHaveLength(1);
    f.data.stop(); f.event(); expect(f.search.isCurrent(version)).toBe(true); expect(f.requests).toHaveLength(1);
  } finally { f.dispose(); }
  const local = await fixture("local");
  try {
    local.search.configure("topic", true); const version = local.search.version;
    local.event({ sequence: 1, type: "workspace", target: { projectId: "project" } });
    expect(local.search.isCurrent(version)).toBe(false); expect(local.mutations).toBe(0);
  } finally { local.dispose(); }
});

test("repeated invalidation coalesces search reads while inventory accepts explicit live results", async () => {
  const f = await fixture();
  try {
    f.inventory.configure(true); f.search.configure("topic", true); f.tick(); await settle();
    const old = f.search.version;
    f.event(); f.event({ hostId: "remote", sequence: 2, type: "workspace", target: { projectId: "project" } }); f.tick();
    expect(f.search.isCurrent(old)).toBe(false); expect(f.requests).toHaveLength(1);
    f.answer("stale"); await settle();
    expect(f.requests).toHaveLength(2); expect(f.search.getSnapshot().branches).toEqual([]); expect(f.inventory.getSnapshot().recent).toEqual(["stale"]);
    f.answer("fresh"); await settle();
    expect(f.search.getSnapshot().branches.map(b => b.name)).toEqual(["fresh"]); expect(f.inventory.getSnapshot().recent).toEqual(["fresh"]);
    expect(f.mutations).toBe(0);
  } finally { f.dispose(); }
});

test("ordinary draft/cache notifications do not invalidate reads or dispatch mutations", async () => {
  const f = await fixture();
  try {
    f.inventory.configure(true); f.search.configure("topic", true); f.tick(); await settle(); f.answer("before"); await settle();
    const version = f.search.version;
    f.data.documents.set("note", { content: null, text: "", dirty: false }); f.data.edit("note", "retained draft");
    await settle(); expect(f.search.isCurrent(version)).toBe(true); expect(f.requests).toHaveLength(1);
    f.event(); f.tick(); f.answer("after"); await settle();
    expect(f.data.documents.get("note")?.text).toBe("retained draft"); expect(f.data.documents.get("note")?.dirty).toBe(true); expect(f.mutations).toBe(0);
  } finally { f.dispose(); }
});


test("checkout resolution loses admission on a same-revision repository event", async () => {
  const f = await fixture(), checkout = new BranchSearch(f.data);
  try {
    checkout.configure("", true);
    const pending = checkout.resolveCheckout("main"); expect(f.requests).toHaveLength(1);
    f.event();
    f.requests[0]!.result.resolve({ type: "git.resolve-checkout", target: { kind: "revision", expression: "main", commit: "a".repeat(40) } });
    expect(await pending).toBeUndefined();
    const fresh = checkout.resolveCheckout("main"); expect(f.requests).toHaveLength(2);
    f.requests[1]!.result.resolve({ type: "git.resolve-checkout", target: { kind: "revision", expression: "main", commit: "b".repeat(40) } });
    expect(await fresh).toEqual({ kind: "revision", expression: "main", commit: "b".repeat(40) }); expect(f.mutations).toBe(0);
  } finally { checkout.configure("", false); f.dispose(); }
});

for (const mode of ["checkout", "starting-state"] as const) test(`${mode} search routes typed changes while live inventory remains subscribed without duplicate reads`, async () => {
  for (const [kind, expected] of [
    ["config", ["git.recent-branches", "default"]],
    ["head", ["git.recent-branches", "default", "search"]],
    ["local-refs", ["git.recent-branches", "search"]],
    ["remote-refs", ["git.recent-branches", "default", "search"]],
    ["index", []], ["worktree-topology", []], ["working-tree", []], ["synced-branch", []], [undefined, ["git.recent-branches", "default", "search"]],
    ["future-kind", ["git.recent-branches", "default", "search"]],
  ] as const) {
    const f = await fixture("remote", mode);
    try {
      f.inventory.configure(true); f.search.configure("topic", true); f.tick(); await settle(); f.answer("before"); await settle();
      const count = f.requests.length;
      // Index revision may change without changing HEAD or any branch query.
      if (kind === "index") f.status.revision = "new-index-revision";
      f.event({ hostId: "remote", sequence: 2, type: "workspace", target: { projectId: "project" }, repositoryChange: kind } as DesktopEvent);
      f.tick(); await settle();
      const methods = expected.filter(type => type === "search").map(type => type === "default" ? mode === "checkout" ? "git.default-branch" : "git.base-branch" : type === "search" ? mode === "checkout" ? "git.search-branches" : "git.search-starting-branches" : type);
      expect(f.requests.slice(count).map(r => r.input.type)).toEqual(methods);
      f.answer("after"); await settle(); expect(f.mutations).toBe(0);
    } finally { f.dispose(); }
  }
});

test("a live recent result neither cancels nor waits for an unrelated base result", async () => {
  const f = await fixture();
  try {
    f.inventory.configure(true); await settle();
    const [recent, base] = f.live.filter(r => r.action === "retain");
    f.publish(recent!, { type: "git.recent-branches", branches: ["before"] });
    f.event({ hostId: "remote", sequence: 2, type: "workspace", target: { projectId: "project" }, repositoryChange: "local-refs" });
    expect(f.requests).toEqual([]); expect(f.live.filter(r => r.action === "retain")).toHaveLength(2);
    f.publish(base!, { type: "git.base-branch", base: { remote: "origin", local: "still-current" } });
    f.publish(recent!, { type: "git.recent-branches", branches: ["after"] });
    expect(f.inventory.getSnapshot()).toMatchObject({ recent: ["after"], baseBranch: { remote: "origin", local: "still-current" } });
  } finally { f.dispose(); }
});

test("index-only changes keep search data but still invalidate an outstanding checkout resolution", async () => {
  const f = await fixture("remote", "checkout");
  try {
    f.search.configure("topic", true); f.tick(); await settle(); f.answer("before"); await settle();
    const pending = f.search.resolveCheckout("topic"), request = f.requests.at(-1)!;
    f.event({ hostId: "remote", sequence: 2, type: "workspace", target: { projectId: "project" }, repositoryChange: "index" });
    request.result.resolve({ type: "git.resolve-checkout", target: { kind: "revision", expression: "topic", commit: "b".repeat(40) } });
    expect(await pending).toBeUndefined(); expect(f.search.getSnapshot().branches.map(b => b.name)).toEqual(["before"]);
    expect(f.requests).toHaveLength(2);
  } finally { f.dispose(); }
});
