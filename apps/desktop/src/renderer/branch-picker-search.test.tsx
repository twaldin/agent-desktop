import { expect, test } from "bun:test";
import React from "react";
import type { GitBranch, WorkspaceMutation, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { BranchSelector, type BranchSelectorProps } from "./BranchSelector";
import { controlledBranchQueryObserverFactory } from "./branch-inventory-fixture";
import type { WorkspaceState } from "./workspace-state";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function nodes(value: any): React.ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value?.$$typeof === Symbol.for("react.portal")) return nodes(value.children);
  if (!React.isValidElement<{ children?: React.ReactNode }>(value)) return [];
  return [value, ...nodes(value.props.children)];
}
function text(value: any): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return value && typeof value === "object" ? text(value.props?.children ?? value.children) : "";
}
const branch = (name: string, remote = false): GitBranch => ({ name: remote ? name.slice(name.indexOf("/") + 1) : name, ref: `refs/${remote ? "remotes" : "heads"}/${name}`, commit: "a".repeat(40), current: false, remote, upstream: null, symbolicTarget: null });
const reply = (branches: GitBranch[]): WorkspaceQueryResult => ({ type: "git.search-branches", branches, limitReached: false });
const targetReply = (expression: string, ref = `refs/heads/${expression}`, commit = "a".repeat(40)): WorkspaceQueryResult => ({ type: "git.resolve-checkout", target: {
  kind: "branch", expression, selection: { ref, commit, ...(ref.startsWith("refs/remotes/") ? { localBranch: expression } : {}) },
} });
const revisionReply = (expression: string, commit = "a".repeat(40)): WorkspaceQueryResult => ({ type: "git.resolve-checkout", target: { kind: "revision", expression, commit } });
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

/** Actual component/portal nodes/handlers, controlled hook commit phases and
 * geometry objects. This is not mounted React, DOM default-action or OS proof. */
function fixture() {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const body = { nodeType: 1 }, fakeWindow = { addEventListener() {}, removeEventListener() {} };
  for (const [key, value] of Object.entries({ document: { body }, window: fakeWindow, innerWidth: 1440, innerHeight: 1000,
    ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, cancelAnimationFrame() {} })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const mutations: WorkspaceMutation[] = [], selectionRequests: { query: WorkspaceQuery; response: ReturnType<typeof deferred<WorkspaceQueryResult>> }[] = [];
  let inventoryValues: { recent: string[]; defaultBranch: string | null } = { recent: ["cached-main"], defaultBranch: null }, holdInventory = false;
  const observers = controlledBranchQueryObserverFactory(({ query, response }) => {
    if (holdInventory) return;
    if (query.type === "git.recent-branches") response.resolve({ type: query.type, branches: inventoryValues.recent });
    else if (query.type === "git.default-branch") response.resolve({ type: query.type, branch: inventoryValues.defaultBranch });
    else throw new Error(`Unexpected inventory query ${query.type}`);
  });
  const inventoryRequests = observers.requests;
  let entered = deferred<void>(); const listeners = new Set<() => void>(); const watches = new Set<object>();
  const workspace = { connected: true, repositoryQueryRevision() { return 0; }, restored: true, busy: false, status: { branch: "main", head: "head", revision: "reviewed", entries: [] },
    branches: [branch("cached-main")], errors: {}, loading: new Set(), retainRepositoryWatch() { const lease = {}; watches.add(lease); return () => { watches.delete(lease); }; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    createBranchQueryObserver: observers.createBranchQueryObserver,
    loadGit: async () => {}, loadWorktrees: async () => {},
    query(query: WorkspaceQuery) {
      const response = deferred<WorkspaceQueryResult>();
      selectionRequests.push({ query, response });
      entered.resolve(); return response.promise;
    },
    mutateCommand: async (action: WorkspaceMutation) => { mutations.push(action); return "checkout-command"; },
  } as unknown as WorkspaceState;
  let props: BranchSelectorProps = { workspace, connected: true, variant: "environment", branchPrefix: "codex/", onOpenGitSettings() {} };
  let cursor = 0, tree: React.ReactNode, dirty = false, effects: Array<() => void> = [];
  const slots: any[] = [], cleanup = new Map<number, () => void>(), deps = new Map<number, readonly unknown[]>();
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value: any) => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useReducer(_reducer: unknown, initial: unknown) { cursor++; return [initial, () => {}]; },
    useId() { return `id-${cursor++}`; }, useEffect() { cursor++; },
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { cursor++; return snapshot(); },
    useMemo(factory: () => unknown, next: readonly unknown[]) { const i = cursor++, previous = slots[i];
      if (!previous || next.length !== previous.deps.length || !next.every((value, index) => Object.is(value, previous.deps[index]))) slots[i] = { deps: next, value: factory() };
      return slots[i].value; },
    useLayoutEffect(effect: () => void | (() => void), next: readonly unknown[]) { const i = cursor++, previous = deps.get(i);
      if (previous && previous.length === next.length && next.every((value, index) => Object.is(value, previous[index]))) return;
      effects.push(() => { cleanup.get(i)?.(); const result = effect(); if (result) cleanup.set(i, result); else cleanup.delete(i); deps.set(i, next); }); },
  };
  function render(change: Partial<BranchSelectorProps> = {}) {
    props = { ...props, ...change };
    for (let pass = 0; pass < 10; pass++) {
      cursor = 0; effects = []; dirty = false;
      const previous = internals.H; internals.H = dispatcher;
      try { tree = BranchSelector(props); } finally { internals.H = previous; }
      for (const node of nodes(tree)) if (node.props.ref && typeof node.props.ref === "object" && !node.props.ref.current) node.props.ref.current = {
        open: false, showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, contains: () => false,
        getBoundingClientRect: () => ({ left: 650, right: 850, top: 650, bottom: 678 }), querySelector: () => undefined,
      };
      for (const effect of effects) effect();
      if (!dirty) return;
    }
    throw new Error("Controlled component did not settle");
  }
  function find(predicate: (node: React.ReactElement<any>) => boolean) { const found = nodes(tree).find(predicate); if (!found) throw new Error(`Node absent: ${text(tree)}`); return found; }
  render();
  return { workspace, selectionRequests, inventoryRequests, mutations, render, find,
    inventory(values: typeof inventoryValues, held = false) { inventoryValues = values; holdInventory = held; },
    nodes: () => nodes(tree),
    connection(connected: boolean) { workspace.connected = connected; for (const listener of listeners) listener(); },
    open() { find(node => node.type === "button" && node.props["aria-label"] === "Switch branch").props.onClick(); render(); },
    query(value: string) { find(node => node.type === "input" && node.props["aria-label"] === "Search branches").props.onChange({ target: { value } }); render(); },
    async next(count: number) { while (selectionRequests.length < count) { await entered.promise; entered = deferred<void>(); } return selectionRequests[count - 1]!; },
    dispose() { for (const fn of cleanup.values()) fn(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

test("idle component uses independent default current recent inventory without cached catalog rows", async () => {
  const f = fixture();
  try {
    f.inventory({ recent: [], defaultBranch: null }, true);
    f.open(); await settle(); f.render();
    expect(f.inventoryRequests.map(item => item.query)).toEqual([{ type: "git.recent-branches", limit: 100 }, { type: "git.default-branch" }]);
    expect(f.nodes().some(node => node.props.role === "status")).toBe(true);
    expect(f.nodes().filter(node => node.props.role === "menuitemradio")).toEqual([]);
    f.inventoryRequests[0]!.response.resolve({ type: "git.recent-branches", branches: ["tip-new", "main", "tip-old", "tip-new"] });
    await settle(); f.render();
    const rows = () => f.nodes().filter(node => node.props.role === "menuitemradio").map(node => text(node));
    expect(rows()).toEqual(["main", "tip-new", "tip-old"]);
    expect(f.nodes().some(node => node.props.role === "status")).toBe(false);
    f.inventoryRequests[1]!.response.resolve({ type: "git.default-branch", branch: "trunk" });
    await settle(); f.render();
    expect(rows()).toEqual(["trunk", "main", "tip-new", "tip-old"]);
    expect(f.selectionRequests).toEqual([]); expect(f.mutations).toEqual([]);
    f.find(node => node.props.role === "menuitemradio" && text(node) === "tip-old").props.onClick();
    const request = await f.next(1);
    expect(request.query).toEqual({ type: "git.resolve-checkout", expression: "tip-old" });
    request.response.resolve(targetReply("tip-old")); await settle();
    expect(f.mutations).toEqual([{ type: "git.checkout-ref", selection: { ref: "refs/heads/tip-old", commit: "a".repeat(40) }, expectedRevision: "reviewed" }]);
  } finally { f.dispose(); }
});

test("idle component hides stale catalog authority and retains inventory while typing then refreshes on reopen", async () => {
  const f = fixture();
  try {
    f.workspace.status = { ...f.workspace.status!, branch: null };
    f.workspace.branches = [{ ...branch("stale-current"), current: true }];
    f.inventory({ recent: ["fresh"], defaultBranch: "trunk" });
    f.open(); await settle(); f.render();
    const rows = () => f.nodes().filter(node => node.props.role === "menuitemradio").map(node => text(node));
    expect(rows()).toEqual(["trunk", "fresh"]);
    f.query("typed"); f.query(""); await settle(); f.render();
    expect(f.inventoryRequests).toHaveLength(2); expect(rows()).toEqual(["trunk", "fresh"]);
    f.open(); f.inventory({ recent: ["reopened"], defaultBranch: null }); f.open(); await settle(); f.render();
    expect(f.inventoryRequests).toHaveLength(4); expect(rows()).toEqual(["reopened"]);
    expect(f.selectionRequests).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test("commit destination menu does not request checkout inventory", async () => {
  const f = fixture();
  try {
    f.render({ destination: { newBranch: false, onChange() {} } });
    f.find(node => node.type === "button" && node.props["aria-label"] === "Commit to").props.onClick(); f.render(); await settle();
    expect(f.inventoryRequests).toEqual([]); expect(f.selectionRequests).toEqual([]);
    expect(f.nodes().filter(node => node.props.role === "menuitemradio").map(node => text(node))).toEqual(["main", "New branch"]);
  } finally { f.dispose(); }
});

test("actual picker row resolves by name before dispatching the current exact identity", async () => {
  const f = fixture();
  try {
    f.open(); f.query("topic");
    const request = await f.next(1); expect(request.query).toEqual({ type: "git.search-branches", query: "topic", limit: 20 });
    request.response.resolve(reply([branch("topic")])); await settle(); f.render();
    expect(f.nodes().filter(node => node.props.role === "menuitemradio").map(node => text(node))).toEqual(["topic"]);
    f.find(node => node.props.role === "menuitemradio").props.onClick(); const resolution = await f.next(2);
    expect(resolution.query).toEqual({ type: "git.resolve-checkout", expression: "topic" }); expect(f.mutations).toEqual([]);
    resolution.response.resolve(targetReply("topic", "refs/heads/topic", "b".repeat(40))); await settle();
    expect(f.mutations).toEqual([{ type: "git.checkout-ref", selection: { ref: "refs/heads/topic", commit: "b".repeat(40) }, expectedRevision: "reviewed" }]);
  } finally { f.dispose(); }
});

test("actual remote row resolves its short name and checks out the unique remote without a naming dialog", async () => {
  const f = fixture();
  try {
    f.open(); f.query("topic"); (await f.next(1)).response.resolve(reply([branch("origin/topic", true)])); await settle(); f.render();
    expect(f.nodes().filter(node => node.props.role === "menuitemradio").map(node => text(node))).toEqual(["topic"]);
    f.find(node => node.props.role === "menuitemradio").props.onClick(); const resolution = await f.next(2);
    expect(resolution.query).toEqual({ type: "git.resolve-checkout", expression: "topic" });
    f.render(); expect(f.nodes().some(node => node.type === "dialog")).toBe(false); expect(f.mutations).toEqual([]);
    resolution.response.resolve(targetReply("topic", "refs/remotes/origin/topic")); await settle(); f.render();
    expect(f.mutations).toEqual([{ type: "git.checkout-ref", selection: { ref: "refs/remotes/origin/topic", commit: "a".repeat(40), localBranch: "topic" }, expectedRevision: "reviewed" }]);
    expect(f.nodes().some(node => node.props.role === "menu")).toBe(false);
  } finally { f.dispose(); }
});

test("actual search Enter prevents default and missing target never falls back to a cached branch", async () => {
  const f = fixture();
  try {
    f.open(); f.query("absent"); let prevented = 0;
    f.find(node => node.type === "input" && node.props["aria-label"] === "Search branches").props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, metaKey: true, preventDefault() { prevented++; }, stopPropagation() {} });
    const exact = await f.next(1); expect(exact.query).toEqual({ type: "git.resolve-checkout", expression: "absent" });
    exact.response.resolve({ type: "git.resolve-checkout", target: null }); await settle(); f.render();
    expect(prevented).toBe(1); expect(f.mutations).toEqual([]); expect(f.selectionRequests).toHaveLength(1);
    expect(f.nodes().some(node => node.props.role === "alert" && text(node).includes("No matching branch"))).toBe(true);
  } finally { f.dispose(); }
});

for (const kind of ["remote", "revision"] as const) test(`actual Use sends the host ${kind} target without a presentation lookup`, async () => {
  const f = fixture();
  try {
    f.open(); f.query("topic");
    f.find(node => node.props.role === "menuitem" && text(node) === "Use topic").props.onClick();
    const lookup = await f.next(1); expect(lookup.query).toEqual({ type: "git.resolve-checkout", expression: "topic" });
    expect(f.mutations).toEqual([]);
    lookup.response.resolve(kind === "remote" ? targetReply("topic", "refs/remotes/upstream/topic") : revisionReply("topic")); await settle(); f.render();
    expect(f.mutations).toEqual([kind === "remote"
      ? { type: "git.checkout-ref", selection: { ref: "refs/remotes/upstream/topic", localBranch: "topic", commit: "a".repeat(40) }, expectedRevision: "reviewed" }
      : { type: "git.checkout-revision", revision: { expression: "topic", commit: "a".repeat(40) }, expectedRevision: "reviewed" }]);
    expect(f.nodes().some(node => node.props.role === "menu" || node.type === "dialog")).toBe(false); expect(f.selectionRequests).toHaveLength(1);
  } finally { f.dispose(); }
});

test("actual resolution cannot migrate to a replacement workspace before passive close", async () => {
  const f = fixture();
  try {
    f.open(); f.query("topic");
    f.find(node => node.props.role === "menuitem" && text(node) === "Use topic").props.onClick(); const old = await f.next(1);
    f.render({ workspace: { ...f.workspace } as WorkspaceState });
    old.response.resolve(targetReply("topic", "refs/remotes/origin/topic")); await settle(); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test("actual Use rejects a stale target after loss-return then permits a new explicit lookup", async () => {
  const f = fixture();
  try {
    f.open(); f.query("v1");
    const use = () => f.find(node => node.props.role === "menuitem" && text(node) === "Use v1");
    use().props.onClick(); const old = await f.next(1);
    f.connection(false); f.connection(true); f.render(); expect(use().props.disabled).toBe(false);
    old.response.resolve(revisionReply("v1")); await settle(); expect(f.mutations).toEqual([]);
    use().props.onClick(); const current = await f.next(2);
    current.response.resolve(revisionReply("v1", "b".repeat(40))); await settle();
    expect(f.mutations).toEqual([{ type: "git.checkout-revision", revision: { expression: "v1", commit: "b".repeat(40) }, expectedRevision: "reviewed" }]);
  } finally { f.dispose(); }
});

test("actual Use keeps failed checkout visible without an automatic retry", async () => {
  const f = fixture();
  try {
    f.workspace.mutateCommand = async action => { f.mutations.push(action); f.workspace.errors.action = "Inspect the original checkout"; return undefined; };
    f.open(); f.query("HEAD~1");
    f.find(node => node.props.role === "menuitem" && text(node) === "Use HEAD~1").props.onClick();
    (await f.next(1)).response.resolve(revisionReply("HEAD~1")); await settle(); f.render();
    expect(f.mutations).toHaveLength(1); expect(f.nodes().some(node => node.props.role === "menu")).toBe(true);
    expect(f.nodes().some(node => node.props.role === "alert" && text(node).includes("Inspect the original"))).toBe(true);
  } finally { f.dispose(); }
});

test("actual unresolved receipt retains original recovery control and disables a new Use", async () => {
  const f = fixture();
  try {
    f.workspace.mutateCommand = async action => {
      f.mutations.push(action);
      f.workspace.pending = { envelope: { id: "original-revision-command", command: { type: "workspace.mutate", target: { projectId: "fixture" }, action } }, uncertain: true };
      return "original-revision-command";
    };
    f.open(); f.query("HEAD");
    f.find(node => node.props.role === "menuitem" && text(node) === "Use HEAD").props.onClick();
    (await f.next(1)).response.resolve(revisionReply("HEAD")); await settle(); f.render();
    expect(f.workspace.pending?.envelope.id).toBe("original-revision-command");
    expect(f.find(node => node.props.role === "menuitem" && text(node) === "Use HEAD").props.disabled).toBe(true);
    expect(f.find(node => node.type === "button" && text(node) === "Retry original workspace command").props.disabled).toBe(false);
    expect(f.mutations).toHaveLength(1); expect(f.selectionRequests).toHaveLength(1);
  } finally { f.dispose(); }
});

for (const oldFirst of [true, false]) test(`live exact admission survives loss-return before render, old settles ${oldFirst ? "first" : "last"}`, async () => {
  const f = fixture();
  try {
    f.open(); f.query("topic");
    const enter = () => f.find(node => node.type === "input" && node.props["aria-label"] === "Search branches").props.onKeyDown;
    const event = { key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() {} };
    enter()(event); const old = await f.next(1); f.render();
    expect(f.find(node => node.props.role === "menuitem" && text(node) === "Use topic").props.disabled).toBe(true);
    const busyRenderEnter = enter();
    // Keep the exact busy handler: controller observes both events before render.
    f.connection(false); f.connection(true);
    busyRenderEnter(event); const fresh = await f.next(2);
    expect(fresh.query).toEqual({ type: "git.resolve-checkout", expression: "topic" });
    busyRenderEnter(event); await settle(); expect(f.selectionRequests).toHaveLength(2);
    if (oldFirst) { old.response.resolve(targetReply("topic", "refs/heads/topic", "c".repeat(40))); await settle(); expect(f.mutations).toEqual([]); }
    fresh.response.resolve(targetReply("topic", "refs/heads/topic", "b".repeat(40))); await settle();
    expect(f.mutations).toEqual([{ type: "git.checkout-ref", selection: { ref: "refs/heads/topic", commit: "b".repeat(40) }, expectedRevision: "reviewed" }]);
    if (!oldFirst) { old.response.resolve(targetReply("topic", "refs/heads/topic", "c".repeat(40))); await settle(); }
    expect(f.mutations).toHaveLength(1); f.render(); expect(f.nodes().some(node => node.props.role === "menu")).toBe(false);
  } finally { f.dispose(); }
});

for (const loss of ["status", "busy", "pending"] as const) test(`actual selection rejects live ${loss} loss during resolution without rendering`, async () => {
  const f = fixture();
  try {
    f.open(); f.query("topic"); f.find(node => node.props.role === "menuitem" && text(node) === "Use topic").props.onClick(); const held = await f.next(1);
    if (loss === "status") f.workspace.status = undefined;
    else if (loss === "busy") f.workspace.busy = true;
    else f.workspace.pending = { envelope: { id: "another-command", command: { type: "workspace.mutate", target: { projectId: "fixture" }, action: { type: "git.checkout", branch: "other", expectedRevision: "reviewed" } } }, uncertain: true };
    held.response.resolve(targetReply("topic")); await settle(); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test("idle current branch dismisses after host resolution and explicit creation keeps its existing dialog", async () => {
  const f = fixture();
  try {
    f.workspace.branches = [branch("main")]; f.inventory({ recent: ["main"], defaultBranch: null }); f.open(); await settle(); f.render();
    f.find(node => node.props.role === "menuitemradio").props.onClick(); const held = await f.next(1);
    expect(held.query).toEqual({ type: "git.resolve-checkout", expression: "main" }); held.response.resolve(targetReply("main")); await settle(); f.render();
    expect(f.mutations).toEqual([]); expect(f.nodes().some(node => node.props.role === "menu")).toBe(false);
    f.open(); f.find(node => node.props.role === "menuitem" && text(node) === "Create and checkout new branch…").props.onClick(); f.render();
    expect(f.find(node => node.type === "input" && node.props["aria-label"] === "Branch name").props.value).toBe("codex/");
    f.find(node => node.type === "input" && node.props["aria-label"] === "Branch name").props.onChange({ target: { value: "codex/new" } }); f.render();
    f.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await settle();
    expect(f.mutations).toEqual([{ type: "git.checkout", branch: "codex/new", expectedRevision: "reviewed", create: true }]);
  } finally { f.dispose(); }
});

for (const stale of ["owner", "closed", "query", "busy"] as const) test(`retained row handler cannot start a query after ${stale} changes`, async () => {
  const f = fixture();
  try {
    f.workspace.branches = [branch("topic")]; f.inventory({ recent: ["topic"], defaultBranch: null }); f.open(); await settle(); f.render();
    const click = f.find(node => node.props.role === "menuitemradio").props.onClick;
    if (stale === "owner") f.render({ workspace: { ...f.workspace } as WorkspaceState });
    else if (stale === "closed") { f.find(node => node.type === "button" && node.props["aria-label"] === "Switch branch").props.onClick(); f.render(); }
    else if (stale === "query") f.query("different");
    else f.workspace.busy = true;
    click(); await settle(); expect(f.selectionRequests).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

for (const navigation of ["changed query", "reopened menu"] as const) test(`late local Use success preserves ${navigation}`, async () => {
  const f = fixture(), entered = deferred<void>(), completion = deferred<string | undefined>();
  try {
    f.workspace.mutateCommand = async action => { f.mutations.push(action); entered.resolve(); return completion.promise; };
    f.open(); f.query("topic");
    f.find(node => node.props.role === "menuitem" && text(node) === "Use topic").props.onClick();
    const resolution = await f.next(1);
    // Feed the same exact local branch through either version's real query
    // interface. This adapter does not implement the component's close guard.
    if (resolution.query.type === "git.search-branches") resolution.response.resolve(reply([branch("topic")]));
    else { expect(resolution.query).toEqual({ type: "git.resolve-checkout", expression: "topic" }); resolution.response.resolve(targetReply("topic")); }
    await entered.promise;
    expect(f.mutations).toEqual([{ type: "git.checkout-ref", selection: { ref: "refs/heads/topic", commit: "a".repeat(40) }, expectedRevision: "reviewed" }]);
    if (navigation === "changed query") f.query("different");
    else {
      f.find(node => node.type === "button" && node.props["aria-label"] === "Switch branch").props.onClick(); f.render();
      expect(f.nodes().some(node => node.props.role === "menu")).toBe(false);
      f.open(); f.query("topic");
    }
    completion.resolve("checkout-command"); await settle(); f.render();
    expect(f.nodes().some(node => node.props.role === "menu")).toBe(true);
    expect(f.find(node => node.type === "input" && node.props["aria-label"] === "Search branches").props.value).toBe(navigation === "changed query" ? "different" : "topic");
    expect(f.mutations).toHaveLength(1);
  } finally { completion.resolve("checkout-command"); f.dispose(); }
});

for (const changedQuery of [false, true]) test(`actual picker transfers only its current typed refusal to the conflict owner (changed query ${changedQuery})`, async () => {
  const f = fixture(), entered = deferred<void>(), completion = deferred<void>(), received: any[] = [];
  try {
    f.render({ onCheckoutBlocked: request => received.push(request) });
    async function refused(action: WorkspaceMutation) {
      f.mutations.push(action); entered.resolve(); await completion.promise;
      if (action.type !== "git.checkout-ref") throw new Error("Wrong checkout action");
      f.workspace.checkoutRefusal = { commandId: "typed-refusal", action, error: { code: "GIT_CHECKOUT_BLOCKED", message: "blocked", checkoutConflict: { conflictedPaths: ["tracked"] } } };
      f.workspace.errors.action = "blocked";
    }
    // Both are the real WorkspaceState public APIs. The historical component
    // used boolean mutate; final uses the admitted original ID.
    f.workspace.mutate = async action => { await refused(action); return true; };
    f.workspace.mutateCommand = async action => { await refused(action); return "typed-refusal"; };
    f.open(); f.query("topic");
    f.find(node => node.props.role === "menuitem" && text(node) === "Use topic").props.onClick();
    (await f.next(1)).response.resolve(targetReply("topic")); await entered.promise;
    if (changedQuery) f.query("later");
    completion.resolve(); await settle(); f.render();
    expect(f.mutations).toHaveLength(1);
    expect(received).toHaveLength(changedQuery ? 0 : 1);
    if (!changedQuery) { expect(received[0].data).toBe(f.workspace); expect(received[0].refusal).toBe(f.workspace.checkoutRefusal); }
    expect(f.nodes().some(node => node.props.role === "menu")).toBe(changedQuery);
  } finally { completion.resolve(); f.dispose(); }
});

for (const handler of ["Use", "Enter", "row"] as const) for (const transition of ["close-reopen", "query roundtrip"] as const)
  test(`retired ${handler} handler cannot revive after ${transition} restores its tuple`, async () => {
    const f = fixture(), query = handler === "row" ? "" : "topic";
    function invoke() {
      if (handler === "Use") return f.find(node => node.props.role === "menuitem" && text(node) === "Use topic").props.onClick;
      if (handler === "row") return f.find(node => node.props.role === "menuitemradio" && text(node) === "topic").props.onClick;
      const keydown = f.find(node => node.type === "input" && node.props["aria-label"] === "Search branches").props.onKeyDown;
      return () => keydown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() {} });
    }
    try {
      f.inventory({ recent: ["topic"], defaultBranch: null }); f.open(); f.query(query); await settle(); f.render();
      const retired = invoke();
      if (transition === "close-reopen") {
        f.find(node => node.type === "button" && node.props["aria-label"] === "Switch branch").props.onClick(); f.render();
        expect(f.nodes().some(node => node.props.role === "menu")).toBe(false);
        f.open(); f.query(query);
      } else { f.query("other"); f.query(query); }
      await settle(); f.render();
      expect(f.find(node => node.type === "input" && node.props["aria-label"] === "Search branches").props.value).toBe(query);
      retired(); await settle();
      expect(f.selectionRequests).toEqual([]); expect(f.mutations).toEqual([]);
      // The current handler for the otherwise identical tuple must still work.
      invoke()(); const fresh = await f.next(1);
      expect(fresh.query).toEqual({ type: "git.resolve-checkout", expression: "topic" });
      fresh.response.resolve(targetReply("topic")); await settle(); f.render();
      expect(f.mutations).toEqual([{ type: "git.checkout-ref", selection: { ref: "refs/heads/topic", commit: "a".repeat(40) }, expectedRevision: "reviewed" }]);
    } finally { f.dispose(); }
  });

test("ordinary redraw preserves a live selection handler without pinning controller generation", async () => {
  const f = fixture();
  try {
    f.open(); f.query("topic");
    const live = f.find(node => node.props.role === "menuitem" && text(node) === "Use topic").props.onClick;
    f.render(); f.render(); live(); const request = await f.next(1);
    expect(request.query).toEqual({ type: "git.resolve-checkout", expression: "topic" });
    request.response.resolve(targetReply("topic")); await settle(); expect(f.mutations).toHaveLength(1);
  } finally { f.dispose(); }
});

test("degraded branch inventory exposes independent warning and recovery with no repository-watch warning", async () => {
  const f = fixture();
  try {
    f.open(); await settle();
    const recent = f.inventoryRequests.find(request => request.query.type === "git.recent-branches")!;
    recent.response.resolve({ type: "git.recent-branches", branches: ["still-readable"] }, true); f.render();
    expect(f.workspace.repositoryWatchWarning).toBeUndefined();
    const recover = f.find(node => node.type === "button" && text(node) === "Retry live updates");
    expect(f.nodes().some(node => node.props.role === "status" && text(node).includes("incomplete"))).toBe(true);
    expect(f.nodes().some(node => node.props.role === "menuitemradio" && text(node) === "still-readable")).toBe(true);
    expect(f.nodes().filter(node => node.type === "p").some(node => nodes(node.props.children).some(child => child.type === "p"))).toBe(false);
    recover.props.onClick(); await settle(); expect(recent.recoveries).toBe(1);
    expect(f.selectionRequests).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});
