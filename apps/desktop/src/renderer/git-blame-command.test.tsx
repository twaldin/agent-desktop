import React from "react";
import { expect, test } from "bun:test";
import { WorkspaceGitFilePanel, workspaceGitBlameCommand } from "./WorkspaceGitFilePanel";
import type { GitFileHistoryState } from "./git-file-history-state";
import { APP_COMMAND_BINDING_OWNERS, readAppCommandBindings } from "./app-command-bindings";

/** Actual component hooks with controlled commit/DOM boundaries; no layout or native keyboard proof. */
function fixture() {
  const slots: any[] = []; let cursor = 0;
  const effects: Array<() => void> = [];
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  let hidden = false, connected = true, attached = true, calls = 0, otherCalls = 0;
  const button = { disabled: false, get isConnected() { return connected; }, getClientRects: () => hidden ? [] : [{}], closest: () => hidden ? panel : null };
  const panel = { querySelectorAll: () => [button], contains: (node: unknown) => node === button && attached };
  const root = { contains: (node: unknown) => attached && node === panel } as unknown as HTMLElement;
  const origin = { closest: () => panel } as unknown as Element;
  const state = { enabled: false, busy: false, path: "one.ts", data: { connected: true }, toggle: () => calls++ } as unknown as GitFileHistoryState;
  const replacement = { ...state, path: "two.ts", toggle: () => otherCalls++ } as unknown as GitFileHistoryState;
  function render(current = state, active = true) {
    cursor = 0; effects.length = 0;
    const previous = internals.H;
    internals.H = {
      useState: (value: unknown) => { cursor++; return [value, () => {}]; },
      useRef: (value: unknown) => { const slot = cursor++; return slots[slot] ??= { current: value }; },
      useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
        const slot = cursor++, old = slots[slot];
        if (!old || deps.some((value, index) => value !== old.deps[index])) effects.push(() => { old?.cleanup?.(); slots[slot] = { deps, cleanup: effect() }; });
      },
    };
    try {
      const tree = WorkspaceGitFilePanel({ state: current, active });
      const visit = (value: any) => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!React.isValidElement(value)) return;
        const props = value.props as any;
        if ("data-git-blame-toggle" in props) props.ref.current = button;
        visit(props.children);
      };
      visit(tree); effects.forEach(effect => effect());
    } finally { internals.H = previous; }
  }
  return { root, origin, state, replacement, render,
    command: () => workspaceGitBlameCommand(root, origin),
    hide(value: boolean) { hidden = value; }, disconnect() { connected = false; }, detach() { attached = false; },
    get counts() { return [calls, otherCalls]; },
    close() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test("command uses the focused file only and preserves no-default/custom binding ownership", () => {
  const f = fixture();
  try {
    f.render(); f.command()?.(); expect(f.counts).toEqual([1, 0]);
    expect(workspaceGitBlameCommand(f.root, null)).toBeUndefined();
    expect(workspaceGitBlameCommand(f.root, { closest: () => ({}) } as unknown as Element)).toBeUndefined();
    expect(APP_COMMAND_BINDING_OWNERS["git.toggleBlame"]).toBe("git-toggle-blame");
    expect(readAppCommandBindings(undefined, true).bindings["git-toggle-blame"]).toEqual([]);
    const configured = readAppCommandBindings({ key: "general.commandKeymap", deleted: false,
      value: { version: 1, platform: "mac", overrides: [{ command: "git.toggleBlame", keys: ["Command+Alt+G"] }] },
      revision: { counter: 1, actor: "fixture", opId: "fixture-command" } }, true);
    expect(configured.error).toBeUndefined();
    expect(configured.bindings["git-toggle-blame"]).toEqual(["Command+Alt+G"]);
  } finally { f.close(); }
});

test("retained command cannot target replacement state or revive after committed hide/reopen", () => {
  const f = fixture();
  try {
    f.render(); const original = f.command()!;
    f.render(f.replacement); original(); expect(f.counts).toEqual([0, 0]);
    f.command()?.(); expect(f.counts).toEqual([0, 1]);
    f.render(); original(); expect(f.counts).toEqual([0, 1]);
    const restored = f.command()!;
    f.render(f.state, false); restored(); expect(f.command()).toBeUndefined();
    f.render(); restored(); expect(f.counts).toEqual([0, 1]);
    f.command()?.(); expect(f.counts).toEqual([1, 1]);
  } finally { f.close(); }
});

test("hidden, detached and disposed owners cannot dispatch a captured command", () => {
  for (const invalidate of ["hide", "detach", "disconnect", "close"] as const) {
    const f = fixture();
    try {
      f.render(); const command = f.command()!;
      if (invalidate === "hide") f.hide(true); else f[invalidate]();
      command(); expect(f.counts).toEqual([0, 0]);
    } finally { f.close(); }
  }
});
