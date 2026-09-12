import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TerminalCreationBridge, TerminalCreationResponse } from "@agent-desktop/shared";
import type { TerminalWindowIntent } from "../terminal-window-intent";
import { defaultWindowView } from "../window-state";
import type { TerminalWindowOwner as Owner } from "./terminal-window-owner";
const { TerminalWindowOwner } = await import(process.env.TERMINAL_RECOVERY_ROUTING_OWNER_SOURCE ?? "./terminal-window-owner");
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab, type DockTab } from "./dock-state";
import { reconcileDockPresentations, type DockPresentations } from "./dock-presentations";

const hostId = "10000000-0000-4000-8000-000000000001", sessionId = "20000000-0000-4000-8000-000000000002";
const terminalId = "30000000-0000-4000-8000-000000000003", epoch = "40000000-0000-4000-8000-000000000004";
const tab = { ...createBrowserNewTab(hostId, sessionId, "source"), browserNewTab: { status: "idle" as const, draft: "saved address" } };
const intent: TerminalWindowIntent = { version: 1, hostId,
  source: { kind: "browser", tabId: tab.id, browserInstanceId: tab.browserInstanceId!, title: tab.title, draft: "saved address" },
  request: { version: 1, requestId: "50000000-0000-4000-8000-000000000005", controlEpoch: epoch, target: { sessionId }, cols: 120, rows: 30 } };
const requestKey = `${hostId}:${intent.request.requestId}`;
const app = readFileSync(process.env.TERMINAL_RECOVERY_ROUTING_APP_SOURCE ?? new URL("./App.tsx", import.meta.url), "utf8");
// Execute the two actual App filtering expressions. This is not a mounted App
// or a JSX/default-action simulation; the retained owner and identity map are real.
const localExpression = app.match(/const pendingTerminals = ([^\n]+);/)?.[1];
const globalExpression = app.match(/terminalRequests\.intents\.filter\(intent => \(intent\.source\.kind === "dock"[\s\S]*?workspaceKey\(workspaceTarget\)\)/)?.[0];
if (!localExpression || !globalExpression) throw new Error("Actual App terminal recovery filters are missing");
const localFilter = new Function("terminalRequests", "dock", "tab", `return (${localExpression});`);
const globalFilter = new Function("terminalRequests", "dock", "hostId", "workspaceTarget", "workspaceKey", `return (${globalExpression});`);
function routes(owner: Owner, presentations: DockPresentations, candidate: DockTab = tab, target: { sessionId: string } | undefined = { sessionId }) {
  const dock = { presentations, snapshot: presentations.snapshot };
  return { local: localFilter(owner, dock, candidate) as TerminalWindowIntent[],
    global: globalFilter(owner, dock, hostId, target, (value: { sessionId: string }) => `session:${value.sessionId}`) as TerminalWindowIntent[] };
}
function fixture() {
  let presentations = reconcileDockPresentations(undefined, { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") }, "initial");
  let result: TerminalCreationResponse = { version: 1, hostId, requestId: intent.request.requestId, status: "unavailable" };
  const calls: string[] = [];
  const bridge: TerminalCreationBridge = {
    async getTerminalCreationCapabilities() { calls.push("capabilities"); throw new Error("Recovery cannot acquire capabilities"); },
    async createNativeTerminal() { calls.push("create"); throw new Error("Recovery cannot create"); },
    async observeTerminalCreation(request, owner) { calls.push("inspect"); expect(request).toEqual(intent.request); expect(owner).toBe(hostId); return { ok: true, value: result }; },
  };
  const owner = new TerminalWindowOwner(bridge, [intent], () => {});
  function commit(next: DockPresentations) { presentations = next; owner.commit({ hostId, target: { sessionId }, enabled: true, connected: true, presentations }); }
  commit(presentations);
  return { owner, calls, commit, get presentations() { return presentations; },
    available() { result = { version: 1, hostId, requestId: intent.request.requestId, status: "settled", receipt: { outcome: "completed", terminalId },
      terminal: { id: terminalId, target: intent.request.target, cwd: "/fixture", protocol: "tmux-v1", serverGeneration: epoch, status: "running", attachable: true } }; } };
}

test("App routes a same-ID replacement browser to explicit dock recovery and retains the original request", async () => {
  const f = fixture();
  try {
    expect(routes(f.owner, f.presentations)).toEqual({ local: [intent], global: [] });
    expect(await f.owner.inspect(requestKey)).toMatchObject({ status: "error", outcome: "unknown" });
    const original = f.presentations;
    const closed = reconcileDockPresentations(original, { tabs: [], state: createDockState() }, "close"); f.commit(closed);
    const reopened = reconcileDockPresentations(closed, original.snapshot, "reopen"); f.commit(reopened);
    expect(reopened.instances.get(tab.id)).not.toBe(original.instances.get(tab.id));
    expect(routes(f.owner, reopened)).toEqual({ local: [], global: [intent] });
    expect(f.owner.intents).toEqual([intent]); expect(f.calls).toEqual(["inspect"]);
    expect(await f.owner.inspect(requestKey)).toEqual({ status: "cancelled", creationMayHaveRun: true });
    f.available();
    const guard = f.owner.attachmentGuard({ hostId, target: intent.request.target, cols: 120, rows: 30, source: { kind: "dock", destination: "bottom" } });
    const result = await f.owner.inspectToDock(requestKey);
    expect(result.status).toBe("ready"); expect(guard()).toBe(true); expect(f.calls).toEqual(["inspect", "inspect"]);
    if (result.status !== "ready") throw new Error("Expected the original terminal result");
    const snapshot = { tabs: [...reopened.snapshot.tabs, result.tab], state: insertDockTab(reopened.snapshot.state, result.tab, "bottom") };
    f.commit(reconcileDockPresentations(reopened, snapshot, "publish"));
    const view = { ...defaultWindowView(), route: { hostId, sessionId }, dock: snapshot, terminalCreations: f.owner.intents };
    f.owner.committed(view); f.owner.saved({ ...view, terminalCreations: f.owner.intents });
    expect(f.owner.intents).toEqual([]); expect(f.presentations.snapshot.tabs[0]).toBe(tab);
    expect(f.presentations.instances.get(tab.id)).toBe(reopened.instances.get(tab.id));
  } finally { f.owner.dispose(); }
});

test("App keeps recovery on the original moved or hidden browser but not an edited source", async () => {
  const f = fixture();
  try {
    await f.owner.inspect(requestKey);
    const moved = reconcileDockPresentations(f.presentations, { tabs: [tab], state: insertDockTab(createDockState(), tab, "bottom") }, "move");
    f.commit(moved); expect(routes(f.owner, moved)).toEqual({ local: [intent], global: [] });
    const hidden = reconcileDockPresentations(moved, { ...moved.snapshot, state: { ...moved.snapshot.state, bottom: { ...moved.snapshot.state.bottom, open: false } } }, "hide");
    f.commit(hidden); expect(routes(f.owner, hidden)).toEqual({ local: [intent], global: [] });
    for (const changed of [{ ...tab, title: "renamed" }, { ...tab, browserNewTab: { ...tab.browserNewTab, draft: "different" } }, { ...tab, browserNewTab: { ...tab.browserNewTab } }]) {
      const edited = reconcileDockPresentations(hidden, { ...hidden.snapshot, tabs: [changed] }, "edit");
      f.commit(edited); expect(routes(f.owner, edited, changed)).toEqual({ local: [], global: [intent] });
    }
    expect(f.owner.intents).toEqual([intent]); expect(f.calls).toEqual(["inspect"]);
  } finally { f.owner.dispose(); }
});

test("restored intent routes from exact saved source without I/O and respects current workspace visibility", () => {
  const f = fixture();
  try {
    expect(routes(f.owner, f.presentations)).toEqual({ local: [intent], global: [] });
    const missing = reconcileDockPresentations(f.presentations, { tabs: [], state: createDockState() }, "closed");
    expect(routes(f.owner, missing).global).toEqual([intent]);
    expect(routes(f.owner, missing, tab, { sessionId: epoch }).global).toEqual([]);
    const renamed = { ...tab, title: "changed source" };
    const changed = reconcileDockPresentations(f.presentations, { ...f.presentations.snapshot, tabs: [renamed] }, "rename");
    // Rendering classifies the supplied snapshot, not the preceding committed one.
    expect(routes(f.owner, changed, renamed)).toEqual({ local: [], global: [intent] });
    expect(f.owner.intents).toEqual([intent]); expect(f.calls).toEqual([]);
  } finally { f.owner.dispose(); }
});

test("restored source is anchored before first inspection and cannot rebind after close or absence", async () => {
  for (const initiallyPresent of [true, false]) {
    const initial = reconcileDockPresentations(undefined, initiallyPresent ? { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") }
      : { tabs: [], state: createDockState() }, "initial");
    let calls = 0, notices = 0;
    const owner = new TerminalWindowOwner({ async observeTerminalCreation() { calls++; return { ok: true, value: {
      version: 1, hostId, requestId: intent.request.requestId, status: "settled", receipt: { outcome: "completed", terminalId },
      terminal: { id: terminalId, target: intent.request.target, cwd: "/fixture", protocol: "tmux-v1", serverGeneration: epoch, status: "running", attachable: true },
    } }; } }, [intent], () => { notices++; });
    const context = { hostId, target: { sessionId }, enabled: true, connected: true, presentations: initial };
    try {
      owner.commit(context);
      owner.commit(context);
      const closed = reconcileDockPresentations(initial, { tabs: [], state: createDockState() }, "close");
      owner.commit({ ...context, presentations: closed });
      const reopened = reconcileDockPresentations(closed, { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") }, "reopen");
      owner.commit({ ...context, presentations: reopened });
      const noticesBeforeInspection = notices;
      expect(await owner.inspect(requestKey)).toEqual({ status: "cancelled", creationMayHaveRun: true });
      expect(routes(owner, reopened)).toEqual({ local: [], global: [intent] });
      expect(noticesBeforeInspection).toBe(1);
      expect(calls).toBe(0); expect(owner.intents).toEqual([intent]); expect(owner.retainsSource(reopened, tab.id)).toBe(false);
    } finally { owner.dispose(); }
  }
});
