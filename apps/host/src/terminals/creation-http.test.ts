import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_OWNER_HEADER } from "@agent-desktop/shared";
import type { NativeTerminalInfo } from "../../../../packages/shared/src/terminals";
import { HostStore } from "../store";
import { TerminalCreationHttp } from "./creation-http";
import { TerminalError } from "./error";
import type { TerminalCreationRequest } from "./creation-records";

const roots: string[] = [], stores: HostStore[] = [], databases: Database[] = [], routes: TerminalCreationHttp[] = [];
afterEach(async () => {
  for (const route of routes.splice(0)) await route.dispose();
  for (const db of databases.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-terminal-create-http-")); roots.push(root);
  const store = new HostStore(root); stores.push(store);
  const db = new Database(join(root, "state.sqlite")); databases.push(db);
  const input: TerminalCreationRequest = { version: 1, requestId: crypto.randomUUID(), controlEpoch: crypto.randomUUID(), target: { projectId: crypto.randomUUID() }, cols: 120, rows: 30 };
  const native = new Map<string, NativeTerminalInfo>();
  const calls = { resolve: 0, environment: 0, create: 0, get: 0 };
  const started = deferred<void>();
  let createResult: ((info: NativeTerminalInfo) => Promise<NativeTerminalInfo>) | undefined, resolutionFailure = false, readFailure = false, retargeted = false;
  const manager: ConstructorParameters<typeof TerminalCreationHttp>[0]["manager"] = {
    async create(options, _environment, action, reservation) {
      calls.create++; reservation?.validateOwner();
      expect(action).toBeUndefined(); expect(reservation?.terminalId).toBe(store.terminalCreations.get(input)?.terminalId);
      expect(store.terminalCreations.get(input)?.state).toBe("pending");
      const info: NativeTerminalInfo = { id: reservation!.terminalId, target: options.target, cwd: root, shell: "fixture",
        pid: null, cols: options.cols!, rows: options.rows!, status: "running", createdAt: 1, protocol: "tmux-v1",
        serverGeneration: input.controlEpoch, geometryRevision: 1, inputEpoch: input.controlEpoch };
      native.set(info.id, info); started.resolve();
      return createResult ? createResult(info) : info;
    },
    get(id) { calls.get++; if (readFailure) throw new Error("catalogue unavailable"); const info = native.get(id); if (!info) throw new TerminalError("TERMINAL_NOT_FOUND", "missing"); return info; },
  };
  function route(epoch = input.controlEpoch) {
    const value = new TerminalCreationHttp({ hostId: store.host.id, controlEpoch: epoch, records: store.terminalCreations, manager,
      resolveTarget: () => { calls.resolve++; if (resolutionFailure) throw new Error("missing owner"); return retargeted && calls.resolve > 1 ? root + "/changed" : root; },
      environmentForTarget: () => { calls.environment++; return undefined; } });
    routes.push(value); return value;
  }
  const send = async (owner: TerminalCreationHttp, operation = "create", value: unknown = input, headers: Record<string, string> = { [WORKSPACE_OWNER_HEADER]: store.host.id }) => {
    const response = await owner.handle(new Request(`http://fixture.invalid/v2/terminals/${operation}`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(value) }));
    if (!response) throw new Error("Expected owned route");
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  };
  return { root, store, db, input, calls, started, native, route, send,
    controlCreate(value: typeof createResult) { createResult = value; }, failResolve() { resolutionFailure = true; }, retarget() { retargeted = true; }, failRead() { readFailure = true; } };
}

test("durable terminal route claims before dispatch and duplicate in-flight requests never repeat", async () => {
  const f = fixture(), gate = deferred<void>(), route = f.route();
  f.controlCreate(async info => { await gate.promise; return info; });
  const first = f.send(route); await f.started.promise;
  try {
    expect((await f.send(route)).body.status).toBe("pending");
    expect((await f.send(f.route())).body.status).toBe("pending");
    const changed = await f.send(route, "create", { ...f.input, cols: 121 });
    expect(changed.status).toBe(409); expect(changed.body.error.code).toBe("TERMINAL_CREATE_INPUT_MISMATCH");
    expect(f.calls).toEqual({ resolve: 2, environment: 1, create: 1, get: 0 });
  } finally { gate.resolve(); }
  expect((await first).body.receipt.outcome).toBe("completed");
  expect((await f.send(f.route())).body.receipt.outcome).toBe("completed");
  expect(f.calls.create).toBe(1);
});

test("lost response and changed route epoch retain ID; observation neither resolves nor acquires", async () => {
  const f = fixture(), route = f.route();
  await f.send(route); // Discard the create response as a lost client reply.
  const before = { ...f.calls }, restarted = f.route(crypto.randomUUID());
  const result = await f.send(restarted, "creation-status");
  expect(result.body).toMatchObject({ version: 1, hostId: f.store.host.id, status: "settled", receipt: { outcome: "completed" }, terminal: { id: result.body.receipt.terminalId } });
  expect(result.headers.get(WORKSPACE_OWNER_HEADER)).toBe(f.store.host.id);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect(f.calls).toEqual({ ...before, get: before.get + 1 });
  f.native.clear();
  expect((await f.send(restarted, "creation-status")).body.terminal).toBeUndefined();
  expect((await f.send(restarted)).body.receipt.outcome).toBe("completed");
  expect(f.calls.create).toBe(1);
  expect((await f.send(restarted, "create", { ...f.input, requestId: crypto.randomUUID() })).body.error.code).toBe("TERMINAL_CREATE_EPOCH_CHANGED");
});

test("claim and settlement storage failures never become normal completion or replay authority", async () => {
  const f = fixture(), route = f.route();
  f.db.exec("CREATE TRIGGER fail_admission BEFORE INSERT ON metadata WHEN NEW.key LIKE 'terminal-creation.v1:%' BEGIN SELECT RAISE(ABORT,'blocked'); END");
  expect((await f.send(route)).body.error.code).toBe("TERMINAL_CREATE_ADMISSION_FAILED");
  expect(f.calls.create).toBe(0); expect(f.calls.resolve).toBe(0);
  f.db.exec("DROP TRIGGER fail_admission");
  f.db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'terminal-creation.v1:%' BEGIN SELECT RAISE(ABORT,'blocked'); END");
  expect((await f.send(route)).body.error.code).toBe("TERMINAL_CREATE_SETTLEMENT_FAILED");
  const record = f.store.terminalCreations.get(f.input)!;
  expect(record.state).toBe("pending"); expect(f.calls.create).toBe(1);
  const restarted = f.route(crypto.randomUUID());
  const result = await f.send(restarted, "creation-status");
  expect(result.body).toMatchObject({ status: "settled", receipt: { outcome: "unknown", terminalId: record.terminalId }, terminal: { id: record.terminalId } });
  expect((await f.send(restarted)).body.receipt.outcome).toBe("unknown");
  expect(f.calls.create).toBe(1); expect(f.store.terminalCreations.get(f.input)).toEqual(record);
});

test("malformed native completion remains unknown while undispatched target failure is not-submitted", async () => {
  const f = fixture(), route = f.route();
  f.controlCreate(async info => ({ ...info, id: crypto.randomUUID() }));
  expect((await f.send(route)).body.receipt.outcome).toBe("unknown");
  expect((await f.send(route)).body.receipt.outcome).toBe("unknown"); expect(f.calls.create).toBe(1);
  const second = fixture(); second.failResolve();
  const failed = await second.send(second.route());
  expect(failed.body.receipt.outcome).toBe("not-submitted"); expect(second.calls.create).toBe(0);
});

test("owner, malformed input, stale capability and failed catalogue reads fail closed", async () => {
  const f = fixture(), route = f.route();
  expect((await f.send(route, "create", f.input, {})).body.error.code).toBe("OWNER_MISMATCH");
  expect((await f.send(route, "create", { ...f.input, cwd: "/" })).status).toBe(400);
  expect((await f.send(route, "create", { ...f.input, controlEpoch: crypto.randomUUID() })).body.error.code).toBe("TERMINAL_CREATE_EPOCH_CHANGED");
  expect(f.calls).toEqual({ resolve: 0, environment: 0, create: 0, get: 0 });
  const fresh = { ...f.input, requestId: crypto.randomUUID() };
  expect((await f.send(route, "creation-status", fresh)).body.status).toBe("unavailable");
  expect(f.calls.get).toBe(0);
  await f.send(route); f.failRead();
  expect((await f.send(route, "creation-status")).body.error.code).toBe("TERMINAL_CREATE_OBSERVATION_FAILED");
  expect(f.calls.create).toBe(1);
});

test("disposal waits for admitted result settlement and refuses late body admission", async () => {
  const f = fixture(), route = f.route(), gate = deferred<void>();
  f.controlCreate(async info => { await gate.promise; return info; });
  const active = f.send(route); await f.started.promise;
  let drained = false; const disposal = route.dispose().then(() => { drained = true; });
  try { await Promise.resolve(); expect(drained).toBe(false); expect((await f.send(route)).body.error.code).toBe("TERMINALS_STOPPING"); }
  finally { gate.resolve(); }
  expect((await active).body.receipt.outcome).toBe("completed"); await disposal;
  expect(drained).toBe(true); expect(f.store.terminalCreations.get(f.input)?.state).toBe("settled");
  const next = f.route(); let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = next.handle(new Request("http://fixture.invalid/v2/terminals/create", { method: "POST", headers: { [WORKSPACE_OWNER_HEADER]: f.store.host.id },
    body: new ReadableStream({ start(controller) { stream = controller; } }) }));
  const stopped = next.dispose(); stream.enqueue(new TextEncoder().encode(JSON.stringify({ ...f.input, requestId: crypto.randomUUID() }))); stream.close();
  expect((await response)!.status).toBe(503); await stopped; expect(f.calls.create).toBe(1);
});


test("queued terminal creation refuses a retargeted catalog owner without a replacement acquisition", async () => {
  const f = fixture(); f.retarget();
  const route = f.route(), result = await f.send(route);
  expect(result.body.receipt.outcome).toBe("unknown");
  expect(f.calls.resolve).toBe(2); expect(f.native.size).toBe(0);
  expect((await f.send(route)).body.receipt.outcome).toBe("unknown");
  expect(f.calls.create).toBe(1);
});


test("terminal creation capability is owner-bound and legacy action endpoint is not claimed", async () => {
  const f = fixture(), route = f.route();
  const response = await route.handle(new Request("http://fixture.invalid/v2/terminals/creation-capabilities", { headers: { [WORKSPACE_OWNER_HEADER]: f.store.host.id } }));
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({ version: 1, hostId: f.store.host.id, controlEpoch: f.input.controlEpoch });
  expect((await f.send(route, "creation-capabilities")).status).toBe(405);
  expect(route.handle(new Request("http://fixture.invalid/v2/terminals/action", { method: "POST" }))).toBeUndefined();
  expect(f.calls).toEqual({ resolve: 0, environment: 0, create: 0, get: 0 });
});
