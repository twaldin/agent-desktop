import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopBridge, DesktopEvent, WorkspaceTarget } from "../../packages/shared/src/protocol";
import type { NativeSshCatalog, NativeSshDetail, NativeSshMutation } from "../../packages/shared/src/ssh-settings";
import { SshToolSettings } from "../../apps/desktop/src/renderer/SshToolSettings";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/native-settings.css";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(cause: unknown): void };
const deferred = <T,>(): Deferred<T> => { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const remoteHostId = "host-remote", localHostId = "host-local";
const target: WorkspaceTarget = { projectId: "project-one" };
const managed = { id: "user:alpha", name: "alpha", scope: "user" as const, source: "/fixture/user.json", shadowed: false, editable: true };
const legacy = { id: "legacy:old", name: "legacy", scope: "user" as const, source: "~/.ssh/config", shadowed: true, editable: false };
let catalog: NativeSshCatalog = { revision: "r1", hosts: [managed, legacy], warnings: [] };
const details = new Map<string, NativeSshDetail>([
  [managed.id, { revision: "r1", host: managed, config: { host: "alpha.invalid", username: "agent", port: 2222, keyPath: "~/.ssh/alpha", description: "Fixture", compat: false, future: { preserved: true } } }],
  [legacy.id, { revision: "r1", host: legacy, config: { host: "legacy.invalid", port: "2201", key: "~/.ssh/legacy", compat: "yes" } }],
]);
const initial = deferred<NativeSshCatalog>();
let firstRead = true, heldRead: Deferred<NativeSshCatalog> | null = null, holdNext = false;
let pendingMutation: { mutation: NativeSshMutation; deferred: Deferred<NativeSshCatalog> } | null = null;
const reads: Array<{ target?: WorkspaceTarget; hostId?: string; held: boolean }> = [], mutations: NativeSshMutation[] = [], listeners = new Set<(event: DesktopEvent) => void>();
const bridge = {
  getSshHosts: async (requestTarget?: WorkspaceTarget, hostId?: string) => {
    if (firstRead) { firstRead = false; reads.push({ target: requestTarget, hostId, held: true }); return initial.promise; }
    if (holdNext) { holdNext = false; heldRead = deferred(); reads.push({ target: requestTarget, hostId, held: true }); return heldRead.promise; }
    reads.push({ target: requestTarget, hostId, held: false }); return structuredClone(catalog);
  },
  getSshHostDetail: async (_target: WorkspaceTarget | undefined, request: { hostId: string; expectedRevision: string }, hostId?: string) => {
    if (hostId !== remoteHostId || request.expectedRevision !== catalog.revision) throw new Error("Stale detail request");
    const detail = details.get(request.hostId); if (!detail) throw new Error("Missing detail");
    return { ...structuredClone(detail), revision: catalog.revision };
  },
  mutateSshHost: async (_target: WorkspaceTarget | undefined, mutation: NativeSshMutation, hostId?: string) => {
    if (hostId !== remoteHostId || pendingMutation) throw new Error("Unexpected concurrent mutation");
    mutations.push(structuredClone(mutation)); const wait = deferred<NativeSshCatalog>(); pendingMutation = { mutation, deferred: wait }; return wait.promise;
  },
  subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
} satisfies Pick<DesktopBridge, "getSshHosts" | "getSshHostDetail" | "mutateSshHost" | "subscribe">;

let setConnected!: (value: boolean) => void;
function Harness() { const [connected, update] = useState(true); setConnected = update; return <main><SshToolSettings bridge={bridge} hostId={remoteHostId} localHostId={localHostId} hostName="Remote fixture" target={target} connected={connected}/></main>; }
createRoot(document.getElementById("root")!).render(<Harness/>);

const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length);
Object.assign(window, {
  sshToolState: () => ({
    text: document.body.innerText,
    rows: visible(".ssh-tool-row-main").map(node => ({ text: node.innerText, disabled: (node as HTMLButtonElement).disabled })),
    dialog: document.querySelector<HTMLDialogElement>(".ssh-tool-dialog")?.open ?? false,
    dialogTitle: document.querySelector("#ssh-tool-dialog-title")?.textContent,
    activeConnected: document.activeElement?.isConnected,
    activeRow: document.activeElement?.matches(".ssh-tool-row-main") ? document.activeElement.querySelector("strong")?.firstChild?.textContent : null,
    activeIsAdd: document.activeElement === document.querySelector(".ssh-tool-add"),
    active: document.activeElement?.getAttribute("aria-label") || document.activeElement?.getAttribute("name") || document.activeElement?.textContent?.trim(),
    reads: structuredClone(reads), mutations: structuredClone(mutations), pendingMutation: pendingMutation?.mutation ?? null,
    disabledFields: visible(".ssh-tool-form input,.ssh-tool-form select,.ssh-tool-form button").map(node => ({ name: node.getAttribute("name") || node.textContent?.trim(), disabled: node.matches(":disabled") })),
    stale: visible(".ssh-tool-stale").map(node => node.textContent?.trim()),
  }),
  sshToolControl: (command: string, argument?: unknown) => {
    if (command === "release-initial") { initial.resolve(structuredClone(catalog)); return; }
    if (command === "hold-next-read") { holdNext = true; return; }
    if (command === "release-held-read") { const wait = heldRead; if (!wait) throw new Error("No held catalog read"); heldRead = null; wait.resolve(structuredClone(argument as NativeSshCatalog)); return; }
    if (command === "emit-settings") { for (const listener of listeners) listener({ type: "settings", sequence: Date.now(), ...(argument === "local" ? {} : { hostId: remoteHostId }), target }); return; }
    if (command === "resolve-mutation") {
      if (!pendingMutation) throw new Error("No pending mutation");
      catalog = structuredClone(argument as NativeSshCatalog);
      for (const host of catalog.hosts) if (!details.has(host.id)) details.set(host.id, { revision: catalog.revision, host, config: { host: `${host.name}.invalid` } });
      for (const [id, detail] of details) details.set(id, { ...detail, revision: catalog.revision, host: catalog.hosts.find(host => host.id === id) ?? detail.host });
      const wait = pendingMutation.deferred; pendingMutation = null; wait.resolve(structuredClone(catalog)); return;
    }
    if (command === "set-catalog-and-emit") { catalog = structuredClone(argument as NativeSshCatalog); for (const listener of listeners) listener({ type: "settings", sequence: Date.now(), hostId: remoteHostId, target }); return; }
    if (command === "set-connected") { setConnected(Boolean(argument)); return; }
    throw new Error(`Unknown SSH tool fixture command ${command}`);
  },
});

declare global { interface Window { sshToolState(): unknown; sshToolControl(command: string, argument?: unknown): void } }
