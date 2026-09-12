/** Controlled NativeBrowserOwner lifetime; no default loader, SDK or worker. */
import assert from "node:assert/strict";
import { NativeBrowserOwner, type BrowserEvaluationReservation, type BrowserOwnerBackend } from "../../apps/host/src/omp-browser/owner";

const ticks = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const flatten = (error: unknown): string[] => error instanceof AggregateError ? [...error.errors].flatMap(flatten) : [error instanceof Error ? error.message : String(error)];
const passed: string[] = [], failures: { name: string; error: string }[] = [];
async function scenario(name: string, run: () => Promise<void>) {
  try { await run(); passed.push(name); } catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
function backend(reserve: NonNullable<BrowserOwnerBackend["reserveEvaluation"]>, release: () => Promise<void> = async () => {}): BrowserOwnerBackend {
  return { create: async () => { throw new Error("Unexpected create"); }, reserveEvaluation: reserve, release };
}
function reservation(target: Readonly<{ name: string; targetId: string }>, operationId: string, options: Partial<BrowserEvaluationReservation> = {}): BrowserEvaluationReservation {
  return { ownerSessionId: "owner", ...target, operationId, ready: Promise.resolve(), assertCurrent() {}, dispose: async () => {}, ...options };
}

await scenario("captured input survives loader wait and same operation is deduplicated", async () => {
  const gate = Promise.withResolvers<BrowserOwnerBackend>(); let calls = 0;
  const owner = new NativeBrowserOwner({ id: "owner", cwd: "/controlled" }, () => gate.promise);
  const target = { name: "original", targetId: "target" };
  const pending = owner.reserveBrowserEvaluation(target, "operation");
  target.name = "replacement"; target.targetId = "other";
  gate.resolve(backend((request, operation) => { calls++; assert.deepEqual(request, { name: "original", targetId: "target" }); return reservation(request, operation); }));
  const value = await pending; await value.ready;
  assert.equal((await owner.reserveBrowserEvaluation({ name: "original", targetId: "target" }, "operation")).targetId, "target");
  assert.throws(() => owner.reserveBrowserEvaluation(target, "operation"), /changed target/);
  assert.equal(calls, 1); await owner.dispose();
});

await scenario("retirement during loader wait admits no native reservation", async () => {
  const gate = Promise.withResolvers<BrowserOwnerBackend>(); let calls = 0, releases = 0;
  const owner = new NativeBrowserOwner({ id: "owner", cwd: "/controlled" }, () => gate.promise);
  const pending = owner.reserveBrowserEvaluation({ name: "original", targetId: "target" }, "operation");
  const rejected = assert.rejects(pending, /retired/); const disposal = owner.dispose();
  gate.resolve(backend((request, operation) => { calls++; return reservation(request, operation); }, async () => { releases++; }));
  await rejected; await disposal; assert.equal(calls, 0); assert.equal(releases, 1);
});

await scenario("synchronous native disposal callback cannot escape retained owner cleanup", async () => {
  const closed = Promise.withResolvers<void>(); let drains = 0, releases = 0;
  let owner!: NativeBrowserOwner, disposal!: Promise<void>;
  owner = new NativeBrowserOwner({ id: "owner", cwd: "/controlled" }, async () => backend((request, operation) => {
    disposal = owner.dispose();
    return reservation(request, operation, { dispose: async options => { assert.equal(options?.kill, true); drains++; await closed.promise; } });
  }, async () => { releases++; }));
  const value = await owner.reserveBrowserEvaluation({ name: "original", targetId: "target" }, "operation");
  await assert.rejects(value.ready, /retired/); assert.throws(() => value.assertCurrent(), /retired/);
  await ticks(); assert.equal(drains, 1); assert.equal(releases, 0);
  closed.resolve(); await disposal; await owner.dispose(); assert.equal(releases, 1);
});

await scenario("all resource drains settle independently before final backend release", async () => {
  const one = Promise.withResolvers<void>(), two = Promise.withResolvers<void>(); let releases = 0;
  const owner = new NativeBrowserOwner({ id: "owner", cwd: "/controlled" }, async () => backend((request, operation) => reservation(request, operation, {
    dispose: () => operation === "one" ? one.promise : two.promise,
  }), async () => { releases++; throw new Error("backend release"); }));
  await owner.reserveBrowserEvaluation({ name: "first", targetId: "1" }, "one");
  await owner.reserveBrowserEvaluation({ name: "second", targetId: "2" }, "two");
  const disposed = owner.dispose(); const outcome = disposed.then(() => undefined, error => error);
  one.reject(new Error("first resource")); await ticks(); assert.equal(releases, 0);
  two.reject(new Error("second resource"));
  assert.deepEqual(flatten(await outcome).sort(), ["backend release", "first resource", "second resource"]);
  assert.equal(releases, 1);
});

await scenario("invalid publication retains its cleanup failure for joining owner disposal", async () => {
  let releases = 0;
  const owner = new NativeBrowserOwner({ id: "owner", cwd: "/controlled" }, async () => backend((request, operation) => reservation(request, operation, {
    targetId: "foreign", dispose: async () => { throw new Error("unpublished cleanup"); },
  }), async () => { releases++; }));
  await assert.rejects(owner.reserveBrowserEvaluation({ name: "first", targetId: "target" }, "one"), /Invalid browser reservation cleanup/);
  const error = await owner.dispose().then(() => undefined, error => error);
  assert.deepEqual(flatten(error), ["unpublished cleanup"]); assert.equal(releases, 1);
});

await scenario("missing native reservation capability never falls back to creation", async () => {
  let creates = 0;
  const owner = new NativeBrowserOwner({ id: "owner", cwd: "/controlled" }, async () => ({ create: async () => { creates++; throw new Error("Unexpected create"); }, release: async () => {} }));
  await assert.rejects(owner.reserveBrowserEvaluation({ name: "first", targetId: "target" }, "one"), /unavailable/);
  assert.equal(creates, 0); await owner.dispose();
});

console.log(JSON.stringify({ passed, failures, counts: { pass: passed.length, fail: failures.length }, limits: "Actual NativeBrowserOwner with injected backend only; no SDK, browser, worker, first-Send or physical proof." }, null, 2));
if (failures.length) process.exitCode = 1;
