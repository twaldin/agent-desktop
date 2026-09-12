import { expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import type { DesktopBridge, TerminalCreationRequest, TerminalCreationResponse } from "@agent-desktop/shared";
import type { DockAddAction } from "./DockPanel";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";
import { defaultWindowView } from "../window-state";
import { hasNativeTerminalBridge } from "./native-terminal-state";
import { BrowserWorkspaceMenu, browserWorkspaceRows, type BrowserWorkspaceMenuContext } from "./browser-workspace-menu";
const { TerminalWindowOwner }: typeof import("./terminal-window-owner") = await import(process.env.TERMINAL_SETTLEMENT_OWNER_SOURCE ?? "./terminal-window-owner");
import { useWorkbenchDock } from "./use-workbench-dock";

const hostId = "10000000-0000-4000-8000-000000000001", sessionId = "20000000-0000-4000-8000-000000000002";
const epoch = "30000000-0000-4000-8000-000000000003", terminalId = "40000000-0000-4000-8000-000000000004";
const app = readFileSync(process.env.TERMINAL_SETTLEMENT_APP_SOURCE ?? new URL("./App.tsx", import.meta.url), "utf8");
const start = app.indexOf("  const terminalAction:"), end = app.indexOf("  const reviewAction:", start);
if (start < 0 || end <= start) throw new Error("Actual App terminal action declaration missing");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`function action(values) {
  const { connected, dockWorkspace, hasNativeTerminalBridge, bridge, preparationTarget, commandKeymap, appCommandShortcutLabel, appCommandBindings, dock, browserMenu } = values;
  ${app.slice(start, end)} return terminalAction;
}`);
const action = new Function(`${code}; return action;`)() as (values: Record<string, unknown>) => DockAddAction;
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** Actual App action, menu, hook and window owner; controlled React slots,
 * explicit commit/save notifications and bridge replies, no mounted UI/IPC. */
function fixture(withSibling = false) {
  const source = createBrowserNewTab(hostId, sessionId, "source"); source.browserNewTab = { status: "idle", draft: "kept address" };
  const sibling = createBrowserNewTab(hostId, sessionId, "sibling");
  const state = insertDockTab(createDockState(), source, "right");
  const initial = { ...defaultWindowView(), route: { hostId, sessionId }, dock: { tabs: withSibling ? [source, sibling] : [source], state: withSibling ? insertDockTab(state, sibling, "bottom") : state } };
  const calls: string[] = [];
  let reply: "ready" | "negative" = "ready";
  const bridge = {
    nativeTerminalQuery: async () => { calls.push("list"); return { ok: true, value: { type: "list", terminals: [] } }; },
    nativeTerminalAction: async () => { throw new Error("No unkeyed acquisition"); },
    getNativeTerminalCapabilities: async () => { throw new Error("No legacy acquisition"); },
    writeNativeTerminal: async () => { throw new Error("No input"); }, subscribeNativeTerminals: () => () => {},
    getTerminalCreationCapabilities: async () => { calls.push("capabilities"); return { ok: true, value: { version: 1, hostId, controlEpoch: epoch } }; },
    createNativeTerminal: async () => { calls.push("create"); throw new Error("Lost sent result"); },
    observeTerminalCreation: async (request: TerminalCreationRequest) => {
      calls.push("inspect");
      const value: TerminalCreationResponse = { version: 1, hostId, requestId: request.requestId, status: "settled",
        receipt: reply === "negative" ? { outcome: "not-submitted", terminalId, message: "Rejected before creation" } : { outcome: "completed", terminalId },
        ...(reply === "ready" ? { terminal: { id: terminalId, target: request.target, cwd: "/fixture", protocol: "tmux-v1" as const, serverGeneration: epoch, status: "running" as const, attachable: true } } : {}) };
      return { ok: true, value };
    },
  } as unknown as DesktopBridge;
  const slots: any[] = [], queue: Array<() => void> = []; let cursor = 0;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = { useState(init: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === "function" ? init() : init;
    return [slots[i], (next: any) => queue.push(() => slots[i] = typeof next === "function" ? next(slots[i]) : next)]; },
    useRef(init: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: init }); }, useEffect() {} };
  const menu = new BrowserWorkspaceMenu(() => {}), owner = new TerminalWindowOwner(bridge, [], () => {});
  function render() { cursor = 0; const previous = internals.H; internals.H = dispatcher;
    try { return useWorkbenchDock(bridge, initial, hostId, { sessionId }, true, message => { throw new Error(message); }, undefined, undefined, undefined, undefined, owner); }
    finally { internals.H = previous; } }
  let context: BrowserWorkspaceMenuContext;
  function commit() {
    const dock = render();
    const terminal = action({ connected: true, dockWorkspace: { sessionId }, hasNativeTerminalBridge, bridge,
      preparationTarget: { hostId, target: `session:${sessionId}` }, commandKeymap: undefined, dock, browserMenu: menu });
    context = { presentations: dock.presentations, owner: { kind: "chat", hostId, sessionId }, enabled: true, connected: true,
      actions: [terminal], chatTitle: "Chat", replace: dock.replaceBrowserDestination };
    owner.commit({ hostId, target: { sessionId }, enabled: true, connected: true, presentations: dock.presentations });
    owner.committed(view()); menu.commit(context);
  }
  function view() { return { ...initial, dock: render().persisted, terminalCreations: owner.intents }; }
  function flush() { while (queue.length) queue.shift()!(); commit(); }
  commit();
  return { menu, owner, render, calls, source, sibling, flush, view, save() { owner.saved(view()); }, negative() { reply = "negative"; },
    row(sourceId = source.id) { const row = browserWorkspaceRows(context, sourceId, "Terminal", "en").find(row => row.kind === "action"); if (!row) throw new Error("Terminal row unavailable"); return row; },
    async unknown() { const row = this.row(); expect(menu.choose(row)).toBe(true); await drain(); commit(); this.save(); await drain();
      expect(menu.state(row.origin.presentation.instanceId)?.status).toBe("unknown"); expect(owner.intents).toHaveLength(1); return row; },
    dispose() { owner.dispose(); menu.dispose(); } };
}

test("a different browser rejected by the workspace request stays retryable without acquiring its own unknown fence", async () => {
  const f = fixture(true);
  try {
    const original = await f.unknown(), intent = f.owner.intents[0]!;
    const sibling = f.row(f.sibling.id);
    expect(f.menu.choose(sibling)).toBe(true); await drain();
    expect(f.menu.state(sibling.origin.presentation.instanceId)?.status).toBe("error");
    expect(f.menu.retainsSource(f.render().presentations, f.sibling.id)).toBe(false);
    expect(f.menu.state(original.origin.presentation.instanceId)?.status).toBe("unknown");
    expect(f.owner.intents).toEqual([intent]); expect(f.calls).toEqual(["list", "capabilities", "create"]);
    // Repeated deliberate attempts while A is unresolved still cannot query,
    // create or associate a new request with B.
    expect(f.menu.choose(f.row(f.sibling.id))).toBe(true); await drain();
    expect(f.owner.intents).toEqual([intent]); expect(f.calls).toEqual(["list", "capabilities", "create"]);
    expect(f.render().snapshot.tabs.find(tab => tab.id === f.sibling.id)?.browserNewTab).toEqual({ status: "idle" });
    f.negative();
    expect(await f.owner.inspect(`${hostId}:${intent.request.requestId}`)).toMatchObject({ status: "error", outcome: "not-submitted" });
    expect(f.owner.intents).toEqual([]); expect(f.menu.state(original.origin.presentation.instanceId)).toBeUndefined();
    // A has settled. A new explicit B selection now obtains its own request;
    // only this subsequent sent/lost request may leave B unknown.
    expect(f.menu.choose(f.row(f.sibling.id))).toBe(true); await drain(); f.flush(); f.save(); await drain();
    expect(f.menu.state(sibling.origin.presentation.instanceId)?.status).toBe("unknown");
    expect(f.owner.intents).toHaveLength(1);
    expect(f.owner.intents[0]?.request.requestId).not.toBe(intent.request.requestId);
    expect(f.owner.intents[0]?.source).toMatchObject({ kind: "browser", tabId: f.sibling.id });
    expect(f.owner.intents[0]?.source.kind === "browser" && f.owner.intents[0].source.draft).toBeUndefined();
    expect(f.calls).toEqual(["list", "capabilities", "create", "inspect", "list", "capabilities", "create"]);
  } finally { f.dispose(); }
});

test("saved detached recovery releases only its browser action fence and keeps the edited source draft", async () => {
  const f = fixture();
  try {
    const row = await f.unknown(), intent = f.owner.intents[0]!;
    f.render().updateTitle(f.source.id, "Renamed source"); f.flush();
    const result = await f.owner.inspectToDock(`${hostId}:${intent.request.requestId}`);
    expect(result.status).toBe("ready");
    expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("unknown");
    if (result.status !== "ready") throw new Error("Expected original terminal");
    const guard = f.owner.attachmentGuard({ hostId, target: intent.request.target, cols: 120, rows: 30, source: { kind: "dock", destination: "bottom" } });
    f.render().publishTerminal(result.tab, "bottom", guard); f.flush();
    expect(f.owner.intents).toEqual([]); expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("unknown");
    f.owner.failed("Save interrupted"); expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("unknown");
    f.save();
    expect(f.menu.state(row.origin.presentation.instanceId)).toBeUndefined();
    expect(f.render().snapshot.tabs.find(tab => tab.id === f.source.id)).toMatchObject({ title: "Renamed source", browserNewTab: { draft: "kept address" } });
    expect(f.calls).toEqual(["list", "capabilities", "create", "inspect"]);
    expect(f.menu.retainsSource(f.render().presentations, f.source.id)).toBe(false);
  } finally { f.dispose(); }
});

test("confirmed negative recovery releases the exact attempt after a source edit without preparing again", async () => {
  const f = fixture();
  try {
    const row = await f.unknown(), intent = f.owner.intents[0]!;
    f.render().updateTitle(f.source.id, "Changed title"); f.flush(); f.negative();
    expect(await f.owner.inspectToDock(`${hostId}:${intent.request.requestId}`)).toMatchObject({ status: "error", outcome: "not-submitted" });
    expect(f.owner.intents).toEqual([]); expect(f.menu.state(row.origin.presentation.instanceId)).toBeUndefined();
    expect(f.calls).toEqual(["list", "capabilities", "create", "inspect"]);
    expect(f.render().snapshot.tabs).toHaveLength(1); expect(f.render().snapshot.tabs[0]?.browserNewTab?.draft).toBe("kept address");
  } finally { f.dispose(); }
});

test("settlement cannot clear a pending or newer attempt on the same presentation", async () => {
  const f = fixture();
  try {
    const row = f.row(); expect(f.menu.choose(row)).toBe(true);
    const settle = f.menu.captureSettlement(row.origin); expect(typeof settle).toBe("function");
    expect(f.menu.captureSettlement({ ...row.origin })).toBeUndefined();
    settle!(); expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("preparing");
    await drain(); f.flush(); f.save(); await drain();
    expect(f.menu.state(row.origin.presentation.instanceId)?.status).toBe("unknown");
    const intent = f.owner.intents[0]!; f.negative();
    expect(await f.owner.inspect(`${hostId}:${intent.request.requestId}`)).toMatchObject({ status: "error", outcome: "not-submitted" });
    expect(f.menu.state(row.origin.presentation.instanceId)).toBeUndefined();
    const next = await f.unknown();
    expect(next.origin.presentation.instanceId).toBe(row.origin.presentation.instanceId);
    expect(next.origin.state).toBe(row.origin.state);
    const retained = f.owner.intents;
    settle!(); settle!();
    expect(f.menu.state(next.origin.presentation.instanceId)?.status).toBe("unknown");
    expect(f.owner.intents).toEqual(retained); expect(f.calls.filter(value => value === "create")).toHaveLength(2);
  } finally { f.dispose(); }
});
