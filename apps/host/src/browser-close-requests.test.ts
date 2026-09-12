import { afterEach, expect, test } from "bun:test";
import { BrowserCloseRequests, type BrowserCloseHandle } from "./browser-close-requests";
import { closeFixture, closeInput, closeOwner, flush } from "./fixtures/browser-close";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture(close?: BrowserCloseHandle["closeBrowserTab"]) {
  const f = closeFixture(), calls: string[] = [], entered = Promise.withResolvers<void>();
  const manager = new BrowserCloseRequests(f.store.browserCloses, f.store.host.id, "epoch-one", () => 1000);
  const handle: BrowserCloseHandle = { workerPid: 42, closeBrowserTab: async target => {
    calls.push("close"); expect(f.store.browserCloses.get(closeOwner, closeInput)).toBeDefined();
    expect(target).toEqual(closeInput.target); entered.resolve();
    return close ? close(target) : { ...target, ownerId: "session", released: true };
  } };
  let current: BrowserCloseHandle | undefined = handle, available = true;
  const binding = { isCurrent: () => available, getExistingHandle: async () => { calls.push("lookup"); return current; } };
  cleanups.push(async () => { try { await manager.dispose(); } catch { /* The failure is asserted by its owning test. */ } finally { f.cleanup(); } });
  return { ...f, manager, handle, calls, entered, binding, replace: (next?: BrowserCloseHandle) => { current = next; }, unavailable: () => { available = false; } };
}
test("concurrent exact requests claim before lookup/dispatch and retry remains historical after manager recreation", async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<BrowserCloseHandle["closeBrowserTab"]>>>(), f = fixture(() => gate.promise);
  const input = structuredClone(closeInput), first = f.manager.execute(closeOwner, input, f.binding);
  input.target.targetId = "changed-after-admission";
  const retry = f.manager.execute(closeOwner, closeInput, f.binding); await f.entered.promise;
  expect(f.manager.observe(closeOwner, closeInput).status).toBe("pending"); expect(f.calls).toEqual(["lookup", "close"]);
  gate.resolve({ ...closeInput.target, ownerId: "session", released: true });
  const receipt = await first; expect(receipt).toEqual(f.completed()); expect(await retry).toEqual(receipt);
  const history = new BrowserCloseRequests(f.store.browserCloses, f.store.host.id, "next-epoch", () => 999999);
  f.unavailable(); const before = [...f.calls];
  expect(await history.execute(closeOwner, closeInput, f.binding)).toEqual(receipt);
  expect(history.observe(closeOwner, closeInput)).toMatchObject({ status: "settled", receipt });
  expect(f.calls).toEqual(before); await history.dispose();
});
test("same-epoch lost process map and restart both keep pending IDs unknown without lookup or replay", async () => {
  const f = fixture(); f.store.browserCloses.claim(closeOwner, closeInput);
  for (const epoch of ["epoch-one", "next-epoch"]) {
    const manager = new BrowserCloseRequests(f.store.browserCloses, f.store.host.id, epoch, () => 1000);
    expect(await manager.execute(closeOwner, closeInput, f.binding)).toMatchObject({ outcome: "unknown" });
    expect(manager.observe(closeOwner, closeInput)).toMatchObject({ status: "settled", receipt: { outcome: "unknown" } });
    await manager.dispose();
  }
  expect(f.calls).toEqual([]); expect(f.store.browserCloses.get(closeOwner, closeInput)?.receipt).toBeUndefined();
});
test("claim and settlement failures cannot dispatch early or report an unsaved successful close", async () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER close_claim_failure BEFORE INSERT ON metadata WHEN NEW.key LIKE 'browser-close.v1:%' BEGIN SELECT RAISE(ABORT,'claim failed'); END");
  await expect(f.manager.execute(closeOwner, closeInput, f.binding)).rejects.toThrow("claim failed"); expect(f.calls).toEqual([]);
  f.db.exec("DROP TRIGGER close_claim_failure");
  f.db.exec("CREATE TRIGGER close_finish_failure BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'browser-close.v1:%' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
  await expect(f.manager.execute(closeOwner, closeInput, f.binding)).rejects.toThrow("finish failed");
  expect(f.store.browserCloses.get(closeOwner, closeInput)?.receipt).toBeUndefined();
  expect(await f.manager.execute(closeOwner, closeInput, f.binding)).toMatchObject({ outcome: "unknown" });
  expect(f.calls.filter(x => x === "close")).toHaveLength(1);
});
test("pre-dispatch missing worker rejects while post-dispatch replacement and false confirmation stay unknown", async () => {
  const missing = fixture(); missing.replace();
  expect(await missing.manager.execute(closeOwner, closeInput, missing.binding)).toMatchObject({ outcome: "rejected" }); expect(missing.calls).toEqual(["lookup"]);
  const gate = Promise.withResolvers<Awaited<ReturnType<BrowserCloseHandle["closeBrowserTab"]>>>(), replaced = fixture(() => gate.promise);
  const work = replaced.manager.execute(closeOwner, closeInput, replaced.binding); await replaced.entered.promise;
  replaced.replace({ ...replaced.handle }); gate.resolve({ ...closeInput.target, ownerId: "session", released: true });
  expect(await work).toMatchObject({ outcome: "unknown" });
  const wrong = fixture(async target => ({ ...target, targetId: "replacement", ownerId: "session", released: true }));
  expect(await wrong.manager.execute(closeOwner, closeInput, wrong.binding)).toMatchObject({ outcome: "unknown" });
});
test("preflight refusal is rejected, operational failure unknown, and stale tickets never reserve", async () => {
  const rejected = fixture(async () => { throw Object.assign(new Error("disabled"), { name: "BrowserActionRejected" }); });
  expect(await rejected.manager.execute(closeOwner, closeInput, rejected.binding)).toMatchObject({ outcome: "rejected" });
  const failed = fixture(async () => { throw new Error("worker died"); });
  expect(await failed.manager.execute(closeOwner, closeInput, failed.binding)).toMatchObject({ outcome: "unknown" });
  const stale = fixture();
  for (const change of [{ controlEpoch: "retired" }, { observedAt: 99999 }]) expect(await stale.manager.execute(closeOwner, { ...closeInput, ...change }, stale.binding)).toMatchObject({ outcome: "rejected" });
  expect(stale.calls).toEqual([]); expect(stale.store.browserCloses.get(closeOwner, closeInput)).toBeUndefined();
});
test("shutdown during existing-worker lookup prevents close and still settles its reservation", async () => {
  const f = fixture(), lookup = Promise.withResolvers<BrowserCloseHandle | undefined>(), entered = Promise.withResolvers<void>();
  const work = f.manager.execute(closeOwner, closeInput, { isCurrent: () => true, getExistingHandle: () => { entered.resolve(); return lookup.promise; } });
  await entered.promise; const drain = f.manager.dispose();
  lookup.resolve(f.handle);
  expect(await work).toMatchObject({ outcome: "rejected" }); await drain;
  expect(f.calls).toEqual([]); expect(f.store.browserCloses.get(closeOwner, closeInput)?.receipt?.outcome).toBe("rejected");
});
test("bounded pending admission rejects a ninth new request without claiming it, while existing duplicates join", async () => {
  const f = fixture(), lookup = Promise.withResolvers<BrowserCloseHandle | undefined>();
  const binding = { isCurrent: () => true, getExistingHandle: () => lookup.promise };
  const inputs = Array.from({ length: 8 }, (_, index) => ({ ...closeInput, requestId: `close-${index}` }));
  const work = inputs.map(input => f.manager.execute(closeOwner, input, binding));
  const duplicate = f.manager.execute(closeOwner, inputs[0]!, binding);
  const ninth = { ...closeInput, requestId: "ninth" };
  expect(await f.manager.execute(closeOwner, ninth, binding)).toMatchObject({ outcome: "rejected" });
  expect(f.store.browserCloses.get(closeOwner, ninth)).toBeUndefined();
  lookup.resolve(undefined);
  const results = await Promise.all(work); expect(results.every(result => result.outcome === "rejected")).toBe(true);
  expect(await duplicate).toEqual(results[0]!); expect(f.calls).toEqual([]);
});
test("retained shutdown waits sent close and durable finish even when finish fails; later admission cannot dispatch", async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<BrowserCloseHandle["closeBrowserTab"]>>>(), f = fixture(() => gate.promise);
  const work = f.manager.execute(closeOwner, closeInput, f.binding).catch(error => error as Error); await f.entered.promise;
  f.db.exec("CREATE TRIGGER close_finish_failure BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'browser-close.v1:%' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
  let drained = false;
  const drain = f.manager.dispose().then(() => { drained = true; return undefined; }, error => { drained = true; return error as AggregateError; });
  await flush(); expect(drained).toBe(false);
  expect(await f.manager.execute(closeOwner, { ...closeInput, requestId: "second" }, f.binding)).toMatchObject({ outcome: "rejected" });
  gate.resolve({ ...closeInput.target, ownerId: "session", released: true });
  expect(await work).toBeInstanceOf(Error); const error = await drain;
  expect(error).toBeInstanceOf(AggregateError); expect(error?.errors.map((e: Error) => e.message).join()).toContain("finish failed");
  await expect(f.manager.dispose()).rejects.toThrow("history could not finish");
  expect(f.calls.filter(x => x === "close")).toHaveLength(1);
});
