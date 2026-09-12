import { afterEach, expect, test } from "bun:test";
import React from "react";
import type { BranchQueryObserverStatus, BranchQueryObserverView, BranchQueryRequest, DesktopEvent, GitStatus, RepositoryWatchObserverStatus, RepositoryWatchRequest, RepositoryWatchView, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { retainWorkspace } from "./workspace-lease";
import { WorkspaceState } from "./workspace-state";
import { useBranchInventory } from "./use-branch-inventory";
import { useStartingStateInventory } from "./use-starting-state-inventory";
import { useBranchSearch } from "./use-branch-search";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function clock() {
  let now = 0, next = 0; const timers = new Map<number, { at: number; run: () => void }>();
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  globalThis.setTimeout = ((run: () => void, delay = 0) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  cleanups.push(() => { globalThis.setTimeout = set; globalThis.clearTimeout = clear; });
  return { async tick(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.run(); await flush(); } };
}

/** A renderer bridge fixture. Branch results are emitted explicitly from captured
 * retained requests; repository-watch status never synthesizes host execution. */
async function workspace(hostId = "host", projectId = "project", liveBranches = true, watching = true) {
  const requests: { query: WorkspaceQuery; result: ReturnType<typeof deferred<WorkspaceQueryResult>> }[] = [];
  const branches: BranchQueryRequest[] = [], branchListeners = new Set<(status: BranchQueryObserverStatus) => void>();
  const watches: RepositoryWatchRequest[] = [], watchListeners = new Set<(status: RepositoryWatchObserverStatus) => void>(), events = new Set<(event: DesktopEvent) => void>();
  const records: BranchQueryObserverStatus[] = []; let mutations = 0;
  const status = { revision: "stable", branch: "main", head: "a".repeat(40), entries: [] } as unknown as GitStatus;
  const bridge = {
    subscribe(fn: (event: DesktopEvent) => void) { events.add(fn); return () => { events.delete(fn); }; },
    ...(watching ? { repositoryWatch: async (request: RepositoryWatchRequest) => { watches.push(request); }, subscribeRepositoryWatch: (fn: (status: RepositoryWatchObserverStatus) => void) => { watchListeners.add(fn); return () => { watchListeners.delete(fn); }; } } : {}),
    ...(liveBranches ? { branchQuery: async (request: BranchQueryRequest) => { branches.push(request); }, subscribeBranchQuery: (fn: (status: BranchQueryObserverStatus) => void) => { branchListeners.add(fn); return () => { branchListeners.delete(fn); }; } } : {}),
    async workspaceQuery(_target: unknown, query: WorkspaceQuery) {
      if (query.type === "files.list") return { type: query.type, entries: [] };
      if (query.type === "git.status") return { type: query.type, status };
      const result = deferred<WorkspaceQueryResult>(); requests.push({ query, result }); return result.promise;
    },
    async command() { mutations++; throw new Error("No mutations allowed"); },
  };
  const data = new WorkspaceState(bridge, hostId, { projectId }, { read: async () => null, write: async () => {} }, "local");
  await data.restore(); data.status = status; data.setConnected(true); const release = retainWorkspace(data); cleanups.push(release);
  function emit(request: BranchQueryRequest, view: BranchQueryObserverView, extra: Partial<BranchQueryObserverStatus> = {}) {
    const record = { hostId, subscriptionId: request.subscriptionId, target: { projectId }, query: request.query, view, ...extra } as BranchQueryObserverStatus;
    records.push(record); for (const listener of [...branchListeners]) listener(record);
  }
  function complete(request: BranchQueryRequest, name: string, generation = 1, error?: string) {
    const result = request.query.type === "git.recent-branches" ? { type: request.query.type, branches: [name] }
      : request.query.type === "git.default-branch" ? { type: request.query.type, branch: name }
      : { type: request.query.type, base: { local: name, remote: "origin" } };
    emit(request, { phase: "ready", ...(error ? { error } : {}), update: { generation, requiresRecovery: false, phase: "complete", result } } as BranchQueryObserverView);
  }
  return { data, requests, branches, branchListeners, records, watches, watchListeners, release, get mutations() { return mutations; }, emit, complete,
    status(view: RepositoryWatchView, extra: Partial<RepositoryWatchObserverStatus> = {}) { const first = watches.find(request => request.action === "retain")!; for (const listener of [...watchListeners]) listener({ hostId, subscriptionId: first.subscriptionId, target: { projectId }, view, ...extra }); },
    answerSearch(name: string) { for (const item of requests) if (item.query.type === "git.search-branches" || item.query.type === "git.search-starting-branches") item.result.resolve({ type: item.query.type, limitReached: false, branches: [{ name, ref: `refs/heads/${name}`, commit: "a".repeat(40), current: false, remote: false, upstream: null, symbolicTarget: null }] }); },
  };
}

/** Actual hooks/controllers/WorkspaceState/BranchQueryObserver/parser/retention;
 * React commit phases and bridge/timers are controlled. No IPC, host, or OS watch runs. */
function hook(kind: "inventory" | "starting" | "search", data: WorkspaceState) {
  let input = { data, active: false, open: false, query: "topic" }, cursor = 0, effects: (() => void)[] = [], value: any;
  const slots: any[] = [], clean = new Map<number, () => void>(), deps = new Map<number, readonly unknown[]>();
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useRef(initial: unknown) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useMemo(factory: () => unknown, next: readonly unknown[]) { const i = cursor++, prior = slots[i]; if (!prior || next.length !== prior.deps.length || !next.every((v, j) => Object.is(v, prior.deps[j]))) slots[i] = { deps: next, value: factory() }; return slots[i].value; },
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { cursor++; return snapshot(); },
    useLayoutEffect(effect: () => void | (() => void), next: readonly unknown[]) { const i = cursor++, old = deps.get(i); if (old && old.length === next.length && next.every((v, j) => Object.is(v, old[j]))) return;
      effects.push(() => { clean.get(i)?.(); clean.delete(i); const off = effect(); if (off) clean.set(i, off); deps.set(i, next); }); },
  };
  function render(change: Partial<typeof input> = {}, commit = true) {
    input = { ...input, ...change }; cursor = 0; effects = []; const prior = internals.H; internals.H = dispatcher;
    try { value = kind === "starting" ? useStartingStateInventory(input.data, input.active, input.open) : kind === "inventory" ? useBranchInventory(input.data, input.active) : useBranchSearch(input.data, input.query, input.active); }
    finally { internals.H = prior; }
    if (commit) for (const effect of effects) effect();
  }
  const dispose = () => { for (const off of clean.values()) off(); clean.clear(); }; cleanups.push(dispose); render();
  return { render, dispose, get value() { return value; } };
}

test("committed inventory dispatches live owners only after commit and accepts explicit independent updates", async () => {
  const time = clock(), w = await workspace(), h = hook("inventory", w.data);
  h.render({ active: true }, false); await flush(); expect(w.branches).toEqual([]); expect(w.watches).toEqual([]);
  h.render({ active: true }); await flush(); expect(w.branches.map(request => request.action)).toEqual(["retain", "retain"]); expect(w.watches).toHaveLength(1);
  const recent = w.branches.find(request => request.query.type === "git.recent-branches")!, base = w.branches.find(request => request.query.type === "git.default-branch")!;
  w.complete(recent, "initial"); w.complete(base, "trunk"); await flush(); h.render();
  expect(h.value.snapshot).toMatchObject({ recent: ["initial"], defaultBranch: "trunk", loaded: true });
  w.complete(recent, "changed", 2); await flush(); h.render(); expect(h.value.snapshot).toMatchObject({ recent: ["changed"], defaultBranch: "trunk" });
  const before = w.data.repositoryInvalidation; w.status({ phase: "ready" });
  expect(w.data.repositoryInvalidation).toBe(before + 1); expect(w.branches).toHaveLength(2); // Watch readiness does not fabricate a branch result.
  h.dispose(); await time.tick(250); expect(w.branches.map(request => request.action)).toEqual(["retain", "retain", "release", "release"]); expect(w.branchListeners.size).toBe(0); expect(w.watches.map(request => request.action)).toEqual(["retain", "release"]); expect(w.mutations).toBe(0);
});

test("starting inventory survives popup close, replaces its live owners, and ignores retired records", async () => {
  const time = clock(), a = await workspace(), b = await workspace("other", "next"), h = hook("starting", a.data);
  h.render({ active: true, open: true }); await flush(); const old = a.branches.find(request => request.query.type === "git.recent-branches")!;
  h.render({ open: false }); await time.tick(250); expect(a.watches).toHaveLength(1); expect(a.branches).toHaveLength(2);
  h.render({ data: b.data, active: false, open: false }); await flush(); expect(a.branches.map(request => request.action)).toEqual(["retain", "retain", "release", "release"]); expect(b.branches).toEqual([]);
  a.complete(old, "late"); await flush(); h.render(); expect(h.value.snapshot.recent).toEqual([]);
  h.render({ active: true, open: true }); await flush(); expect(b.branches.filter(request => request.action === "retain")).toHaveLength(2); expect(b.branches[0]).toMatchObject({ hostId: "other", target: { projectId: "next" } });
  h.dispose(); await time.tick(250);
});

test("search retains its typed workspaceQuery path and old answers cannot survive a watch generation", async () => {
  const time = clock(), w = await workspace(), h = hook("search", w.data);
  h.render({ active: true, query: "" }); await flush(); expect(w.watches).toEqual([]); expect(w.branches).toEqual([]);
  h.render({ query: "topic" }); await time.tick(200); expect(w.requests.map(request => request.query.type)).toEqual(["git.search-branches"]); expect(w.watches).toHaveLength(1);
  const version = h.value.controller.version; w.status({ phase: "ready" }); expect(h.value.controller.isCurrent(version)).toBe(false);
  await time.tick(200); expect(w.requests).toHaveLength(1); w.answerSearch("stale"); await flush(); expect(w.requests).toHaveLength(2); h.render(); expect(h.value.snapshot.branches).toEqual([]);
  w.answerSearch("fresh"); await flush(); h.render(); expect(h.value.snapshot.branches.map((row: { name: string }) => row.name)).toEqual(["fresh"]);
  h.dispose(); await time.tick(250);
});

test("inventory and search share one watch; branch warning is carried only by its explicit live record", async () => {
  const time = clock(), w = await workspace(), inventory = hook("inventory", w.data), search = hook("search", w.data);
  inventory.render({ active: true }); search.render({ active: true }); await time.tick(200); expect(w.watches).toHaveLength(1);
  const recent = w.branches.find(request => request.query.type === "git.recent-branches")!; w.complete(recent, "partial", 1, "stream lag"); await flush(); inventory.render();
  expect(inventory.value.snapshot).toMatchObject({ recent: ["partial"], warning: "Live updates may be incomplete. stream lag" });
  const generation = w.data.repositoryInvalidation; w.status({ phase: "ready", error: "watch partial" });
  expect(w.data.repositoryInvalidation).toBe(generation + 1); expect(w.data.repositoryWatchWarning).toContain("watch partial"); expect(w.branches).toHaveLength(2);
  inventory.dispose(); await time.tick(250); expect(w.watches).toHaveLength(1);
  search.dispose(); await time.tick(250); expect(w.watches.map(request => request.action)).toEqual(["retain", "release"]);
});

test("missing branch bridge reports live-query failure and never falls back to workspaceQuery", async () => {
  const time = clock(), w = await workspace("host", "project", false), h = hook("inventory", w.data);
  h.render({ active: true }); await flush(); h.render();
  expect(w.requests).toEqual([]); expect(h.value.snapshot.error).toContain("Live branch queries are unavailable"); expect(h.value.snapshot.defaultError).toContain("Live branch queries are unavailable"); expect(w.mutations).toBe(0);
  h.dispose(); await time.tick(250);
});

test("foreign records and watch recovery do not manufacture results; cached connection changes retire and replace owners", async () => {
  const time = clock(), w = await workspace(), h = hook("inventory", w.data); h.render({ active: true }); await flush();
  const old = w.branches.find(request => request.query.type === "git.recent-branches")!, initial = w.branches.length;
  w.emit(old, { phase: "ready", update: { generation: 1, requiresRecovery: false, phase: "complete", result: { type: "git.recent-branches", branches: ["foreign"] } } }, { hostId: "foreign" }); await flush(); h.render(); expect(h.value.snapshot.recent).toEqual([]);
  w.release(); w.data.setConnected(false); w.status({ phase: "disconnected" }); const release = retainWorkspace(w.data); cleanups.push(release);
  w.data.setConnected(true); w.status({ phase: "pending" }); w.status({ phase: "ready" }); await flush();
  expect(w.branches.slice(initial).map(request => request.action)).toEqual(["release", "release", "retain", "retain"]); expect(w.watches.map(request => request.action)).toEqual(["retain"]); expect(w.branchListeners.size).toBe(2);
  const replacement = w.branches.filter(request => request.action === "retain" && request.query.type === "git.recent-branches").at(-1)!; w.complete(replacement, "reconnected", 2); await flush(); h.render(); expect(h.value.snapshot.recent).toEqual(["reconnected"]);
  h.dispose(); await time.tick(250); expect(w.branchListeners.size).toBe(0); expect(w.watches.map(request => request.action)).toEqual(["retain", "release"]);
});
