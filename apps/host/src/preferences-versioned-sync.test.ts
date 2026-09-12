import { afterEach, expect, test } from "bun:test";
import type { HostStore } from "./store";
import type { StoredPreferencesState } from "./preferences/store";
import { PreferencesSync } from "./preferences-sync";
import { probeAppHost } from "./network";
import { parsePreferencesSnapshot } from "../../../packages/shared/src/preferences";
import { COMMAND_KEYMAP_PREFERENCE } from "../../../packages/shared/src/preferences-v2";

const originalFetch = globalThis.fetch;
const active: PreferencesSync[] = [];
afterEach(async () => { for (const sync of active.splice(0)) await sync.dispose(); globalThis.fetch = originalFetch; });
function wire(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(input instanceof Request ? input.url : String(input), init))) as typeof fetch;
}
/** Only in-memory adapters and intercepted fetch. No host, SQLite, sockets or Tailscale commands are started. */
function replica(notification?: () => void) {
  let state: StoredPreferencesState | undefined, writes = 0, notifications = 0;
  const adapter = {
    host: { id: crypto.randomUUID() }, readPreferencesState: () => structuredClone(state),
    updatePreferencesState<T>(update: (saved: StoredPreferencesState | undefined) => { state: StoredPreferencesState; result: T }): T {
      const next = update(structuredClone(state)); state = structuredClone(next.state); writes++; return next.result;
    },
  };
  const sync = new PreferencesSync(adapter as unknown as HostStore, () => { notifications++; notification?.(); }); active.push(sync);
  return { sync, state: () => structuredClone(state), writes: () => writes, notifications: () => notifications };
}
function seed(sync: PreferencesSync) {
  return sync.store.mutateCommandKeymap({ expectedRevision: null, edit: { type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } } }, [{ id: "search", defaults: ["CmdOrCtrl+K"] }]);
}

test("inner keymap2 negotiates transport3 and cannot be rewritten for older peers", async () => {
  const local = replica(), modern = replica(), map = seed(local.sync);
  local.sync.store.mutateCommandKeymap({ expectedRevision: map.revision, edit: { type: "number-target", target: "sidebar" } }, []);
  const saved = local.state(), calls: string[] = [];
  wire((url, init) => {
    calls.push(url);
    expect(url).toBe("https://modern.invalid/v3/preferences/merge");
    const body = JSON.parse(String(init?.body));
    expect(body.records[0].value.primaryNumberShortcutTarget).toBe("sidebar");
    return Response.json(modern.sync.mergeV2(body));
  });
  await local.sync.sync([{ hostId: "old", origin: "https://old.invalid" }, { hostId: "v2", origin: "https://v2.invalid", preferencesSyncVersion: 2 }, { hostId: "modern", origin: "https://modern.invalid", preferencesSyncVersion: 3 }]);
  expect(calls).toEqual(["https://modern.invalid/v3/preferences/merge"]);
  expect(local.sync.errors.old).toContain("saved locally"); expect(local.sync.errors.v2).toContain("saved locally");
  expect(local.sync.errors.modern).toBeUndefined();
  expect(local.state()).toEqual(saved); expect(modern.sync.snapshotV2()).toEqual(local.sync.snapshotV2());
});

test("one exchange engine projects v1 and sends full v2 only to explicitly capable peers", async () => {
  const local = replica(), old = replica(), modern = replica();
  const map = seed(local.sync);
  const mode = local.sync.store.put({ key: "theme.mode", value: "dark" });
  const calls: { url: string; body: unknown }[] = [];
  wire((url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url, body });
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-only");
    if (url === "https://legacy.invalid/v1/preferences/merge") {
      expect(parsePreferencesSnapshot(body)).toEqual({ version: 1, records: [mode] });
      return Response.json(old.sync.merge(body));
    }
    if (url === "https://modern.invalid/v2/preferences/merge") return Response.json(modern.sync.mergeV2(body));
    throw new Error(`Unexpected intercepted URL ${url}`);
  });
  await local.sync.sync([{ hostId: "old", origin: "https://legacy.invalid", token: "fixture-only" },
    { hostId: "modern", origin: "https://modern.invalid", token: "fixture-only", preferencesSyncVersion: 2 }]);
  expect(calls).toHaveLength(2); expect(local.sync.errors).toEqual({});
  expect(old.sync.snapshot().records).toEqual([mode]);
  expect(old.sync.snapshotV2().records.some(record => record.key === COMMAND_KEYMAP_PREFERENCE)).toBe(false);
  expect(modern.sync.snapshotV2().records).toContainEqual(map);
  expect(local.sync.snapshotV2().records).toContainEqual(map);
  expect(modern.notifications()).toBe(1);
});

test("a reset tombstone crosses v2 but never leaks through an old peer's request or response", async () => {
  const local = replica(), other = replica(), map = seed(local.sync);
  other.sync.mergeV2(local.sync.snapshotV2());
  const tombstone = local.sync.store.mutateCommandKeymap({ expectedRevision: map.revision, edit: { type: "reset-all" } }, [{ id: "search", defaults: ["CmdOrCtrl+K"] }]);
  const calls: string[] = [];
  wire((url, init) => {
    calls.push(url); const body = JSON.parse(String(init?.body));
    if (url.includes("/v1/")) { expect(body).toEqual({ version: 1, records: [] }); return Response.json({ version: 1, records: [] }); }
    expect(body.records).toEqual([tombstone]); return Response.json(other.sync.mergeV2(body));
  });
  await local.sync.sync([{ hostId: "old", origin: "https://old.invalid" }, { hostId: "other", origin: "https://other.invalid", preferencesSyncVersion: 2 }]);
  expect(calls).toHaveLength(2); expect(local.sync.errors).toEqual({});
  expect(other.sync.snapshotV2().records).toEqual([tombstone]);
  expect(local.sync.snapshotV2().records).toEqual([tombstone]);
});

test("failed or wrong-version v2 responses do not silently fall back, remove state or report success", async () => {
  const local = replica(); seed(local.sync);
  for (const response of [() => new Response("unavailable", { status: 404 }), () => Response.json({ version: 1, records: [] })]) {
    const before = local.state(), writes = local.writes(), calls: string[] = [];
    wire(url => { calls.push(url); return response(); });
    await local.sync.sync([{ hostId: "other", origin: "https://other.invalid", preferencesSyncVersion: 2 }]);
    expect(calls).toEqual(["https://other.invalid/v2/preferences/merge"]);
    expect(local.sync.errors.other).toContain("saved locally");
    expect(local.state()).toEqual(before); expect(local.writes()).toBe(writes);
  }
});

test("health negotiation retains old host identity and accepts only the explicitly supported capability", async () => {
  const host = { id: "fixture", name: "Fixture", platform: "linux", architecture: "x64" };
  for (const capability of [undefined, 1, 2, 3, "2", null]) {
    const calls: string[] = [];
    wire(url => { calls.push(url); return Response.json({ protocolVersion: 1, host, ...(capability === undefined ? {} : { preferencesSyncVersion: capability }) }); });
    expect(await probeAppHost("https://fixture.invalid")).toEqual({ availability: "available", host, origin: "https://fixture.invalid", ...(capability === 2 || capability === 3 ? { preferencesSyncVersion: capability } : {}) });
    expect(calls).toEqual(["https://fixture.invalid/v1/health"]);
  }
});

test("a newly learned winner is forwarded within the same sync cycle", async () => {
  const local = replica(), upstream = replica();
  const winner = seed(upstream.sync), forwarded: unknown[][] = [];
  wire((url, init) => {
    const body = JSON.parse(String(init?.body));
    if (url.startsWith("https://upstream.invalid/")) return Response.json(upstream.sync.snapshotV2());
    forwarded.push(body.records); return Response.json(body);
  });
  await local.sync.sync([{ hostId: "upstream", origin: "https://upstream.invalid", preferencesSyncVersion: 2 },
    { hostId: "downstream", origin: "https://downstream.invalid", preferencesSyncVersion: 2 }]);
  expect(forwarded).toEqual([[], [winner]]);
  expect(local.sync.snapshotV2().records).toEqual([winner]);
  expect(local.notifications()).toBe(1);
});

test("the mutation wrapper notifies and synchronizes only after a successful transaction", async () => {
  const local = replica(), bodies: unknown[] = [];
  const peers = [{ hostId: "peer", origin: "https://peer.invalid", preferencesSyncVersion: 2 as const }];
  wire((_url, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body); return Response.json(body); });
  await local.sync.sync(peers); bodies.length = 0;
  const record = local.sync.mutateCommandKeymap({ expectedRevision: null, edit: { type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } } }, [{ id: "search", defaults: ["CmdOrCtrl+K"] }]);
  await local.sync.sync(peers);
  expect(local.notifications()).toBe(1);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.every(body => JSON.stringify(body) === JSON.stringify({ version: 2, records: [record] }))).toBe(true);
  const count = bodies.length;
  expect(() => local.sync.mutateCommandKeymap({ expectedRevision: null, edit: { type: "reset-all" } }, [{ id: "search", defaults: [] }])).toThrow("changed");
  expect(local.notifications()).toBe(1); expect(bodies).toHaveLength(count);
});


test("a post-save notification failure retains the map and reports an unknown outcome instead of a rejected edit", () => {
  const local = replica(() => { throw new Error("event journal failed"); });
  const definitions = [{ id: "search", defaults: ["CmdOrCtrl+K"] }];
  let failure: unknown;
  try { local.sync.mutateCommandKeymap({ expectedRevision: null, edit: { type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } } }, definitions); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(local.writes()).toBe(1);
  expect(local.sync.snapshotV2().records.find(record => record.key === COMMAND_KEYMAP_PREFERENCE)).toMatchObject({ value: { overrides: [{ command: "search", keys: ["Command+J"] }] } });
  expect(() => local.sync.mutateCommandKeymap({ expectedRevision: null, edit: { type: "reset-all" } }, definitions)).toThrow("changed");
  expect(local.writes()).toBe(1);
});
