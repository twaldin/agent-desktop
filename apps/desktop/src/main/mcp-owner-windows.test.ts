import { expect, test } from "bun:test";
import { McpOwnerWindow } from "./mcp-owner-windows";
import type { McpOwnerRequest, McpOwnerSnapshot } from "@agent-desktop/shared";
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const endpoint = { hostId: "original-host", origin: "http://original.invalid", token: "disposable-fixture" };
const acquire = { type: "acquire" as const, ownerId: "original-owner", target: { projectId: null } };
const snapshot: McpOwnerSnapshot = { ownerId: acquire.ownerId, epoch: "original-epoch", cwd: "/original", projectId: null, interactions: [], catalogue: { available: true, canOpenApps: true, epoch: "catalogue", revision: 1, servers: [] } };

test("document loss before endpoint settlement never dispatches acquisition or retirement", async () => {
  const gate = deferred<typeof endpoint>(), calls: string[] = [];
  const window = new McpOwnerWindow({ current: () => true, connect: () => gate.promise, request: async (_, request) => { calls.push(request.type); return snapshot; } });
  const opening = window.dispatch(endpoint.hostId, acquire); void opening.catch(() => {});
  await Promise.resolve(); const drain = window.retire(); gate.resolve(endpoint);
  await expect(opening).rejects.toThrow("document"); await drain; expect(calls).toEqual([]);
});
test("sent acquisition lost receipt is retired on the captured endpoint and joined before document drain", async () => {
  const gate = deferred<McpOwnerSnapshot>(), cleanup = deferred<{ closed: true }>(), calls: unknown[] = [];
  const mutable = { ...endpoint };
  const window = new McpOwnerWindow({ current: () => true, connect: async () => mutable, request: async (target, request) => {
    calls.push({ target: { ...target }, request }); return request.type === "acquire" ? gate.promise : cleanup.promise;
  } });
  const opening = window.dispatch(endpoint.hostId, acquire); void opening.catch(() => {});
  while (!calls.length) await Promise.resolve(); mutable.origin = "http://replacement.invalid";
  let settled = false; const drain = window.retire().then(() => { settled = true; });
  gate.reject(new Error("lost acquisition response")); await expect(opening).rejects.toThrow("lost acquisition response");
  while (calls.length < 2) await Promise.resolve(); expect(settled).toBe(false);
  expect(calls[1]).toEqual({ target: endpoint, request: { ...acquire, type: "retire" } });
  cleanup.resolve({ closed: true }); await drain; expect(settled).toBe(true);
});
test("retire before acquire installs a local tombstone and a foreign generation cannot close an owner", async () => {
  const calls: McpOwnerRequest[] = [];
  const window = new McpOwnerWindow({ current: () => true, connect: async () => endpoint, request: async (_, request) => { calls.push(request); return request.type === "retire" ? { closed: true } : snapshot; } });
  await window.dispatch(endpoint.hostId, { ...acquire, ownerId: "retired-before-open", type: "retire" });
  expect(() => window.dispatch(endpoint.hostId, { ...acquire, ownerId: "retired-before-open" })).toThrow("retired");
  await window.dispatch(endpoint.hostId, acquire);
  await expect(window.dispatch(endpoint.hostId, { type: "close", ownerId: acquire.ownerId, epoch: "foreign" })).rejects.toThrow("generation");
  expect(calls.map(value => value.type)).toEqual(["acquire"]);
  await window.dispatch(endpoint.hostId, { type: "close", ownerId: acquire.ownerId, epoch: snapshot.epoch });
  expect(calls.map(value => value.type)).toEqual(["acquire", "retire"]);
  await window.retire();
});
test("failed cleanup remains observable and retries only the original retire request", async () => {
  let closes = 0;
  const window = new McpOwnerWindow({ current: () => true, connect: async () => endpoint, request: async (_, request) => {
    if (request.type === "acquire") return snapshot;
    if (++closes === 1) throw new Error("cleanup transport failed"); return { closed: true };
  } });
  await window.dispatch(endpoint.hostId, acquire);
  await expect(window.retire()).rejects.toThrow("cleanup"); await window.retire(); expect(closes).toBe(2);
});
