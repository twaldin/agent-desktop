import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopEvent, HostState, NetworkState } from "../../../../packages/shared/src/protocol";
import { startHost } from "../../../host/src/server";
import { requestHost } from "../main/host-transport";
import { verifyKnownHost } from "../main/host-recovery";
import { HostCatalog } from "./host-catalog";

async function until(read: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!read()) { if (Date.now() >= deadline) throw new Error("Actual host connection condition timed out"); await Bun.sleep(10); }
}

test("real authenticated host state survives delayed probe failures, recovers independently, and becomes offline when its owner stops", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-host-connection-")));
  const agentDirectory = join(directory, "agent"), discoveryDirectory = join(directory, "project");
  await mkdir(agentDirectory); await mkdir(discoveryDirectory);
  await writeFile(join(agentDirectory, "config.yml"), "extensions: []\n");
  const host = await startHost({ dataDirectory: join(directory, "host"), agentDirectory, discoveryDirectory });
  const endpoint = host.connection, owner = endpoint.hostId;
  const initial = await requestHost(endpoint, "/v1/state") as HostState;
  const local: HostState = { ...initial, host: { ...initial.host, id: "local-fixture" }, projects: [], sessions: [], drafts: [], lastEventSequence: 0 };
  const unavailable: NetworkState = { status: "connected", checkedAt: Date.now(), hosts: [{ nodeId: "owner-node", name: initial.host.name, platform: initial.host.platform, online: true, availability: "unavailable", error: "Controlled delayed discovery probe failure" }] };
  let discovery = Promise.withResolvers<NetworkState>();
  let heldResponse: ReturnType<typeof Promise.withResolvers<HostState>> | undefined;
  let responseRead: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let socket: WebSocket | undefined;
  let ownerFetches = 0;
  const catalog = new HostCatalog({
    getState: async id => {
      if (id !== owner) return local;
      ownerFetches++;
      // Real bearer-authenticated HTTP completes; delay only delivery to model
      // a response lost while a newer WebSocket observation is already visible.
      const state = await requestHost(endpoint, "/v1/state") as HostState;
      responseRead?.resolve();
      return heldResponse ? heldResponse.promise : state;
    },
    getHosts: () => discovery.promise,
    subscribe: listener => {
      socket = new WebSocket(`${endpoint.origin.replace("http:", "ws:")}/v1/events`, ["agent-desktop", endpoint.token]);
      socket.onmessage = event => listener({ ...JSON.parse(String(event.data)), hostId: owner } as DesktopEvent);
      socket.onclose = () => listener({ type: "connection", hostId: owner, sequence: 0, connected: false, error: "Actual owning socket closed" });
      return () => { if (socket) { socket.onmessage = null; socket.onclose = null; socket.close(); } };
    },
  }, { read: async () => JSON.stringify({ states: [initial], nodes: [["owner-node", owner]] }), write: async () => {} });
  try {
    await catalog.restore(); catalog.start();
    await until(() => Boolean(catalog.records.get(owner)?.connected));
    expect(await verifyKnownHost(endpoint)).toEqual(endpoint);
    await expect(verifyKnownHost({ ...endpoint, hostId: crypto.randomUUID() })).rejects.toThrow("different host identity");
    await expect(verifyKnownHost({ ...endpoint, token: "deliberately-invalid-fixture-token" })).rejects.toThrow("Unauthorized");

    heldResponse = Promise.withResolvers<HostState>(); responseRead = Promise.withResolvers<void>();
    const refreshing = catalog.refreshHost(owner); await responseRead.promise;
    const before = catalog.records.get(owner)!.state!.lastEventSequence;
    const added = await host.dispatch({ id: crypto.randomUUID(), command: { type: "project.add", path: discoveryDirectory } });
    expect(added.ok).toBe(true);
    await until(() => catalog.records.get(owner)!.state!.lastEventSequence > before);
    heldResponse.reject(new Error("Controlled older HTTP response failure")); await refreshing;
    heldResponse = undefined; responseRead = undefined;
    expect(catalog.records.get(owner)?.connected).toBe(true);
    expect(catalog.records.get(owner)?.state?.projects).toHaveLength(1);

    const probing = catalog.refresh(owner);
    const callsBeforeRecovery = ownerFetches;
    await until(() => catalog.records.get(owner)?.loading === false);
    discovery.resolve(unavailable); await probing;
    expect(catalog.records.get(owner)?.connected).toBe(true);
    expect(catalog.network?.hosts[0]?.error).toBe(unavailable.hosts[0]!.error);
    // Even if discovery repeatedly fails, the selected host is directly tested.
    discovery = Promise.withResolvers<NetworkState>(); discovery.resolve(unavailable);
    await catalog.refresh(owner);
    expect(ownerFetches).toBeGreaterThan(callsBeforeRecovery);
    expect(catalog.records.get(owner)?.connected).toBe(true);

    await host.stop();
    await until(() => catalog.records.get(owner)?.connected === false);
    await catalog.refresh(owner);
    expect(catalog.records.get(owner)?.connected).toBe(false);
    expect(catalog.records.get(owner)?.error).toBeTruthy();
    expect(catalog.records.get(owner)?.state?.projects).toHaveLength(1);
    await expect(verifyKnownHost(endpoint)).rejects.toThrow();
  } finally {
    catalog.stop(); await host.stop(); await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
