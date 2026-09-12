import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { DraftBrowserWorkers } from "./browser-draft-workers";
import type { WorkerBrowserOwner, WorkerFailure } from "./omp-workers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
function worker(id: string, cwd: string, overrides: Partial<WorkerBrowserOwner> = {}) {
  const calls: string[] = []; let listener: ((failure: WorkerFailure) => void) | undefined;
  const handle: WorkerBrowserOwner = {
    id, cwd, workerPid: 1234, workerFailure: undefined,
    getBrowserMetadata: async () => { calls.push("metadata"); return { availability: "unavailable", reason: "controlled metadata" }; },
    createBrowserTab: async () => { calls.push("create"); throw new Error("controlled acquisition failed"); },
    controlBrowser: async () => { calls.push("control"); throw new Error("controlled control failed"); },
    inspectBrowserTab: async () => { throw new Error("Unexpected observation in this fixture"); },
    openBrowserEvaluation: async () => { throw new Error("Unexpected evaluator allocation in existing fixture"); }, reserveBrowserEvaluation: async () => { throw new Error("Unexpected reservation in this fixture"); },
    inspectBrowserEvaluationReservation: async () => { throw new Error("Unexpected reservation status in this fixture"); },
    closeBrowserTab: async () => { calls.push("close"); throw new Error("controlled close failed"); },
    getBrowserFrame: async () => { calls.push("frame"); throw new Error("controlled frame failed"); },
    subscribeWorkerFailure: value => { calls.push("subscribe"); listener = value; return () => { calls.push("unsubscribe"); listener = undefined; }; },
    dispose: async () => { calls.push("dispose"); }, ...overrides,
  };
  return { handle, calls, fail: () => listener?.({ type: "worker_failure", message: "child died", pid: 1234 }) };
}
function fixture(factory?: (input: { id: string; cwd: string }) => Promise<WorkerBrowserOwner>, limit = 32) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "draft-browser-workers-"))), cwd = join(root, "project"); mkdirSync(cwd);
  const store = new HostStore(join(root, "data")), db = new Database(join(root, "data", "state.sqlite"));
  const project = store.addProject({ path: cwd });
  const saved = store.putDraft({ id: "draft", text: "keep unsent", projectId: project.id, model: null }, 0);
  if (!saved.ok) throw new Error("Fixture draft save failed");
  const request = { hostId: store.host.id, ownerId: "owner-one", draftId: "draft", draftRevision: 1 };
  const inputs: { id: string; cwd: string }[] = [], handles: ReturnType<typeof worker>[] = [];
  const registry = new DraftBrowserWorkers(store, cwd, { createBrowserOwner: async input => {
    inputs.push({ ...input });
    if (factory) return factory(input);
    const next = worker(input.id, input.cwd); handles.push(next); return next.handle;
  } }, limit);
  let expectedCleanupFailure = false;
  cleanups.push(async () => {
    const closed = await outcome(registry.dispose());
    db.close(); store.close(); rmSync(root, { recursive: true, force: true });
    if (closed.error && !expectedCleanupFailure) throw closed.error;
  });
  return { root, cwd, store, db, registry, request, inputs, handles, expectCleanupFailure: () => { expectedCleanupFailure = true; } };
}

test("one owner setup joins exact callers; history and read-only inspection do not start workers", async () => {
  const gate = Promise.withResolvers<WorkerBrowserOwner>(); const f = fixture(() => gate.promise);
  expect(f.registry.inspect(f.request)).toEqual({ state: "absent" }); expect(f.inputs).toEqual([]);
  const input = { ...f.request }, a = f.registry.acquire(input), b = f.registry.acquire(f.request);
  input.ownerId = "changed"; input.draftRevision = 99;
  const starting = f.registry.inspect(f.request).state;
  await tick(); const initialInputs = f.inputs.map(value => ({ ...value }));
  const native = worker(f.request.ownerId, f.cwd); gate.resolve(native.handle);
  const first = await a, second = await b;
  expect(starting).toBe("starting"); expect(initialInputs).toEqual([{ id: f.request.ownerId, cwd: f.cwd }]);
  await first.getBrowserMetadata(); await second.getBrowserMetadata();
  expect(native.calls).toEqual(["subscribe", "metadata", "metadata"]);
  expect(f.registry.inspect(f.request)).toMatchObject({ state: "ready", workerPid: 1234 });
  await expect(f.registry.acquire({ ...f.request, draftRevision: 2 })).rejects.toThrow("binding");
  expect(f.store.getDraft("draft")?.text).toBe("keep unsent"); expect(f.store.listSessions()).toEqual([]);
  await f.registry.dispose(); expect(native.calls).toEqual(["subscribe", "metadata", "metadata", "unsubscribe", "dispose"]);
  const next = new DraftBrowserWorkers(f.store, f.cwd, { createBrowserOwner: async () => { throw new Error("must not spawn"); } });
  try { await expect(next.acquire(f.request)).rejects.toThrow("cannot be recreated"); expect(next.inspect(f.request).state).toBe("unavailable"); }
  finally { await next.dispose(); }
});

test("retirement before factory dispatch suppresses setup and retains the durable identity", async () => {
  const f = fixture(), pending = outcome(f.registry.acquire(f.request));
  await f.registry.retire(f.request);
  expect((await pending).error?.message).toContain("unavailable"); expect(f.inputs).toEqual([]);
  expect(f.registry.inspect(f.request).state).toBe("retired");
  await f.registry.retire(f.request);
  await expect(f.registry.acquire(f.request)).rejects.toThrow("retired");
});

test("held setup drains and disposes its returned worker before retirement completes", async () => {
  const gate = Promise.withResolvers<WorkerBrowserOwner>(), f = fixture(() => gate.promise);
  const pending = outcome(f.registry.acquire(f.request)); await tick();
  let retired = false; const closing = f.registry.retire(f.request).then(() => { retired = true; });
  await tick(); const beforeSetup = { retired, count: f.inputs.length };
  const native = worker(f.request.ownerId, f.cwd); gate.resolve(native.handle);
  expect((await pending).error?.message).toContain("unavailable"); await closing;
  expect(beforeSetup).toEqual({ retired: false, count: 1 });
  expect(native.calls).toEqual(["dispose"]); expect(retired).toBe(true);
});

test("changed directory during setup refuses publication and closes only the returned handle", async () => {
  const gate = Promise.withResolvers<WorkerBrowserOwner>(), f = fixture(() => gate.promise);
  const pending = outcome(f.registry.acquire(f.request)); await tick();
  renameSync(f.cwd, join(f.root, "old")); mkdirSync(f.cwd);
  const native = worker(f.request.ownerId, f.cwd); gate.resolve(native.handle);
  expect((await pending).error?.message).toContain("directory identity changed");
  await f.registry.dispose(); expect(native.calls).toEqual(["dispose"]);
  expect(f.registry.inspect(f.request).state).toBe("unavailable");
});

test("wrong worker identity and failed setup cannot be silently recreated", async () => {
  const f = fixture(async input => worker("wrong-owner", input.cwd).handle);
  await expect(f.registry.acquire(f.request)).rejects.toThrow("different owner"); await tick();
  await expect(f.registry.acquire(f.request)).rejects.toThrow("cannot be recreated"); expect(f.inputs.length).toBe(1);
  const g = fixture(async () => { throw new Error("init failed"); });
  await expect(g.registry.acquire(g.request)).rejects.toThrow("init failed"); await tick();
  await expect(g.registry.acquire(g.request)).rejects.toThrow("cannot be recreated"); expect(g.inputs.length).toBe(1);
});

test("worker failure retires live access; stored history cannot resurrect it", async () => {
  const f = fixture(), handle = await f.registry.acquire(f.request), native = f.handles[0]!;
  native.fail();
  await expect(handle.getBrowserMetadata()).rejects.toThrow("unavailable");
  await tick(); expect(native.calls).toEqual(["subscribe", "unsubscribe", "dispose"]);
  await expect(f.registry.acquire(f.request)).rejects.toThrow("cannot be recreated"); expect(f.inputs.length).toBe(1);
});

test("synchronous failure notification still hands returned subscription cleanup to disposal", async () => {
  const calls: string[] = [];
  const f = fixture(async input => worker(input.id, input.cwd, {
    subscribeWorkerFailure: listener => { listener({ type: "worker_failure", message: "already dead", pid: 1234 }); return () => { calls.push("unsubscribe"); }; },
    dispose: async () => { calls.push("dispose"); },
  }).handle);
  await expect(f.registry.acquire(f.request)).rejects.toThrow("unavailable"); await f.registry.dispose();
  expect(calls).toEqual(["unsubscribe", "dispose"]);
});

test("retirement suppresses late operation results and retained handles cannot dispatch again", async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<WorkerBrowserOwner["getBrowserMetadata"]>>>(); let reads = 0;
  const f = fixture(async input => worker(input.id, input.cwd, { getBrowserMetadata: async () => { reads++; return gate.promise; } }).handle);
  const handle = await f.registry.acquire(f.request), pending = outcome(handle.getBrowserMetadata());
  await f.registry.retire(f.request); gate.resolve({ availability: "unavailable", reason: "late" });
  expect((await pending).error?.message).toContain("unavailable");
  await expect(handle.getBrowserMetadata()).rejects.toThrow("unavailable"); expect(reads).toBe(1);
});

for (const retirement of ["retire", "directory replacement"] as const) test(`dispatched reservation retains unknown outcome after ${retirement}`, async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<WorkerBrowserOwner["reserveBrowserEvaluation"]>>>();
  let reserves = 0;
  const f = fixture(async input => worker(input.id, input.cwd, { reserveBrowserEvaluation: async () => { reserves++; return gate.promise; } }).handle);
  const handle = await f.registry.acquire(f.request);
  const target = { workerPid: 1234, name: "original", targetId: "target" };
  const pending = outcome(handle.reserveBrowserEvaluation(target, "reservation"));
  expect(reserves).toBe(1);
  if (retirement === "retire") await f.registry.retire(f.request);
  else { renameSync(f.cwd, join(f.root, "old-reservation-directory")); mkdirSync(f.cwd); }
  gate.resolve({ ...target, ownerId: handle.id, operationId: "reservation", phase: "ready" });
  const result = await pending;
  expect(result.error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  const refused = await outcome(handle.reserveBrowserEvaluation(target, "new-reservation"));
  expect(refused.error).toBeDefined();
  expect((refused.error as Error & { code?: string }).code).toBeUndefined();
  expect(reserves).toBe(1);
});

for (const kind of ["preflight", "uncertain"] as const) test(`reservation wrapper preserves worker ${kind} error classification`, async () => {
  const error = kind === "preflight" ? new Error("Browser reservation request limit reached.") : Object.assign(new Error("Original reply lost"), { code: "OUTCOME_UNKNOWN" });
  let calls = 0;
  const f = fixture(async input => worker(input.id, input.cwd, { reserveBrowserEvaluation: async () => { calls++; throw error; } }).handle);
  const handle = await f.registry.acquire(f.request);
  const result = await outcome(handle.reserveBrowserEvaluation({ workerPid: 1234, name: "original", targetId: "target" }, "op"));
  expect(result.error?.message).toBe(error.message);
  expect((result.error as Error & { code?: string }).code).toBe(kind === "uncertain" ? "OUTCOME_UNKNOWN" : undefined);
  expect(calls).toBe(1);
});

test("later draft text revisions preserve the original browser reservation binding", async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<WorkerBrowserOwner["reserveBrowserEvaluation"]>>>();
  let reserves = 0;
  const f = fixture(async input => worker(input.id, input.cwd, { reserveBrowserEvaluation: async () => { reserves++; return gate.promise; } }).handle);
  const handle = await f.registry.acquire(f.request);
  const target = { workerPid: 1234, name: "original", targetId: "target" };
  const pending = handle.reserveBrowserEvaluation(target, "reservation");
  expect(f.store.putDraft({ id: "draft", text: "new revision", projectId: f.store.getDraft("draft")!.projectId, model: null }, 1).ok).toBe(true);
  gate.resolve({ ...target, ownerId: handle.id, operationId: "reservation", phase: "ready" });
  expect((await pending).phase).toBe("ready");
  expect(reserves).toBe(1);
});

test("cleanup failure remains visible on repeated retirement and shutdown; both cleanup steps execute", async () => {
  const calls: string[] = [];
  const f = fixture(async input => worker(input.id, input.cwd, {
    subscribeWorkerFailure: () => () => { calls.push("unsubscribe"); throw new Error("unsubscribe failed"); },
    dispose: async () => { calls.push("dispose"); throw new Error("worker close failed"); },
  }).handle); f.expectCleanupFailure();
  await f.registry.acquire(f.request);
  const first = await outcome(f.registry.retire(f.request)), second = await outcome(f.registry.retire(f.request));
  for (const result of [first, second]) {
    const nested = (result.error as AggregateError).errors[0] as AggregateError;
    expect(nested.errors.map(error => error.message)).toEqual(["unsubscribe failed", "worker close failed"]);
  }
  await expect(f.registry.dispose()).rejects.toThrow("cleanup failed"); await expect(f.registry.dispose()).rejects.toThrow("cleanup failed");
  expect(calls).toEqual(["unsubscribe", "dispose"]);
});

test("failed durable retirement still drains worker and does not report successful retirement", async () => {
  const f = fixture(); await f.registry.acquire(f.request);
  f.db.exec("CREATE TRIGGER fail_retire BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'draft-browser-owner.v1:%' BEGIN SELECT RAISE(ABORT,'retire write failed'); END");
  const result = await outcome(f.registry.retire(f.request));
  expect((result.error as AggregateError).errors.map(error => error.message)).toEqual(["retire write failed"]);
  expect(f.handles[0]!.calls).toEqual(["subscribe", "unsubscribe", "dispose"]);
  expect(f.store.draftBrowserOwners.get(f.request.ownerId)?.retiredAt).toBeUndefined();
  expect(f.registry.inspect(f.request).state).toBe("unavailable");
  f.db.exec("DROP TRIGGER fail_retire"); await f.registry.retire(f.request);
  expect(f.registry.inspect(f.request).state).toBe("retired");
});

test("capacity refuses before claiming; completed retirement releases capacity and shutdown stops admission", async () => {
  const f = fixture(undefined, 1); await f.registry.acquire(f.request);
  const next = { ...f.request, ownerId: "owner-two" };
  await expect(f.registry.acquire(next)).rejects.toThrow("limit reached");
  expect(f.store.draftBrowserOwners.get(next.ownerId)).toBeUndefined();
  await f.registry.retire(f.request); await f.registry.acquire(next);
  expect(f.inputs.map(input => input.id)).toEqual(["owner-one", "owner-two"]);
  await f.registry.dispose();
  await expect(f.registry.acquire({ ...next, ownerId: "owner-three" })).rejects.toThrow("stopping");
  expect(f.store.draftBrowserOwners.get("owner-three")).toBeUndefined();
});

test("shutdown before factory dispatch prevents creation and retains unknown history", async () => {
  const f = fixture(), ready = outcome(f.registry.acquire(f.request));
  await f.registry.dispose();
  expect((await ready).error?.message).toContain("unavailable"); expect(f.inputs).toEqual([]);
  expect(f.registry.inspect(f.request).state).toBe("unavailable");
  expect(f.store.draftBrowserOwners.get(f.request.ownerId)?.retiredAt).toBeUndefined();
});

test("shutdown waits for other owners even when one cleanup fails", async () => {
  const gate = Promise.withResolvers<void>(), calls: string[] = [];
  const f = fixture(async input => worker(input.id, input.cwd, { dispose: async () => {
    calls.push(input.id);
    if (input.id === "owner-one") throw new Error("first cleanup failed");
    await gate.promise;
  } }).handle); f.expectCleanupFailure();
  await f.registry.acquire(f.request); await f.registry.acquire({ ...f.request, ownerId: "owner-two" });
  let finished = false; const closing = outcome(f.registry.dispose()).then(result => { finished = true; return result; });
  await tick(); const earlyFinished = finished, started = [...calls];
  gate.resolve(); const result = await closing;
  expect(earlyFinished).toBe(false); expect(started.sort()).toEqual(["owner-one", "owner-two"]);
  expect(result.error?.message).toContain("cleanup failed"); expect(finished).toBe(true);
});

test("evaluator publication loss disposes only its returned channel and reports unknown without a second open", async () => {
  const gate = Promise.withResolvers<import("./omp-browser/evaluation-client").WorkerBrowserEvaluation>();
  let opens = 0, channelCloses = 0;
  const f = fixture(async input => worker(input.id, input.cwd, { openBrowserEvaluation: async () => { opens++; return gate.promise; } }).handle);
  const handle = await f.registry.acquire(f.request);
  const pending = outcome(handle.openBrowserEvaluation({ workerPid: 1234, name: "page", targetId: "surface" }, "evaluation", "cmux", 100));
  await tick(); await f.registry.retire(f.request);
  gate.resolve({ backend: "cmux", state: { version: 1, surfaceId: "surface", url: "about:blank", viewport: { width: 1, height: 1 }, elementRefs: [] },
    request: async () => { throw new Error("No dispatch after publication loss"); }, dispose: async () => { channelCloses++; } });
  const result = await pending;
  expect(result.error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(opens).toBe(1); expect(channelCloses).toBe(1);
  await expect(handle.openBrowserEvaluation({ workerPid: 1234, name: "page", targetId: "surface" }, "evaluation", "cmux", 100)).rejects.toThrow("unavailable");
  expect(opens).toBe(1);
});

test("retained evaluator callbacks preserve terminal drain after draft admission loss while blocking new data", async () => {
  let sink: ((frame: import("./omp-browser/evaluation-wire").BrowserEvaluationFrame) => void) | undefined;
  let closes = 0; const delivered: string[] = [];
  const f = fixture(async input => worker(input.id, input.cwd, { openBrowserEvaluation: async () => ({ backend: "cdp",
    descriptor: { version: 1, channel: "native-channel", targetId: "target", activateForScreenshot: false },
    start: async post => { if (sink && sink !== post) throw new Error("Changed original receiver"); sink = post; }, receive: () => { throw new Error("No unexpected outbound frames"); }, dispose: async () => { closes++; },
  }) }).handle);
  const handle = await f.registry.acquire(f.request), channel = await handle.openBrowserEvaluation({ workerPid: 1234, name: "page", targetId: "target" }, "evaluation", "cdp", 100);
  if (channel.backend !== "cdp") throw new Error("Expected original CDP channel");
  const receiver = (frame: import("./omp-browser/evaluation-wire").BrowserEvaluationFrame) => { delivered.push(frame.kind); };
  await channel.start(receiver); await channel.start(receiver);
  await f.registry.retire(f.request);
  expect(() => sink!({ type: "worker-cdp", channel: "native-channel", kind: "data", sequence: 1, data: "{}" })).toThrow("unavailable");
  sink!({ type: "worker-cdp", channel: "native-channel", kind: "close" });
  sink!({ type: "worker-cdp", channel: "native-channel", kind: "drained", errors: [] });
  await channel.dispose();
  expect(delivered).toEqual(["close", "drained"]); expect(closes).toBe(1);
});
