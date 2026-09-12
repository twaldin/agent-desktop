import { expect, test } from "bun:test";
import React from "react";
import type { GitBranch, WorktreeStartingState, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { StartingStateMenu } from "./StartingStateMenu";
import { startingStateGroups } from "./starting-state-options";
import { BranchInventory } from "./branch-inventory";
import { BranchSearch } from "./branch-search";
import { controlledBranchQueryObserverFactory } from "./branch-inventory-fixture";
import type { WorkspaceState } from "./workspace-state";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function nodes(value: any): React.ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return React.isValidElement<{ children?: React.ReactNode }>(value) ? [value, ...nodes(value.props.children)] : [];
}
const remote = (name: string): GitBranch => ({ name, ref: `refs/remotes/${name}`, remote: true, current: false, commit: "a".repeat(40), upstream: null, symbolicTarget: null });
const response = (rows: GitBranch[]): Extract<WorkspaceQueryResult, { type: "git.search-starting-branches" }> => ({ type: "git.search-starting-branches", branches: rows, limitReached: false });
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

/** Actual component and controller calls, with explicit hook commit phases and
 * virtual timer admission. No mounted React, browser defaults or native focus. */
function fixture(options: { selected?: WorktreeStartingState; current?: string | null; recent?: string[]; base?: { local: string; remote: string } | null; dirty?: boolean } = {}) {
  const timers = new Map<number, { callback: () => void; delay: number }>(); let timerId = 0;
  const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const observers = controlledBranchQueryObserverFactory(request => {
    const { query, response } = request;
    if (query.type === "git.recent-branches") response.resolve({ type: query.type, branches: options.recent ?? ["feature/recent", "feature/saved", "main"] });
    else if (query.type === "git.base-branch") response.resolve({ type: query.type, base: options.base === undefined ? { remote: "team/origin", local: "main" } : options.base });
    else throw new Error(`Unexpected inventory query ${query.type}`);
  });
  const searches: { query: WorkspaceQuery; response: ReturnType<typeof deferred<WorkspaceQueryResult>> }[] = [];
  const listeners = new Set<() => void>(); const watches = new Set<object>(); const selections: WorktreeStartingState[] = []; let closes = 0;
  const workspace = { connected: true, repositoryQueryRevision() { return 0; }, restored: true, busy: false, status: { revision: "r1", branch: options.current === undefined ? "feature/current" : options.current, entries: options.dirty === false ? [] : [{}] },
    retainRepositoryWatch() { const lease = {}; watches.add(lease); return () => { watches.delete(lease); }; },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    createBranchQueryObserver: observers.createBranchQueryObserver,
    query(query: WorkspaceQuery) {
      const result = deferred<WorkspaceQueryResult>(); searches.push({ query, response: result });
      return result.promise;
    },
  } as unknown as WorkspaceState;
  const inventory = new BranchInventory(workspace, "starting-state"); inventory.configure(true);
  let props: React.ComponentProps<typeof StartingStateMenu> = { inventory: { controller: inventory, snapshot: inventory.getSnapshot() }, workspace, connected: true, disabled: false, projectName: "Project", query: "",
    selected: options.selected ?? { type: "branch", branchName: "feature/saved" }, onQuery(query) { props = { ...props, query }; },
    onSelect(state) { selections.push(state); }, onClose() { closes++; } };
  let cursor = 0, tree: React.ReactNode, effects: Array<() => void> = [];
  const slots: any[] = [], cleanups = new Map<number, () => void>(), deps = new Map<number, readonly unknown[]>();
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useRef(value: unknown) { const i = cursor++; return slots[i] ?? (slots[i] = { current: value }); },
    useMemo(factory: () => unknown, next: readonly unknown[]) { const i = cursor++, prior = slots[i];
      if (!prior || next.length !== prior.deps.length || !next.every((v, at) => Object.is(v, prior.deps[at]))) slots[i] = { value: factory(), deps: next };
      return slots[i].value; },
    useSyncExternalStore(_subscribe: unknown, get: () => unknown) { cursor++; return get(); },
    useLayoutEffect(fn: () => void | (() => void), next: readonly unknown[]) { const i = cursor++, prior = deps.get(i);
      if (prior && next.length === prior.length && next.every((v, at) => Object.is(v, prior[at]))) return;
      effects.push(() => { cleanups.get(i)?.(); cleanups.delete(i); const cleanup = fn(); if (cleanup) cleanups.set(i, cleanup); deps.set(i, next); }); },
  };
  function render(change: Partial<typeof props> = {}) {
    props = { ...props, ...change, inventory: { controller: inventory, snapshot: inventory.getSnapshot() } }; cursor = 0; effects = [];
    const old = internals.H; internals.H = dispatcher;
    try { tree = StartingStateMenu(props); } finally { internals.H = old; }
    for (const fn of effects) fn();
  }
  render();
  return { workspace, queries: searches, inventoryRequests: observers.requests, selections, get closes() { return closes; }, render,
    all: () => nodes(tree), row: (label: string) => nodes(tree).find(n => n.type === "button" && n.props.title === label)!,
    input: () => nodes(tree).find(n => n.type === "input")!,
    async flush() { await settle(); render(); },
    fireSearch() { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) timer.callback(); return pending.map(t => t.delay); },
    connection(value: boolean) { workspace.connected = value; for (const listener of listeners) listener(); },
    stop() { for (const cleanup of cleanups.values()) cleanup(); cleanups.clear(); },
    dispose() { inventory.configure(false); for (const cleanup of cleanups.values()) cleanup(); globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear; },
  };
}

test("idle picker groups retain default/current/saved/recent order and exact base remote payload", async () => {
  const f = fixture();
  try {
    await f.flush(); await f.flush();
    expect(f.inventoryRequests.map(r => r.query.type)).toEqual(["git.recent-branches", "git.base-branch"]);
    const titles = f.all().filter(n => n.type === "button").map(n => n.props.title);
    expect(titles).toEqual(["feature/current", "team/origin/main", "main", "feature/current", "feature/saved", "feature/recent"]);
    expect(f.row("feature/saved").props["aria-checked"]).toBe(true);
    f.row("team/origin/main").props.onClick();
    expect(f.selections).toEqual([{ type: "branch", branchName: "main", remoteRef: "refs/remotes/team/origin/main" }]);
    expect(f.closes).toBe(1); f.row("team/origin/main").props.onClick(); expect(f.selections).toHaveLength(1);
    expect(f.inventoryRequests).toHaveLength(2); expect(f.queries).toHaveLength(0);
  } finally { f.dispose(); }
});

test("typed picker debounces300, saves qualified remote intent and never resolves or checks out", async () => {
  const f = fixture();
  try {
    await f.flush(); f.render({ query: "topic" }); f.render();
    expect(f.fireSearch()).toEqual([300]);
    const request = f.queries.at(-1)!;
    expect(request.query).toEqual({ type: "git.search-starting-branches", query: "topic", limit: 20 });
    request.response.resolve(response([remote("origin/topic"), remote("other/topic")])); await f.flush();
    f.row("other/topic").props.onClick();
    expect(f.selections).toEqual([{ type: "branch", branchName: "other/topic", remoteRef: "refs/remotes/other/topic" }]);
    expect([...f.inventoryRequests, ...f.queries].map(r => r.query.type)).toEqual(["git.recent-branches", "git.base-branch", "git.search-starting-branches"]);
  } finally { f.dispose(); }
});

test("prior reply and row cannot survive connection roundtrip; new explicit selection uses fresh response", async () => {
  const f = fixture();
  try {
    await f.flush(); const old = f.row("team/origin/main");
    f.render({ query: "topic" }); f.fireSearch(); const request = f.queries.at(-1)!;
    f.connection(false); f.connection(true); old.props.onClick(); expect(f.selections).toEqual([]);
    f.fireSearch(); request.response.resolve(response([remote("origin/old")])); await f.flush();
    expect(f.row("origin/old")).toBeUndefined();
    const replacement = f.queries.filter(r => r.query.type === "git.search-starting-branches").at(-1)!;
    replacement.response.resolve(response([remote("origin/topic")])); await f.flush();
    f.row("origin/topic").props.onClick(); expect(f.selections).toHaveLength(1);
  } finally { f.dispose(); }
});

test("retired rows do not revive after query ABA, component stop or owner status change", async () => {
  for (const change of ["query", "stop", "status", "disabled"] as const) {
    const f = fixture();
    try {
      await f.flush(); const old = f.row("team/origin/main");
      if (change === "query") { f.render({ query: "different" }); f.render({ query: "" }); await f.flush(); }
      else if (change === "stop") f.stop();
      else if (change === "disabled") f.render({ disabled: true });
      else f.workspace.status = { ...f.workspace.status!, revision: "r2" };
      old.props.onClick(); expect(f.selections).toEqual([]); expect(f.closes).toBe(0);
    } finally { f.dispose(); }
  }
});

test("Enter waits for typed results, composing input never selects, modified Enter uses same row decision", async () => {
  const f = fixture();
  try {
    await f.flush(); f.render({ query: "topic" }); f.render();
    let prevented = 0; const enter = (extra = {}) => ({ key: "Enter", metaKey: true, preventDefault() { prevented++; }, nativeEvent: { isComposing: false }, ...extra });
    f.input().props.onKeyDown(enter()); expect(prevented).toBe(1); expect(f.selections).toEqual([]);
    f.fireSearch(); f.queries.at(-1)!.response.resolve(response([remote("origin/topic")])); await f.flush();
    f.input().props.onKeyDown(enter({ nativeEvent: { isComposing: true } })); expect(f.selections).toEqual([]);
    f.input().props.onKeyDown(enter()); expect(f.selections).toEqual([{ type: "branch", branchName: "origin/topic", remoteRef: "refs/remotes/origin/topic" }]);
  } finally { f.dispose(); }
});

test("malformed or old-mode responses stay visible errors, no local fallback or request replay", async () => {
  for (const result of [{ type: "git.search-branches", branches: [], limitReached: false }, response([{ ...remote("origin/topic"), name: "topic" }])]) {
    const f = fixture();
    try {
      await f.flush(); f.render({ query: "topic" }); f.fireSearch(); f.queries.at(-1)!.response.resolve(result as WorkspaceQueryResult); await f.flush();
      expect(f.all().some(n => n.props.role === "alert")).toBe(true); expect(f.row("origin/topic")).toBeUndefined();
      expect(f.queries.filter(r => r.query.type === "git.search-starting-branches")).toHaveLength(1); expect(f.selections).toEqual([]);
    } finally { f.dispose(); }
  }
});

test("dirty row filters by actual branch label and clear starting state does not grow a dirty row", () => {
  const inventory = { recent: ["main"], defaultBranch: "main", loading: false, loaded: true, baseBranch: null };
  const search = { query: "", branches: [], loading: false, limitReached: false };
  expect(startingStateGroups("", "main", false, { type: "working-tree" }, inventory, search)[0]?.label).toBe("Local branches");
  expect(startingStateGroups("local file", "main", true, { type: "working-tree" }, inventory, search).some(g => g.label === "Local file state")).toBe(false);
});

test("starting search API never admits checkout resolution", async () => {
  const calls: WorkspaceQuery[] = [];
  const controller = new BranchSearch({ connected: true, repositoryQueryRevision() { return 0; }, subscribe: () => () => {}, async query(query) { calls.push(query); throw new Error("No query expected"); } }, "starting-state");
  controller.configure("", true);
  try { expect(await controller.resolveCheckout("main")).toBeUndefined(); expect(calls).toEqual([]); }
  finally { controller.configure("", false); }
});


for (const interaction of ["click", "enter"] as const) test(`unknown saved remote is not a local row and click/Enter cannot strip its ref (${interaction})`, async () => {
    const selected: WorktreeStartingState = { type: "branch", branchName: "origin/topic", remoteRef: "refs/remotes/origin/topic" };
    const f = fixture({ selected, current: null, recent: [], base: null, dirty: false });
    try {
      await f.flush(); await f.flush();
      if (interaction === "click") f.row("origin/topic")?.props.onClick();
      else f.input().props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} });
      expect(f.selections).toEqual([]); expect(f.closes).toBe(0);
      expect(f.all().filter(n => n.props.role === "menuitemradio")).toEqual([]);
      expect(selected).toEqual({ type: "branch", branchName: "origin/topic", remoteRef: "refs/remotes/origin/topic" });
    } finally { f.dispose(); }
});

for (const interaction of ["click", "enter"] as const) test(`typed search keeps a discovered remote row's exact identity for pointer and Enter (${interaction})`, async () => {
    const selected: WorktreeStartingState = { type: "branch", branchName: "origin/topic", remoteRef: "refs/remotes/origin/topic" };
    const f = fixture({ selected, current: null, recent: [], base: null, dirty: false });
    try {
      await f.flush(); f.render({ query: "topic" }); f.fireSearch();
      f.queries.at(-1)!.response.resolve(response([remote("origin/topic")])); await f.flush();
      const rows = f.all().filter(n => n.props.role === "menuitemradio"); expect(rows).toHaveLength(1);
      expect(rows[0]!.props["aria-checked"]).toBe(true);
      if (interaction === "click") rows[0]!.props.onClick();
      else f.input().props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} });
      expect(f.selections).toEqual([selected]); expect(f.closes).toBe(1);
    } finally { f.dispose(); }
});

test("same-spelled actual local branch stays independently selectable beside saved remote", async () => {
  for (const source of ["current", "recent", "default", "search"] as const) {
    const selected: WorktreeStartingState = { type: "branch", branchName: "origin/topic", remoteRef: "refs/remotes/origin/topic" };
    const inventory = { recent: source === "recent" ? ["origin/topic"] : [], defaultBranch: source === "default" ? "origin/topic" : undefined, baseBranch: null, loaded: true, loading: false };
    const search = { query: source === "search" ? "topic" : "", branches: source === "search" ? [{ ...remote("origin/topic"), remote: false, ref: "refs/heads/origin/topic" }] : [], loading: false, limitReached: false };
    const groups = startingStateGroups(search.query, source === "current" ? "origin/topic" : null, false, selected, inventory, search);
    expect(groups.find(group => group.label === "Local branches")?.rows).toEqual([{ key: "refs/heads/origin/topic", label: "origin/topic", state: { type: "branch", branchName: "origin/topic" } }]);
  }
});

test("local saved fallback and explicit base pair remain available while unrelated local names survive", () => {
  const search = { query: "", branches: [], loading: false, limitReached: false };
  const empty = { recent: [], loading: false, loaded: true, baseBranch: null };
  expect(startingStateGroups("", null, false, { type: "branch", branchName: "local-authored" }, empty, search)[0]!.rows[0]!.state).toEqual({ type: "branch", branchName: "local-authored" });
  const selected: WorktreeStartingState = { type: "branch", branchName: "origin/topic", remoteRef: "refs/remotes/origin/topic" };
  expect(startingStateGroups("", null, false, selected, { ...empty, recent: ["other"] }, search).flatMap(g => g.rows).map(row => row.label)).toEqual(["other"]);
  const base: WorktreeStartingState = { type: "branch", branchName: "main", remoteRef: "refs/remotes/origin/main" };
  const groups = startingStateGroups("", null, false, base, { ...empty, defaultBranch: "main", baseBranch: { remote: "origin", local: "main" } }, search);
  expect(groups[0]!.rows[0]!.state).toEqual(base);
  expect(groups[1]!.rows[0]!.state).toEqual({ type: "branch", branchName: "main" });
});
