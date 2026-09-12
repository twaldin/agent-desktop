import { expect, test } from "bun:test";
import React from "react";
import type { GitBranch, GitStatus, NewChatExecution, Project, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { ComposerContext } from "./ComposerContext";
import type { WorkspaceState } from "./workspace-state";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const branch = (name: string) => ({ name, ref: `refs/heads/${name}`, remote: false, symbolicTarget: null }) as GitBranch;
const status = (dirty = false) => ({ branch: "main", revision: "current", entries: dirty ? [{ path: "note.txt" }] : [] }) as unknown as GitStatus;
const saved: NewChatExecution = { type: "worktree", startingState: { type: "branch", branchName: "feature/saved" } };

/** Actual forwardRef component and effects with controlled commit phases. No
 * mounted DOM, browser event loop, native UI or persistence transport proof. */
function fixture(execution: NewChatExecution = saved) {
  const globalNames = ["window", "document", "innerWidth", "innerHeight", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame"] as const;
  const globals = globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const replacements = { window: { addEventListener() {}, removeEventListener() {} }, document: { body: { nodeType: 1 } }, innerWidth: 1440, innerHeight: 1000,
    ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  for (const name of globalNames) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: replacements[name] });
  const queries: { input: WorkspaceQuery; result: ReturnType<typeof deferred<WorkspaceQueryResult>> }[] = [];
  const originalSetInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  const watches = new Set<object>();
  const listeners = new Set<() => void>(), changes: NewChatExecution[] = [];
  let git = deferred<GitStatus>(), catalog = deferred<GitBranch[]>(), catalogReads = 0;
  const data = { connected: true, repositoryQueryRevision() { return 0; }, restored: true, busy: false, pending: undefined, status: undefined as GitStatus | undefined,
    branches: [] as GitBranch[], loading: new Set<string>(), errors: {} as Record<string, string | undefined>,
    retainRepositoryWatch() { const lease = {}; watches.add(lease); return () => { watches.delete(lease); }; },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    setConnected(value: boolean) { data.connected = value; notify(); },
    start() {}, stop() {}, restore: async () => {},
    query(input: WorkspaceQuery) { const result = deferred<WorkspaceQueryResult>(); queries.push({ input, result }); return result.promise; },
    async loadGit() { const result = await git.promise; data.status = result; notify(); },
    async loadWorktrees() {
      catalogReads++; data.loading.add("worktrees"); notify();
      try { data.branches = await catalog.promise; data.errors.worktrees = undefined; }
      catch (error) { data.errors.worktrees = (error as Error).message; }
      finally { data.loading.delete("worktrees"); notify(); }
    },
  };
  function notify() { for (const fn of listeners) fn(); }
  type Props = React.ComponentProps<typeof ComposerContext>;
  let props: Props = { hostId: "host", hostName: "Host", hosts: [], projects: [{ id: "project", name: "Project" } as Project],
    projectId: "project", connected: true, addingProject: false, workspace: data as unknown as WorkspaceState,
    execution, worktreesAvailable: true, onExecution(value) { changes.push(value); props = { ...props, execution: value }; },
    onProject() {}, onHost() {}, onAddProject() {}, onOpenGitSettings() {} };
  let cursor = 0, tree: React.ReactNode, effects: Array<() => void> = [];
  const slots: any[] = [], cleanups = new Map<number, () => void>(), deps = new Map<number, readonly unknown[]>();
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function effect(fn: () => void | (() => void), next?: readonly unknown[]) {
    const id = cursor++, prior = deps.get(id);
    if (next && prior && next.length === prior.length && next.every((v, i) => Object.is(v, prior[i]))) return;
    effects.push(() => { cleanups.get(id)?.(); cleanups.delete(id); const cleanup = fn(); if (cleanup) cleanups.set(id, cleanup); if (next) deps.set(id, next); });
  }
  const dispatcher = {
    useState(initial: unknown) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === "function" ? initial() : initial;
      return [slots[id], (value: any) => { slots[id] = typeof value === "function" ? value(slots[id]) : value; }]; },
    useRef(initial: unknown) { const id = cursor++; return slots[id] ?? (slots[id] = { current: initial }); },
    useMemo(factory: () => unknown, next: readonly unknown[]) { const id = cursor++, prior = slots[id];
      if (!prior || next.length !== prior.deps.length || !next.every((v, i) => Object.is(v, prior.deps[i]))) slots[id] = { value: factory(), deps: next };
      return slots[id].value; },
    useSyncExternalStore(_subscribe: unknown, get: () => unknown) { cursor++; return get(); },
    useReducer(_fn: unknown, initial: unknown) { cursor++; return [initial, () => {}]; },
    useEffect: effect, useLayoutEffect: effect, useImperativeHandle() { cursor++; },
  };
  function render(change: Partial<Props> = {}) {
    props = { ...props, ...change }; cursor = 0; effects = [];
    const previous = internals.H; internals.H = dispatcher;
    try { tree = (ComposerContext as any).render(props, null); } finally { internals.H = previous; }
    for (const fn of effects) fn();
  }
  async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); }
  render();
  return { data, queries, watches, changes, render, settle, get props() { return props; }, get tree() { return tree; },
    get catalogReads() { return catalogReads; },
    git(value = status()) { git.resolve(value); }, catalog(rows = [branch("main"), branch("feature/saved")]) { catalog.resolve(rows); },
    failCatalog() { catalog.reject(new Error("Branch catalog unavailable")); },
    reconnect() { data.connected = false; render({ connected: false }); git = deferred(); catalog = deferred(); data.connected = true; render({ connected: true }); },
    dispose() { for (const fn of cleanups.values()) fn(); globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; for (const [name, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } },
  };
}

test("reopening preserves a saved non-current starting branch while Git arrives before its catalog", async () => {
  const f = fixture();
  try {
    await f.settle(); f.git(); await f.settle();
    expect(f.changes).toEqual([]); expect(f.props.execution).toEqual(saved);
    expect(f.catalogReads).toBe(1);
    f.catalog(); await f.settle();
    expect(f.changes).toEqual([]); expect(f.props.execution).toEqual(saved);
  } finally { f.dispose(); }
});

test("missing branch and clean local-file-state choices are preserved for explicit correction", async () => {
  for (const execution of [saved, { type: "worktree", startingState: { type: "working-tree" } } as NewChatExecution]) {
    const f = fixture(execution);
    try {
      f.git(); f.catalog([branch("main")]); await f.settle(); await f.settle();
      expect(f.changes).toEqual([]); expect(f.props.execution).toEqual(execution);
    } finally { f.dispose(); }
  }
});

test("catalog failure and reconnect do not rewrite the saved starting state", async () => {
  const f = fixture();
  try {
    await f.settle(); f.git(); f.failCatalog(); await f.settle();
    expect(f.changes).toEqual([]); expect(f.data.errors.worktrees).toBe("Branch catalog unavailable");
    f.reconnect(); await f.settle(); f.git(); f.catalog(); await f.settle();
    expect(f.catalogReads).toBe(2); expect(f.props.execution).toEqual(saved); expect(f.changes).toEqual([]);
  } finally { f.dispose(); }
});

test("Local mode does not request worktree inventory until selected", async () => {
  const f = fixture({ type: "local" });
  try {
    f.git(); await f.settle(); expect(f.catalogReads).toBe(0);
    f.render({ execution: saved }); await f.settle();
    expect(f.catalogReads).toBe(1); f.catalog(); await f.settle(); expect(f.changes).toEqual([]);
  } finally { f.dispose(); }
});

test("explicit project change still initializes that project's existing fallback", async () => {
  const f = fixture();
  try {
    f.git(); f.catalog(); await f.settle();
    const other = { ...f.data, status: { ...status(), branch: "other-main" }, branches: [branch("other-main")] };
    f.render({ projectId: "other", projects: [{ id: "other", name: "Other" } as Project], workspace: other as unknown as WorkspaceState });
    expect(f.changes).toEqual([{ type: "worktree", startingState: { type: "branch", branchName: "other-main" } }]);
  } finally { f.dispose(); }
});


test("saved remote intent can open the picker without any local branch fallback", async () => {
  const f = fixture({ type: "worktree", startingState: { type: "branch", branchName: "origin/topic", remoteRef: "refs/remotes/origin/topic" } });
  try {
    f.git({ ...status(), branch: null }); f.catalog([]); await f.settle();
    const visit = (value: any): any[] => Array.isArray(value) ? value.flatMap(visit) : React.isValidElement<{ children?: React.ReactNode }>(value) ? [value, ...visit(value.props.children)] : [];
    const trigger = visit(f.tree).find(node => node.props["aria-label"] === "What branch should this chat start from?");
    expect(trigger).toBeDefined(); expect(trigger.props.disabled).toBe(false); expect(f.changes).toEqual([]);
    f.render({ worktreesAvailable: false });
    expect(visit(f.tree).find(node => node.props["aria-label"] === "What branch should this chat start from?").props.disabled).toBe(true);
  } finally { f.dispose(); }
});


test("closed local-file-state chip follows authoritative current branch without rewriting intent", async () => {
  const f = fixture({ type: "worktree", startingState: { type: "working-tree" } });
  const visit = (value: any): any[] => Array.isArray(value) ? value.flatMap(visit) : React.isValidElement<{ children?: React.ReactNode }>(value) ? [value, ...visit(value.props.children)] : [];
  const label = () => visit(f.tree).find(node => node.props["aria-label"] === "What branch should this chat start from?").props.children[1].props.children;
  try {
    expect(label()).toBe("main (current)");
    f.git({ ...status(), branch: "feature/live" }); f.catalog([{ ...branch("stale"), current: true }]); await f.settle();
    expect(label()).toBe("feature/live (current)");
    f.data.status = { ...status(), branch: null }; f.render();
    expect(label()).toBe("main (current)"); expect(f.changes).toEqual([]);
  } finally { f.dispose(); }
});


test("actual composer retains first-open reads after close and retires the permission across Local mode", async () => {
  const f = fixture({ type: "worktree", startingState: { type: "branch", branchName: "main", remoteRef: "refs/remotes/origin/main" } });
  const visit = (value: any): any[] => Array.isArray(value) ? value.flatMap(visit) : React.isValidElement<{ children?: React.ReactNode }>(value) ? [value, ...visit(value.props.children)] : [];
  const trigger = () => visit(f.tree).find(node => node.props["aria-label"] === "What branch should this chat start from?");
  const click = () => { trigger().props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 700, left: 500, bottom: 728, width: 100 }), focus() {} } }); f.render(); };
  const answer = () => { for (const q of f.queries) {
    if (q.input.type === "git.base-branch") q.result.resolve({ type: q.input.type, base: { local: "main", remote: "origin" } });
    else if (q.input.type === "git.recent-branches") q.result.resolve({ type: q.input.type, branches: ["main"] });
    else throw new Error(`Unexpected query ${q.input.type}`);
  } };
  try {
    f.git(); f.catalog(); await f.settle(); expect(f.queries).toEqual([]);
    expect(trigger().props.children[1].props.children).toBe("main");
    click(); expect(f.queries).toHaveLength(2); expect(f.watches.size).toBe(1); await f.settle(); click();
    expect(trigger().props["aria-expanded"]).toBe(false); expect(f.watches.size).toBe(1);
    answer(); await f.settle(); expect(trigger().props.children[1].props.children).toBe("origin/main");
    const saved = f.props.execution; f.render({ execution: { type: "local" } }); f.render({ execution: saved }); await f.settle();
    expect(f.queries).toHaveLength(2); expect(f.watches.size).toBe(0); expect(trigger().props.children[1].props.children).toBe("main");
    click(); expect(f.queries).toHaveLength(4); expect(f.changes).toEqual([]);
  } finally { f.dispose(); }
});
