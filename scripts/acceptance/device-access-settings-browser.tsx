import { createRoot } from "react-dom/client";
import type { DesktopBridge, DeviceAccessState, DeviceAccessUpdate, NetworkState } from "../../packages/shared/src/protocol";
import type { HostOption } from "../../apps/desktop/src/renderer/host-catalog";
import { ConnectionsSettings } from "../../apps/desktop/src/renderer/ConnectionsSettings";
import "../../apps/desktop/src/renderer/styles.css";

type AccessBridge = Pick<DesktopBridge, "getDeviceAccess" | "updateDeviceAccess" | "subscribeDeviceAccess">;
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(cause: unknown): void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const copy = (value: DeviceAccessState): DeviceAccessState => ({ ...value, policy: { ...value.policy, revokedNodeIds: [...value.policy.revokedNodeIds] } });

let owner: DeviceAccessState = { hostId: "host-local", supported: true, policy: { revision: 1, enabled: true, revokedNodeIds: [] } };
const initialRead = deferred<DeviceAccessState>();
let nextRead: Deferred<DeviceAccessState> | undefined = initialRead;
let capturedRead: Deferred<DeviceAccessState> | undefined;
let pendingUpdate: { wait: Deferred<void>; update: DeviceAccessUpdate } | undefined;
let failNextUpdate: string | undefined;
const reads: { revision: number; supported: boolean; deferred: boolean }[] = [];
const updates: DeviceAccessUpdate[] = [];
const listeners = new Set<() => void>();

const bridge: AccessBridge = {
  async getDeviceAccess() {
    const snapshot = copy(owner), held = nextRead;
    nextRead = undefined;
    reads.push({ revision: snapshot.policy.revision, supported: snapshot.supported, deferred: Boolean(held) });
    return held ? held.promise : snapshot;
  },
  async updateDeviceAccess(update) {
    updates.push(structuredClone(update));
    if (pendingUpdate) throw new Error("Fixture received a repeated update while one was pending");
    const wait = deferred<void>(); pendingUpdate = { wait, update };
    await wait.promise;
    pendingUpdate = undefined;
    if (failNextUpdate) { const message = failNextUpdate; failNextUpdate = undefined; throw new Error(message); }
    if (update.expectedRevision !== owner.policy.revision) throw new Error("Device access changed in another window. Refresh before trying again.");
    const revoked = new Set(owner.policy.revokedNodeIds);
    if (update.change.type === "availability") owner = { ...owner, policy: { ...owner.policy, revision: owner.policy.revision + 1, enabled: update.change.enabled } };
    else {
      if (update.change.allowed) revoked.delete(update.change.nodeId); else revoked.add(update.change.nodeId);
      owner = { ...owner, policy: { ...owner.policy, revision: owner.policy.revision + 1, revokedNodeIds: [...revoked].sort() } };
    }
    return copy(owner);
  },
  subscribeDeviceAccess(listener) { listeners.add(listener); return () => listeners.delete(listener); },
};

const network: NetworkState = {
  status: "connected", ownNodeId: "node-home", ownName: "Home", listenAddress: "100.64.0.1", checkedAt: 1,
  hosts: [
    { nodeId: "node-work", name: "Work Mac", platform: "darwin", online: true, availability: "available", origin: "http://100.64.0.2" },
    { nodeId: "node-phone", name: "Phone", platform: "ios", online: true, availability: "available" },
  ],
};
const hosts: HostOption[] = [{ key: "host-local", hostId: "host-local", nodeId: "node-home", name: "Home", local: true, availability: "available", cached: false }];

createRoot(document.getElementById("root")!).render(<ConnectionsSettings bridge={bridge} hosts={hosts} network={network}
  localHost={{ id: "host-local", name: "Home", platform: "darwin", architecture: "arm64" }} activeHostId="host-local"
  onSelectHost={() => { throw new Error("Device access fixture must not select another host"); }} onRefresh={() => {}}/>);

const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(element => element.getClientRects().length > 0);
Object.assign(window, {
  deviceAccessState: () => ({
    text: document.body.innerText,
    switches: visible('[role="switch"]').map(element => ({ label: element.getAttribute("aria-label"), checked: element.getAttribute("aria-checked"), disabled: (element as HTMLButtonElement).disabled })),
    actions: visible(".connections-access-button").map(element => ({ label: element.textContent?.trim(), aria: element.getAttribute("aria-label"), disabled: (element as HTMLButtonElement).disabled, spinning: Boolean(element.querySelector(".spinner")) })),
    alerts: visible('[role="alert"]').map(element => element.textContent?.trim()),
    statuses: visible('[role="status"]').map(element => element.textContent?.trim()),
    owner: copy(owner), reads: structuredClone(reads), updates: structuredClone(updates), pending: pendingUpdate?.update,
  }),
  deviceAccessControl: (command: string, argument?: unknown) => {
    if (command === "release-initial-read") { initialRead.resolve(copy(owner)); return; }
    if (command === "hold-next-read") { if (nextRead) throw new Error("A read is already held"); nextRead = deferred<DeviceAccessState>(); return; }
    if (command === "resolve-read") { if (!nextRead) throw new Error("No unread deferred read exists"); return; }
    if (command === "release-held-read") throw new Error("Use release-captured-read after the read has started");
    if (command === "emit") { for (const listener of listeners) listener(); return; }
    if (command === "capture-and-emit") {
      if (nextRead || capturedRead) throw new Error("A read is already held");
      capturedRead = deferred<DeviceAccessState>(); nextRead = capturedRead;
      for (const listener of listeners) listener(); return;
    }
    if (command === "release-captured-read") {
      if (!capturedRead) throw new Error("No captured read exists");
      const held = capturedRead; capturedRead = undefined; held.resolve(copy(argument as DeviceAccessState)); return;
    }
    if (command === "resolve-update") { if (!pendingUpdate) throw new Error("No update is pending"); pendingUpdate.wait.resolve(); return; }
    if (command === "fail-update") { if (!pendingUpdate) throw new Error("No update is pending"); failNextUpdate = String(argument); pendingUpdate.wait.resolve(); return; }
    if (command === "set-owner") { owner = copy(argument as DeviceAccessState); return; }
    throw new Error(`Unknown device access fixture command ${command}`);
  },
});

declare global {
  interface Window {
    deviceAccessState(): unknown;
    deviceAccessControl(command: string, argument?: unknown): void;
  }
}
