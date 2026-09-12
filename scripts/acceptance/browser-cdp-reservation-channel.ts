/** Controlled retained-CDP opening/channel fixture. No endpoint, browser, Worker, SDK, or IPC runtime is started. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = ".data/browser-cdp-reservation-channel-2026-09-11";
const cdpPath = process.env.CDP_RETAINED_SOURCE ?? `${base}/native-source/native/src/tools/browser/cdp-evaluation-channel.ts`;
const supervisorPath = process.env.CDP_SUPERVISOR_SOURCE ?? `${base}/native-source/native/src/tools/browser/tab-supervisor.ts`;
const workerPath = process.env.CDP_WORKER_CHANNEL_SOURCE ?? `${base}/context/src/tools/browser/worker-cdp-channel.ts`;
const [cdpSource, supervisorSource, workerSource] = await Promise.all([readFile(cdpPath, "utf8"), readFile(supervisorPath, "utf8"), readFile(workerPath, "utf8")]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const compile = (value: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(value.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""));
function part(source: string, from: string, until: string) { const start = source.indexOf(from), end = source.indexOf(until, start); assert(start >= 0 && end > start, `Missing selected source: ${from}`); return source.slice(start, end); }
const reserved = part(supervisorSource, "export function openReservedCdpEvaluation(", "export function getTab(");
const cleanup = part(supervisorSource, "const tabCleanups = new WeakMap", "export const BROWSER_TAB_OWNER_CLOSE_VERSION");
const ticks = async () => { for (let turn = 0; turn < 48; turn++) await Promise.resolve(); };
function observe<T>(promise: Promise<T>) { let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined; void promise.then(value => result = { ok: true, value }, error => result = { ok: false, error }); return { get result() { return result; }, async settled() { await ticks(); return result; } }; }
function messages(error: unknown): string[] { return error instanceof AggregateError ? error.errors.flatMap(messages) : [error instanceof Error ? error.message : String(error)]; }

function module() {
	const worker = new Function(`${compile(workerSource)}\nreturn { ParentWorkerCdpChannel, WorkerCdpChannel };`)() as { ParentWorkerCdpChannel: new (channel: string, transport: object, post: (frame: unknown) => void) => any; WorkerCdpChannel: new (channel: string, post: (frame: unknown) => void) => any };
	const cdp = new Function("ParentWorkerCdpChannel", `${compile(cdpSource)}\nreturn { createCdpEvaluationOpening };`)(worker.ParentWorkerCdpChannel) as { createCdpEvaluationOpening(descriptor: unknown, source: unknown): any };
	const supervisor = (reservedTabNames: Map<string, unknown>, tabs: Map<string, unknown>) => new Function("ToolError", "reservedTabNames", "tabs", "crypto", "createCdpEvaluationOpening", `${compile(reserved)}\nreturn { openReservedCdpEvaluation };`)(class ToolError extends Error {}, reservedTabNames, tabs, { randomUUID: () => "channel-1" }, cdp.createCdpEvaluationOpening) as { openReservedCdpEvaluation(owner: string, target: { name: string; targetId: string }, operation: string, timeoutMs: number): Promise<any> };
	const cleanupTab = (reservationMap: WeakMap<object, any>) => new Function("ToolError", "tabEvaluationReservations", "tabObservationReads", "drainTabTools", "drainCmuxRun", "reservedTabNames", `${compile(cleanup)}\nreturn cleanupTab;`)(class ToolError extends Error {}, reservationMap, new Map(), async () => {}, async () => {}, new Map()) as (tab: object, run: () => Promise<void>, ownerRelease?: boolean, options?: unknown) => Promise<void>;
	return { ...worker, ...cdp, supervisor, cleanupTab };
}
function fixture() {
	const api = module(), frames: unknown[] = [], allocation = Promise.withResolvers<any>(), disposal = Promise.withResolvers<void>();
	let current = true, opens = 0, finish = 0;
	const transport = {
		onmessage: undefined as ((message: string) => void) | undefined, onclose: undefined as (() => void) | undefined,
		send(_message: string) {}, finishStartup() { finish++; }, async dispose() { await disposal.promise; },
	};
	const source = { async open() { opens++; return await allocation.promise; }, assertCurrent() { if (!current) throw new Error("original source lost"); } };
	const descriptor = { version: 1 as const, channel: "channel-1", targetId: "target-1", activateForScreenshot: true, dialogs: "dismiss" as const };
	return { api, frames, allocation, disposal, transport, source, descriptor, opening: () => api.createCdpEvaluationOpening(descriptor, source), setCurrent(value: boolean) { current = value; }, get opens() { return opens; }, get finish() { return finish; } };
}

const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: unknown[] = [];
async function scenario(name: string, body: () => Promise<unknown>) { try { evidence.push({ name, value: await body() }); passed.push(name); } catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); } }

await scenario("opening publishes before allocation, captures one source, and rejects invalid descriptors", async () => {
	const h = fixture(), opening = h.opening(); assert.equal(h.opens, 0);
	const ready = observe(opening.ready); await ticks(); assert.equal(h.opens, 1); assert.equal(h.frames.length, 0);
	h.allocation.resolve(h.transport); await ticks(); const readyOutcome = await ready.settled(); assert(readyOutcome?.ok); const channel = readyOutcome.value as any;
	assert.equal(h.finish, 1); assert.deepEqual(channel.descriptor, h.descriptor);
	await assert.rejects(Promise.resolve().then(() => h.api.createCdpEvaluationOpening({ ...h.descriptor, version: 2 }, h.source)), /Invalid/);
	const closed = observe(channel.dispose()); h.disposal.resolve(); assert.equal((await closed.settled())?.ok, true);
	return { opens: h.opens, framesBeforeStart: h.frames.length };
});

await scenario("actual reserved supervisor opening dedupes the original root and rejects pre-ready, foreign, and cmux reservations", async () => {
	const h = fixture(), reservations = new Map<string, any>(), tabs = new Map<string, any>(), supervisor = h.api.supervisor(reservations, tabs);
	const timeouts:number[]=[];
	const record = { ready: true, cdpOpening: undefined as unknown, value: { name: "original", ownerSessionId: "owner-1", targetId: "target-1", operationId: "op-1", assertCurrent() {} } };
	reservations.set("original", record); tabs.set("original", { backend: "worker", connectionOwner: { open: async (timeout:number) => { timeouts.push(timeout);return await h.source.open(); } }, activateForScreenshot: true, dialogPolicy: "dismiss" });
	const first = supervisor.openReservedCdpEvaluation("owner-1", { name: "original", targetId: "target-1" }, "op-1", 100), second = supervisor.openReservedCdpEvaluation("owner-1", { name: "original", targetId: "target-1" }, "op-1", 10);
	await ticks(); assert.equal(h.opens, 1); h.allocation.resolve(h.transport); const [one, two] = await Promise.all([first, second]); assert.equal(one.descriptor.channel, two.descriptor.channel);assert.deepEqual(timeouts,[100]);
	record.ready = false; assert.throws(() => supervisor.openReservedCdpEvaluation("owner-1", { name: "original", targetId: "target-1" }, "op-1", 10), /not ready/); record.ready = true;
	assert.throws(() => supervisor.openReservedCdpEvaluation("foreign", { name: "original", targetId: "target-1" }, "op-1", 10), /not ready/);
	tabs.set("original", { backend: "cmux" }); record.cdpOpening = undefined; assert.throws(() => supervisor.openReservedCdpEvaluation("owner-1", { name: "original", targetId: "target-1" }, "op-1", 10), /not a CDP/);
	h.disposal.resolve(); await one.dispose(); return { allocations: h.opens, channel: one.descriptor.channel, timeouts };
});

await scenario("start/receive use actual ParentWorkerCdpChannel data ack close and drained frames", async () => {
	const h = fixture(), opening = h.opening(); await ticks(); h.allocation.resolve(h.transport); const channel = await opening.ready;
	channel.start((frame:unknown) => h.frames.push(frame)); h.transport.onmessage?.("native-data"); await ticks();
	const data = h.frames.find((frame: any) => frame.kind === "data") as any; assert(data);
	channel.receive({ type: "worker-cdp", channel: "channel-1", kind: "ack", sequence: data.sequence });
	channel.receive({ type: "worker-cdp", channel: "channel-1", kind: "close" }); const drained = observe(channel.dispose()); h.disposal.resolve(); assert.equal((await drained.settled())?.ok, true);
	assert.equal(h.frames.some((frame: any) => frame.kind === "drained"), true);
	return { frameKinds: h.frames.map((frame: any) => frame.kind) };
});

await scenario("a duplicate receiver cannot take over or revive a retired opening", async () => {
	const h = fixture(), opening = h.opening(); await ticks(); h.allocation.resolve(h.transport); const channel = await opening.ready;
	const first = () => {}; channel.start(first); channel.start(first); assert.throws(() => channel.start(() => {}), /receiver/);
	assert.throws(() => channel.receive({ type: "worker-cdp", channel: "foreign", kind: "ack", sequence: 1 }), /original source|Invalid|channel/);
	h.setCurrent(false); const drain = observe(channel.dispose()); assert.equal(drain.result, undefined); h.disposal.resolve(); await drain.settled(); h.setCurrent(true);
	return { firstReceiverOnly: true };
});

await scenario("captured descriptor and source methods survive caller mutation",async()=>{
	const h=fixture(),opening=h.opening();h.descriptor.targetId="replacement";h.descriptor.activateForScreenshot=false;
	h.source.open=async()=>{throw new Error("replacement allocator");};h.source.assertCurrent=()=>{throw new Error("replacement guard");};
	await ticks();h.allocation.resolve(h.transport);const channel=await opening.ready;
	assert.equal(channel.descriptor.targetId,"target-1");assert.equal(channel.descriptor.activateForScreenshot,true);assert.equal(h.opens,1);
	h.disposal.resolve();await channel.dispose();return{originalTarget:channel.descriptor.targetId,opens:h.opens};
});

await scenario("retirement before scheduled allocation never opens a root",async()=>{
	const h=fixture(),opening=h.opening(),ready=observe(opening.ready);await opening.dispose();await ticks();
	assert.equal(h.opens,0);assert.equal(ready.result?.ok,false);return{opens:h.opens};
});

await scenario("source loss after allocation detaches unpublished root and retains detach failure",async()=>{
	const h=fixture(),opening=h.opening(),ready=observe(opening.ready);await ticks();h.setCurrent(false);h.allocation.resolve(h.transport);
	await ticks();const held=!ready.result;h.disposal.reject(new Error("native detach failure"));await ticks();
	assert.equal(held,true);assert.equal(ready.result?.ok,false);assert(ready.result&&!ready.result.ok);const errors=messages(ready.result.error);
	assert(errors.includes("original source lost"));assert(errors.includes("native detach failure"));h.setCurrent(true);
	await assert.rejects(opening.dispose(),/opening or drain/);assert.equal(h.opens,1);return{held,errors};
});

await scenario("actual worker channel preserves full browser and child commands and joins original transport drain",async()=>{
	const h=fixture(),opening=h.opening(),sent:string[]=[],received:string[]=[];h.transport.send=value=>{sent.push(value);};
	await ticks();h.allocation.resolve(h.transport);const channel=await opening.ready;
	const worker=new h.api.WorkerCdpChannel(channel.descriptor.channel,(frame:any)=>channel.receive(frame));worker.onmessage=(value:string)=>received.push(value);
	channel.start((frame:unknown)=>worker.receive(frame));
	const commands=[{id:1,method:"Target.createTarget",params:{url:"about:blank"}},{id:2,method:"Runtime.evaluate",params:{expression:"2+2"},sessionId:"owned-child"},{id:3,method:"Browser.close"}];
	for(const command of commands)worker.send(JSON.stringify(command));
	for(const command of commands)h.transport.onmessage?.(JSON.stringify({id:command.id,result:{},...(command.sessionId?{sessionId:command.sessionId}:{})}));
	const disposal=observe(channel.dispose());await ticks();const held=!disposal.result;h.disposal.resolve();await ticks();
	assert.deepEqual(sent.map(x=>JSON.parse(x)),commands);assert.equal(received.length,3);assert.equal(held,true);assert.equal(disposal.result?.ok,true);await worker.dispose();
	return{methods:commands.map(x=>x.method),held,limit:"Controlled transport echoes, not actual protocol/SDK/backend operation proof."};
});

await scenario("a live foreign channel frame cannot dispatch to original transport",async()=>{
	const h=fixture(),opening=h.opening();let sent=0;h.transport.send=()=>{sent++;};await ticks();h.allocation.resolve(h.transport);const channel=await opening.ready;channel.start(()=>{});
	channel.receive({type:"worker-cdp",channel:"foreign",kind:"data",sequence:1,data:"request"});await ticks();assert.equal(sent,0);
	channel.receive({type:"worker-cdp",channel:"channel-1",kind:"data",sequence:1,data:"original request"});assert.equal(sent,1);
	h.disposal.resolve();await channel.dispose();return{foreignSent:0,originalSent:sent};
});

await scenario("expected retirement suppresses late frames without inventing a drain failure",async()=>{
	const h=fixture(),opening=h.opening();await ticks();h.allocation.resolve(h.transport);const channel=await opening.ready;
	channel.start((frame:unknown)=>h.frames.push(frame));const late=h.transport.onmessage,drain=observe(channel.dispose());late?.("late original reply");
	h.disposal.resolve();await ticks();assert.equal(drain.result?.ok,true);assert.equal(h.frames.filter((x:any)=>x.kind==="data").length,0);
	return{frames:h.frames.map((x:any)=>x.kind)};
});

await scenario("receiver error during synchronous start replay remains in channel drain",async()=>{
	const h=fixture(),opening=h.opening();let listener:((message:string)=>void)|undefined;
	Object.defineProperty(h.transport,"onmessage",{configurable:true,get:()=>listener,set:(value:typeof listener)=>{listener=value;value?.("buffered original event");}});
	await ticks();h.allocation.resolve(h.transport);const channel=await opening.ready;let attempted=0;
	assert.throws(()=>channel.start(()=>{attempted++;throw new Error("destination post failure");}));
	h.disposal.resolve();await assert.rejects(channel.dispose(),error=>messages(error).includes("destination post failure"));
	assert(attempted>0);return{attempted};
});

for(const trigger of ["dispatch","event"] as const) await scenario(`original source loss during ${trigger} stays retired after restoration`,async()=>{
	const h=fixture(),opening=h.opening();let sends=0;h.transport.send=()=>{sends++;};await ticks();h.allocation.resolve(h.transport);const channel=await opening.ready;
	channel.start((frame:unknown)=>h.frames.push(frame));h.setCurrent(false);
	if(trigger==="dispatch")assert.throws(()=>channel.receive({type:"worker-cdp",channel:"channel-1",kind:"data",sequence:1,data:"request"}),/original source lost/);
	else h.transport.onmessage?.("late event");
	h.setCurrent(true);assert.throws(()=>channel.receive({type:"worker-cdp",channel:"channel-1",kind:"data",sequence:1,data:"retry"}));
	h.disposal.resolve();await assert.rejects(channel.dispose(),error=>messages(error).includes("original source lost"));
	assert.equal(sends,0);assert.equal(h.frames.filter((frame:any)=>frame.kind==="data").length,0);return{trigger,sends};
});

await scenario("dispose joins held allocation and records late success or rejection before resource cleanup", async () => {
	const h = fixture(), opening = h.opening(); await ticks(); const draining = observe(opening.dispose());
	assert.equal(draining.result, undefined); h.allocation.resolve(h.transport); await ticks(); h.disposal.resolve(); assert.equal((await draining.settled())?.ok, true);
	const failed = fixture(), failedOpening = failed.opening(); await ticks(); const failedDrain = observe(failedOpening.dispose()); failed.allocation.reject(new Error("late allocation failure"));
	const outcome = await failedDrain.settled(); assert.equal(outcome?.ok, false); assert(messages((outcome as { error: unknown }).error).includes("late allocation failure"));
	return { lateSuccess: true, lateErrors: messages((outcome as { error: unknown }).error) };
});

await scenario("actual cleanupTab marks reentrant disposal, joins held CDP drain, then retains allocation and resource failures", async () => {
	const h = fixture(), opening = h.opening(); await ticks();
	const reservations = new WeakMap<object, any>();
	const tab = { backend: "worker", state: "alive", name:"original" }; let resourceReleased = false, holdReleased = false, reentrant: ReturnType<typeof observe> | undefined, duplicateRuns = 0;
	const cleanupTab = h.api.cleanupTab(reservations);
	const record = {
		drained: Promise.resolve(), cdpOpening: { dispose() { reentrant ??= observe(cleanupTab(tab, async () => { duplicateRuns++; }, true)); return opening.dispose(); } }, revoked: false, retiredWorker: false,
		assertSource() {},
		async releaseHold() { holdReleased = true; },
	};
	reservations.set(tab, record);
	const cleanupResult = observe(cleanupTab(tab, async () => { resourceReleased = true; throw new Error("resource release failure"); }, true, { kill: true }));
	await ticks(); assert.equal(record.revoked, true); assert.equal(resourceReleased, false); assert.equal(holdReleased, false);
	h.allocation.resolve(h.transport); await ticks(); assert.equal(resourceReleased, false); h.disposal.resolve();
	const outcome = await cleanupResult.settled(); await reentrant?.settled();
	assert.equal(outcome?.ok, false); const errors = messages((outcome as { error: unknown }).error);
	assert(errors.includes("resource release failure")); assert.equal(resourceReleased, true); assert.equal(holdReleased, true); assert.equal(duplicateRuns,0); assert.equal(reentrant?.result?.ok,false);
	return { markerPublished: record.revoked, resourceReleased, holdReleased, errors };
});

await scenario("actual cleanupTab aggregates a late allocation failure with an independent resource failure", async () => {
	const h = fixture(), opening = h.opening(); await ticks(); const reservations = new WeakMap<object, any>(), tab = { backend: "worker" };
	let held = false;
	const cleanupTab = h.api.cleanupTab(reservations);
	reservations.set(tab, { drained: Promise.resolve(), cdpOpening:opening, revoked: false, retiredWorker: false, assertSource() {}, async releaseHold() { held = true; } });
	const result = observe(cleanupTab(tab, async () => { throw new Error("resource release failure"); }, true, { kill: true }));
	h.allocation.reject(new Error("late allocation failure")); const outcome = await result.settled();
	assert.equal(outcome?.ok, false); const errors = messages((outcome as { error: unknown }).error);
	assert(errors.includes("late allocation failure")); assert(errors.includes("resource release failure")); assert.equal(held, true);
	return { errors, held };
});

console.log(JSON.stringify({ sources: { cdp: { path: cdpPath, sha256: hash(cdpSource), bytes: Buffer.byteLength(cdpSource) }, supervisor: { path: supervisorPath, sha256: hash(supervisorSource), bytes: Buffer.byteLength(supervisorSource) }, workerChannel: { path: workerPath, sha256: hash(workerSource), bytes: Buffer.byteLength(workerSource) } }, selected: { reserved: hash(reserved), cleanup: hash(cleanup) }, counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence, limits: "Controlled actual CDP opening and parent/worker channel bodies with only retained transport/current-resource seams fake. No CDP endpoint, browser, Worker, SDK, IPC runtime, or native allocation executes. Supervisor reserved/cleanup source is fenced and hashed; its full dependency graph is not constructed here." }, null, 2));
if (failures.length) process.exitCode = 1;
