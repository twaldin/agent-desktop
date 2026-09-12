import { expect, test } from "bun:test";
import React from "react";
import type { DesktopMenuItem } from "../../../../packages/shared/src/context-menu";
import type { WorkspaceState } from "./workspace-state";
import type { BranchSelectorProps } from "./BranchSelector";
import { controlledBranchQueryObserverFactory } from "./branch-inventory-fixture";
const { BranchSelector }: typeof import("./BranchSelector") = await import(process.env.BRANCH_COPY_SELECTOR_SOURCE ?? "./BranchSelector");

function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function workspace(branch: string | null = "feature/λ-exact") {
  const calls: string[] = [];
  const observers = controlledBranchQueryObserverFactory();
  const value = { status: { branch, entries: [], head: "head", revision: "revision" }, branches: [], errors: {}, loading: new Set(),
    connected: true, repositoryQueryRevision() { return 0; }, restored: true, busy: false, subscribe: () => () => {},
    createBranchQueryObserver: observers.createBranchQueryObserver,
    loadGit: async () => { calls.push("git"); }, loadWorktrees: async () => { calls.push("worktrees"); },
    mutate: async () => { throw new Error("Copy cannot check out or mutate"); } } as unknown as WorkspaceState;
  return { value, calls };
}
function nodes(value: React.ReactNode): React.ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!React.isValidElement<{ children?: React.ReactNode }>(value)) return [];
  return [value, ...nodes(value.props.children)];
}

/** Actual BranchSelector and copy hook with controlled commit/effect delivery.
 * No mounted DOM, native menu, clipboard permission or OS focus is exercised. */
function fixture() {
  const original = workspace();
  let props: BranchSelectorProps = { workspace: original.value, connected: true, variant: "environment", branchPrefix: "codex/", onOpenGitSettings() { throw new Error("No settings action"); } };
  const slots: any[] = [], cleanups = new Map<number, () => void>(), effectDeps = new Map<number, readonly unknown[]>();
  let cursor = 0, effects: Array<() => void> = [], tree: React.ReactNode, mounted = false;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useRef(initial: unknown) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (next: any) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useReducer(_reducer: unknown, initial: unknown) { cursor++; return [initial, () => {}]; },
    useId() { return `id-${cursor++}`; },
    useMemo(factory: () => unknown, deps: readonly unknown[]) {
      const i = cursor++, previous = slots[i];
      if (!previous || !deps.every((value, index) => Object.is(value, previous.deps[index]))) slots[i] = { deps, value: factory() };
      return slots[i].value;
    },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { cursor++; return getSnapshot(); },
    useEffect() { cursor++; },
    useLayoutEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const i = cursor++, old = effectDeps.get(i);
      if (old && old.length === deps.length && old.every((value, index) => Object.is(value, deps[index]))) return;
      effects.push(() => { cleanups.get(i)?.(); const cleanup = effect(); if (cleanup) cleanups.set(i, cleanup); else cleanups.delete(i); effectDeps.set(i, deps); });
    },
  };
  function render(change: Partial<BranchSelectorProps> = {}) {
    props = { ...props, ...change }; cursor = 0; effects = [];
    const previous = internals.H; internals.H = dispatcher;
    try {
      const selector = BranchSelector(props);
      if (!React.isValidElement(selector) || typeof selector.type !== "function") {
        if (mounted) { for (const cleanup of cleanups.values()) cleanup(); cleanups.clear(); effectDeps.clear(); slots.length = 0; }
        mounted = false; tree = selector;
      } else {
        mounted = true; tree = (selector.type as (props: BranchSelectorProps) => React.ReactNode)(selector.props as BranchSelectorProps);
      }
    } finally { internals.H = previous; }
    for (const effect of effects) effect();
  }
  const menus: { items: DesktopMenuItem[]; result: ReturnType<typeof deferred<string | null>> }[] = [], copied: string[] = [];
  let clipboard: (value: string) => Promise<void> = async value => { copied.push(value); };
  const view = { agentDesktop: { showContextMenu: async (items: DesktopMenuItem[]) => { const result = deferred<string | null>(); menus.push({ items, result }); return result.promise; } },
    navigator: { clipboard: { writeText: (value: string) => clipboard(value) } } };
  function trigger() { const node = nodes(tree).find(value => value.type === "button" && value.props["aria-label"] === "Switch branch"); if (!node) throw new Error("Branch trigger missing"); return node; }
  function open(prevented = false) {
    let stops = 0, prevents = 0;
    const event = { currentTarget: { ownerDocument: { defaultView: view } }, defaultPrevented: prevented,
      preventDefault() { prevents++; }, stopPropagation() { stops++; } };
    const action = trigger().props.onContextMenu;
    if (typeof action !== "function") throw new Error("Environment branch secondary action is missing");
    const result = action(event) as Promise<void>;
    return { result, get stops() { return stops; }, get prevents() { return prevents; } };
  }
  render();
  return { original, copied, menus, render, open, trigger, setClipboard(write: typeof clipboard) { clipboard = write; },
    alerts() { render(); return nodes(tree).filter(node => node.props.role === "alert").map(node => node.props.children); },
    dispose() { for (const cleanup of cleanups.values()) cleanup(); cleanups.clear(); } };
}

test("environment branch context action copies the literal branch once and preserves primary checkout-menu loading", async () => {
  const f = fixture();
  try {
    const opened = f.open(); expect(opened.prevents).toBe(1); expect(opened.stops).toBe(1);
    expect(f.menus[0]?.items).toEqual([{ id: "copy-branch-name", label: "Copy branch name" }]);
    expect(f.original.calls).toEqual([]); expect(f.copied).toEqual([]);
    f.menus[0]!.result.resolve("copy-branch-name"); await opened.result;
    expect(f.copied).toEqual(["feature/λ-exact"]); expect(f.alerts()).toEqual([]);
    f.trigger().props.onClick(); expect(f.original.calls).toEqual(["git", "worktrees"]);
  } finally { f.dispose(); }
});

test("repository loss unmounts the controlled selector and retires its open native menu", async () => {
  const f = fixture();
  try {
    const opened = f.open();
    f.original.value.gitAvailability = "not-repository"; f.render();
    expect(() => f.trigger()).toThrow("Branch trigger missing");
    f.menus[0]!.result.resolve("copy-branch-name"); await opened.result;
    expect(f.copied).toEqual([]);
    f.original.value.gitAvailability = "repository"; f.render();
    expect(f.trigger().props["aria-label"]).toBe("Switch branch");
  } finally { f.dispose(); }
});

test("dismissal, unknown menu ids, prevented events and non-environment branch triggers cannot copy", async () => {
  const f = fixture();
  try {
    for (const id of [null, "checkout"]) { const opened = f.open(); f.menus.at(-1)!.result.resolve(id); await opened.result; }
    expect(f.copied).toEqual([]);
    const prevented = f.open(true); await prevented.result; expect(prevented.prevents).toBe(0);
    f.render({ variant: "composer" }); await f.open().result;
    f.render({ variant: "commit" }); await f.open().result;
    f.render({ variant: "environment", workspace: workspace(null).value }); await f.open().result;
    expect(f.menus).toHaveLength(2); expect(f.original.calls).toEqual([]);
  } finally { f.dispose(); }
});

test("committed workspace or branch roundtrip and unmount invalidate an outstanding native copy selection", async () => {
  for (const transition of ["workspace", "branch", "unmount"] as const) {
    const f = fixture();
    try {
      const opened = f.open();
      if (transition === "unmount") f.dispose();
      else if (transition === "workspace") { f.render({ workspace: workspace().value }); f.render({ workspace: f.original.value }); }
      else { f.original.value.status!.branch = "changed"; f.render(); f.original.value.status!.branch = "feature/λ-exact"; f.render(); }
      f.menus[0]!.result.resolve("copy-branch-name"); await opened.result;
      expect(f.copied).toEqual([]); expect(f.original.calls).toEqual([]);
    } finally { f.dispose(); }
  }
});

test("newer menu supersedes old selection and clipboard errors remain visible only to their owning branch", async () => {
  const f = fixture();
  try {
    const first = f.open(), second = f.open();
    f.menus[0]!.result.resolve("copy-branch-name"); await first.result; expect(f.copied).toEqual([]);
    f.setClipboard(async () => { throw new Error("Clipboard denied"); });
    f.menus[1]!.result.resolve("copy-branch-name"); await second.result; expect(f.alerts()).toEqual(["Clipboard denied"]);
    const entered = deferred<void>(), late = deferred<void>();
    f.setClipboard(() => { entered.resolve(); return late.promise; });
    const third = f.open(); f.menus[2]!.result.resolve("copy-branch-name"); await entered.promise;
    f.render({ workspace: workspace("other").value }); late.reject(new Error("Late clipboard failure")); await third.result;
    expect(f.alerts()).toEqual([]);
  } finally { f.dispose(); }
});

for (const loss of ["detached", "absent"] as const) {
  test(`copy ignores stale current catalog when authoritative status is ${loss}`, async () => {
    const f = fixture();
    try {
      f.original.value.branches = [{ name: "catalog-stale", ref: "refs/heads/catalog-stale", commit: "old", current: true, remote: false, upstream: null, symbolicTarget: null }];
      if (loss === "detached") f.original.value.status!.branch = null;
      else f.original.value.status = undefined;
      f.render();
      // The primary display fallback is intentionally separate from copy authority.
      expect(f.trigger().props.title).toBe("catalog-stale");
      const opened = f.open();
      for (const menu of f.menus) menu.result.resolve("copy-branch-name");
      await opened.result;
      expect(f.menus).toHaveLength(0); expect(f.copied).toEqual([]);
      expect(opened.prevents).toBe(0); expect(f.original.calls).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`committed status ${loss} then return invalidates pending copy even with unchanged catalog label`, async () => {
    const f = fixture();
    try {
      const status = { ...f.original.value.status! };
      f.original.value.branches = [{ name: status.branch!, ref: `refs/heads/${status.branch}`, commit: "old", current: true, remote: false, upstream: null, symbolicTarget: null }];
      f.render(); const opened = f.open();
      f.original.value.status = loss === "detached" ? { ...status, branch: null } : undefined; f.render();
      f.original.value.status = { ...status }; f.render();
      f.menus[0]!.result.resolve("copy-branch-name"); await opened.result;
      expect(f.copied).toEqual([]); expect(f.original.calls).toEqual([]);
      const fresh = f.open(); f.menus[1]!.result.resolve("copy-branch-name"); await fresh.result;
      expect(f.copied).toEqual(["feature/λ-exact"]);
    } finally { f.dispose(); }
  });
}

test("unchanged authoritative branch survives catalog refresh and repeated committed status", async () => {
  const f = fixture();
  try {
    const opened = f.open();
    f.original.value.branches = [{ name: "other-catalog", ref: "refs/heads/other-catalog", commit: "other", current: true, remote: false, upstream: null, symbolicTarget: null }];
    f.original.value.status = { ...f.original.value.status! }; f.render();
    f.menus[0]!.result.resolve("copy-branch-name"); await opened.result;
    expect(f.copied).toEqual(["feature/λ-exact"]); expect(f.menus).toHaveLength(1);
  } finally { f.dispose(); }
});

test("status loss suppresses a clipboard error from the previously authoritative branch", async () => {
  const f = fixture();
  try {
    const status = { ...f.original.value.status! }, entered = deferred<void>(), write = deferred<void>();
    f.original.value.branches = [{ name: status.branch!, ref: `refs/heads/${status.branch}`, commit: "old", current: true, remote: false, upstream: null, symbolicTarget: null }]; f.render();
    f.setClipboard(() => { entered.resolve(); return write.promise; });
    const opened = f.open(); f.menus[0]!.result.resolve("copy-branch-name"); await entered.promise;
    f.original.value.status = undefined; f.render(); f.original.value.status = status; f.render();
    write.reject(new Error("Clipboard rejected after status loss")); await opened.result;
    expect(f.alerts()).toEqual([]);
  } finally { f.dispose(); }
});
