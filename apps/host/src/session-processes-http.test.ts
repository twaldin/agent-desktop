import { afterEach, expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../packages/shared/src/session-activity";
import { parseSessionProcessesEnvelope, type SessionProcessMutation } from "../../../packages/shared/src/session-processes";
import { closeFixture } from "./fixtures/browser-close";
import { SessionProcessRequests, type SessionProcessesHandle } from "./session-process-requests";
import { SessionProcessesHttp } from "./session-processes-http";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const f = closeFixture(), owner = { nativeSessionId: "session", epoch: "worker", projectDir: f.root };
  const target = { brokerId: "broker", name: "server", id: "record", generation: 1 };
  const row = { target, state: "ready", createdAt: 1, startedAt: 1, restartCount: 0, outputBytes: 5, readyPending: [], persist: false, detached: false };
  let current = true, lookups = 0, calls = 0;
  const handle: SessionProcessesHandle = { nativeProcesses: async request => { calls++; return request.action === "read"
    ? { action: "read", snapshot: { owner, brokerId: "broker", rows: [row] } } : { action: "mutation", row }; } };
  const manager = new SessionProcessRequests(f.store.processOperations, { getExistingHandle: async () => { lookups++; return current ? handle : undefined; }, isCurrent: () => current });
  const http = new SessionProcessesHttp(f.store.host.id, manager);
  cleanups.push(async () => { try { await http.dispose(); } catch { /* Failure tests assert retained drain errors. */ } f.cleanup(); });
  const mutation: SessionProcessMutation = { action: "input", operationId: "operation-1", owner, target, text: "hello\n" };
  function post(body: unknown, host = f.store.host.id, path = "session") {
    return http.route(new Request(`http://fixture/v1/sessions/${path}/processes`, { method: "POST", headers: { [SESSION_ACTIVITY_OWNER_HEADER]: host }, body: JSON.stringify(body) }));
  }
  return { ...f, owner, target, row, handle, manager, http, mutation, post, current: (value: boolean) => { current = value; }, counts: () => ({ lookups, calls }) };
}
test("route owner, method, body and session guards precede any native lookup or durable claim", async () => {
  const f = fixture();
  expect(await f.http.route(new Request("http://fixture/v1/sessions/session/jobs"))).toBeUndefined();
  expect((await f.post({ action: "read" }, "foreign"))?.status).toBe(409);
  expect((await f.http.route(new Request("http://fixture/v1/sessions/session/processes", { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: f.store.host.id } })))?.status).toBe(405);
  expect((await f.post({ action: "shutdown" }))?.status).toBe(400);
  expect((await f.post(f.mutation, f.store.host.id, "other"))?.status).toBe(400);
  expect((await f.post({ action: "read" }, f.store.host.id, "%00"))?.status).toBe(400);
  expect(f.counts()).toEqual({ lookups: 0, calls: 0 }); expect(f.schema()).toBe(1);
});
test("HTTP returns projected native rows and durable receipts without starting a replacement worker", async () => {
  const f = fixture(), read = (await f.post({ action: "read" }))!;
  expect(read.headers.get("Cache-Control")).toBe("no-store");
  expect(parseSessionProcessesEnvelope(await read.json(), f.store.host.id, "session").result).toMatchObject({ action: "read", snapshot: { owner: f.owner, rows: [f.row] } });
  const complete = (await f.post(f.mutation))!;
  expect(parseSessionProcessesEnvelope(await complete.json(), f.store.host.id, "session").result).toMatchObject({ action: "mutation", receipt: { status: "completed" } });
  f.current(false);
  const lookup = (await f.post({ action: "receipt", operationId: f.mutation.operationId }))!;
  expect(parseSessionProcessesEnvelope(await lookup.json(), f.store.host.id, "session").result).toMatchObject({ action: "receipt", receipt: { status: "completed" } });
  expect((await f.post({ ...f.mutation, text: "changed" }))?.status).toBe(409);
  expect(f.counts()).toEqual({ lookups: 2, calls: 2 });
});
test("bounded body reader cancels actual oversized streams without native dispatch", async () => {
  const f = fixture(); let canceled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel() { canceled = true; } });
  const response = (await f.http.route(new Request("http://fixture/v1/sessions/session/processes", { method: "POST", headers: { [SESSION_ACTIVITY_OWNER_HEADER]: f.store.host.id }, body })))!;
  expect(response.status).toBe(400); expect(canceled).toBe(true); expect(f.counts().calls).toBe(0);
});
test("shutdown joins an already-admitted body and refuses new routes without touching closed state", async () => {
  const f = fixture(); let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
  const response = f.http.route(new Request("http://fixture/v1/sessions/session/processes", { method: "POST", headers: { [SESSION_ACTIVITY_OWNER_HEADER]: f.store.host.id }, body }));
  let drained = false; const drain = f.http.dispose().then(() => { drained = true; });
  expect(drained).toBe(false);
  expect((await f.post({ action: "read" }))?.status).toBe(409);
  bodyController.enqueue(new TextEncoder().encode('{"action":"read"}')); bodyController.close();
  expect((await response)?.status).toBe(409); await drain;
  expect(f.counts()).toEqual({ lookups: 0, calls: 0 });
});
test("dispatched malformed mutation during shutdown is durable unknown and retained by route drain", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<unknown>();
  f.handle.nativeProcesses = async () => { entered.resolve(); return gate.promise; };
  const pending = f.post(f.mutation); await entered.promise;
  const drain = f.http.dispose().catch(error => error as AggregateError);
  gate.resolve({ action: "mutation", row: { ...f.row, target: { ...f.target, id: "foreign" } } });
  const response = (await pending)!; expect(response.status).toBe(200);
  expect(parseSessionProcessesEnvelope(await response.json(), f.store.host.id, "session").result).toMatchObject({ action: "mutation", receipt: { status: "unknown" } });
  expect(await drain).toBeInstanceOf(AggregateError);
  expect(f.store.processOperations.get("session", f.mutation.operationId)?.status).toBe("unknown");
});
test("database finish failure exposes only unknown guidance, no private SQLite or native error contents", async () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER process_finish_failure BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'session-process.v1:%' BEGIN SELECT RAISE(ABORT,'secret-db-path'); END");
  const response = (await f.post(f.mutation))!;
  expect(response.status).toBe(500); expect(await response.text()).not.toContain("secret-db-path");
  const lookup = (await f.post({ action: "receipt", operationId: f.mutation.operationId }))!;
  expect(parseSessionProcessesEnvelope(await lookup.json(), f.store.host.id, "session").result).toMatchObject({ action: "receipt", receipt: { status: "unknown" } });
  await f.post(f.mutation);
  expect(f.counts()).toEqual({ lookups: 1, calls: 1 });
});
