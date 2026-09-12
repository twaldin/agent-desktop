/** Controlled complete-CmuxTab plus retained-channel fixture. No socket, browser, Worker, SDK, or native runtime is started. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = ".data/browser-reservation-backend-2026-09-11/native-source/native/src/tools/browser/cmux";
const cmuxPath = process.env.CMUX_RETAINED_SOURCE ?? `${base}/cmux-tab.ts`;
const channelPath = process.env.CMUX_CHANNEL_SOURCE ?? `${base}/evaluation-channel.ts`;
const [cmuxSource, channelSource] = await Promise.all([readFile(cmuxPath, "utf8"), readFile(channelPath, "utf8")]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const compile = (value: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(value.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""));
class ToolError extends Error { override name = "ToolError"; }
class ToolAbortError extends ToolError { override name = "ToolAbortError"; }
const ticks = async () => { for (let turn = 0; turn < 48; turn++) await Promise.resolve(); };
function observe<T>(promise: Promise<T>) { let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined; void promise.then(value => result = { ok: true, value }, error => result = { ok: false, error }); return { get result() { return result; }, async settled() { await ticks(); return result; } }; }
function messages(error: unknown): string[] { return error instanceof AggregateError ? error.errors.flatMap(messages) : [error instanceof Error ? error.message : String(error)]; }

function module() {
	const deps: Record<string, unknown> = {
		logger: { debug() {}, warn() {} }, postmortem: { isExpectedCleanupError() { return false; }, markExpectedCleanupError<T>(error: T) { return error; }, interceptUnhandledRejections(_consume: (error: unknown) => boolean) { return () => {}; } }, Snowflake: { next: () => "image" }, untilAborted: async (_signal: AbortSignal | undefined, run: () => unknown) => await run(),
		OperationAbortError: class OperationAbortError extends Error {}, JsRuntime: class {}, resizeImage: async () => ({}), resolveToCwd: (value: string) => value, formatScreenshot: () => "", bindRunFacade: <T>(value: T) => value,
		isBrowserRunOwnedRejection: () => false, markBrowserRunRejection: <T>(value: T) => value, observeBrowserRunPromise: <T>(value: T) => value, resolvePredicateTimeout: () => 0, waitForRun: async () => {}, withBrowserPromiseCombinatorTracking: async (_owner: unknown, _callback: unknown, run: () => Promise<unknown>) => await run(),
		ToolAbortError, ToolError, throwIfAborted(signal: AbortSignal | undefined) { signal?.throwIfAborted(); }, assertSelectorString(value: unknown) { if (typeof value !== "string") throw new ToolError("selector"); }, buildAriaSnapshotScript: () => "'',", DEFAULT_VIEWPORT: { width: 800, height: 600, deviceScaleFactor: 1 },
		createBrowserRunContext: () => ({}), extractReadableFromHtml: () => "", cloneSafe: structuredClone, RunOutput: class { pushText() {}; pushDisplay() {}; finish() { return []; } },
		cmuxSnapshotToObservation: (_snapshot: unknown, viewport: { width: number; height: number; deviceScaleFactor?: number }) => ({ url: "https://example.test/", title: "Original", viewport, elements: [{ id: 7, name: "Save", role: "button" }] }), GEOMETRY_SCRIPT: "({innerWidth:800,innerHeight:600,dpr:1})", mapWaitUntil: (value: unknown) => value, serializeEvalWithEnvelope: (value: string) => value, unwrapEvalEnvelope: <T>(value: T) => value,
		Bun: { sleep: async () => {}, file: () => ({ type: "application/octet-stream", arrayBuffer: async () => new ArrayBuffer(0) }) }, Buffer,
	};
	const cmux = new Function(...Object.keys(deps), `${compile(cmuxSource)}\nreturn { CmuxTab, captureCmuxRetainedState, createRetainedCmuxTab };`)(...Object.values(deps)) as any;
	const channel = new Function("ToolError", "captureCmuxRetainedState", `${compile(channelSource)}\nreturn { createCmuxEvaluationChannel };`)(ToolError, cmux.captureCmuxRetainedState) as any;
	return { ...cmux, ...channel };
}

const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: unknown[] = [];
async function scenario(name: string, body: () => Promise<unknown>) { try { evidence.push({ name, value: await body() }); passed.push(name); } catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); } }
function fixture() {
	const api = module(), calls: Array<{ method: string; params: Record<string, unknown>; options?: unknown }> = [];
	let current = true, responder: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> = async (_method, params) => ({ surface_id: params.surface_id as string });
	const client = { async request(method: string, params: Record<string, unknown>, options?: unknown) { calls.push({ method, params: structuredClone(params), options: structuredClone(options) }); return await responder(method, params); } };
	const state = { version: 1 as const, surfaceId: "surface-1", url: "https://example.test/", title: "Original", viewport: { width: 901, height: 577, deviceScaleFactor: 2 }, elementRefs: [{ id: 7, ref: "@e7", name: "Save", role: "button" }] };
	const tab = api.createRetainedCmuxTab(state, client), source = { request: client.request.bind(client), assertCurrent() { if (!current) throw new ToolError("original source changed"); } };
	return { api, tab, client, calls, source, state, channel: () => api.createCmuxEvaluationChannel(tab, source), setCurrent(value: boolean) { current = value; }, setResponder(value: typeof responder) { responder = value; } };
}

await scenario("fresh retained tab preserves viewport/ref state without observe or readyInfo", async () => {
	const h = fixture(); assert.deepEqual(h.tab.viewport(), h.state.viewport); assert.equal(h.tab.url(), h.state.url);
	const channel = h.channel(), state = channel.state as { viewport: { width: number }; elementRefs: { ref: string }[] }; state.viewport.width = 1; state.elementRefs[0]!.ref = "@e99";
	h.state.viewport.width = 2; h.state.elementRefs[0].ref = "@e77";
	assert.equal(channel.state.viewport.width, 901); assert.equal(channel.state.elementRefs[0].ref, "@e7");
	assert(await h.tab.page.$("e7")); assert.equal(await h.tab.page.$("e99"), null); assert.equal(h.calls.some(call => call.method === "browser.snapshot" || call.method === "browser.url.get"), false);
	return { viewport: h.tab.viewport(), requests: h.calls.map(call => call.method) };
});

await scenario("actual original observe then capture restores its element reference without another observe", async () => {
	const h = fixture(); const original = new h.api.CmuxTab({ client: h.client, surfaceId: "surface-1", url: "https://example.test/", title: "Original" });
	await original.observe(); const observedCalls = h.calls.length;
	const retained = h.api.createRetainedCmuxTab(h.api.captureCmuxRetainedState(original), h.client);
	const element = await retained.page.$("e7");
	assert(element); assert.equal(h.calls.slice(observedCalls).some((call: { method: string }) => call.method === "browser.snapshot"), false);
	assert.equal(h.calls.slice(observedCalls).some((call: { method: string }) => call.method === "browser.url.get"), false);
	return { observedCalls, callsAfterCapture: h.calls.length - observedCalls };
});

await scenario("allowlisted facade-shaped requests route only through the captured original client", async () => {
	const h = fixture(), channel = h.channel();
	const samples: Array<[string, Record<string, unknown>]> = [
		["browser.url.get", { surface_id: "surface-1" }], ["browser.eval", { surface_id: "surface-1", script: "1" }], ["browser.navigate", { surface_id: "surface-1", url: "https://next.test" }], ["browser.snapshot", { surface_id: "surface-1", interactive: true, max_depth: 12 }], ["browser.screenshot", { surface_id: "surface-1" }], ["browser.press", { surface_id: "surface-1", key: "Enter" }], ["browser.scroll", { surface_id: "surface-1", dx: 1, dy: 2 }], ["browser.click", { surface_id: "surface-1", selector: "#x" }], ["browser.dblclick", { surface_id: "surface-1", selector: "#x" }], ["browser.hover", { surface_id: "surface-1", selector: "#x" }], ["browser.focus", { surface_id: "surface-1", selector: "#x" }], ["browser.check", { surface_id: "surface-1", selector: "#x" }], ["browser.uncheck", { surface_id: "surface-1", selector: "#x" }], ["browser.type", { surface_id: "surface-1", selector: "#x", text: "x" }], ["browser.fill", { surface_id: "surface-1", selector: "#x", text: "x" }], ["browser.scroll_into_view", { surface_id: "surface-1", selector: "#x" }], ["browser.wait", { surface_id: "surface-1", selector: "#x", timeout_ms: 1 }], ["surface.close", { surface_id: "surface-1" }],
	];
	for (const [method, params] of samples) await channel.request(method, params, { timeoutMs: 5 });
	assert.equal(h.calls.length, samples.length); assert.equal(h.calls.every(call => call.params.surface_id === "surface-1"), true);
	await assert.rejects(channel.request("browser.open_split", { surface_id: "surface-1" }), /Unsupported/);
	await assert.rejects(channel.request("browser.url.get", { surface_id: "foreign" }), /target changed/);
	await assert.rejects(channel.request("browser.url.get", { surface_id: "surface-1", workspace: "foreign" }), /Unexpected/);
	return { routed: h.calls.length, explicitClose: h.calls.some(call => call.method === "surface.close") };
});

await scenario("source loss latches, and caller mutations cannot retarget a dispatched request", async () => {
	const h = fixture(), channel = h.channel(), params = { surface_id: "surface-1", script: "1" };
	const first = channel.request("browser.eval", params); params.surface_id = "foreign"; params.script = "mutated"; await first;
	assert.deepEqual(h.calls[0]?.params, { surface_id: "surface-1", script: "1" });
	h.setCurrent(false); await assert.rejects(channel.request("browser.url.get", { surface_id: "surface-1" }), /source changed/);
	h.setCurrent(true); await assert.rejects(channel.request("browser.url.get", { surface_id: "surface-1" }), /source was lost/);
	return { firstParams: h.calls[0]?.params };
});

await scenario("64 held channel requests reject overflow and drain without a surface close", async () => {
	const h = fixture(), gates = Array.from({ length: 64 }, () => Promise.withResolvers<Record<string, unknown>>()); let next = 0;
	h.setResponder(async () => await gates[next++]!.promise);
	const channel = h.channel(), pending = Array.from({ length: 64 }, () => channel.request("browser.url.get", { surface_id: "surface-1" }));
	await ticks(); await assert.rejects(channel.request("browser.url.get", { surface_id: "surface-1" }), /capacity/); const draining = observe(channel.dispose());
	for (const gate of gates) gate.resolve({ surface_id: "surface-1" }); const settled = await Promise.allSettled(pending); assert.equal(settled.every(result => result.status === "rejected"), true); assert.equal((await draining.settled())?.ok, true);
	assert.equal(h.calls.some(call => call.method === "surface.close"), false);
	return { capacity: 64, requestsRejectedAfterRetirement: settled.length, surfaceClosed: false };
});

await scenario("synchronous reentrant dispose joins its valid request but rejects late publication", async () => {
	const reentrant = fixture(), reentrantGate = Promise.withResolvers<Record<string, unknown>>(); let reentrantChannel: any;
	reentrant.setResponder(async () => { void reentrantChannel.dispose(); return await reentrantGate.promise; });
	reentrantChannel = reentrant.channel(); const reentrantRequest = observe(reentrantChannel.request("browser.url.get", { surface_id: "surface-1" })); await ticks(); const reentrantDrain = observe(reentrantChannel.dispose());
	assert.equal(reentrantDrain.result, undefined); reentrantGate.resolve({ surface_id: "surface-1" }); assert.equal((await reentrantRequest.settled())?.ok, false); assert.equal((await reentrantDrain.settled())?.ok, true);
	return { requestRejectedAfterRetirement: true, drainCompleted: true };
});

await scenario("late operational reply remains in the channel drain", async () => {
	const failed = fixture(), late = Promise.withResolvers<Record<string, unknown>>(); failed.setResponder(async () => await late.promise); const failing = failed.channel(); const request = observe(failing.request("browser.url.get", { surface_id: "surface-1" })); const dispose = observe(failing.dispose()); late.reject(new Error("late operational"));
	assert.equal((await request.settled())?.ok, false); const outcome = await dispose.settled(); assert.equal(outcome?.ok, false); assert(messages((outcome as { error: unknown }).error).includes("late operational"));
	return { lateErrors: messages((outcome as { error: unknown }).error) };
});

await scenario("late malformed reply remains in the channel drain", async () => {
	const malformed = fixture(), malformedGate = Promise.withResolvers<Record<string, unknown>>(); malformed.setResponder(async () => await malformedGate.promise); const malformedChannel = malformed.channel(); const malformedRequest = observe(malformedChannel.request("browser.url.get", { surface_id: "surface-1" })); const malformedDrain = observe(malformedChannel.dispose()); malformedGate.resolve([] as unknown as Record<string, unknown>);
	assert.equal((await malformedRequest.settled())?.ok, false); const malformedOutcome = await malformedDrain.settled(); assert.equal(malformedOutcome?.ok, false); assert(messages((malformedOutcome as { error: unknown }).error).includes("Invalid cmux evaluation record"));
	return { malformedErrors: messages((malformedOutcome as { error: unknown }).error) };
});

await scenario("actual fresh facade uses the channel for navigation, title and observed-ref actions", async () => {
 const h=fixture(), channel=h.channel();h.setResponder(async (method,params)=>method==="browser.eval"?{value:"fresh title"}:method==="browser.navigate"?{url:params.url}:{surface_id:params.surface_id});
 const fresh=h.api.createRetainedCmuxTab(channel.state,channel);assert.equal(h.calls.length,0);
 await fresh.goto("https://destination.test/");assert.equal(fresh.url(),"https://destination.test/");assert.equal(await fresh.title(),"fresh title");
 const handle=await fresh.page.$("e7");assert(handle);await handle.click();await fresh.type("#input","text");await fresh.fill("#input","filled");await fresh.press("Enter");await fresh.scroll(2,3);
 assert.deepEqual(h.calls.map(x=>x.method),["browser.navigate","browser.eval","browser.click","browser.type","browser.fill","browser.press","browser.scroll"]);
 assert.equal(h.calls[2]?.params.selector,"@e7");assert(h.calls.every(x=>x.params.surface_id==="surface-1"));await channel.dispose();return {methods:h.calls.map(x=>x.method)};
});
await scenario("retained state rejects sparse, duplicate, accessor and malformed metadata",async()=>{
 const h=fixture();const mutations:Array<(s:any)=>void>=[s=>{s.version=2;},s=>{s.viewport.width=NaN;},s=>{s.elementRefs.length=2;},s=>{s.elementRefs.push({...s.elementRefs[0]});},s=>{s.elementRefs[0].ref="@e99";},s=>{s.extra="route";}];
 for(const mutate of mutations){const state=structuredClone(h.state);mutate(state);assert.throws(()=>h.api.createRetainedCmuxTab(state,h.client));}
 let getterCalls=0;const accessor=structuredClone(h.state);Object.defineProperty(accessor,"url",{enumerable:true,get(){getterCalls++;return "changed";}});assert.throws(()=>h.api.createRetainedCmuxTab(accessor,h.client));assert.equal(getterCalls,0);assert.equal(h.calls.length,0);return {rejected:mutations.length+1,getterCalls};
});
await scenario("all wait alternatives and absent optional fields preserve native request shape",async()=>{
 const h=fixture(),c=h.channel();
 for(const params of [{load_state:"interactive"},{load_state:"complete"},{url_contains:"next"},{selector:"#x"}])await c.request("browser.wait",{surface_id:"surface-1",...params,timeout_ms:undefined},{timeoutMs:undefined});
 await c.request("browser.snapshot",{surface_id:"surface-1",interactive:false,max_depth:undefined});
 await assert.rejects(c.request("browser.wait",{surface_id:"surface-1",selector:"#x",url_contains:"other"}));
 await assert.rejects(c.request("browser.url.get",{surface_id:"surface-1"},{connectionGeneration:2}));
 assert.equal(h.calls.length,5);assert(h.calls.every(x=>!Object.hasOwn(x.params,"timeout_ms")&&!Object.hasOwn(x.params,"max_depth")));await c.dispose();return{calls:h.calls.length};
});
await scenario("reported live operational failure does not poison later channel disposal",async()=>{
 const h=fixture(),c=h.channel();h.setResponder(async()=>{throw new Error("live operational failure");});await assert.rejects(c.request("browser.eval",{surface_id:"surface-1",script:"1"}),/live operational failure/);await c.dispose();return{reported:true};
});
await scenario("original request and concurrent original source failures both survive drain",async()=>{
 const h=fixture(),c=h.channel();h.setResponder(async()=>{h.setCurrent(false);throw new Error("operation failed first");});const result=observe(c.request("browser.eval",{surface_id:"surface-1",script:"1"}));await ticks();assert.equal(result.result?.ok,false);const drain=await observe(c.dispose()).settled();assert.equal(drain?.ok,false);const errs=messages((drain as {error:unknown}).error);assert(errs.includes("operation failed first"));assert(errs.includes("original source changed"));return {errors:errs};
});
await scenario("channel keeps captured function and source guard when caller changes source object",async()=>{
 const h=fixture(),c=h.channel();let replacementCalls=0;(h.source as any).request=async()=>{replacementCalls++;return {};};h.source.assertCurrent=()=>{};
 await c.request("browser.url.get",{surface_id:"surface-1"});h.setCurrent(false);await assert.rejects(c.request("browser.url.get",{surface_id:"surface-1"}),/original source changed/);assert.equal(replacementCalls,0);assert.equal(h.calls.length,1);await assert.rejects(c.dispose());return{replacementCalls,originalCalls:h.calls.length};
});
await scenario("source guard reentrant disposal cannot dispatch after admission check",async()=>{
 const h=fixture();let armed=false,c:any;const source={request:h.client.request.bind(h.client),assertCurrent(){if(armed){armed=false;void c.dispose();}}};c=h.api.createCmuxEvaluationChannel(h.tab,source);armed=true;await assert.rejects(c.request("browser.url.get",{surface_id:"surface-1"}),/retired/);await c.dispose();assert.equal(h.calls.length,0);return{calls:h.calls.length};
});

console.log(JSON.stringify({ sources: { cmux: { path: cmuxPath, sha256: hash(cmuxSource), bytes: Buffer.byteLength(cmuxSource) }, channel: { path: channelPath, sha256: hash(channelSource), bytes: Buffer.byteLength(channelSource) } }, counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence, limits: "Controlled complete transpiled CmuxTab module and evaluation-channel body with injected runtime/client/FS utilities. No socket, browser, Worker, SDK, native runtime, session service, or physical surface cleanup executes. One case calls actual observe with a controlled snapshot converter; no readyInfo or observation is called during fresh restoration. Other cases seed explicit plain state. No real JS evaluator run is executed." }, null, 2));
if (failures.length) process.exitCode = 1;
