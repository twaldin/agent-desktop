import { expect, test } from "bun:test";
import React from "react";
import { BranchSwitchDialog } from "./BranchSwitchDialog";
import { GitSubmissionDialog } from "./GitSubmissionDialog";
import { continueBranchSwitch } from "./branch-switch-continuation";
import { WorkspaceState } from "./workspace-state";
import type { GitCheckoutRefusal } from "../../../../packages/shared/src/checkout-refusal";
import type { GitSubmissionIntent, GitSubmissionReceipt } from "../../../../packages/shared/src/git-submissions";
import type { CommandEnvelope, DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { WorkspaceMutation } from "@agent-desktop/shared";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const refusal: GitCheckoutRefusal = { commandId: "blocked-checkout", action: { type: "git.checkout-ref", selection: { ref: "refs/heads/topic", commit: "a".repeat(40) }, expectedRevision: "before-commit" },
  error: { code: "GIT_CHECKOUT_BLOCKED", message: "blocked", checkoutConflict: { conflictedPaths: ["tracked"] } } };
const intent: GitSubmissionIntent = { operation: "commit", contextRevision: "context", selectionMode: "include-unstaged", message: "Explicit message" };
function receipt(): GitSubmissionReceipt { return { commandId: "original-commit", hostId: "owner-host", target: { sessionId: "session-a" }, operation: "commit", revision: 1, phase: "completed", outcome: "succeeded", cancelRequested: false,
  commit: { commit: "b".repeat(40), summary: "saved", reviewedTree: "t1", committedTree: "t1", publishedIndexTree: "t2" }, createdAt: 1, updatedAt: 2 }; }
function workspace() {
  const actions: WorkspaceMutation[] = [], listeners = new Set<() => void>();
  const data = { hostId: "owner-host", target: { sessionId: "session-a" }, connected: true, restored: true, busy: false,
    status: { head: "b".repeat(40), branch: "main", revision: "after-commit", entries: [] }, errors: {}, loading: new Set(), gitSubmission: receipt(),
    loadGit: async () => {}, start() {}, stop() {}, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    mutateCommand: async (action: WorkspaceMutation, _version: unknown, guard: () => boolean) => { if (!guard()) return; actions.push(structuredClone(action)); return "next-checkout"; },
  } as unknown as WorkspaceState;
  return { data, actions, connection(value: boolean) { data.connected = value; for (const listener of listeners) listener(); } };
}

test("confirmed original commit continues exact destination with the refreshed source revision", async () => {
  const f = workspace();
  expect(await continueBranchSwitch(f.data, refusal, "original-commit", f.data.gitSubmission, () => true)).toBe("next-checkout");
  expect(f.actions).toEqual([{ ...refusal.action, expectedRevision: "after-commit" }]);
  expect(refusal.action.expectedRevision).toBe("before-commit");
});

for (const outcome of ["pending", "unknown", "failed", "cancelled"] as const) test(`${outcome} commit cannot continue checkout`, async () => {
  const f = workspace(); f.data.gitSubmission!.outcome = outcome;
  await expect(continueBranchSwitch(f.data, refusal, "original-commit", f.data.gitSubmission, () => true)).rejects.toThrow("not been confirmed");
  expect(f.actions).toEqual([]);
});
for (const mismatch of ["id", "host", "target", "push-only", "head", "newer-receipt", "git-error", "cache-error"] as const) test(`continuation rejects ${mismatch}`, async () => {
  const f = workspace(), original = structuredClone(f.data.gitSubmission!);
  if (mismatch === "id") original.commandId = "another-commit";
  if (mismatch === "host") original.hostId = "host-b";
  if (mismatch === "target") original.target = { projectId: "p" };
  if (mismatch === "push-only") { original.operation = "push"; delete original.commit; }
  if (mismatch === "head") f.data.status!.head = "c".repeat(40);
  if (mismatch === "newer-receipt") f.data.loadGit = async () => { f.data.gitSubmission = { ...receipt(), commandId: "later-command" }; };
  if (mismatch === "git-error") f.data.errors.git = "failed query";
  if (mismatch === "cache-error") f.data.cacheWarning = "unsaved receipt";
  await expect(continueBranchSwitch(f.data, refusal, "original-commit", original, () => true)).rejects.toThrow();
  expect(f.actions).toEqual([]);
});
test("owner loss during status read and after read before admission prevents a new checkout", async () => {
  for (const boundary of ["read", "admission"]) {
    const f = workspace(), gate = deferred<void>(); let current = true;
    if (boundary === "read") f.data.loadGit = () => gate.promise;
    else f.data.mutateCommand = async (action, _version, guard) => { await gate.promise; if (!guard?.()) return; f.actions.push(action); return "unexpected"; };
    const running = continueBranchSwitch(f.data, refusal, "original-commit", f.data.gitSubmission, () => current);
    await Promise.resolve(); current = false; gate.resolve();
    expect(await running).toBeUndefined(); expect(f.actions).toEqual([]);
  }
});

test("actual WorkspaceState returns its admitted ID through uncertain delivery and checks owner after restore", async () => {
  const deliveries: CommandEnvelope[] = [], saved = new Map<string, string>();
  const bridge = { command: async (envelope: CommandEnvelope) => { deliveries.push(envelope); throw new Error("lost response"); }, subscribe: () => () => {},
    workspaceQuery: async () => { throw new Error("unexpected query"); } } satisfies Pick<DesktopBridge, "command" | "subscribe" | "workspaceQuery">;
  const data = new WorkspaceState(bridge, "owner-host", { sessionId: "session-a" }, { read: async key => saved.get(key) ?? null, write: async (key, value) => { saved.set(key, value); } });
  data.setConnected(true); data.refresh = async () => {};
  const gate = deferred<void>(), restore = data.restore.bind(data); let current = true;
  data.restore = async () => { await gate.promise; await restore(); };
  const blocked = data.mutateCommand(refusal.action, undefined, () => current);
  current = false; gate.resolve(); expect(await blocked).toBeUndefined(); expect(deliveries).toEqual([]); expect(data.pending).toBeUndefined();
  data.restore = restore;
  const id = await data.mutateCommand(refusal.action, undefined, () => true);
  expect(id).toBe(deliveries[0]!.id); expect(data.pending).toMatchObject({ envelope: { id }, uncertain: true });
  expect(deliveries).toHaveLength(1); expect(await data.mutateCommand(refusal.action)).toBeUndefined();
});

// Calls the actual component with controlled React phases. Radix/DOM, native
// focus and physical connection delivery are deliberately not simulated here.
function nodes(value: any): React.ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!React.isValidElement<{ children?: React.ReactNode }>(value)) return [];
  return [value, ...nodes(value.props.children)];
}
function component() {
  const f = workspace(); f.data.gitSubmission = undefined;
  let current = true, closed = 0, tree: React.ReactNode, cursor = 0, dirty = false;
  const slots: any[] = [], dependencies = new Map<number, readonly unknown[] | undefined>(), cleanups = new Map<number, () => void>();
  let effects: Array<() => void> = [];
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => { const i = cursor++, before = dependencies.get(i);
    if (deps && before && deps.length === before.length && deps.every((v, n) => Object.is(v, before[n]))) return;
    effects.push(() => { cleanups.get(i)?.(); const cleanup = run(); if (cleanup) cleanups.set(i, cleanup); else cleanups.delete(i); dependencies.set(i, deps); }); };
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (value: any) => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useReducer(_reducer: unknown, initial: unknown) { cursor++; return [initial, () => { dirty = true; }]; },
    useEffect: effect, useLayoutEffect: effect,
  };
  function render() {
    for (let pass = 0; pass < 15; pass++) {
      cursor = 0; dirty = false; effects = []; const previous = internals.H; internals.H = dispatcher;
      try { tree = BranchSwitchDialog({ request: { data: f.data, refusal }, supported: true, branchPrefix: "codex/", isCurrent: () => current, onOpenGitSettings() {}, onClose() { closed++; } }); }
      finally { internals.H = previous; }
      for (const effect of effects) effect(); if (!dirty) return;
    }
    throw new Error("Component did not settle");
  }
  function find(predicate: (node: React.ReactElement<any>) => boolean) { const node = nodes(tree).find(predicate); if (!node) throw new Error("Node missing"); return node; }
  const submit = () => { find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); render(); const send = find(node => node.type === GitSubmissionDialog).props.onSubmit; send(intent); render(); return send; };
  render();
  return { ...f, render, find, submit, nodes: () => nodes(tree), closed: () => closed, invalidate() { current = false; }, dispose() { for (const cleanup of cleanups.values()) cleanup(); } };
}
async function flush(f: ReturnType<typeof component>) { for (let i = 0; i < 30; i++) { await Promise.resolve(); f.render(); } }

test("actual dialog waits for its commit, hidden working state continues once after confirmation", async () => {
  const f = component();
  try {
    const commit = deferred<string | undefined>();
    f.data.mutateCommand = async (action, version, guard) => {
      if (!guard?.()) return; f.actions.push(action);
      if (action.type === "git.submit") { expect(version).toBe(10); return commit.promise; }
      f.data.mutationReceipt = { commandId: "checkout-result", value: { type: "git.checkout-ref", status: f.data.status! } }; return "checkout-result";
    };
    const retainedSubmit = f.submit(); expect(f.actions.map(action => action.type)).toEqual(["git.submit"]);
    f.find(node => node.type === "button" && node.props.children === "Close").props.onClick(); f.render(); expect(f.nodes()).toEqual([]);
    f.data.gitSubmission = { ...receipt(), outcome: "unknown" }; commit.resolve("original-commit"); await flush(f);
    expect(f.actions).toHaveLength(1); expect(f.closed()).toBe(0);
    retainedSubmit(intent); await flush(f); expect(f.actions).toHaveLength(1);
    f.data.gitSubmission = receipt(); await flush(f);
    expect(f.actions.map(action => action.type)).toEqual(["git.submit", "git.checkout-ref"]);
    expect(f.actions[1]).toEqual({ ...refusal.action, expectedRevision: "after-commit" }); expect(f.closed()).toBeGreaterThan(0);
  } finally { f.dispose(); }
});
test("actual dialog owner loss during commit response prevents continuation even with successful receipt", async () => {
  const f = component(), gate = deferred<string | undefined>();
  try {
    f.data.mutateCommand = async action => { f.actions.push(action); return gate.promise; };
    f.submit(); f.invalidate(); f.data.gitSubmission = receipt(); gate.resolve("original-commit"); await flush(f);
    expect(f.actions.map(action => action.type)).toEqual(["git.submit"]); expect(f.closed()).toBe(0);
  } finally { f.dispose(); }
});

for (const boundary of ["commit response", "status read"] as const) test(`actual dialog latches disconnect-return during ${boundary}`, async () => {
  const f = component(), gate = deferred<void>();
  try {
    f.data.mutateCommand = async (action, _version, guard) => {
      if (!guard?.()) return; f.actions.push(action);
      if (action.type === "git.submit") { if (boundary === "commit response") await gate.promise; f.data.gitSubmission = receipt(); return "original-commit"; }
      return "unexpected-checkout";
    };
    if (boundary === "status read") f.data.loadGit = () => gate.promise;
    f.submit(); await flush(f);
    f.connection(false); f.connection(true); gate.resolve(); await flush(f);
    expect(f.actions.map(action => action.type)).toEqual(["git.submit"]); expect(f.closed()).toBe(0);
    expect(f.nodes().some(node => node.props.role === "status" && String(node.props.children).includes("Connection interrupted"))).toBe(true);
  } finally { gate.resolve(); f.dispose(); }
});


test("a refused commit admission shows an error without inventing an original retry control", async () => {
  const f = component();
  try {
    f.data.mutateCommand = async () => undefined;
    f.submit(); await flush(f);
    expect(f.actions).toEqual([]);
    expect(f.nodes().some(node => node.props.role === "status" && String(node.props.children).includes("not submitted"))).toBe(true);
    expect(f.nodes().some(node => node.type === "button" && String(node.props.children).includes("Retry original"))).toBe(false);
  } finally { f.dispose(); }
});
