import { expect, test } from "bun:test";
import React from "react";
import type { WorkspaceState } from "./workspace-state";
import { useStartingStateInventory } from "./use-starting-state-inventory";
import { startingStateLabel } from "./starting-state-options";
import { controlledBranchQueryObserverFactory } from "./branch-inventory-fixture";

function workspace() {
  const observers = controlledBranchQueryObserverFactory();
  const listeners = new Set<() => void>();
  const watches = new Set<object>();
  const data = { connected: true, status: { revision: "one", branch: "feature/live" },
    retainRepositoryWatch() { const lease = {}; watches.add(lease); return () => { watches.delete(lease); }; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    createBranchQueryObserver: observers.createBranchQueryObserver,
  } as unknown as WorkspaceState;
  return { data, queries: observers.requests, listeners, watches, notify() { for (const listener of listeners) listener(); },
    answer(base: { local: string; remote: string } | null, recent = ["main"]) {
      for (const { query, response } of observers.requests) {
        if (query.type === "git.base-branch") response.resolve({ type: query.type, base });
        else if (query.type === "git.recent-branches") response.resolve({ type: query.type, branches: recent });
        else throw new Error(`Unexpected query ${query.type}`);
      }
    },
  };
}
/** Execute the actual hook's effects against actual inventory/controllers.
 * Commit phases are controlled; this is not a mounted React or IPC test. */
function fixture(initial: WorkspaceState | undefined) {
  let input = { workspace: initial, active: false, open: false }, cursor = 0;
  let effects: (() => void)[] = [], value: ReturnType<typeof useStartingStateInventory>;
  const slots: any[] = [], cleanups = new Map<number, () => void>(), deps = new Map<number, readonly unknown[]>();
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useRef(initial: unknown) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useMemo(factory: () => unknown, next: readonly unknown[]) { const i = cursor++, previous = slots[i];
      if (!previous || next.length !== previous.deps.length || !next.every((v, at) => Object.is(v, previous.deps[at]))) slots[i] = { deps: next, value: factory() };
      return slots[i].value; },
    useSyncExternalStore(_subscribe: unknown, get: () => unknown) { cursor++; return get(); },
    useLayoutEffect(fn: () => void | (() => void), next: readonly unknown[]) { const i = cursor++, previous = deps.get(i);
      if (previous && previous.length === next.length && next.every((v, at) => Object.is(v, previous[at]))) return;
      effects.push(() => { cleanups.get(i)?.(); cleanups.delete(i); const cleanup = fn(); if (cleanup) cleanups.set(i, cleanup); deps.set(i, next); }); },
  };
  function render(change: Partial<typeof input> = {}, commit = true) {
    input = { ...input, ...change }; cursor = 0; effects = [];
    const previous = internals.H; internals.H = dispatcher;
    try { value = useStartingStateInventory(input.workspace, input.active, input.open); } finally { internals.H = previous; }
    if (commit) for (const effect of effects) effect();
  }
  render();
  return { render, get value() { return value; }, async flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); },
    dispose() { for (const cleanup of cleanups.values()) cleanup(); },
  };
}

test("first explicit open starts reads; close retains late replies and closed updates, reopen refreshes", async () => {
  const w = workspace(), f = fixture(w.data);
  try {
    expect(w.queries).toEqual([]); expect(w.watches.size).toBe(0);
    f.render({ active: true, open: true }); await f.flush();
    expect(w.watches.size).toBe(1); expect(w.queries.map(q => q.query.type)).toEqual(["git.recent-branches", "git.base-branch"]);
    f.render({ open: false }); expect(w.listeners.size).toBe(1); expect(w.watches.size).toBe(1);
    w.answer({ remote: "team/origin", local: "develop" }, ["topic"]); await f.flush();
    expect(startingStateLabel({ type: "working-tree" }, null, f.value.snapshot)).toBe("develop (current)");
    w.data.status = { ...w.data.status!, revision: "two", head: "new-commit" }; w.notify();
    expect(w.queries).toHaveLength(2);
    w.answer({ remote: "team/origin", local: "next" }, ["topic"]); await f.flush();
    expect(startingStateLabel({ type: "working-tree" }, null, f.value.snapshot)).toBe("next (current)");
    f.render({ open: true }); expect(w.queries).toHaveLength(2);
    expect(w.queries.every(q => q.query.type === "git.base-branch" || q.query.type === "git.recent-branches")).toBe(true);
  } finally { f.dispose(); }
  expect(w.listeners.size).toBe(0); expect(w.watches.size).toBe(0);
});

test("closed loss-return rejects old reads and resumes the same owner's inventory without reopening", async () => {
  const w = workspace(), f = fixture(w.data);
  try {
    f.render({ active: true, open: true }); await f.flush(); f.render({ open: false });
    w.data.connected = false; w.notify(); w.data.connected = true; w.notify();
    expect(w.queries).toHaveLength(2); // Sent reads finish before replacement admission.
    w.answer({ remote: "old", local: "stale" }); await f.flush();
    expect(f.value.snapshot.baseBranch).toBeUndefined(); expect(w.queries).toHaveLength(4);
    w.answer({ remote: "fresh", local: "current" }); await f.flush();
    expect(f.value.snapshot.baseBranch).toEqual({ remote: "fresh", local: "current" });
  } finally { f.dispose(); }
});

test("owner replacement, inactive mode and unmount retire reads; replacement stays unopened", async () => {
  const a = workspace(), b = workspace(), f = fixture(a.data);
  try {
    f.render({ active: true, open: true }); await f.flush(); f.render({ workspace: b.data, active: false, open: false });
    expect(a.listeners.size).toBe(0); expect(b.queries).toEqual([]);
    a.answer({ remote: "old", local: "old" }); await f.flush(); expect(f.value.snapshot.baseBranch).toBeUndefined();
    f.render({ active: true, open: true }); f.render({ active: false, open: false });
    b.answer({ remote: "new", local: "new" }); await f.flush();
    expect(f.value.snapshot.baseBranch).toBeUndefined(); expect(b.listeners.size).toBe(0);
    f.render({ active: true, open: true }); await f.flush(); expect(b.queries).toHaveLength(2);
    f.dispose(); b.answer({ remote: "late", local: "late" }); await f.flush();
    expect(f.value.snapshot.baseBranch).toBeUndefined(); expect(b.listeners.size).toBe(0);
  } finally { f.dispose(); }
});

test("uncommitted open causes no read; absent workspace stays inert", () => {
  const w = workspace(), f = fixture(undefined);
  try {
    expect(f.value.controller).toBeUndefined();
    f.render({ workspace: w.data, active: true, open: true }, false); expect(w.queries).toEqual([]);
    f.render({ active: false, open: false }); expect(w.queries).toEqual([]);
  } finally { f.dispose(); }
});

test("closed labels qualify only the exact selected base pair and preserve authored branch names", () => {
  const inventory = { recent: ["topic", "master"], loading: false, loaded: true, baseBranch: { remote: "team/origin", local: "main" }, defaultBranch: "main" };
  expect(startingStateLabel({ type: "branch", branchName: "main", remoteRef: "refs/remotes/team/origin/main" }, "live", inventory)).toBe("team/origin/main");
  expect(startingStateLabel({ type: "branch", branchName: "main", remoteRef: "refs/remotes/other/main" }, "live", inventory)).toBe("main");
  expect(startingStateLabel({ type: "branch", branchName: "authored", remoteRef: "refs/remotes/team/origin/main" }, "live", inventory)).toBe("authored");
  expect(startingStateLabel({ type: "branch", branchName: "other/topic", remoteRef: "refs/remotes/other/topic" }, "live", inventory)).toBe("other/topic");
  expect(startingStateLabel({ type: "working-tree" }, "live", inventory)).toBe("live (current)");
  expect(startingStateLabel({ type: "working-tree" }, null, { ...inventory, baseBranch: null, defaultBranch: undefined })).toBe("master (current)");
  expect(startingStateLabel({ type: "working-tree" }, null, { recent: ["topic"], loading: false, loaded: true })).toBe("main (current)");
  expect(startingStateLabel({ type: "working-tree" }, null, { recent: [], loading: false, loaded: false })).toBe("main (current)");
});
