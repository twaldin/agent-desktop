import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserRecoveryRecord } from "./browser-recovery-record";
import type { WorkerReconnectEndpoint, WorkerResetPolicyReconnect } from "./omp-workers/reconnect-wire";
import { HostStore } from "./store";

const roots: string[] = [];
const stores = new Set<HostStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(root: string): HostStore {
  const store = new HostStore(root);
  stores.add(store);
  return store;
}

function close(store: HostStore): void {
  store.close();
  stores.delete(store);
}

function resetPolicy(root: string, label: string, reverse = false): WorkerResetPolicyReconnect {
  const entries = reverse
    ? [["cwd", join(root, `${label}-cwd`)], ["sessionFile", join(root, `${label}.jsonl`)], ["rootSessionId", `${label}-root`], ["workerEpoch", `${label}-epoch`]]
    : [["workerEpoch", `${label}-epoch`], ["rootSessionId", `${label}-root`], ["sessionFile", join(root, `${label}.jsonl`)], ["cwd", join(root, `${label}-cwd`)]];
  return Object.fromEntries(entries) as WorkerResetPolicyReconnect;
}

function endpoint(root: string, label: string, pid: number, policy?: WorkerResetPolicyReconnect): WorkerReconnectEndpoint {
  return {
    version: 1,
    pid,
    instanceId: crypto.randomUUID(),
    socketPath: join(root, `${label}.sock`),
    token: (pid === 41 ? "a" : "b").repeat(64),
    ...(policy ? { resetPolicy: policy } : {}),
  };
}

function arm(store: HostStore, root: string, sessionId: string, source: WorkerReconnectEndpoint, destination: WorkerReconnectEndpoint): BrowserRecoveryRecord {
  const commandId = `command-${sessionId}`;
  store.claimCommand(commandId, `hash-${sessionId}`, {
    type: "session.create",
    projectId: null,
    browserContinuation: {
      version: 1,
      owner: { ownerId: "browser-owner", draftId: "draft", draftRevision: 1 },
      pages: [{
        request: { requestId: "page", controlEpoch: "control", observedAt: 1, initialUrl: "https://example.invalid" },
        target: { workerPid: source.pid, name: "page", targetId: "target" },
        backend: "worker",
        kindTag: "headless",
      }],
    },
  });
  const record: BrowserRecoveryRecord = {
    version: 2,
    hostId: store.host.id,
    commandId,
    sessionId,
    ownerId: "browser-owner",
    status: "arming",
    source,
    destination,
    bindings: [{ workerPid: source.pid, name: "page", targetId: "target", ownerId: "browser-owner", operationId: "operation", backend: "cdp" }],
    recordedAt: 1,
  };
  store.recordBrowserRecovery(record);
  return record;
}

test("durable recovery binds both exact reset-policy endpoint identities across ready and reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-reset-endpoint-")); roots.push(root);
  const first = open(root);
  const armed = arm(first, root, "bound", endpoint(root, "source", 41, resetPolicy(root, "source")), endpoint(root, "destination", 42, resetPolicy(root, "destination")));

  first.recordBrowserRecovery({
    ...armed,
    status: "ready",
    source: { ...armed.source, resetPolicy: resetPolicy(root, "source", true) },
    destination: { ...armed.destination, resetPolicy: resetPolicy(root, "destination", true) },
  });
  close(first);

  const reopened = open(root);
  const saved = reopened.listBrowserRecoveries().find(record => record.sessionId === "bound")!;
  expect(saved).toMatchObject({ status: "ready", source: { resetPolicy: resetPolicy(root, "source") }, destination: { resetPolicy: resetPolicy(root, "destination") } });

  for (const changed of [
    { ...saved, source: { ...saved.source, resetPolicy: { ...saved.source.resetPolicy!, workerEpoch: "forged-epoch" } } },
    { ...saved, source: { ...saved.source, resetPolicy: undefined } },
    { ...saved, destination: { ...saved.destination, resetPolicy: { ...saved.destination.resetPolicy!, rootSessionId: "forged-root" } } },
    { ...saved, destination: { ...saved.destination, resetPolicy: undefined } },
  ]) expect(() => reopened.recordBrowserRecovery(changed)).toThrow("durable native owner");
});

test("legacy ownerless endpoints remain stable but cannot gain a reset-policy identity", () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-legacy-endpoint-")); roots.push(root);
  const store = open(root);
  const armed = arm(store, root, "legacy", endpoint(root, "source", 41), endpoint(root, "destination", 42));
  store.recordBrowserRecovery({ ...armed, status: "ready" });
  const saved = store.listBrowserRecoveries().find(record => record.sessionId === "legacy")!;
  expect(saved.source.resetPolicy).toBeUndefined();
  expect(saved.destination.resetPolicy).toBeUndefined();
  expect(() => store.recordBrowserRecovery({ ...saved, source: { ...saved.source, resetPolicy: resetPolicy(root, "source") } })).toThrow("durable native owner");
  expect(() => store.recordBrowserRecovery({ ...saved, destination: { ...saved.destination, resetPolicy: resetPolicy(root, "destination") } })).toThrow("durable native owner");
});
