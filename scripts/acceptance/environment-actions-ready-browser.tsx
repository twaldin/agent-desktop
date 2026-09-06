import { useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, CommandResult, DesktopEvent, LocalEnvironmentActionsState, NativeTerminalInfo, WorkspaceQueryResult } from "@agent-desktop/shared";
import { EnvironmentActions } from "../../apps/desktop/src/renderer/EnvironmentActions";
import { WorkspaceState } from "../../apps/desktop/src/renderer/workspace-state";
import "../../apps/desktop/src/renderer/styles.css";

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint")!;
const hostId = params.get("host")!;
const projectId = params.get("project")!;
let environmentQueries = 0;
const listeners = new Set<(event: DesktopEvent) => void>();

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Fixture route ${path} failed with ${response.status}`);
  return response.json();
}

const workspace = new WorkspaceState({
  workspaceQuery: async (target, query) => {
    if (query.type === "environment.actions") environmentQueries++;
    return request<WorkspaceQueryResult>("/v1/workspace/query", { target, query });
  },
  command: (envelope: CommandEnvelope) => request<CommandResult>("/v5/commands", envelope),
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
}, hostId, { projectId }, { read: async () => null, write: async () => {} });

function Harness() {
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => workspace.subscribe(redraw), []);
  return <><output hidden data-owner-connected={String(workspace.connected)}/><EnvironmentActions
    workspace={workspace}
    connected
    onTerminal={(_terminal: NativeTerminalInfo) => {}}
    onSettings={() => {}}
  /></>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);

const wait = async (predicate: () => boolean, label: string) => {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const snapshot = () => ({
  ownerConnected: workspace.connected,
  environmentQueries,
  primary: document.querySelector<HTMLButtonElement>('[aria-label="Run: Count run"]')?.outerHTML ?? null,
  actions: workspace.environmentActions as LocalEnvironmentActionsState | undefined,
  error: workspace.errors["environment-actions"],
});

Object.assign(window, {
  async awaitMountedBeforeOwner() {
    await wait(() => Boolean(document.querySelector('[aria-label="Actions"]')), "mounted production EnvironmentActions");
    await new Promise(resolve => setTimeout(resolve, 150));
    if (environmentQueries !== 0) throw new Error(`Environment actions queried ${environmentQueries} time(s) before the owner workspace connected.`);
    if (workspace.environmentActions) throw new Error("Environment actions loaded before the owner workspace connected.");
    return snapshot();
  },
  async connectOwner() {
    workspace.setConnected(true);
    await wait(() => environmentQueries === 1 && Boolean(document.querySelector<HTMLButtonElement>('[aria-label="Run: Count run"]:not(:disabled)')), "primary action after delayed owner connection");
    return snapshot();
  },
  async reconnectOwner() {
    const beforeReconnect = environmentQueries;
    workspace.setConnected(false);
    await wait(() => document.querySelector('output[data-owner-connected="false"]') !== null, "committed disconnected owner render");
    if (!document.querySelector<HTMLButtonElement>('[aria-label="Run: Count run"]')?.disabled) throw new Error("Cached primary must be disabled while its owner is disconnected.");
    await frame();
    workspace.setConnected(true);
    await wait(() => document.querySelector('output[data-owner-connected="true"]') !== null && environmentQueries > beforeReconnect, "environment actions reload after owner reconnect");
    return { ...snapshot(), beforeReconnect };
  },
  actionsReadyState: snapshot,
});
