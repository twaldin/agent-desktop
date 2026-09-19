import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodexResetPolicyOwner, NativeResetAnswer, ResetAdmission, ResetCheckpoint, ResetObservation, ResetPermit, ResetPlanSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";

const root = process.argv[2]!;
assert.ok(root, "usage: native-reset-task-owner.ts <root>");
assert.equal(process.env.HOME, root);
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "project");
await mkdir(path.join(cwd, ".omp", "agents"), { recursive: true });
await mkdir(agentDir, { recursive: true });

const transportRequests: string[] = [];
const responseGates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
const inferenceServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		assert.equal(url.pathname, "/v1/chat/completions");
		const body = (await request.json()) as { messages?: unknown[] };
		const id = request.headers.get("x-agent-id") ?? `request-${transportRequests.length + 1}`;
		transportRequests.push(id);
		const gate = responseGates.get(id);
		if (gate) await gate.promise;
		const callId = `yield-${transportRequests.length}`;
		const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
			`data: ${JSON.stringify({ id: callId, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		assert.ok(Array.isArray(body.messages));
		return new Response(
			chunk({ role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "yield", arguments: JSON.stringify({ data: "controlled child complete" }) } }] }, null) +
			chunk({}, "tool_calls") + `data: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	},
});

await writeFile(path.join(agentDir, "config.yml"), [
	"extensions: []",
	"async:",
	"  enabled: false",
	"task:",
	"  agentIdleTtlMs: 60000",
	"  maxRuntimeMs: 10000",
	"codexResets:",
	"  autoRedeem: yes",
	"  keepCredits: 0",
	"  salvageHorizonHours: 12",
	"  minBlockedMinutes: 60",
	"",
].join("\n"));
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { fixture: {
	api: "openai-completions", baseUrl: `http://127.0.0.1:${inferenceServer.port}/v1`, auth: "none",
	models: [{ id: "base", name: "Controlled child", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(path.join(cwd, ".omp", "agents", "owned-child.md"), [
	"---", 'name: "owned-child"', 'description: "Controlled reset-owner child"', 'model: "fixture/base"',
	"tools: [task, yield]", 'spawns: ["owned-child"]', "blocking: true", "---", "Return through yield immediately.", "",
].join("\n"));

let blockedFetches = 0;
const usageRoutes: string[] = [];
const usageBase = Math.floor(Date.now() / 1000) * 1000;
const usageFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	usageRoutes.push(url.pathname);
	assert.equal(url.hostname, "chatgpt.com");
	if (url.pathname.endsWith("/wham/usage")) {
		return Response.json({ plan_type: "plus", rate_limit: { allowed: true, limit_reached: false,
			primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: Math.floor((usageBase + 4 * 60 * 60 * 1000) / 1000) },
			secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: Math.floor((usageBase + 2 * 24 * 60 * 60 * 1000) / 1000) } },
			rate_limit_reset_credits: { available_count: 1 } });
	}
	if (url.pathname.endsWith("/wham/rate-limit-reset-credits")) {
		return Response.json({ available_count: 1, credits: [{ id: "credit-owned", status: "available", reset_type: "codex_rate_limits",
			granted_at: new Date(usageBase - 24 * 60 * 60 * 1000).toISOString(), expires_at: new Date(usageBase + 60 * 60 * 1000).toISOString() }] });
	}
	blockedFetches++;
	throw new Error(`Unexpected usage route: ${url.pathname}`);
}, { preconnect: () => {} }) as typeof fetch;

const native = await import("@oh-my-pi/pi-coding-agent");
const { AgentRegistry, AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings, SqliteAuthCredentialStore } = native;
const { AgentLifecycleManager } = await import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle");
const { defaultCodexAutoRedeemCoordinator } = await import("@oh-my-pi/pi-coding-agent/session/codex-auto-reset");
const { getAgentDbPath } = await import("@oh-my-pi/pi-utils");
const auth = new AuthStorage(await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir)), { usageFetch });
await auth.set("openai-codex", [{ type: "oauth", refresh: "fixture-refresh", access: "fixture-access", expires: usageBase + 24 * 60 * 60 * 1000,
	accountId: "acct-owned", email: "owned@example.com" }]);

type Entry = { phase: string; passId?: string; nativeSessionId?: string; trigger?: string; source?: string; agentRefId?: string; instanceId?: number; settingsIsRoot?: boolean };
class Owner implements CodexResetPolicyOwner {
	readonly entries: Entry[] = [];
	readonly #instances = new WeakMap<object, number>();
	readonly #passes = new Map<string, object>();
	#nextInstance = 1;
	#rootSettings: object | undefined;
	constructor(readonly name: string) {}
	attachRootSettings(settings: object): void { this.#rootSettings = settings; }
	async checkpoint(event: ResetCheckpoint): Promise<void> {
		const pass = event.phase === "planned" || event.phase === "answer" || event.phase === "setting-written" ? event.snapshot.pass : event.pass;
		const matches = AgentRegistry.global().list().filter(ref => ref.session?.sessionId === pass.nativeSessionId);
		assert.equal(matches.length, 1, `${this.name} must resolve exactly one live child for ${pass.nativeSessionId}`);
		const child = matches[0]!.session!;
		if (event.phase === "started") this.#passes.set(pass.passId, child);
		else assert.equal(this.#passes.get(pass.passId), child, `${this.name} must never rebind an existing pass`);
		let instanceId = this.#instances.get(child);
		if (instanceId === undefined) { instanceId = this.#nextInstance++; this.#instances.set(child, instanceId); }
		this.entries.push({ phase: event.phase, passId: pass.passId, nativeSessionId: pass.nativeSessionId, trigger: pass.trigger, source: pass.source,
			agentRefId: matches[0]!.id, instanceId, settingsIsRoot: child.settings === this.#rootSettings });
	}
	async presentDecision(_snapshot: ResetPlanSnapshot, selectNative: () => Promise<NativeResetAnswer>): Promise<void> { await selectNative(); }
	async admit(_snapshot: ResetPlanSnapshot, _actionIndex: number): Promise<ResetAdmission> { return { kind: "hold", reason: "owner-unavailable" }; }
	async complete(_permit: ResetPermit, _observation: ResetObservation): Promise<void> { assert.fail("Held fixture admission must not complete"); }
}

async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}
function resetSweepFixtureState(): void {
	defaultCodexAutoRedeemCoordinator.lastSweepAt = 0;
	defaultCodexAutoRedeemCoordinator.sweepInFlight = false;
	defaultCodexAutoRedeemCoordinator.sweepPromise = undefined;
	defaultCodexAutoRedeemCoordinator.inFlightByAccount.clear();
	defaultCodexAutoRedeemCoordinator.attemptedKeys.clear();
	defaultCodexAutoRedeemCoordinator.deferredUntilByKey.clear();
	defaultCodexAutoRedeemCoordinator.lastAttemptAtByAccount.clear();
}
async function runOwnedTask(label: string, owner: Owner | undefined) {
	const settings = await Settings.loadIsolated({ agentDir, cwd });
	const modelRegistry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
	const model = modelRegistry.find("fixture", "base"); assert.ok(model);
	const sessionManager = SessionManager.create(cwd, path.join(agentDir, `sessions-${label}`));
	const rootRegistry = new AgentRegistry();
	const created = await createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry, sessionManager, model,
		agentRegistry: rootRegistry,
		hasUI: false, interactivePrompts: false, disableExtensionDiscovery: true, extensions: [], enableLsp: false, enableMCP: false,
		toolNames: ["task"], skills: [], rules: [], contextFiles: [], systemPrompt: "Controlled owner propagation root.", codexResetPolicyOwner: owner });
	await sessionManager.ensureOnDisk();
	owner?.attachRootSettings(created.session.settings);
	const rootSessionId = created.session.sessionId;
	assert.equal(rootRegistry.get("Main")?.session, created.session);
	assert.equal(AgentRegistry.global().list().some(ref => ref.session === created.session), false, "Production-style root registry stays separate from TaskExecutor global children");
	const childId = `${label}-child`;
	const gate = Promise.withResolvers<void>(); responseGates.set(childId, gate);
	const originalFetch = globalThis.fetch;
	let nextInferenceId: string | undefined = childId;
	globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname !== "127.0.0.1") { blockedFetches++; throw new Error(`Nonlocal inference fetch blocked: ${url.origin}${url.pathname}`); }
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		assert.ok(nextInferenceId, "Every controlled inference request must have an expected child id");
		headers.set("x-agent-id", nextInferenceId); nextInferenceId = undefined;
		return originalFetch(input, { ...init, headers });
	}, { preconnect: () => {} }) as typeof fetch;
	try {
		const task = created.session.getToolByName("task"); assert.ok(task);
		const running = task.execute(`task-${label}`, { name: childId, agent: "owned-child", task: `Run controlled ${label} child.` });
		const initial = await waitFor(() => AgentRegistry.global().get(childId)?.session ?? undefined, `${label} initial child`);
		const initialSessionId = initial.sessionId;
		await waitFor(() => transportRequests.includes(childId) ? true : undefined, `${label} initial inference boundary`);
		let nestedSessionId: string | undefined;
		if (owner) {
			const nestedName = `${label}-nested`;
			const nestedId = `${childId}.${nestedName}`;
			const nestedGate = Promise.withResolvers<void>(); responseGates.set(nestedId, nestedGate); nextInferenceId = nestedId;
			const nestedTask = initial.getToolByName("task"); assert.ok(nestedTask);
			const runningNested = nestedTask.execute(`task-${nestedId}`, { name: nestedName, agent: "owned-child", task: `Run controlled ${label} nested child.` });
			const nested = await waitFor(() => AgentRegistry.global().get(nestedId)?.session ?? undefined, `${label} nested child`);
			nestedSessionId = nested.sessionId;
			resetSweepFixtureState();
			await nested.fetchUsageReportsWithResetPolicy({ source: "manual" });
			nestedGate.resolve(); responseGates.delete(nestedId);
			await runningNested;
		}
		let absentError: string | undefined;
		let initialPolicy: unknown;
		if (owner) {
			resetSweepFixtureState();
			initialPolicy = await initial.fetchUsageReportsWithResetPolicy({ source: "manual" });
		}
		else try { await initial.fetchUsageReportsWithResetPolicy({ source: "manual" }); } catch (error) { absentError = String(error); }
		gate.resolve(); responseGates.delete(childId);
		const taskResult = await running;
		assert.equal(taskResult.isError, undefined);
		let revivedSessionId: string | undefined;
		let revivedPolicy: unknown;
		let revivedConfig: unknown;
		if (owner) {
			await AgentLifecycleManager.global().park(childId);
			await waitFor(() => {
				const ref = AgentRegistry.global().get(childId);
				return ref?.status === "parked" && ref.session === null ? true : undefined;
			}, `${label} child park and detach`);
			const revived = await AgentLifecycleManager.global().ensureLive(childId);
			assert.notEqual(revived, initial, "Lifecycle revive must construct a replacement AgentSession instance");
			revivedSessionId = revived.sessionId;
			resetSweepFixtureState();
			revivedConfig = revived.settings.getGroup("codexResets");
			revivedPolicy = await revived.fetchUsageReportsWithResetPolicy({ source: "manual" });
			await revived.dispose();
		}
		await created.session.dispose();
		return { rootSessionId, initialSessionId, nestedSessionId, revivedSessionId, absentError, initialPolicy, revivedPolicy, revivedConfig };
	} finally {
		globalThis.fetch = originalFetch;
		gate.resolve();
	}
}

const ownerA = new Owner("owner-a");
const ownerB = new Owner("owner-b");
const ownedA = await runOwnedTask("owned-a", ownerA);
const unowned = await runOwnedTask("unowned", undefined);
const ownedB = await runOwnedTask("owned-b", ownerB);
inferenceServer.stop(true);

const ids = (owner: Owner) => owner.entries.filter(entry => entry.phase === "started").map(entry => entry.nativeSessionId);
assert.equal(ownerA.entries.some(entry => entry.nativeSessionId === ownedA.rootSessionId), false);
assert.equal(ownerB.entries.some(entry => entry.nativeSessionId === ownedB.rootSessionId), false);
assert.deepEqual(new Set(ids(ownerA)), new Set([ownedA.initialSessionId, ownedA.nestedSessionId, ownedA.revivedSessionId]));
assert.deepEqual(new Set(ids(ownerB)), new Set([ownedB.initialSessionId, ownedB.nestedSessionId, ownedB.revivedSessionId]));
assert.equal(ownerA.entries.filter(entry => entry.phase === "started").length, 3);
assert.equal(ownerB.entries.filter(entry => entry.phase === "started").length, 3);
assert.equal(ownerA.entries.some(entry => entry.settingsIsRoot !== false), false);
assert.equal(ownerB.entries.some(entry => entry.settingsIsRoot !== false), false);
for (const [owner, run] of [[ownerA, ownedA], [ownerB, ownedB]] as const) {
	const childStarts = owner.entries.filter(entry => entry.phase === "started" && entry.nativeSessionId === run.initialSessionId);
	assert.equal(childStarts.length, 2, "Initial and revived passes retain the real shared transcript session id");
	assert.equal(new Set(childStarts.map(entry => entry.instanceId)).size, 2, "Revival binds a new live AgentSession instance without rebinding the original pass");
	assert.equal(new Set(childStarts.map(entry => entry.agentRefId)).size, 1, "Lifecycle revival reuses the exact child AgentRef");
}
assert.equal(ownerA.entries.some(entry => ids(ownerB).includes(entry.nativeSessionId)), false);
assert.match(unowned.absentError ?? "", /requires a configured codexResetPolicyOwner/);
assert.equal(blockedFetches, 0);
console.log(JSON.stringify({ ownedA, ownedB, unowned, ownerA: ownerA.entries, ownerB: ownerB.entries, transportRequests, blockedFetches }));
