/** Controlled dual-source acceptance for supervisor-owned session-tool draining. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [sourcePath, beforePath] = process.argv.slice(2);
if (!sourcePath) throw new Error("Usage: browser-supervisor-work-drain.ts <tab-supervisor.ts> [before-tab-supervisor.ts]");
const source = await readFile(sourcePath, "utf8"), before = beforePath ? await readFile(beforePath, "utf8") : undefined;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const compile = (text: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(text.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""));
function part(text: string, start: string, end: string) { const a = text.indexOf(start), b = text.indexOf(end, a); if (a < 0 || b < 0) throw new Error(`Missing selected body: ${start}`); return text.slice(a, b); }
const hasTracker = source.includes("function trackTabTool(");
const tracker = hasTracker ? part(source, "// A worker result can remove PendingRun", "/** One cleanup per native object") : "";
const cleanup = part(source, "function cleanupTab(", "export const BROWSER_TAB_OWNER_CLOSE_VERSION");
const messages = part(source, "function handleTabMessage(", "async function recycleTimedOutWorkerTab(");
class ToolError extends Error { override name = "ToolError"; }
class ToolAbortError extends Error { override name = "ToolAbortError"; }

function harness() {
	const sent: Array<{ worker: object; message: any }> = [], tabCleanups = new WeakMap<object, Promise<void>>(), activeTabCleanups = new Map<object, Promise<void>>(), tabObservationReads = new Map<object, Promise<void>>();
	const makeWorker = () => { const value = { send(message: unknown) { sent.push({ worker: value, message }); } }; return value; };
	let worker = makeWorker(); let callback: ((...args: any[]) => Promise<unknown>) | undefined, cleanupGate: Promise<void> = Promise.resolve();
	const tab: any = { backend: "worker", state: "alive", worker, pending: new Map(), name: "selected" };
	const api = new Function("ToolError", "ToolAbortError", "tabCleanups", "activeTabCleanups", "tabObservationReads", "errorFromPayload", "logWorkerMessage", "logger",
		[compile(tracker), compile(cleanup), compile(messages), "return { cleanupTab, handleTabMessage, dispatchToolCall };"] .join("\n"),
	)(ToolError, ToolAbortError, tabCleanups, activeTabCleanups, tabObservationReads, (value: any) => new Error(value?.message ?? "worker failure"), () => {}, { debug() {} }) as any;
	function pending(id = "run") {
		const item: any = { signal: undefined, toolCalls: new Map(), context: { snapshot: { cwd: "/controlled" }, callTool: async (...args: any[]) => { if (!callback) throw new Error("callback absent"); return await callback(...args); } }, resolve() {}, reject() {} };
		tab.pending.set(id, item); return item;
	}
	function call(id = "run", request = "tool") { api.handleTabMessage(tab, { type: "tool-call", runId: id, id: request, name: "named", args: { request } }); }
	function result(id = "run") { api.handleTabMessage(tab, { type: "result", id, ok: true, payload: { displays: [], screenshots: [] } }); }
	return { api, tab, sent, pending, call, result, setCallback(value: typeof callback) { callback = value; }, setCleanup(value: Promise<void>) { cleanupGate = value; }, cleanup() { return api.cleanupTab(tab, async () => { tab.state = "dead"; await cleanupGate; }); }, replaceWorker() { worker = makeWorker(); tab.worker = worker; return worker; }, worker: () => worker };
}
const ticks = async () => { for (let i = 0; i < 48; i++) await Promise.resolve(); };
function tracked(promise: Promise<unknown>) { let result: { ok: boolean; error?: unknown } | undefined; void promise.then(() => result = { ok: true }, error => result = { ok: false, error }); return { async settle() { await ticks(); return result; }, pending: () => !result }; }
function errors(value: unknown): string[] { return value instanceof AggregateError ? [...value.errors].flatMap(errors) : [value instanceof Error ? value.message : String(value)]; }
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: unknown[] = [];
async function scenario(name: string, body: () => Promise<unknown>) { try { evidence.push({ name, value: await body() }); passed.push(name); } catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); } }

await scenario("result removal does not release a held session callback before cleanup drains it", async () => {
	const h = harness(), gate = Promise.withResolvers<void>(); let aborted = false; h.pending(); h.setCallback(async (_n, _a, signal) => { signal.addEventListener("abort", () => { aborted = true; }); await gate.promise; return "late-success"; });
	h.call(); await ticks(); h.result(); const drain = tracked(h.cleanup()); await ticks(); const observedAbort = aborted, observedPending = drain.pending(); gate.resolve(); const outcome = await drain.settle(); assert.equal(observedAbort, true); assert.equal(observedPending, true); assert.equal(outcome?.ok, true); return { fixed: hasTracker, observedAbort, observedPending, outcome };
});
await scenario("multiple callbacks remain drain-owned after their PendingRun is removed", async () => {
	const h = harness(), one = Promise.withResolvers<void>(), two = Promise.withResolvers<void>(); let calls = 0; h.pending(); h.setCallback(async () => { calls++; await (calls === 1 ? one.promise : two.promise); return calls; }); h.call("run", "one"); h.call("run", "two"); await ticks(); h.result(); const drain = tracked(h.cleanup()); await ticks(); const pendingBefore = drain.pending(); one.resolve(); await ticks(); const pendingAfterOne = drain.pending(); two.resolve(); assert.equal((await drain.settle())?.ok, true); assert.equal(pendingBefore, true); assert.equal(pendingAfterOne, true); return { fixed: hasTracker, calls, pendingBefore, pendingAfterOne };
});
await scenario("late operational callback error is retained by retirement and combines with cleanup error", async () => {
	const h = harness(), tool = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>(); h.pending(); h.setCallback(async () => { await tool.promise; throw new Error("late tool failure"); }); h.setCleanup(cleanup.promise); h.call(); await ticks(); h.result(); const drain = tracked(h.cleanup()); cleanup.reject(new Error("cleanup failure")); tool.resolve(); const outcome = await drain.settle(); assert.equal(outcome?.ok, false); assert.deepEqual(errors(outcome?.error).sort(), ["cleanup failure", "late tool failure"]); return { fixed: hasTracker, outcome: outcome?.ok };
});
await scenario("live callback failure is delivered once and does not poison later clean cleanup", async () => {
	const h = harness(); h.pending(); h.setCallback(async () => { throw new Error("live failure"); }); h.call(); await ticks(); assert.equal(h.sent.filter(item => item.message.type === "tool-reply").length, 1); assert.equal(h.sent[0]?.message.reply.ok, false); assert.equal(h.sent[0]?.message.reply.error.message, "live failure"); const outcome = await tracked(h.cleanup()).settle(); assert.equal(outcome?.ok, true); return { replies: h.sent.length };
});
await scenario("replacement worker receives no reply from the original held callback", async () => {
	const h = harness(), gate = Promise.withResolvers<void>(); h.pending(); h.setCallback(async () => { await gate.promise; return "late"; }); const original = h.worker(); h.call(); await ticks(); const replacement = h.replaceWorker(); gate.resolve(); await ticks(); assert.equal(h.sent.filter(item => item.worker === replacement).length, 0); assert.equal(h.sent.filter(item => item.worker === original).length, 0); return { replies: h.sent.length };
});
await scenario("cleanup bars a new session-tool dispatch", async () => {
	const h = harness(); let calls = 0; h.pending(); h.setCallback(async () => { calls++; return "unexpected"; }); await h.cleanup(); h.call(); await ticks(); assert.equal(calls, 0); return { calls };
});
await scenario("synchronous callback cleanup still reserves its own held work", async () => {
	const h = harness(), gate = Promise.withResolvers<void>(); h.pending(); let cleanup: ReturnType<typeof tracked> | undefined; h.setCallback(async () => { cleanup = tracked(h.cleanup()); await gate.promise; return "done"; }); h.call(); await ticks(); const wasPending = cleanup?.pending(); gate.resolve(); await ticks(); const outcome = await cleanup?.settle(); assert.equal(wasPending, true); assert.equal(outcome?.ok, true); return { fixed: hasTracker };
});

await scenario("late operational failure remains in repeated cleanup even when native cleanup succeeds", async () => {
 const h=harness(), gate=Promise.withResolvers<void>();h.pending();h.setCallback(async()=>{await gate.promise;throw new Error("unreported tool failure");});
 h.call();await ticks();h.result();const drain=tracked(h.cleanup());await ticks();const wasPending=drain.pending();gate.resolve();const outcome=await drain.settle();
 assert.equal(wasPending,true);assert.equal(outcome?.ok,false);assert.deepEqual(errors(outcome?.error),["unreported tool failure"]);
 const repeated=await tracked(h.cleanup()).settle();assert.equal(repeated?.ok,false);assert.deepEqual(errors(repeated?.error),["unreported tool failure"]);
 assert.equal(h.sent.length,0);return {wasPending,errors:errors(outcome?.error)};
});
await scenario("exact cleanup cancellation is clean after its callback really settles", async()=>{
 const h=harness(),gate=Promise.withResolvers<void>();let signal:AbortSignal|undefined;h.pending();h.setCallback(async(_n,_a,value)=>{signal=value;await gate.promise;if(value.aborted)throw value.reason;return "late";});
 h.call();await ticks();h.result();const drain=tracked(h.cleanup());await ticks();const aborted=signal?.aborted,wasPending=drain.pending();gate.resolve();const outcome=await drain.settle();
 assert.equal(aborted,true);assert.equal(wasPending,true);assert.equal(outcome?.ok,true);assert.equal(h.sent.length,0);return {aborted,wasPending};
});
await scenario("live caller abort retains its ordinary tool error reply",async()=>{
 const h=harness(),gate=Promise.withResolvers<void>(),abort=new AbortController();const pending=h.pending();pending.signal=abort.signal;
 h.setCallback(async(_n,_a,signal)=>{await gate.promise;signal.throwIfAborted();return "unexpected";});h.call();abort.abort(new Error("caller cancelled"));gate.resolve();await ticks();
 assert.equal(h.sent.length,1);assert.equal(h.sent[0]?.message.reply.ok,false);assert.equal(h.sent[0]?.message.reply.error.message,"caller cancelled");assert.equal((await tracked(h.cleanup()).settle())?.ok,true);return {replies:h.sent.length};
});
await scenario("failed reply transport remains a cleanup failure",async()=>{
 const h=harness();h.pending();h.worker().send=()=>{throw new Error("reply transport failed");};h.setCallback(async()=>"value");h.call();await ticks();const result=await tracked(h.cleanup()).settle();
 assert.equal(result?.ok,false);assert(errors(result?.error).includes("reply transport failed"));return {ok:result?.ok,errors:errors(result?.error)};
});

await scenario("one failed success reply remains a failure even if a second send would work",async()=>{
 const h=harness();h.pending();let sends=0;h.worker().send=()=>{if(++sends===1)throw new Error("first delivery failed");};h.setCallback(async()=>"success");h.call();await ticks();const result=await tracked(h.cleanup()).settle();
 assert.equal(result?.ok,false);assert.deepEqual(errors(result?.error),["first delivery failed"]);assert.equal(sends,1);return {ok:result?.ok,sends};
});
await scenario("native typed cancellation after cleanup abort is a clean completed drain",async()=>{
 const h=harness(),gate=Promise.withResolvers<void>();let aborted=false;h.pending();h.setCallback(async(_n,_a,signal)=>{await gate.promise;aborted=signal.aborted;if(aborted)throw new ToolAbortError("Command aborted");return "finished";});
 h.call();h.result();const result=tracked(h.cleanup());await ticks();const wasPending=result.pending();gate.resolve();const outcome=await result.settle();
 assert.equal(aborted,true);assert.equal(wasPending,true);assert.equal(outcome?.ok,true);assert.equal(h.sent.length,0);return {aborted,wasPending,ok:outcome?.ok};
});
await scenario("abort does not conceal an unrelated error merely named ToolAbortError",async()=>{
 const h=harness(),gate=Promise.withResolvers<void>();h.pending();h.setCallback(async()=>{await gate.promise;const error=new Error("unrelated operational failure");error.name="ToolAbortError";throw error;});
 h.call();h.result();const result=tracked(h.cleanup());gate.resolve();const outcome=await result.settle();assert.equal(outcome?.ok,false);assert.deepEqual(errors(outcome?.error),["unrelated operational failure"]);return {ok:outcome?.ok};
});

console.log(JSON.stringify({ sourcePath, beforePath, sources: { current: { sha256: hash(source), bytes: Buffer.byteLength(source) }, ...(before === undefined ? {} : { before: { sha256: hash(before), bytes: Buffer.byteLength(before) } }) }, selections: { tracker: hasTracker ? hash(tracker) : null, cleanup: hash(cleanup), messages: hash(messages) }, counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence, limits: "Controlled extracted supervisor source only. No native Worker, IPC, actual session services, parent lease, browser, SDK or network executes; controlled extracted-source execution only. Microtask turns are a controlled scheduling observation, not a wallclock deadline. Old source is expected to fail the drain-owned callback cases before fixed-source validation; live reply and replacement behavior are independently exercised." }, null, 2));
if (failures.length) process.exitCode = 1;
