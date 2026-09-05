import { describe, expect, test } from "bun:test";
import type { HostState, NetworkState } from "../../../../packages/shared/src/protocol";
import { HostCatalog, type HostCatalogBridge } from "./host-catalog";
import type { OfflineCache } from "./offline-cache";

const state = (id: string, sequence = 1): HostState => ({ protocolVersion: 1, host: { id, name: id, platform: "linux", architecture: "x64" }, projects: [{ id: "project", hostId: id, name: `${id} project`, path: `/home/${id}`, createdAt: 1 }], sessions: [], drafts: [], models: [], lastEventSequence: sequence });
const network = (patch: Partial<NetworkState> = {}): NetworkState => ({ status: "connected", ownNodeId: "node-local", checkedAt: 1, hosts: [], ...patch });
function cache(initial?: unknown): OfflineCache & { saved: Map<string, string> } {
  const saved = new Map<string, string>(initial ? [["agent-desktop:host-catalog:v2", JSON.stringify(initial)]] : []);
  return { saved, read: async key => saved.get(key) ?? null, write: async (key, value) => { saved.set(key, value); } };
}
function bridge(overrides: Partial<HostCatalogBridge> = {}): HostCatalogBridge {
  return { getState: async id => state(id ?? "local"), getHosts: async () => network(), subscribe: () => () => {}, ...overrides };
}

describe("machine-owned host catalog", () => {
  test("an older failed discovery probe cannot disconnect a newer authenticated state", async () => {
    const discovery = Promise.withResolvers<NetworkState>();
    const catalog = new HostCatalog(bridge({ getHosts: () => discovery.promise }), cache({ states: [state("remote")], nodes: [["node-remote", "remote"]] }));
    await catalog.restore();
    const refreshing = catalog.refresh();
    catalog.ingest({ type: "state", hostId: "remote", sequence: 9, state: state("remote", 9) });
    discovery.resolve(network({ hosts: [{ nodeId: "node-remote", name: "Remote", platform: "linux", online: true, availability: "unavailable", error: "Earlier service probe timed out" }] }));
    await refreshing;
    expect(catalog.records.get("remote")).toMatchObject({ connected: true, state: { lastEventSequence: 9 } });
    expect(catalog.network?.hosts[0]?.error).toBe("Earlier service probe timed out");
  });
  test("an older failed HTTP refresh cannot disconnect a later authenticated state", async () => {
    const response = Promise.withResolvers<HostState>();
    const catalog = new HostCatalog(bridge({ getState: () => response.promise }), cache());
    await catalog.restore();
    const refreshing = catalog.refreshHost("remote");
    catalog.ingest({ type: "state", hostId: "remote", sequence: 9, state: state("remote", 9) });
    response.reject(new Error("Earlier request timed out"));
    await refreshing;
    expect(catalog.records.get("remote")).toMatchObject({ connected: true, state: { lastEventSequence: 9 } });
  });
  test("an old HTTP success cannot reconnect after the owning stream closes", async () => {
    const response = Promise.withResolvers<HostState>();
    const catalog = new HostCatalog(bridge({ getState: () => response.promise }), cache());
    await catalog.restore();
    const refreshing = catalog.refreshHost("remote");
    catalog.ingest({ type: "connection", hostId: "remote", sequence: 2, connected: false, error: "Owning stream closed" });
    response.resolve(state("remote", 2));
    await refreshing;
    expect(catalog.records.get("remote")).toMatchObject({ connected: false, error: "Owning stream closed" });
  });
  test("a live owning-host connection reconciles an older unavailable discovery option", async () => {
    const catalog = new HostCatalog(bridge({ getHosts: async () => network({ hosts: [{ nodeId: "node-remote", name: "Remote laptop", platform: "linux", online: true, availability: "unavailable", error: "Earlier service probe failed" }] }) }), cache({ states: [state("remote")], nodes: [["node-remote", "remote"]] }));
    await catalog.restore(); await catalog.refresh();
    expect(catalog.options().find(host => host.hostId === "remote")?.availability).toBe("unavailable");
    catalog.ingest({ type: "state", hostId: "remote", sequence: 9, state: state("remote", 9) });
    expect(catalog.records.get("remote")?.connected).toBe(true);
    expect(catalog.options().filter(host => host.hostId === "remote")).toEqual([
      { key: "remote", hostId: "remote", name: "remote", local: false, availability: "available", cached: true, error: undefined },
    ]);
    expect(catalog.network?.hosts[0]?.error).toBe("Earlier service probe failed");
    catalog.ingest({ type: "connection", hostId: "remote", sequence: 10, connected: false, error: "Connection closed" });
    expect(catalog.options().find(host => host.hostId === "remote")).toMatchObject({ availability: "unavailable", cached: true, error: "Connection closed" });
  });
  test("an offline discovery entry recovers after an authenticated fetch and returns offline on disconnect", async () => {
    const catalog = new HostCatalog(bridge({ getHosts: async () => network({ hosts: [{ nodeId: "node-remote", name: "Remote laptop", platform: "linux", online: false, availability: "offline" }] }) }), cache({ states: [state("remote")], nodes: [["node-remote", "remote"]] }));
    await catalog.restore(); await catalog.refresh();
    expect(catalog.options().find(host => host.hostId === "remote")?.availability).toBe("offline");
    await catalog.refreshHost("remote");
    expect(catalog.records.get("remote")?.connected).toBe(true);
    expect(catalog.options().find(host => host.hostId === "remote")).toMatchObject({ availability: "available", error: undefined });
    catalog.ingest({ type: "connection", hostId: "remote", sequence: 2, connected: false });
    expect(catalog.options().find(host => host.hostId === "remote")).toMatchObject({ availability: "offline", cached: true });
  });
  test("incomplete discovery and discovery errors retain a connected owner without fabricating other hosts", async () => {
    let unavailable = false;
    const catalog = new HostCatalog(bridge({ getHosts: async () => { if (unavailable) throw new Error("Discovery timed out"); return network(); } }), cache());
    await catalog.restore(); await catalog.refresh(); await catalog.refreshHost("remote");
    expect(catalog.options().find(host => host.hostId === "remote")?.availability).toBe("available");
    unavailable = true; await catalog.refresh();
    expect(catalog.networkError).toBe("Discovery timed out");
    expect(catalog.options().filter(host => !host.local)).toEqual([
      { key: "remote", hostId: "remote", name: "remote", local: false, availability: "available", cached: true, error: undefined },
    ]);
  });
  test("successful discovery cannot hide a failed authenticated owner fetch", async () => {
    const catalog = new HostCatalog(bridge({ getState: async id => { if (id === "remote") throw new Error("Authenticated request rejected"); return state("local"); }, getHosts: async () => network({ hosts: [{ nodeId: "node-remote", name: "Remote laptop", platform: "linux", online: true, availability: "available", host: state("remote").host }] }) }), cache());
    await catalog.restore(); await catalog.refresh();
    expect(catalog.records.get("remote")?.connected).toBe(false);
    expect(catalog.options().find(host => host.hostId === "remote")).toMatchObject({ availability: "unavailable", cached: false, error: "Authenticated request rejected" });
  });
  test("remote state and disconnect events cannot overwrite the local owner", async () => {
    const catalog = new HostCatalog(bridge(), cache()); await catalog.restore(); await catalog.refresh();
    catalog.ingest({ type: "state", hostId: "remote", sequence: 9, state: state("remote", 9) });
    catalog.ingest({ type: "connection", hostId: "remote", sequence: 10, connected: false });
    expect(catalog.records.get("local")?.connected).toBe(true);
    expect(catalog.records.get("local")?.state?.projects[0]?.path).toBe("/home/local");
    expect(catalog.records.get("remote")?.connected).toBe(false);
    catalog.ingest({ type: "state", hostId: "local", sequence: 11, state: state("remote", 11) });
    expect(catalog.records.get("local")?.state?.host.id).toBe("local");
    expect(catalog.records.get("remote")?.state?.lastEventSequence).toBe(9);
  });
  test("a delayed offline read cannot replace live state or lose another cached machine", async () => {
    let resolveRead!: (value: string) => void; const writes: string[] = [];
    const catalog = new HostCatalog(bridge(), { read: () => new Promise(resolve => { resolveRead = resolve; }), write: async (_key, value) => { writes.push(value); } });
    const restoring = catalog.restore();
    catalog.ingest({ type: "state", sequence: 7, state: state("local", 7) });
    expect(writes).toHaveLength(0);
    resolveRead(JSON.stringify({ localHostId: "local", states: [state("local", 2), state("remote", 3)], nodes: [] }));
    await restoring;
    expect(catalog.records.get("local")).toMatchObject({ connected: true, state: { lastEventSequence: 7 } });
    expect(catalog.records.get("remote")).toMatchObject({ connected: false, state: { lastEventSequence: 3 } });
    expect(JSON.parse(writes.at(-1)!).states).toHaveLength(2);
  });
  test("offline discovery retains the last known owner identity and its projects", async () => {
    const storage = cache({ localHostId: "local", states: [state("local"), state("remote")], nodes: [["node-remote", "remote"]] });
    const catalog = new HostCatalog(bridge({ getHosts: async () => network({ hosts: [{ nodeId: "node-remote", name: "Remote laptop", platform: "linux", online: false, availability: "offline" }] }) }), storage);
    await catalog.restore(); await catalog.refresh();
    expect(catalog.options().filter(host => host.hostId === "remote")).toHaveLength(1);
    expect(catalog.options().find(host => host.hostId === "remote")).toMatchObject({ availability: "offline", cached: true });
    expect(catalog.records.get("remote")?.state?.projects).toHaveLength(1);
    expect(catalog.records.get("remote")?.connected).toBe(false);
  });
  test("a mismatched remote identity preserves its cached catalog and reports failure", async () => {
    const catalog = new HostCatalog(bridge({ getState: async () => state("unexpected") }), cache({ states: [state("remote")], nodes: [] }));
    await catalog.restore(); await catalog.refreshHost("remote");
    expect(catalog.records.get("remote")).toMatchObject({ connected: false, state: { host: { id: "remote" } } });
    expect(catalog.records.get("remote")?.error).toContain("different host identity");
    expect(catalog.records.has("unexpected")).toBe(false);
  });
  test("stale fetches cannot regress a live host or the persisted catalog", async () => {
    const storage = cache(); const catalog = new HostCatalog(bridge(), storage); await catalog.restore();
    catalog.ingest({ type: "state", hostId: "remote", sequence: 10, state: state("remote", 10) });
    catalog.ingest({ type: "state", hostId: "remote", sequence: 3, state: state("remote", 3) });
    expect(catalog.records.get("remote")?.state?.lastEventSequence).toBe(10);
    expect(JSON.parse(storage.saved.get("agent-desktop:host-catalog:v2")!).states[0].lastEventSequence).toBe(10);
  });
  test("cache write errors remain visible without hiding the connected host", async () => {
    const catalog = new HostCatalog(bridge(), { read: async () => null, write: async () => { throw new Error("Quota"); } });
    await catalog.restore(); await catalog.refresh();
    expect(catalog.records.get("local")?.connected).toBe(true);
    expect(catalog.cacheWarning).toContain("unavailable");
  });
  test("a failed cache read never overwrites unknown offline history with a partial live catalog", async () => {
    let fail = true; const writes: string[] = [];
    const catalog = new HostCatalog(bridge(), { read: async () => { if (fail) throw new Error("Locked"); return JSON.stringify({ states: [state("offline")], nodes: [] }); }, write: async (_key, value) => { writes.push(value); } });
    await catalog.restore(); await catalog.refresh();
    expect(catalog.records.get("local")?.connected).toBe(true);
    expect(writes).toHaveLength(0);
    expect(catalog.cacheWarning).toContain("preserved");
    fail = false; await catalog.restore();
    expect(JSON.parse(writes.at(-1)!).states.map((entry: HostState) => entry.host.id).sort()).toEqual(["local", "offline"]);
  });
  test("the first desktop catalog migrates without dropping its saved projects", async () => {
    const storage = cache(); storage.saved.set("agent-desktop:host-cache:v1", JSON.stringify(state("legacy")));
    const catalog = new HostCatalog(bridge(), storage); await catalog.restore();
    expect(catalog.localHostId).toBe("legacy");
    expect(catalog.records.get("legacy")?.state?.projects[0]?.path).toBe("/home/legacy");
    expect(storage.saved.has("agent-desktop:host-catalog:v2")).toBe(true);
  });
});
