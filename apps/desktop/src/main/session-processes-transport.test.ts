import { expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../../packages/shared/src/session-activity";
import type { SessionProcessMutation } from "../../../../packages/shared/src/session-processes";
import { closeFixture } from "../../../host/src/fixtures/browser-close";
import { SessionProcessRequests, type SessionProcessesHandle } from "../../../host/src/session-process-requests";
import { SessionProcessesHttp } from "../../../host/src/session-processes-http";
import { requestSessionProcesses } from "./session-processes-transport";

// Real loopback transport, host route and SQLite journal; only the loaded
// native worker handle is controlled. This is not Electron or provider proof.
function fixture() {
  const f = closeFixture(), owner = { nativeSessionId: "session", epoch: "epoch-1", projectDir: f.root };
  const target = { brokerId: "broker", name: "server", id: "record", generation: 1 };
  const row = { target, state: "ready", createdAt: 1, startedAt: 1, restartCount: 0, outputBytes: 5, readyPending: [], persist: false, detached: false };
  const seen: { owner: string | null; authorized: boolean; body: unknown }[] = [];
  let current = true, calls = 0;
  const handle: SessionProcessesHandle = { nativeProcesses: async input => { calls++; return input.action === "read"
    ? { action: "read", snapshot: { owner, brokerId: "broker", rows: [row] } } : { action: "mutation", row }; } };
  const executor = new SessionProcessRequests(f.store.processOperations, { getExistingHandle: async () => current ? handle : undefined, isCurrent: () => current });
  const route = new SessionProcessesHttp(f.store.host.id, executor);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const authorized = request.headers.get("authorization") === "Bearer fixture-only";
    seen.push({ owner: request.headers.get(SESSION_ACTIVITY_OWNER_HEADER), authorized, body: await request.clone().json() });
    if (!authorized) return new Response("Denied", { status: 401 });
    return await route.route(request) ?? new Response("Missing", { status: 404 });
  } });
  const input: SessionProcessMutation = { action: "input", operationId: "operation-1", owner, target, text: "exact input\n" };
  return { ...f, owner, target, row, handle, route, seen, input, endpoint: { origin: server.url.origin, hostId: f.store.host.id, token: "fixture-only" },
    current: (value: boolean) => { current = value; }, calls: () => calls,
    async stop() { server.stop(true); try { await route.dispose(); } finally { f.cleanup(); } } };
}

test("desktop sends one original-owner POST and reads the durable receipt after worker loss without replay", async () => {
  const f = fixture();
  try {
    expect((await requestSessionProcesses(f.endpoint, "session", { action: "read" })).result).toMatchObject({ action: "read", snapshot: { owner: f.owner, rows: [f.row] } });
    expect((await requestSessionProcesses(f.endpoint, "session", f.input)).result).toMatchObject({ action: "mutation", receipt: { status: "completed" } });
    f.current(false);
    expect((await requestSessionProcesses(f.endpoint, "session", { action: "receipt", operationId: f.input.operationId })).result).toMatchObject({ action: "receipt", receipt: { status: "completed" } });
    expect(f.calls()).toBe(2);
    expect(f.seen).toHaveLength(3); expect(f.seen.every(entry => entry.authorized && entry.owner === f.endpoint.hostId)).toBe(true);
    expect(f.seen[1]!.body).toEqual(f.input);
  } finally { await f.stop(); }
});
test("copies endpoint and input before fetch and rejects a changed original operation", async () => {
  const f = fixture(), mutable = { ...f.endpoint }, input = structuredClone(f.input), original = structuredClone(input);
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    mutable.hostId = "replacement"; mutable.origin = "http://127.0.0.1:1"; mutable.token = "replacement";
    input.text = "replacement"; input.target.id = "replacement";
    return fetchBefore(...args);
  }, { preconnect() {} });
  try { expect((await requestSessionProcesses(mutable, "session", input)).hostId).toBe(f.endpoint.hostId); }
  finally { globalThis.fetch = fetchBefore; }
  try {
    expect(f.seen[0]!.body).toEqual(original);
    await expect(requestSessionProcesses(f.endpoint, "session", { ...original, text: "different" })).rejects.toMatchObject({ code: "OPERATION_MISMATCH" });
    expect(f.calls()).toBe(1);
  } finally { await f.stop(); }
});
test("transport failure after native completion preserves original receipt, never retries the mutation", async () => {
  const f = fixture(), fetchBefore = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    requests++;
    const response = await fetchBefore(...args);
    await response.text();
    throw new Error("Controlled lost response after durable finish");
  }, { preconnect() {} });
  try { await expect(requestSessionProcesses(f.endpoint, "session", f.input)).rejects.toThrow("lost response"); }
  finally { globalThis.fetch = fetchBefore; }
  try {
    expect(requests).toBe(1); expect(f.calls()).toBe(1);
    expect((await requestSessionProcesses(f.endpoint, "session", { action: "receipt", operationId: f.input.operationId })).result).toMatchObject({ action: "receipt", receipt: { status: "completed" } });
    expect(f.calls()).toBe(1);
  } finally { await f.stop(); }
});
test("foreign host bytes are canceled and a malformed result or oversized body cannot confirm an operation", async () => {
  const f = fixture(), fetchBefore = globalThis.fetch;
  let cancelled = 0, calls = 0;
  const cases = [
    () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "foreign" } }),
    () => Response.json({ protocolVersion: 1, hostId: f.endpoint.hostId, sessionId: "other", result: { action: "receipt", receipt: null } }, { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: f.endpoint.hostId } }),
    () => new Response(new Uint8Array(512 * 1024 + 1), { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: f.endpoint.hostId } }),
  ];
  try {
    for (const response of cases) {
      globalThis.fetch = Object.assign(async () => { calls++; return response(); }, { preconnect() {} });
      await expect(requestSessionProcesses(f.endpoint, "session", f.input)).rejects.toThrow();
    }
    expect(cancelled).toBe(1); expect(calls).toBe(3); expect(f.calls()).toBe(0);
  } finally { globalThis.fetch = fetchBefore; await f.stop(); }
});
