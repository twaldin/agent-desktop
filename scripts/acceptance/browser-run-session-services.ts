/**
 * Controlled acceptance for browser run services. It reads a selected native
 * source tree and compiles only the production functions under test with
 * substitutes for transports, workers and the JS runtime. It never imports or
 * starts the native package, SDK, browser, or worker process.
 *
 * Usage: bun scripts/acceptance/browser-run-session-services.ts \
 *   --native-root /absolute/native --dependency-root /absolute/baseline-native --out /empty/result-directory
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

type Source = { path: string; text: string; sha256: string; bytes: number };
type Failure = { name: string; error: string };

function argumentsFor(argv: string[]) {
	let nativeRoot: string | undefined;
	let out: string | undefined;
	let dependencyRoot: string | undefined;
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index], value = argv[index + 1];
		if (!value || (flag !== "--native-root" && flag !== "--out" && flag !== "--dependency-root")) {
			throw new Error("Usage: browser-run-session-services.ts --native-root <absolute native root> --out <empty directory>");
		}
		if (flag === "--native-root") nativeRoot = value;
		else if (flag === "--dependency-root") dependencyRoot = value;
		else out = value;
	}
	if (!nativeRoot || !dependencyRoot || !out || !path.isAbsolute(nativeRoot) || !path.isAbsolute(dependencyRoot) || !path.isAbsolute(out)) {
		throw new Error("--native-root, --dependency-root, and --out must be absolute paths");
	}
	return { nativeRoot, dependencyRoot, out };
}

function section(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from);
	if (from < 0 || to < 0) throw new Error(`Selected production section is missing: ${start}`);
	return source.slice(from, to);
}

function compile(source: string): string {
	return new Bun.Transpiler({ loader: "ts" }).transformSync(
		source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export type \{[^;]+;\r?\n/gm, "").replace(/^export /gm, ""),
	);
}

function toolErrorPayload(error: unknown) {
	const value = error instanceof Error ? error : new Error(String(error));
	return { name: value.name, message: value.message, isToolError: value.name === "ToolError", isAbort: false };
}

const { nativeRoot, dependencyRoot, out } = argumentsFor(process.argv.slice(2));
if ((await readdir(out).catch(error => error && (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error))).length > 0) {
	throw new Error(`Refusing to overwrite nonempty output directory: ${out}`);
}
await mkdir(out, { recursive: true });

const relativePaths = [
	"src/tools/browser/run-context.ts",
	"src/tools/browser/tab-supervisor.ts",
	"src/tools/browser/cmux/cmux-tab.ts",
	"dist/types/tools/browser/run-context.d.ts",
	"dist/types/tools/browser/tab-supervisor.d.ts",
	"dist/types/tools/browser/cmux/cmux-tab.d.ts",
];
const dependencyPaths = ["src/eval/js/tool-bridge.ts", "src/eval/js/shared/prelude.ts", "src/eval/js/shared/prelude.txt"];
const sources: Record<string, Source> = {};
for (const relative of relativePaths) {
	const file = path.join(nativeRoot, relative);
	const text = await readFile(file, "utf8");
	sources[relative] = { path: file, text, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
}
for (const relative of dependencyPaths) {
	const file = path.join(dependencyRoot, relative);
	const text = await readFile(file, "utf8");
	sources[`dependency:${relative}`] = { path: file, text, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
}

const passed: string[] = [];
const failures: Failure[] = [];
const evidence: Array<{ name: string; detail: unknown }> = [];
async function scenario(name: string, body: () => Promise<unknown> | unknown): Promise<void> {
	try {
		const detail = await body();
		passed.push(name);
		evidence.push({ name, detail });
	} catch (error) {
		failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) });
	}
}

await scenario("selected tool bridge and JavaScript prelude invoke the current session tool path", async () => {
	const bridgeSource = sources["dependency:src/eval/js/tool-bridge.ts"]!.text;
	class ToolError extends Error { override name = "ToolError"; }
	const preludeCalls: Array<{ name: string; parameters: unknown; session: unknown; signal: AbortSignal | undefined; context: unknown }> = [];
	const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
	const callSessionTool = new Function(
		"isRecord", "INTENT_FIELD", "ToolError", "invokeEvalPrelude", "EVAL_AGENT_BRIDGE_NAME", "runEvalAgent", "EVAL_BUDGET_BRIDGE_NAME", "runEvalBudget", "EVAL_COMPLETION_BRIDGE_NAME", "runEvalCompletion", "EVAL_CANCEL_BRIDGE_NAME", "EVAL_STATUS_BRIDGE_NAME", "EVAL_WAIT_BRIDGE_NAME", "runEvalCancel", "runEvalStatus", "runEvalWait", "EVAL_WORKPOOL_BRIDGE_NAME", "runEvalWorkpool",
		[compile(bridgeSource), "return callSessionTool;"].join("\n"),
	)(isRecord, "__intent", ToolError, async (name: string, parameters: unknown, options: any) => {
		preludeCalls.push({ name, parameters, session: options.session, signal: options.signal, context: options.context });
		return { content: [{ type: "text", text: "nested-prelude-value" }] };
	}, "agent", async () => null, "budget", async () => null, "completion", async () => null, "cancel", "status", "wait", async () => null, () => null, async () => null, "workpool", async () => null) as (name: string, args: unknown, options: any) => Promise<unknown>;
	const executions: Array<{ id: string; args: unknown; signal: AbortSignal | undefined; context: unknown }> = [];
	const statuses: unknown[] = [];
	const session = {
		getToolForEvalBridge(name: string) {
			assert.equal(name, "named_scope");
			return { async execute(id: string, args: unknown, signal?: AbortSignal, _progress?: unknown, context?: unknown) {
				executions.push({ id, args, signal, context });
				return { content: [{ type: "text", text: "bridge-value" }] };
			} };
		},
		getToolByName() { throw new Error("must not fall back from the current eval bridge path"); },
		getToolContext: () => ({ current: "session-a" }),
	};
	const signal = AbortSignal.timeout(1_000);
	const options = { session, signal, emitStatus: (event: unknown) => statuses.push(event) };
	assert.equal(await callSessionTool("named_scope", { exact: true }, options), "bridge-value");
	assert.deepEqual(executions[0], { id: executions[0]!.id, args: { exact: true, __intent: "js prelude" }, signal, context: { current: "session-a" } });
	assert.match(executions[0]!.id, /^js-named_scope-/);
	assert.equal(await callSessionTool("__prelude__", { name: "nested", parameters: { exact: true } }, options), "nested-prelude-value");
	assert.deepEqual(preludeCalls, [{ name: "nested", parameters: { exact: true }, session, signal, context: { current: "session-a" } }]);
	const blocked = { getToolForEvalBridge() { throw new ToolError("blocked by current session"); } };
	await assert.rejects(() => callSessionTool("named_scope", {}, { session: blocked, signal }), /blocked by current session/);

	const globalKeys = ["__omp_js_prelude_loaded__", "__omp_helpers__", "__omp_emit_status__", "__omp_call_tool__", "__omp_log__", "__omp_table__", "tool", "console", "print", "display", "completion", "output", "agent", "wait", "AgentHandle", "CompletionHandle", "workpool", "WorkPool", "log", "phase", "budget", "read", "write", "env"] as const;
	const previous = new Map(globalKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	try {
		Object.assign(globalThis, {
			__omp_js_prelude_loaded__: false,
			__omp_helpers__: {},
			__omp_emit_status__: () => {},
			__omp_call_tool__: (name: string, args: unknown) => callSessionTool(name, args, options),
			__omp_log__: () => {},
			__omp_table__: () => {},
		});
		new Function(sources["dependency:src/eval/js/shared/prelude.txt"]!.text)();
		assert.equal(await (globalThis as any).tool.named_scope({ from: "prelude" }), "bridge-value");
		assert.deepEqual(executions[1]!.args, { from: "prelude", __intent: "js prelude" });
	} finally {
		for (const key of globalKeys) {
			const descriptor = previous.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as any)[key];
		}
	}
	return { bridgeExecutions: executions.length, statusEvents: statuses.length };
});

await scenario("actual run context snapshots once and calls the originating session bridge", async () => {
	const calls: Array<{ name: string; args: unknown; session: unknown; signal: AbortSignal | undefined; status: unknown }> = [];
	let reads = 0;
	const createBrowserRunContext = new Function("callSessionTool", "webpExclusionForModel", "expandPath",
		[compile(sources["src/tools/browser/run-context.ts"]!.text), "return createBrowserRunContext;"].join("\n"),
	)(
		(name: string, args: unknown, options: { session: unknown; signal?: AbortSignal; emitStatus?: unknown }) => {
			calls.push({ name, args, session: options.session, signal: options.signal, status: options.emitStatus });
			return Promise.resolve({ from: name });
		},
		(model: unknown) => model === "model-a",
		(value: string) => `/expanded/${value}`,
	) as (session: any) => { snapshot: Readonly<Record<string, unknown>>; callTool?: (name: string, args: unknown, signal?: AbortSignal, emitStatus?: unknown) => Promise<unknown> };
	const session = { cwd: "/worktree-a", settings: { get(key: string) { assert.equal(key, "browser.screenshotDir"); reads++; return "shots"; } }, getActiveModel: () => "model-a" };
	const status = () => {};
	const context = createBrowserRunContext(session);
	const signal = AbortSignal.timeout(1_000);
	assert.deepEqual(context.snapshot, { cwd: "/worktree-a", browserScreenshotDir: "/expanded/shots", excludeWebP: true });
	assert.equal(reads, 1);
	assert.deepEqual(await context.callTool?.("named.scope", { exact: true }, signal, status), { from: "named.scope" });
	assert.deepEqual(calls, [{ name: "named.scope", args: { exact: true }, session, signal, status: calls[0]!.status }]);
	assert.equal(typeof calls[0]!.status, "function");
	return { snapshot: context.snapshot, bridgeCalls: calls.length };
});

await scenario("actual worker dispatcher uses only the active run context and preserves reply values/errors/signals", async () => {
	const supervisor = sources["src/tools/browser/tab-supervisor.ts"]!.text;
	const dispatcher = section(supervisor, "async function dispatchToolCall(", "function safeSend(");
	class ToolError extends Error { override name = "ToolError"; }
	const dispatchToolCall = new Function("ToolError", "toErrorPayload",
		[compile(dispatcher), "function safeSend(tab, msg) { tab.worker.send(msg); }", "return dispatchToolCall;"].join("\n"),
	)(ToolError, toolErrorPayload) as (tab: any, message: any) => Promise<void>;
	const signals: AbortSignal[] = [];
	const replies: unknown[] = [];
	const context = {
		snapshot: { cwd: "/worktree-a", browserScreenshotDir: "/shots", excludeWebP: false },
		callTool: async (name: string, args: unknown, signal?: AbortSignal) => {
			signals.push(signal!);
			if (name === "rejected") throw new ToolError("preserved failure");
			return { name, args, owner: "session-a" };
		},
	};
	const pending = { context, signal: undefined, toolCalls: new Map() };
	const tab = { state: "alive", pending: new Map<string, any>([["run-a", pending]]), worker: { send(value: unknown) { replies.push(value); } } };
	await dispatchToolCall(tab, { type: "tool-call", runId: "run-a", id: "one", name: "named.scope", args: { exact: true } });
	assert.deepEqual(replies[0], { type: "tool-reply", id: "one", reply: { ok: true, value: { name: "named.scope", args: { exact: true }, owner: "session-a" } } });
	assert.equal(signals.length, 1);
	assert.equal(pending.toolCalls.size, 0);
	await dispatchToolCall(tab, { type: "tool-call", runId: "run-a", id: "two", name: "rejected", args: null });
	assert.deepEqual(replies[1], { type: "tool-reply", id: "two", reply: { ok: false, error: { name: "ToolError", message: "preserved failure", isToolError: true, isAbort: false } } });
	await dispatchToolCall({ state: "alive", pending: new Map(), worker: { send(value: unknown) { replies.push(value); } } }, { type: "tool-call", runId: "missing", id: "three", name: "forbidden", args: null });
	assert.match(JSON.stringify(replies[2]), /No active run for tool call/);
	const noAuthority = { context: { snapshot: { cwd: "/internal" } }, signal: undefined, toolCalls: new Map() };
	tab.pending.set("run-no-authority", noAuthority);
	await dispatchToolCall(tab, { type: "tool-call", runId: "run-no-authority", id: "four", name: "forbidden", args: null });
	assert.match(JSON.stringify(replies[3]), /No active run for tool call/);
	return { replyCount: replies.length, bridgeSignals: signals.length };
});

await scenario("public supervisor wrapper retains its session API and creates a run context", async () => {
	const supervisor = sources["src/tools/browser/tab-supervisor.ts"]!.text;
	const wrapper = section(supervisor, "export async function runInTab(", "async function runInTabWithContext(");
	const calls: unknown[] = [];
	const runInTab = new Function("createBrowserRunContext", "calls",
		[compile(wrapper), "async function runInTabWithContext(name, opts, context) { calls.push({ name, opts, context }); return \"wrapped\"; }", "return runInTab;"].join("\n"),
	)(
		(session: unknown) => ({ snapshot: { cwd: (session as any).cwd }, callTool: async () => session }), calls,
	) as (name: string, options: unknown) => Promise<unknown>;
	const session = { cwd: "/caller" };
	assert.equal(await runInTab("selected", { code: "code", timeoutMs: 1, signal: undefined, session }), "wrapped");
	assert.equal(calls.length, 1);
	assert.deepEqual((calls[0] as any).opts, { code: "code", timeoutMs: 1, signal: undefined });
	assert.deepEqual((calls[0] as any).context.snapshot, { cwd: "/caller" });
	assert.equal(typeof (calls[0] as any).context.callTool, "function");
	return { wrapperCalls: calls.length };
});

await scenario("actual supervisor run body keeps each tab context without reacquiring or rekeying its owner", async () => {
	const supervisor = sources["src/tools/browser/tab-supervisor.ts"]!.text;
	const runner = section(supervisor, "async function runInTabWithContext(", "/** One cleanup per native object");
	class ToolError extends Error { override name = "ToolError"; }
	class RecoverableWorkerError extends Error {}
	const tabs = new Map<string, any>();
	const workerMessages: unknown[] = [];
	const cmuxOptions: unknown[] = [];
	const runInTabWithContext = new Function("ToolError", "RecoverableWorkerError", "humanActions", "tabs", "killedTabs", "Snowflake", "AbortSignal", "runCmuxCodeWithContext", "raceWithTimeout", "GRACE_MS", "forceKillTab", "recycleTimedOutWorkerTab",
		[compile(runner), "return runInTabWithContext;"].join("\n"),
	)(ToolError, RecoverableWorkerError, new Set(), tabs, new Map(), { next: () => "controlled-run" }, AbortSignal,
		async (_tab: unknown, options: unknown, context: unknown) => { cmuxOptions.push(options, context); return { displays: [], returnValue: "cmux", screenshots: [] }; },
		async (value: Promise<unknown>) => await value, 1, async () => {}, async () => {}) as (name: string, opts: any, context: any) => Promise<unknown>;
	const contextA = { snapshot: { cwd: "/worktree-a", browserScreenshotDir: "/shots-a", excludeWebP: false }, callTool: async () => "a" };
	const contextB = { snapshot: { cwd: "/worktree-b", browserScreenshotDir: "/shots-b", excludeWebP: true }, callTool: async () => "b" };
	const worker = { send(message: any) { workerMessages.push(message); if (message.type === "run") tabs.get("worker")!.pending.get("controlled-run")!.resolve({ displays: [], returnValue: "worker", screenshots: [] }); }, mode: "worker" };
	tabs.set("worker", { state: "alive", backend: "worker", pending: new Map(), worker, ownerSessionId: "original-owner-a" });
	tabs.set("cmux", { state: "alive", backend: "cmux", pending: new Map(), cmuxTab: {}, ownerSessionId: "original-owner-b" });
	const [workerResult, cmuxResult] = await Promise.all([
		runInTabWithContext("worker", { code: "worker", timeoutMs: 10 }, contextA),
		runInTabWithContext("cmux", { code: "cmux", timeoutMs: 10 }, contextB),
	]);
	assert.deepEqual(workerResult, { displays: [], returnValue: "worker", screenshots: [] });
	assert.deepEqual(cmuxResult, { displays: [], returnValue: "cmux", screenshots: [] });
	assert.deepEqual(workerMessages, [{ type: "run", id: "controlled-run", name: "worker", code: "worker", timeoutMs: 10, session: contextA.snapshot }]);
	assert.deepEqual({ code: (cmuxOptions[0] as any).code, timeoutMs: (cmuxOptions[0] as any).timeoutMs }, { code: "cmux", timeoutMs: 10 });
	assert.equal(typeof (cmuxOptions[0] as any).signal?.aborted, "boolean");
	assert.equal((cmuxOptions as any)[1], contextB);
	assert.equal(tabs.get("worker")!.ownerSessionId, "original-owner-a");
	assert.equal(tabs.get("cmux")!.ownerSessionId, "original-owner-b");
	// Internal supervisor callers receive snapshot-only context; their worker run
	// remains usable but cannot gain a session tool callback.
	tabs.set("internal", { state: "alive", backend: "worker", pending: new Map(), ownerSessionId: "original-owner-internal", worker: { mode: "worker", send(message: any) { if (message.type === "run") tabs.get("internal")!.pending.get("controlled-run")!.resolve({ displays: [], returnValue: "internal", screenshots: [] }); } } });
	assert.deepEqual(await runInTabWithContext("internal", { code: "internal", timeoutMs: 10 }, { snapshot: { cwd: "/project" } }), { displays: [], returnValue: "internal", screenshots: [] });
	return { workerSession: workerMessages[0], cmuxContextShared: cmuxOptions[1] === contextB, internalSnapshotOnly: true };
});

await scenario("public cmux wrapper keeps its session/snapshot API and creates one run context", async () => {
	const cmux = sources["src/tools/browser/cmux/cmux-tab.ts"]!.text;
	const wrapper = section(cmux, "export async function runCmuxCode(", "export async function runCmuxCodeWithContext(");
	const calls: unknown[] = [];
	const runCmuxCode = new Function("createBrowserRunContext", "calls",
		[compile(wrapper), "async function runCmuxCodeWithContext(tab, opts, context) { calls.push({ tab, opts, context }); return \"wrapped\"; }", "return runCmuxCode;"].join("\n"),
	)(
		(session: unknown, snapshot: unknown) => ({ snapshot, callTool: async () => ({ session }) }), calls,
	) as (tab: unknown, options: unknown) => Promise<unknown>;
	const session = { cwd: "/caller" }, snapshot = { cwd: "/frozen", excludeWebP: false };
	assert.equal(await runCmuxCode("tab", { code: "code", timeoutMs: 1, session, snapshot }), "wrapped");
	assert.equal(calls.length, 1);
	assert.equal((calls[0] as any).tab, "tab");
	assert.deepEqual((calls[0] as any).opts, { code: "code", timeoutMs: 1, session, snapshot });
	assert.equal((calls[0] as any).context.snapshot, snapshot);
	assert.equal(typeof (calls[0] as any).context.callTool, "function");
	return { wrapperCalls: calls.length };
});

await scenario("actual cmux context run body forwards its exact bridge and combined run signal", async () => {
	const cmux = sources["src/tools/browser/cmux/cmux-tab.ts"]!.text;
	const run = section(cmux, "export async function runCmuxCodeWithContext(", "function numberFrom(");
	class ToolError extends Error { override name = "ToolError"; }
	class ToolAbortError extends Error {}
	const calls: Array<{ name: string; args: unknown; signal?: AbortSignal }> = [];
	let hooks: any;
	const runtime = { setCwd() {}, setRunScope() {}, async run(_code: string, _filename: string, supplied: any) { hooks = supplied; return await supplied.callTool("named.cmux", { exact: true }); } };
	const tab = { setRunContext(value: unknown) { (tab as any).context = value; }, clearRunContext() { (tab as any).cleared = true; }, ensureRuntime() { return runtime; }, page: {}, browser: {} };
	const context = { snapshot: { cwd: "/worktree-c", browserScreenshotDir: "/shots-c", excludeWebP: false }, callTool: async (name: string, args: unknown, signal?: AbortSignal) => { calls.push({ name, args, signal }); return "cmux-value"; } };
	const runCmuxCodeWithContext = new Function("ToolError", "ToolAbortError", "postmortem", "logger", "RunOutput", "cloneSafe", "throwIfAborted", "bindRunFacade", "waitForRun", "withBrowserPromiseCombinatorTracking", "resolvePredicateTimeout", "isBrowserRunOwnedRejection", "markBrowserRunRejection", "observeBrowserRunPromise", "Bun", "crypto", "activeCmuxRuns", "rememberCmuxRunFile", "AbortSignal",
		[compile(run), "return runCmuxCodeWithContext;"].join("\n"),
	)(ToolError, ToolAbortError, { markExpectedCleanupError: (error: unknown) => error, interceptUnhandledRejections: () => () => {}, isExpectedCleanupError: () => false }, { debug() {}, warn() {} }, class { values: unknown[] = []; pushText() {} pushDisplay() {} finish() { return this.values; } }, structuredClone, (signal: AbortSignal) => { if (signal.aborted) throw signal.reason; }, (value: unknown) => value, async () => undefined, async (_owner: unknown, _record: unknown, work: () => unknown) => await work(), () => 1, () => false, (value: unknown) => value, (value: Promise<unknown>) => value, { sleep: async () => {} }, { randomUUID: () => "cmux-run" }, new Map(), () => {}, AbortSignal,
	) as (tab: any, options: any, context: any) => Promise<any>;
	const result = await runCmuxCodeWithContext(tab, { code: "await tool()", timeoutMs: 100 }, context);
	assert.deepEqual(result, { displays: [], returnValue: "cmux-value", screenshots: [] });
	assert.deepEqual((tab as any).context.session, context.snapshot);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.name, "named.cmux");
	assert.equal(typeof calls[0]!.signal?.aborted, "boolean");
	assert.equal((tab as any).cleared, true);
	assert.equal(typeof hooks.callTool, "function");
	await assert.rejects(() => runCmuxCodeWithContext(tab, { code: "no authority", timeoutMs: 100 }, { snapshot: context.snapshot }), /No active run for tool call/);
	return { snapshotShared: (tab as any).context.session === context.snapshot, callCount: calls.length };
});

const result = {
	selectedNativeRoot: nativeRoot,
	sources: Object.fromEntries(Object.entries(sources).map(([relative, source]) => [relative, { path: source.path, sha256: source.sha256, bytes: source.bytes }])),
	counts: { pass: passed.length, fail: failures.length },
	passed,
	failures,
	evidence,
	limits: "Controlled source extraction only. No native package import, SDK, browser, worker, cmux daemon, network, or runtime process executes. The selected tool bridge/prelude test uses a controlled session that exposes getToolForEvalBridge, so it verifies routing and argument/signal propagation but does not establish native permission policy. It exercises worker dispatch, supervisor run admission, and cmux runtime hook bodies; it does not establish browser output/status rendering behavior.",
};
await writeFile(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
