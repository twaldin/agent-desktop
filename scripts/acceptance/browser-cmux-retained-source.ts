/** Controlled retained-cmux source acceptance. No package imports or native execution. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [supervisorPath, beforePath] = process.argv.slice(2);
if (!supervisorPath) throw new Error("Usage: browser-cmux-retained-source.ts <tab-supervisor.ts> [before-tab-supervisor.ts]");
const supervisor = await readFile(supervisorPath, "utf8");
const before = beforePath ? await readFile(beforePath, "utf8") : undefined;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const compile = (source: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""));
function section(source: string, start: string, end: string) {
	const from = source.indexOf(start), to = source.indexOf(end, from);
	if (from < 0 || to < 0) throw new Error(`Missing selected supervisor section: ${start}`);
	return source.slice(from, to);
}

const retained = section(supervisor, "function captureCmuxTabClient(", "export async function runInTab(");
const reuse = section(supervisor, "async function acquireTabImpl(", "type WorkerPageInit =");
const runner = section(supervisor, "async function runInTabWithContext(", "/** One cleanup per native object");
class ToolError extends Error { override name = "ToolError"; }
class ToolAbortError extends Error { override name = "ToolAbortError"; }
class RecoverableWorkerError extends Error {}

type Client = { connectionGeneration?: number; request(method: string, params: Record<string, unknown>, opts?: Record<string, unknown>): Promise<Record<string, unknown>> };
type Browser = { client: Client; kind: { kind: string }; surface?: string };
type Tab = Record<string, any>;
function harness() {
	const tabs = new Map<string, Tab>(), observations = new WeakMap<object, unknown>();
	const runCalls: unknown[] = [], requests: Array<{ client: Client; method: string; params: unknown; opts: unknown }> = [];
	let holds = 0;
	class CmuxTab {
		constructor(readonly options: { client: Client; surfaceId: string; url?: string }) {}
		async goto() {}
		async readyInfo(viewport: unknown) { return { url: this.options.url ?? "about:blank", title: "Original", viewport, targetId: this.options.surfaceId }; }
	}
	const api = new Function("ToolError", "ToolAbortError", "RecoverableWorkerError", "tabs", "CmuxTab", "captureTabObservation", "rememberTabObservation", "holdBrowser", "mapWaitUntil", "DEFAULT_VIEWPORT", "process", "runCmuxCodeWithContext", "humanActions", "killedTabs", "Snowflake", "AbortSignal", "raceWithTimeout", "GRACE_MS", "forceKillTab", "recycleTimedOutWorkerTab", "tabObservations", "performance", "getProjectDir",
		[compile(retained), compile(reuse), compile(runner), "return { captureCmuxTabClient, acquireCmuxTab, acquireTabImpl, runInTabWithContext };"] .join("\n"),
	)(
		ToolError, ToolAbortError, RecoverableWorkerError, tabs, CmuxTab,
		async () => ({ assertCurrent() {} }), (tab:object,value:unknown) => { observations.set(tab,value); }, () => { holds++; }, (value: string) => value, { width: 800, height: 600, deviceScaleFactor: 1 }, { env: {} },
		async (_tab: unknown, options: unknown, context: unknown) => { runCalls.push({ options, context }); return { displays: [], returnValue: "ran", screenshots: [] }; },
		new Set(), new Map(), { next: () => "run" }, AbortSignal, async (value: Promise<unknown>) => await value, 1, async () => {}, async () => {}, observations, performance, () => "/controlled",
	) as { captureCmuxTabClient(browser: Browser): unknown; acquireCmuxTab(name: string, browser: Browser, opts: Record<string, unknown>, client: unknown): Promise<{ tab: Tab; created: boolean }>; acquireTabImpl(name:string,browser:Browser,opts:Record<string,unknown>,client:unknown):Promise<{tab:Tab;created:boolean}>; runInTabWithContext(name: string, opts: Record<string, unknown>, context: unknown): Promise<unknown> };
	function browser() {
		const client: Client = { connectionGeneration: 1, async request(method, params, opts) {
			requests.push({ client, method, params, opts });
			return method === "browser.open_split" ? { surface_id: `surface-${requests.length}`, url: "about:blank" } : {};
		} };
		return { value: { client, kind: { kind: "cmux" } }, client };
	}
	async function acquire(name: string, value: Browser, owner = "creator") {
		const source = api.captureCmuxTabClient(value);
		return await api.acquireCmuxTab(name, value, { timeoutMs: 100, ownerSessionId: owner }, source);
	}
	async function run(name: string, context = { snapshot: { cwd: "/controlled" }, callTool: async () => "tool" }) {
		return await api.runInTabWithContext(name, { code: "controlled", timeoutMs: 100 }, context);
	}
	async function reuseTab(name:string,value:Browser) { return await api.acquireTabImpl(name,value,{timeoutMs:100,url:"https://reuse.test/"},api.captureCmuxTabClient(value)); }
	return { tabs, runCalls, requests, reuseTab, get holds() { return holds; }, browser, acquire, run };
}

const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: unknown[] = [];
async function scenario(name: string, body: () => Promise<unknown>) {
	try { evidence.push({ name, value: await body() }); passed.push(name); }
	catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}


await scenario("original cmux acquisition runs and reuses its retained source", async () => {
	const h = harness(), { value } = h.browser(); const first = await h.acquire("selected", value);
	assert.equal(first.created, true); assert.equal(h.holds, 1); assert.deepEqual(await h.run("selected"), { displays: [], returnValue: "ran", screenshots: [] });
	const reused=await h.reuseTab("selected",value); assert.equal(reused.created,false); assert.equal(reused.tab.targetId,first.tab.targetId);
	assert.equal(h.runCalls.length, 2); return { requestCount: h.requests.length, runCount: h.runCalls.length };
});
for (const mutation of ["generation", "client", "kind"] as const) {
	await scenario(`changed ${mutation} cannot start a retained cmux run`, async () => {
		const h = harness(), { value, client } = h.browser(); await h.acquire("selected", value);
		if (mutation === "generation") client.connectionGeneration = 2;
		if (mutation === "client") value.client = { connectionGeneration: 1, request: client.request };
		if (mutation === "kind") value.kind = { kind: "cmux" };
		let error:unknown; try { await h.run("selected"); } catch(value) { error=value; } assert.equal(h.runCalls.length,0); assert.match(String(error),/original cmux|no longer available|no longer current/i); return { mutation, runCalls: h.runCalls.length };
	});
}
for (const mutation of ["target", "facade", "creator"] as const) {
	await scenario(`mutated retained ${mutation} cannot start evaluator JavaScript`, async () => {
		const h = harness(), { value } = h.browser(); const { tab } = await h.acquire("selected", value);
		if (mutation === "target") tab.targetId = "replacement";
		if (mutation === "facade") tab.cmuxTab = {};
		if (mutation === "creator") tab.ownerSessionId = "replacement";
		let error:unknown; try { await h.run("selected"); } catch(value) { error=value; } assert.equal(h.runCalls.length,0); assert.match(String(error),/original cmux|no longer available|no longer current/i); return { mutation, runCalls: h.runCalls.length };
	});
}
for (const mutation of ["generation","client","kind"] as const) {
  await scenario(`reuse refuses changed original ${mutation} before navigation body`,async()=>{
    const h=harness(),{value,client}=h.browser(); await h.acquire("selected",value);
    if(mutation==="generation")client.connectionGeneration=2;
    if(mutation==="client")value.client={connectionGeneration:1,request:client.request};
    if(mutation==="kind")value.kind={kind:"cmux"};
    let error:unknown;try {await h.reuseTab("selected",value);}catch(value){error=value;}
    assert.equal(h.runCalls.length,0);assert.match(String(error),/original cmux|no longer available|no longer current/i);
    return {mutation,runCalls:h.runCalls.length};
  });
}
await scenario("same-name replacement receives its own record and cannot replay the old one", async () => {
	const h = harness(), original = h.browser(), replacement = h.browser(); const old = await h.acquire("selected", original.value, "old-creator");
	// A different current tab replaces the map entry. The retained source must be
	// rebuilt by its acquisition; run admission sees only that exact new record.
	const fresh = await h.acquire("selected", replacement.value, "new-creator");
	assert.equal(fresh.tab.ownerSessionId,"new-creator");
	assert.deepEqual(await h.run("selected"), { displays: [], returnValue: "ran", screenshots: [] }); assert.equal(h.runCalls.length, 1);
	original.client.connectionGeneration = 2; assert.deepEqual(await h.run("selected"), { displays: [], returnValue: "ran", screenshots: [] });
	return { oldCreator: old.tab.ownerSessionId, newCreator: fresh.tab.ownerSessionId, runCalls: h.runCalls.length };
});

console.log(JSON.stringify({ supervisorPath, beforePath, sources: { current: { sha256: sha256(supervisor), bytes: Buffer.byteLength(supervisor) }, ...(before === undefined ? {} : { before: { sha256: sha256(before), bytes: Buffer.byteLength(before) } }) }, selections: { retained: sha256(retained), reuse:sha256(reuse), runner: sha256(runner) }, counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence, limits: "Complete selected acquisition/source-record/reuse/run-admission sections with controlled client, CmuxTab, observations and run dispatch. No supervisor import, SDK, worker, browser, socket, or native runtime. This is controlled execution of extracted source; outer public acquisition serialization/publication cleanup is not selected. This fixture does not cover parent ownership leases, cmux socket behavior, or cleanup." }, null, 2));
if (failures.length) process.exitCode = 1;
