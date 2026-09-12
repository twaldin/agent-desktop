/** Controlled reservation lifecycle for selected TabSupervisor bodies; no native browser or Worker starts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const sourcePath = process.argv[2] ?? ".data/browser-evaluation-reservation-2026-09-11/native-source/native/src/tools/browser/tab-supervisor.ts";
const source = await readFile(sourcePath, "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function selected(from: string, until: string) {
	const start = source.indexOf(from), end = source.indexOf(until, start);
	assert(start >= 0 && end > start, `Missing selected body: ${from}`);
	return source.slice(start, end);
}
const compile = (value: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(value.replace(/^export /gm, ""));
const reservation = selected("export const BROWSER_TAB_EVALUATION_RESERVATION_VERSION", "export function getTab(");
const toolDrain = selected("interface TabToolWork", "/** One cleanup per native object");
const cleanup = selected("const tabCleanups = new WeakMap", "export const BROWSER_TAB_OWNER_CLOSE_VERSION");
const releaseSession = selected("async function releaseTabSession(", "async function releaseMatchingTabs(");

class ToolError extends Error { override name = "ToolError"; }
class ToolAbortError extends Error { override name = "ToolAbortError"; }
class BrowserActionRejected extends ToolError { override name = "BrowserActionRejected"; }
const ticks = async () => { for (let turn = 0; turn < 48; turn++) await Promise.resolve(); };
function observe(promise: Promise<unknown>) {
	let result: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
	void promise.then(value => { result = { ok: true, value }; }, error => { result = { ok: false, error }; });
	return { get result() { return result; }, async settled() { await ticks(); return result; } };
}
function messages(error: unknown): string[] {
	return error instanceof AggregateError ? error.errors.flatMap(messages) : [error instanceof Error ? error.message : String(error)];
}

function harness(backend: "worker" | "cmux" = "worker") {
	const tabs = new Map<string, any>();
	const tabObservations = new WeakMap<object, { assertCurrent(): void }>();
	const tabObservationReads = new Map<object, Promise<void>>();
	const viewportCaptures = new Map<string, Promise<void>>();
	const humanActions = new Map<string, Promise<void>>();
	const acquireChains = new Map<string, Promise<void>>();
	const actions: string[] = [], releasePolicies: unknown[] = [];
	const cmuxGate = Promise.withResolvers<void>();
	let sourceCurrent = true, releases = 0, holds = 0, onHold: (() => void) | undefined;
	const api = new Function(
		"ToolError", "ToolAbortError", "BrowserActionRejected", "tabs", "tabObservations", "tabObservationReads", "viewportCaptures", "humanActions", "acquireChains",
		"holdBrowser", "releaseBrowser", "drainCmuxRun", "releaseTabSession", "originalCmuxTabSource",
		`${compile(reservation)}\n${compile(toolDrain)}\n${compile(cleanup)}\nreturn { reserveTabEvaluationForOwner, assertTabNotReserved, trackTabTool, cleanupTab, setTabRun: (tab, run) => tabRuns.set(tab, new Set([run])) };`,
	)(
		ToolError, ToolAbortError, BrowserActionRejected, tabs, tabObservations, tabObservationReads, viewportCaptures, humanActions, acquireChains,
		() => { holds++; actions.push("hold"); onHold?.(); },
		async (_browser: unknown, policy: unknown) => { releases++; releasePolicies.push(policy); actions.push("release-browser"); },
		async () => { actions.push("drain-cmux"); await cmuxGate.promise; },
		async (tab: any) => { tab.state = "dead"; actions.push("release-resource"); },
		() => {},
	) as {
		reserveTabEvaluationForOwner(owner: string, target: { name: string; targetId: string }, operation: string): any;
		assertTabNotReserved(name: string, humanAction?: boolean): void;
		trackTabTool(tab: any, ctrl: AbortController, run: () => Promise<void>): Promise<void>;
		cleanupTab(tab: any, run: () => Promise<void>, ownerRelease?: boolean): Promise<void>;
		setTabRun(tab: any, run: Promise<void>): void;
	};
	const workerGate = Promise.withResolvers<void>();
	const worker = {
		assertActive() { if (!sourceCurrent) throw new ToolError("worker changed"); },
		send(message: unknown) { actions.push(`send:${(message as { type: string }).type}`); },
		terminate() { actions.push("terminate-worker"); return workerGate.promise; },
	};
	const tab: any = {
		name: "original", targetId: "target-1", ownerSessionId: "owner-1", state: "alive",
		browser: { kind: "controlled" }, backend, kindTag: backend === "worker" ? "headless" : "cmux", worker, cmuxTab: {},
		connectionOwner: { assertCurrent() { if (!sourceCurrent) throw new ToolError("connection changed"); } },
		pending: new Map(),
	};
	tabs.set(tab.name, tab);
	tabObservations.set(tab, { assertCurrent() { if (!sourceCurrent) throw new ToolError("observation changed"); } });
	return {
		api, tab, actions, workerGate, cmuxGate,
		setRead(promise: Promise<void>) { tabObservationReads.set(tab, promise); },
		setViewport(promise: Promise<void>) { viewportCaptures.set("owner-1\0original\0target-1", promise); },
		setHuman(promise: Promise<void>) { humanActions.set("original", promise); },
		setRun(promise: Promise<void>) { api.setTabRun(tab, promise); },
		setOnHold(value: () => void) { onHold = value; },
		invalidate() { sourceCurrent = false; },
		get releases() { return releases; }, get holds() { return holds; }, get releasePolicies() { return releasePolicies; },
	};
}

function releaseHarness(kindTag: "headless" | "connected" | "spawned" | "relay") {
	const tabs = new Map<string, any>(), tabObservations = new WeakMap<object, { assertCurrent(): void }>();
	const tabObservationReads = new Map<object, Promise<void>>(), viewportCaptures = new Map<string, Promise<void>>(), humanActions = new Map<string, Promise<void>>();
	const acquireChains = new Map<string, Promise<void>>(), tabCleanups = new WeakMap<object, Promise<void>>();
	const releases: unknown[] = [], closes: string[] = [];
	const api = new Function(
		"ToolError", "ToolAbortError", "BrowserActionRejected", "tabs", "tabObservations", "tabObservationReads", "viewportCaptures", "humanActions", "acquireChains", "tabCleanups",
		"holdBrowser", "releaseBrowser", "drainTabTools", "drainCmuxRun", "postmortem", "waitForClosed", "closeUnpublishedWorkerTargets", "waitForTabCleanup", "closeOrphanTarget", "sharedScopeOf", "forgetSharedTarget", "DEFAULT_TAB_CLOSE_TIMEOUT_MS",
		`${compile(reservation)}\n${compile(releaseSession)}\nreturn { reserveTabEvaluationForOwner, releaseTabSession };`,
	)(
		ToolError, ToolAbortError, BrowserActionRejected, tabs, tabObservations, tabObservationReads, viewportCaptures, humanActions, acquireChains, tabCleanups,
		() => {}, async (_browser: unknown, policy: unknown) => { releases.push(policy); }, async () => {}, async () => {},
		{ markExpectedCleanupError(error: Error) { return error; } }, async () => {}, async () => {}, async () => {}, async () => {}, () => undefined, () => {}, 30,
	) as { reserveTabEvaluationForOwner(owner: string, target: { name: string; targetId: string }, operation: string): any; releaseTabSession(tab: any, opts: { kill: boolean }): Promise<void> };
	const worker = { assertActive() {}, send() {}, terminate: async () => {} };
	const tab: any = {
		name: `original-${kindTag}`, targetId: `target-${kindTag}`, ownerSessionId: "owner-1", state: "alive", browser: { kind: "controlled" }, backend: "worker", kindTag, worker,
		connectionOwner: { assertCurrent() {}, async closeTarget(targetId: string) { closes.push(targetId); } }, pending: new Map(),
	};
	tabs.set(tab.name, tab); tabObservations.set(tab, { assertCurrent() {} });
	return { api, tab, releases, closes };
}

const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: unknown[] = [];
async function scenario(name: string, run: () => Promise<unknown>) {
	try { evidence.push({ name, value: await run() }); passed.push(name); }
	catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}

await scenario("same operation is synchronously idempotent and competing admission is fenced", async () => {
	const h = harness(), first = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-1");
	const repeated = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-1");
	assert.equal(repeated, first);
	assert.throws(() => h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-2"), /another reservation/);
	assert.throws(() => h.api.assertTabNotReserved("original"), /reserved/);
	h.workerGate.resolve(); await first.ready;
	assert.equal(h.holds, 1); return { sameObject: repeated === first, holds: h.holds };
});

await scenario("hold callback reentry receives the published reservation and later tool dispatch is barred", async () => {
	const h = harness(); let reentered: unknown;
	h.setOnHold(() => { reentered = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-reentry"); });
	const reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-reentry");
	let dispatched = false; const tool = await h.api.trackTabTool(h.tab, new AbortController(), async () => { dispatched = true; });
	assert.equal(reentered, reservation); assert.equal(dispatched, false); await tool;
	h.workerGate.resolve(); await reservation.ready;
	return { sameReservationDuringHold: reentered === reservation, dispatched };
});

await scenario("expected queued human cancellation is ignored by ready while callers still reject", async () => {
	const h = harness(), queued = Promise.withResolvers<void>(); h.setHuman(queued.promise);
	const reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-human-cancel");
	let cancellation: unknown; try { h.api.assertTabNotReserved("original", true); } catch (error) { cancellation = error; queued.reject(error); }
	assert(cancellation instanceof BrowserActionRejected); h.workerGate.resolve(); await reservation.ready;
	return { callerRejected: cancellation instanceof BrowserActionRejected };
});

await scenario("an unmarked human-action failure still fails ready", async () => {
	const h = harness(), queued = Promise.withResolvers<void>(); h.setHuman(queued.promise);
	const reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-human-failure");
	queued.reject(new BrowserActionRejected("human action failed")); h.workerGate.resolve();
	const outcome = await observe(reservation.ready).settled(); assert.equal(outcome?.ok, false);
	assert(messages((outcome as { error: unknown }).error).includes("human action failed"));
	return { errors: messages((outcome as { error: unknown }).error) };
});

await scenario("quiescence waits for worker, tool, observation, viewport, human action and run drains", async () => {
	const h = harness(), read = Promise.withResolvers<void>(), viewport = Promise.withResolvers<void>(), human = Promise.withResolvers<void>(), run = Promise.withResolvers<void>(), tool = Promise.withResolvers<void>();
	h.setRead(read.promise); h.setViewport(viewport.promise); h.setHuman(human.promise); h.setRun(run.promise);
	const ctrl = new AbortController(); h.api.trackTabTool(h.tab, ctrl, () => tool.promise);
	const reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-drain");
	await ticks(); const before = observe(reservation.ready); await ticks();
	const pendingBeforeSettle = before.result === undefined;
	assert.equal(pendingBeforeSettle, true); assert.equal(ctrl.signal.aborted, true); assert.equal(h.releases, 0);
	read.resolve(); viewport.resolve(); human.resolve(); run.resolve(); tool.resolve(); h.workerGate.resolve();
	assert.equal((await before.settled())?.ok, true); assert.equal(h.actions.includes("terminate-worker"), true);
	return { pendingBeforeSettle, abortedTool: ctrl.signal.aborted, actions: h.actions };
});

await scenario("independent drain failure is retained after every held resource settles", async () => {
	const h = harness(), read = Promise.withResolvers<void>(), viewport = Promise.withResolvers<void>(), human = Promise.withResolvers<void>();
	h.setRead(read.promise); h.setViewport(viewport.promise); h.setHuman(human.promise);
	const reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-errors");
	const ready = observe(reservation.ready); read.reject(new Error("read failure")); viewport.resolve(); human.resolve(); h.workerGate.resolve();
	const outcome = await ready.settled(); assert.equal(outcome?.ok, false); assert(messages((outcome as { error: unknown }).error).includes("read failure"));
	assert.equal(h.actions.includes("terminate-worker"), true); return { errors: messages((outcome as { error: unknown }).error), actions: h.actions };
});

await scenario("source identity loss rejects the quiescence receipt", async () => {
	const h = harness(), reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-identity");
	h.invalidate(); h.workerGate.resolve(); const outcome = await observe(reservation.ready).settled();
	assert.equal(outcome?.ok, false); assert(messages((outcome as { error: unknown }).error).some(message => /source changed|connection changed|observation changed/.test(message)));
	return { errors: messages((outcome as { error: unknown }).error), released: h.releases };
});

await scenario("dispose during quiescence delays destructive release until every reservation drain settles", async () => {
	const h = harness(), read = Promise.withResolvers<void>(); h.setRead(read.promise);
	const reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-dispose");
	const disposal = observe(reservation.dispose({ kill: true })); await ticks();
	assert.equal(h.releases, 0); assert.equal(h.actions.includes("release-resource"), false);
	read.resolve(); h.workerGate.resolve(); const outcome = await disposal.settled();
	assert.equal(h.actions.includes("release-resource"), true); assert.equal(h.releases, 1);
	assert.equal(outcome?.ok, true);
	assert.throws(() => reservation.assertCurrent(), /retired/);
	assert.deepEqual(h.releasePolicies, [{ kill: true }]);
	return { pendingBeforeRelease: true, disposalCompleted: outcome?.ok, releasePolicies: h.releasePolicies, actions: h.actions };
});

await scenario("owner cleanup revokes a ready reservation and keeps the name unavailable after failed destruction", async () => {
	const h = harness(), reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-owner-release");
	h.workerGate.resolve(); await reservation.ready;
	const cleanup = await observe(h.api.cleanupTab(h.tab, async () => { throw new Error("resource close failed"); }, true)).settled();
	assert.equal(cleanup?.ok, false); assert(messages((cleanup as { error: unknown }).error).includes("resource close failed"));
	assert.throws(() => reservation.assertCurrent(), /retired/);
	assert.throws(() => h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-owner-release"), /another reservation|not available/);
	return { actions: h.actions, releases: h.releases };
});

await scenario("owner kill policy reaches the final reservation hold release", async () => {
	const h = harness(), reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-kill");
	h.workerGate.resolve(); await reservation.ready; await reservation.dispose({ kill: true });
	assert.deepEqual(h.releasePolicies, [{ kill: true }]);
	return { finalHoldRelease: h.releasePolicies };
});

await scenario("cmux reservation joins its captured backend drain without worker or surface cleanup", async () => {
	const h = harness("cmux"), value = h.api.reserveTabEvaluationForOwner("owner-1", { name: "original", targetId: "target-1" }, "op-cmux");
	const ready = observe(value.ready); await ticks();
	assert.equal(ready.result, undefined); assert.deepEqual(h.actions, ["hold", "drain-cmux"]);
	h.cmuxGate.resolve(); assert.equal((await ready.settled())?.ok, true);
	assert.equal(h.releases, 0); return { actions: h.actions, released: h.releases };
});

for (const kindTag of ["headless", "connected", "spawned", "relay"] as const) await scenario(`actual release preserves original ${kindTag} target disposition after evaluator retirement`, async () => {
	const h = releaseHarness(kindTag), reservation = h.api.reserveTabEvaluationForOwner("owner-1", { name: h.tab.name, targetId: h.tab.targetId }, `op-release-${kindTag}`);
	await reservation.ready;
	await h.api.releaseTabSession(h.tab, { kill: true });
	assert.deepEqual(h.closes, kindTag === "headless" ? [h.tab.targetId] : []);
	assert.equal((h.releases[0] as { kill?: boolean } | undefined)?.kill, true);
	return { kindTag, targetCloseCalls: h.closes, finalReleasePolicy: h.releases[0] };
});

console.log(JSON.stringify({
	sourcePath, sources: { sha256: hash(source), bytes: Buffer.byteLength(source) },
	selected: { reservation: hash(reservation), trackedToolDrain: hash(toolDrain), cleanup: hash(cleanup), releaseTabSession: hash(releaseSession) },
	counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence,
	limits: "Controlled extracted TabSupervisor reservation, tracked-tool drain, cleanup, and release bodies with stubbed browser/resource release, observation, viewport, human-action, run, and worker boundaries. The queued-human cancellation cases call the actual reservation guard and model a promise already admitted by the human-action entry point; they do not execute the full Puppeteer pre-dispatch body. No native Worker, browser, SDK, IPC, session service, parent lease, or physical target runs. Microtask turns observe controlled promise ordering only.",
}, null, 2));
if (failures.length) process.exitCode = 1;
