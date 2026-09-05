import { createRoot, type Root } from "react-dom/client";
import type { DesktopBridge, NativeTerminalAction, NativeTerminalInfo, NativeTerminalQuery, WorkspaceTarget } from "@agent-desktop/shared";
import { defaultWindowView, type WindowViewState } from "../../apps/desktop/src/window-state";
import { createDockState, dockTabId, insertDockTab, moveDockTab, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import { useWorkbenchDock } from "../../apps/desktop/src/renderer/use-workbench-dock";

type Hook = ReturnType<typeof useWorkbenchDock> & { fixtureOwner: string };
type ActionPlan = { kind: "success"; id: string } | { kind: "delayed"; id: string; gate: ReturnType<typeof Promise.withResolvers<void>> } | { kind: "uncertain" } | { kind: "wrong-target"; id: string };
const checks: string[] = [], errors: string[] = [];
const queries: { query: NativeTerminalQuery; owner?: string }[] = [], actions: { action: NativeTerminalAction; owner?: string }[] = [];
let hook: Hook | undefined, root: Root | undefined, actionPlan: ActionPlan = { kind: "success", id: "created-pane" }, catalog: NativeTerminalInfo[] = [];
const terminal = (id: string, target: WorkspaceTarget): NativeTerminalInfo => ({ id, target, cwd: `/controlled/${id}`, shell: "zsh", pid: 123, cols: 120, rows: 30, status: "running", createdAt: 1, protocol: "tmux-v1", serverGeneration: "controlled-generation", geometryRevision: 1, inputEpoch: "controlled-epoch", attachable: true });
const bridge = {
  getNativeTerminalCapabilities: async () => ({ ok: true as const, value: { protocol: "tmux-v1" as const, tmuxVersion: "3.7c" as const, inputEpoch: "controlled-epoch", dimensions: { minimumCols: 20, maximumCols: 400, minimumRows: 5, maximumRows: 200 } as const } }),
  nativeTerminalQuery: async (query: NativeTerminalQuery, owner?: string) => { queries.push({ query: structuredClone(query), owner }); return { ok: true as const, value: { type: "list" as const, terminals: structuredClone(catalog) } }; },
  nativeTerminalAction: async (action: NativeTerminalAction, owner?: string) => {
    actions.push({ action: structuredClone(action), owner }); const plan = actionPlan;
    if (plan.kind === "delayed") await plan.gate.promise;
    if (plan.kind === "uncertain") return { ok: false as const, error: { code: "OUTCOME_UNKNOWN", message: "Controlled native create outcome is uncertain." } };
    if (action.type !== "create") throw new Error(`Unexpected native action: ${action.type}`);
    const target = plan.kind === "wrong-target" ? { projectId: "different-project" } : action.options.target;
    return { ok: true as const, value: { terminal: terminal(plan.id, target) } };
  },
  writeNativeTerminal: async () => { throw new Error("Unexpected native terminal input"); },
  subscribeNativeTerminals: () => () => {},
} as unknown as DesktopBridge;

function Fixture(props: { initial: WindowViewState; owner: string; target?: WorkspaceTarget; connected: boolean }) {
  hook = { ...useWorkbenchDock(bridge, props.initial, props.owner, props.target, props.connected, message => errors.push(message)), fixtureOwner: props.owner };
  return <div data-owner={props.owner} data-tabs={hook.snapshot.tabs.length}/>;
}
const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
const wait = async (read: () => unknown, label: string) => { const start = performance.now(); while (performance.now() - start < 5_000) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`Timed out: ${label}`); };
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function mount(initial: WindowViewState, owner: string, target?: WorkspaceTarget, connected = true) {
  root?.unmount(); document.getElementById("root")!.replaceChildren(); root = createRoot(document.getElementById("root")!); hook = undefined;
  root.render(<Fixture initial={initial} owner={owner} target={target} connected={connected}/>); await wait(() => hook?.fixtureOwner === owner, `mount ${owner}`); await settle();
}
async function rerender(initial: WindowViewState, owner: string, target?: WorkspaceTarget, connected = true) {
  root!.render(<Fixture initial={initial} owner={owner} target={target} connected={connected}/>); await wait(() => hook?.fixtureOwner === owner, `rerender ${owner}`); await settle();
}
const resetCalls = () => { queries.length = 0; actions.length = 0; errors.length = 0; catalog = []; actionPlan = { kind: "success", id: "created-pane" }; localStorage.clear(); };

Object.assign(window, {
  workbenchDockProgress: () => ({ checks, errors, queries, actions, snapshot: hook?.snapshot }),
  runWorkbenchDockAcceptance: async () => {
    resetCalls();
    const restoredDescriptor = { kind: "terminal" as const, hostId: "offline-owner", target: "session:saved-session" as const, terminalId: "restored-pane", title: "Restored shell" };
    const restoredTab: DockTab = { ...restoredDescriptor, id: dockTabId(restoredDescriptor) };
    const restoredDock = { tabs: [restoredTab], state: insertDockTab(createDockState(), restoredTab, "bottom") };
    await mount({ ...defaultWindowView(), dock: restoredDock }, "offline-owner", { sessionId: "saved-session" }, false);
    assert(hook!.snapshot.tabs[0]?.terminalId === "restored-pane" && queries.length === 0 && actions.length === 0, "restored terminal identity must not create or query");
    hook!.toggle("bottom"); await wait(() => hook!.snapshot.state.bottom.open === false, "hide restored terminal");
    hook!.change(moveDockTab(hook!.snapshot.state, restoredTab.id, "right")); await wait(() => hook!.snapshot.state.right.tabIds.includes(restoredTab.id), "move restored terminal");
    assert(hook!.snapshot.tabs[0]?.terminalId === "restored-pane", "hide/move must preserve native terminal identity");
    checks.push("restored native terminal identity needs no host call and survives hide/move");

    resetCalls(); actionPlan = { kind: "success", id: "actual-created-pane" };
    await mount(defaultWindowView(), "create-owner", { projectId: "create-project" }); await hook!.terminal("bottom", true); await wait(() => hook!.snapshot.tabs.length === 1, "explicit terminal create");
    assert(queries.length === 1 && queries[0]!.owner === "create-owner" && JSON.stringify(queries[0]!.query) === JSON.stringify({ type: "list", target: { projectId: "create-project" } }), "create must refresh the exact owner/target catalog");
    assert(actions.length === 1 && actions[0]!.owner === "create-owner" && actions[0]!.action.type === "create", "create must use the exact owner");
    assert(hook!.snapshot.tabs[0]?.terminalId === "actual-created-pane" && hook!.snapshot.tabs[0]?.hostId === "create-owner", "created tab must use confirmed native identity");
    checks.push("explicit create refreshes its owner catalog and inserts the confirmed native pane ID");

    resetCalls(); const gate = Promise.withResolvers<void>(); actionPlan = { kind: "delayed", id: "late-original-pane", gate };
    const initial = defaultWindowView(); await mount(initial, "original-owner", { projectId: "original-project" }); const late = hook!.terminal("bottom", true); await wait(() => actions.length === 1, "delayed create admission");
    await rerender(initial, "next-owner", { projectId: "next-project" }); gate.resolve(); await late; await wait(() => hook!.snapshot.tabs.some(tab => tab.terminalId === "late-original-pane"), "late original pane binding");
    const lateTab = hook!.snapshot.tabs.find(tab => tab.terminalId === "late-original-pane")!;
    assert(lateTab.hostId === "original-owner" && lateTab.target === "project:original-project" && !lateTab.id.includes("next-owner"), "late result crossed owners");
    checks.push("late native creation remains bound to the owner and workspace captured at admission");

    resetCalls(); localStorage.setItem("terminal.native.selected.legacy-owner.project:legacy-project", "legacy-selected-pane");
    await mount({ ...defaultWindowView(), terminalOpen: true }, "legacy-owner", { projectId: "legacy-project" }); await wait(() => hook!.snapshot.tabs.length === 1, "legacy terminal migration");
    assert(hook!.snapshot.tabs[0]?.terminalId === "legacy-selected-pane" && queries.length === 0 && actions.length === 0, "legacy selected terminal must restore without create");
    checks.push("legacy terminal-open layout restores its selected native pane without host mutation");

    resetCalls(); catalog = [terminal("foreign-pane", { projectId: "different-project" })]; actionPlan = { kind: "uncertain" };
    await mount(defaultWindowView(), "uncertain-owner", { projectId: "intended-project" }); await hook!.terminal("bottom"); await settle();
    assert(hook!.snapshot.tabs.length === 0 && errors.at(-1)?.includes("uncertain"), "uncertain create must not add a terminal tab");
    assert(actions[0]?.action.type === "create" && JSON.stringify(actions[0].action.options.target) === JSON.stringify({ projectId: "intended-project" }), "foreign catalog result substituted the requested target");
    actionPlan = { kind: "wrong-target", id: "wrong-target-pane" }; await hook!.terminal("bottom", true); await settle();
    assert(hook!.snapshot.tabs.length === 0 && errors.at(-1)?.includes("not confirmed"), "mismatched create result must not add a terminal tab");
    checks.push("uncertain and mismatched native create results cannot substitute a foreign target");

    root?.unmount(); return { passed: true, checks, providerRequests: 0, nativeCreates: actions.length };
  },
});
