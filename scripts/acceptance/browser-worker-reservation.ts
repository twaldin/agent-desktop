/** Controlled WorkerBrowserReservations fixture. It imports no native browser implementation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { WorkerBrowserReservationStatus } from "../../apps/host/src/omp-browser/reservation";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { NativeBrowserOwner, type BrowserEvaluationReservation, type BrowserOwnerBackend } from "../../apps/host/src/omp-browser/owner";

const sourcePath = path.resolve(process.env.WORKER_RESERVATION_SOURCE ?? "apps/host/src/omp-browser/reservation.ts");
const source = await readFile(sourcePath, "utf8"), hash = createHash("sha256").update(source).digest("hex");
const { WorkerBrowserReservations, requestWorkerBrowserReservation } = await import(pathToFileURL(sourcePath).href) as typeof import("../../apps/host/src/omp-browser/reservation");
const pid = 74123;
const target = (name = "original", targetId = "target-1") => ({ workerPid: pid, name, targetId });
const ticks = async () => { for (let turn = 0; turn < 24; turn++) await Promise.resolve(); };
function observe<T>(promise: Promise<T>) {
	let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
	void promise.then(value => { result = { ok: true, value }; }, error => { result = { ok: false, error }; });
	return { get result() { return result; }, async settled() { await ticks(); return result; } };
}

type FrameTarget = ReturnType<typeof target>;
type Native = Readonly<BrowserEvaluationReservation>;
type ReservationOperation = { operation: "reserveBrowserEvaluation" | "inspectBrowserEvaluationReservation"; args: { target: FrameTarget; operationId: string } };
interface OwnerPort {
	readonly id: string;
	reserveBrowserEvaluation(target: Readonly<{ name: string; targetId: string }>, operationId: string): Promise<Native>;
}
interface ControlledOwnerPort extends OwnerPort { dispose(): Promise<void> }
interface ParentClient { readonly pid: number; request(operation: ReservationOperation): Promise<unknown> }
function controlledOwner(id = "owner-1") {
	const calls: Array<{ target: { name: string; targetId: string }; operationId: string }> = [];
	let current: OwnerPort, reserve: (value: Readonly<{ name: string; targetId: string }>, operationId: string) => Promise<Native>;
	let readFault: "throw" | "invalid" | undefined;
	let ownerDisposals = 0;
	const owner: ControlledOwnerPort = {
		id,
		async dispose() { ownerDisposals++; },
		reserveBrowserEvaluation(value: Readonly<{ name: string; targetId: string }>, operationId: string) { return reserve(value, operationId); },
	};
	const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
	reserve = async (value, operationId) => {
		calls.push({ target: { ...value }, operationId });
		const gate = gates.get(operationId) ?? Promise.withResolvers<void>(); gates.set(operationId, gate);
		return { ownerSessionId: owner.id, name: value.name, targetId: value.targetId, operationId, ready: gate.promise,
			assertCurrent() { if (current !== owner) throw new Error("native handle retired"); }, async dispose() {} };
	};
	current = owner;
	const reservations = new WorkerBrowserReservations(pid, () => {
		if (readFault === "throw") throw new Error("controlled owner read failure");
		if (readFault === "invalid") return { id: "", reserveBrowserEvaluation: owner.reserveBrowserEvaluation };
		return current;
	});
	return { owner, reservations, calls, gates, replace(value: OwnerPort) { current = value; }, setReadFault(value: "throw" | "invalid" | undefined) { readFault = value; }, setReserve(value: typeof reserve) { reserve = value; }, get ownerDisposals() { return ownerDisposals; } };
}
function pendingGate(h: ReturnType<typeof controlledOwner>, operationId: string) {
	const gate = Promise.withResolvers<void>(); h.gates.set(operationId, gate); return gate;
}
function unknown(error: unknown): boolean { return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "OUTCOME_UNKNOWN"; }
function messages(error: unknown): string[] { return error instanceof AggregateError ? error.errors.flatMap(messages) : [error instanceof Error ? error.message : String(error)]; }

const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: unknown[] = [];
async function scenario(name: string, body: () => Promise<unknown>) {
	try { evidence.push({ name, value: await body() }); passed.push(name); }
	catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}

await scenario("pending admission captures original target and inspect remains lookup-only", async () => {
	const h = controlledOwner(), input = target(); const gate = pendingGate(h, "op-pending");
	const pending = h.reservations.reserve(input, "op-pending"); input.name = "mutated"; input.targetId = "mutated-target";
	const status = h.reservations.inspect(target(), "op-pending");
	assert.deepEqual(status, { ...target(), ownerId: "owner-1", operationId: "op-pending", phase: "pending" });
	await ticks(); assert.deepEqual(h.calls, [{ target: { name: "original", targetId: "target-1" }, operationId: "op-pending" }]);
	gate.resolve(); const ready = await pending; ready.name = "consumer-mutation";
	assert.equal(h.reservations.inspect(target(), "op-pending")?.name, "original");
	assert.equal(h.reservations.inspect(target("different"), "missing"), null); assert.equal(h.calls.length, 1);
	return { pendingPhase: status?.phase, nativeCalls: h.calls.length, resultIsCopied: ready.name !== h.reservations.inspect(target(), "op-pending")?.name };
});

await scenario("same operation dedupes while a same target different operation is rejected", async () => {
	const h = controlledOwner(), gate = pendingGate(h, "op-1");
	const one = h.reservations.reserve(target(), "op-1"), two = h.reservations.reserve(target(), "op-1");
	await assert.rejects(h.reservations.reserve(target(), "op-2"), /already has a reservation/);
	await assert.rejects(h.reservations.reserve(target("changed", "changed-target"), "op-1"), /operation changed target/);
	gate.resolve(); const [first, second] = await Promise.all([one, two]);
	assert.deepEqual(first, second); assert.equal(h.calls.length, 1);
	return { nativeCalls: h.calls.length, phase: first.phase };
});

await scenario("a pending owner-loss inspection latches failure after the original owner returns", async () => {
	const h = controlledOwner(), gate = pendingGate(h, "op-latched");
	const pending = h.reservations.reserve(target(), "op-latched"); await ticks();
	const replacement: OwnerPort = { id: "owner-2", async reserveBrowserEvaluation() { throw new Error("replacement must not admit"); } };
	h.replace(replacement);
	assert.equal(h.reservations.inspect(target(), "op-latched")?.phase, "failed");
	h.replace(h.owner); gate.resolve();
	const settled = await pending; assert.equal(settled.phase, "failed");
	assert.equal(h.reservations.inspect(target(), "op-latched")?.phase, "failed");
	return { phase: settled.phase, nativeCalls: h.calls.length };
});

await scenario("same-operation retry observes owner loss and cannot revive after the original returns", async () => {
	const h = controlledOwner(), gate = pendingGate(h, "op-retry-latch");
	const pending = h.reservations.reserve(target(), "op-retry-latch"); await ticks();
	const replacement: OwnerPort = { id: "owner-2", async reserveBrowserEvaluation() { throw new Error("replacement must not admit"); } };
	h.replace(replacement);
	const retry = observe(h.reservations.reserve(target(), "op-retry-latch"));
	h.replace(h.owner); gate.resolve();
	const [settled, retried] = await Promise.all([pending, retry.settled()]);
	assert.equal(retried?.ok, true); assert.equal((retried as { value: WorkerBrowserReservationStatus }).value.phase, "failed");
	assert.equal(settled.phase, "failed");
	return { phase: settled.phase, retryPhase: (retried as { value: WorkerBrowserReservationStatus }).value.phase, nativeCalls: h.calls.length };
});

for (const fault of ["throw", "invalid"] as const) await scenario(`pending inspect ${fault} owner read latches failure after restoration`, async () => {
	const h = controlledOwner(), gate = pendingGate(h, `op-read-${fault}`);
	const pending = h.reservations.reserve(target(), `op-read-${fault}`); await ticks();
	h.setReadFault(fault);
	let duringFault: WorkerBrowserReservationStatus | undefined, inspectError: unknown;
	try { duringFault = h.reservations.inspect(target(), `op-read-${fault}`) ?? undefined; } catch (error) { inspectError = error; }
	h.setReadFault(undefined); gate.resolve();
	const settled = await pending; assert.equal(settled.phase, "failed");
	assert.equal(duringFault?.phase, "failed");
	return { fault, phase: settled.phase, inspectError: inspectError instanceof Error ? inspectError.message : undefined };
});

await scenario("replacement and native readiness failure retain failed receipts", async () => {
	const h = controlledOwner(), replacedGate = pendingGate(h, "op-replaced");
	const replaced = h.reservations.reserve(target(), "op-replaced"); await ticks(); h.replace({ id: "owner-2", reserveBrowserEvaluation: async () => { throw new Error("should not run"); } }); replacedGate.resolve();
	const failed = await replaced; assert.equal(failed.phase, "failed"); assert.match(failed.error ?? "", /owner changed|native handle retired/);
	const failure = controlledOwner(); failure.setReserve(async () => { throw new Error("native reservation failure"); });
	const nativeFailed = await failure.reservations.reserve(target(), "op-native-failure"); assert.equal(nativeFailed.phase, "failed"); assert.match(nativeFailed.error ?? "", /native reservation failure/);
	assert.equal(failure.reservations.inspect(target(), "op-native-failure")?.phase, "failed");
	return { replacement: failed.phase, native: nativeFailed.phase };
});

await scenario("failed retained records count toward the 64-operation admission limit", async () => {
	const h = controlledOwner(); h.setReserve(async () => { throw new Error("controlled native failure"); });
	const records = Array.from({ length: 64 }, (_, index) => h.reservations.reserve(target(`tab-${index}`, `target-${index}`), `op-${index}`));
	const settled = await Promise.all(records); assert.equal(settled.filter(row => row.phase === "failed").length, 64);
	await assert.rejects(h.reservations.reserve(target("overflow", "overflow"), "op-overflow"), /receipt limit/);
	return { retainedFailed: settled.length, nativeCalls: h.calls.length };
});

await scenario("pending retained records also consume every admission slot", async () => {
	const h = controlledOwner();
	const operations = Array.from({ length: 64 }, (_, index) => `pending-${index}`);
	const gates = operations.map(operation => pendingGate(h, operation));
	const pending = operations.map((operation, index) => h.reservations.reserve(target(`pending-tab-${index}`, `pending-target-${index}`), operation));
	await assert.rejects(h.reservations.reserve(target("pending-overflow", "pending-overflow"), "pending-overflow"), /receipt limit/);
	for (const gate of gates) gate.resolve(); await Promise.all(pending);
	return { retainedPending: operations.length, nativeCalls: h.calls.length };
});

await scenario("dispose stops admission, joins already-admitted work, and leaves owner disposal external", async () => {
	const h = controlledOwner(), gate = pendingGate(h, "op-dispose");
	const admitted = h.reservations.reserve(target(), "op-dispose"); await ticks();
	const joining = h.reservations.dispose(), ownerDisposal = h.owner.dispose();
	await assert.rejects(h.reservations.reserve(target("later"), "op-later"), /stopping/);
	assert.equal(h.ownerDisposals, 1); gate.resolve(); await Promise.all([admitted, joining, ownerDisposal]);
	return { ownerDisposals: h.ownerDisposals, nativeCalls: h.calls.length };
});

await scenario("actual NativeBrowserOwner keeps reservation cleanup external while receipt and owner dispose overlap", async () => {
	const ready = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>();
	let reserveCalls = 0, disposeCalls = 0, releaseCalls = 0;
	const native: Native = {
		ownerSessionId: "owner-native", name: "original", targetId: "target-1", operationId: "op-native-pending", ready: ready.promise,
		assertCurrent() {}, async dispose() { disposeCalls++; await cleanup.promise; },
	};
	const backend: BrowserOwnerBackend = {
		async create() { throw new Error("create is not used by reservation fixture"); },
		reserveEvaluation(value, operationId) { reserveCalls++; assert.deepEqual(value, { name: "original", targetId: "target-1" }); assert.equal(operationId, "op-native-pending"); return native; },
		async release() { releaseCalls++; },
	};
	const owner = new NativeBrowserOwner({ id: "owner-native", cwd: "/controlled" }, async () => backend);
	const receipt = await owner.reserveBrowserEvaluation({ name: "original", targetId: "target-1" }, "op-native-pending");
	const direct = observe(receipt.dispose({ kill: true })), teardown = observe(owner.dispose()); await ticks();
	assert.equal(direct.result, undefined); assert.equal(teardown.result, undefined); assert.equal(reserveCalls, 1); assert(disposeCalls >= 1);
	cleanup.resolve(); ready.resolve();
	assert.equal((await direct.settled())?.ok, true); assert.equal((await teardown.settled())?.ok, true); assert.equal(releaseCalls, 1);
	return { reserveCalls, disposeCalls, releaseCalls };
});

await scenario("actual NativeBrowserOwner reports readiness failure in status and cleanup failure through disposal", async () => {
	const ready = Promise.withResolvers<void>(); let releaseCalls = 0, disposeCalls = 0;
	const native: Native = {
		ownerSessionId: "owner-native-failure", name: "original", targetId: "target-1", operationId: "op-native-failure", ready: ready.promise,
		assertCurrent() {}, async dispose() { disposeCalls++; throw new Error("reservation cleanup failure"); },
	};
	const backend: BrowserOwnerBackend = {
		async create() { throw new Error("create is not used by reservation fixture"); },
		reserveEvaluation() { return native; }, async release() { releaseCalls++; },
	};
	const owner = new NativeBrowserOwner({ id: "owner-native-failure", cwd: "/controlled" }, async () => backend);
	const receipt = await owner.reserveBrowserEvaluation({ name: "original", targetId: "target-1" }, "op-native-failure");
	ready.reject(new Error("native readiness failure")); await assert.rejects(receipt.ready, /native readiness failure/);
	const disposal = observe(owner.dispose()); const outcome = await disposal.settled();
	assert.equal(outcome?.ok, false); assert(messages((outcome as { error: unknown }).error).includes("reservation cleanup failure"));
	assert.equal(disposeCalls, 1); assert.equal(releaseCalls, 1);
	return { disposeCalls, releaseCalls, errors: messages((outcome as { error: unknown }).error) };
});

await scenario("parent reserve validates exact cloned envelopes and marks lost outcomes unknown", async () => {
	const input = target(); const requests: unknown[] = [];
	const client: ParentClient = { pid, async request(operation) {
		requests.push(structuredClone(operation)); operation.args.target.name = "child-mutation";
		return { ...target(), ownerId: "owner-1", operationId: "op-parent", phase: "ready" };
	} };
	const ready = await requestWorkerBrowserReservation(client, "owner-1", input, "op-parent") as WorkerBrowserReservationStatus;
	assert.equal(input.name, "original"); ready.name = "consumer-mutation";
	assert.equal((requests[0] as ReservationOperation).args.target.name, "original");
	assert.equal(ready.phase, "ready");
	const malformed: ParentClient = { pid, async request() { return { ...target(), ownerId: "owner-1", operationId: "op-parent", phase: "failed" }; } };
	await assert.rejects(requestWorkerBrowserReservation(malformed, "owner-1", target(), "op-parent"), unknown);
	const transport: ParentClient = { pid, async request() { throw new Error("transport lost"); } };
	await assert.rejects(requestWorkerBrowserReservation(transport, "owner-1", target(), "op-parent"), unknown);
	return { request: requests[0], phase: ready.phase };
});

await scenario("parent inspect accepts null only as lookup and does not translate ordinary read errors", async () => {
	let calls = 0;
	const absent: ParentClient = { pid, async request() { calls++; return null; } };
	assert.equal(await requestWorkerBrowserReservation(absent, "owner-1", target(), "op-inspect", true), null);
	const failedRead: ParentClient = { pid, async request() { throw new Error("status read failed"); } };
	await assert.rejects(requestWorkerBrowserReservation(failedRead, "owner-1", target(), "op-inspect", true), error => !unknown(error));
	assert.equal(calls, 1); return { inspectCalls: calls };
});

await scenario("160 concurrent same-operation parent reserves share one wire request and retain child lookup", async () => {
	const gate = Promise.withResolvers<unknown>(), requests: ReservationOperation[] = [];
	let reserveSettled = false;
	const client: ParentClient = { pid, async request(operation) {
		requests.push(structuredClone(operation));
		if (operation.operation === "inspectBrowserEvaluationReservation") return { ...target(), ownerId: "owner-1", operationId: "op-parent-shared", phase: reserveSettled ? "ready" : "pending" };
		const result = await gate.promise; reserveSettled = true; return result;
	} };
	const pending = Array.from({ length: 160 }, () => requestWorkerBrowserReservation(client, "owner-1", target(), "op-parent-shared"));
	await ticks();
	const reserveWireCount = requests.filter(request => request.operation === "reserveBrowserEvaluation").length;
	const heldLookup = await requestWorkerBrowserReservation(client, "owner-1", target(), "op-parent-shared", true);
	assert.equal(heldLookup?.phase, "pending");
	gate.resolve({ ...target(), ownerId: "owner-1", operationId: "op-parent-shared", phase: "ready" });
	const settled = await Promise.all(pending); assert.equal(reserveWireCount, 1); assert.equal(settled.every(status => status?.phase === "ready"), true);
	const lookup = await requestWorkerBrowserReservation(client, "owner-1", target(), "op-parent-shared", true);
	assert.equal(lookup?.phase, "ready");
	assert.equal(requests.filter(request => request.operation === "reserveBrowserEvaluation").length, 1);
	assert.equal(requests.filter(request => request.operation === "inspectBrowserEvaluationReservation").length, 2);
	return { callers: pending.length, reserveWires: 1, heldLookupPhase: heldLookup?.phase, lookupPhase: lookup?.phase };
});

await scenario("distinct pending parent reserves stop at the bound before an overflow wire dispatches", async () => {
	const gates = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>(), requests: ReservationOperation[] = [];
	const client: ParentClient = { pid, async request(operation) {
		requests.push(structuredClone(operation)); const gate = gates.get(operation.args.operationId); assert(gate); return await gate.promise;
	} };
	const operations = Array.from({ length: 64 }, (_, index) => `op-parent-${index}`);
	for (const operation of operations) gates.set(operation, Promise.withResolvers<unknown>());
	const pending = operations.map((operation, index) => requestWorkerBrowserReservation(client, "owner-1", target(`parent-tab-${index}`, `parent-target-${index}`), operation));
	const overflow = await requestWorkerBrowserReservation(client, "owner-1", target("parent-overflow", "parent-overflow"), "op-parent-overflow").then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
	await ticks(); const overflowDispatched = requests.some(request => request.args.operationId === "op-parent-overflow");
	for (const [index, operation] of operations.entries()) gates.get(operation)!.resolve({ ...target(`parent-tab-${index}`, `parent-target-${index}`), ownerId: "owner-1", operationId: operation, phase: "ready" });
	const settled = await Promise.all(pending); assert.match(String(overflow.error), /request limit/); assert.equal(overflowDispatched, false); assert.equal(settled.every(status => status?.phase === "ready"), true);
	return { admitted: settled.length, dispatched: requests.length, overflowDispatched: false };
});

console.log(JSON.stringify({
	sourcePath, source: { sha256: hash, bytes: Buffer.byteLength(source) }, counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence,
	limits: "Controlled actual reservation module with injected NativeBrowserOwner-compatible owner and parent client. No SDK/default native loader, child process, IPC runtime, browser, Worker, or physical owner cleanup executes. Owner dispose is a controlled concurrent invocation; the fixture does not claim resource destruction semantics.",
}, null, 2));
if (failures.length) process.exitCode = 1;
