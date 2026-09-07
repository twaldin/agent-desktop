import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { LoadMCPConfigsOptions, LoadMCPConfigsResult } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { NativeSessionMcp } from "./mcp-session";

const roots: string[] = [];
const managers: MCPManager[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.disconnectAll()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const source = (path: string): SourceMeta => ({
	provider: "test",
	providerName: "Disposable fixture",
	path,
	level: "project",
});

function session(options?: { browser?: boolean; projectConfig?: boolean }) {
	const calls = { prompts: [] as unknown[][], tools: [] as unknown[][] };
	const value = {
		settings: { get: (key: string) => key === "mcp.enableProjectConfig" ? options?.projectConfig : undefined },
		getEvalPreludes: () => options?.browser ? [{ name: "browser" }] : [],
		effectiveExtensionRoots: { explicit: ["/fixture/explicit"], mode: "merge", configured: [], configuredLevel: "project" },
		setMCPPromptCommands: (commands: unknown[]) => calls.prompts.push(commands),
		refreshMCPTools: async (tools: unknown[]) => { calls.tools.push(tools); },
	} as unknown as AgentSession;
	return { value, calls };
}

async function actualManager(root: string, capture: LoadMCPConfigsOptions[]) {
	const marker = join(root, "started.txt");
	const fixture = join(import.meta.dir, "fixtures", "mcp-server.ts");
	const loader = async (_cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> => {
		capture.push(structuredClone(options ?? {}));
		const toolName = capture.length === 1 ? "fixture_tool" : "changed_tool";
		return {
			configs: { fixture: { type: "stdio", command: process.execPath, args: [fixture], env: {
				AGENT_DESKTOP_MCP_TEST_MARKER: marker,
				AGENT_DESKTOP_MCP_TEST_RESOURCE_DELAY: "50",
				AGENT_DESKTOP_MCP_TEST_TOOL: toolName,
			} } },
			sources: { fixture: source(join(root, ".mcp.json")) },
			exaApiKeys: [],
		};
	};
	const manager = new MCPManager(root, null, loader);
	managers.push(manager);
	return { manager, marker };
}

async function waitForCatalog(controller: NativeSessionMcp) {
	for (let index = 0; index < 200; index++) {
		const snapshot = controller.read();
		if (snapshot.servers[0]?.resourceCount === 1 && snapshot.servers[0]?.promptCount === 1) return snapshot;
		await Bun.sleep(5);
	}
	throw new Error("Disposable MCP catalog did not settle.");
}

async function markerLines(path: string): Promise<string[]> {
	for (let index = 0; index < 200; index++) {
		const value = await readFile(path, "utf8").catch(() => "");
		if (value.trim()) return value.trim().split("\n");
		await Bun.sleep(5);
	}
	throw new Error("Disposable MCP marker did not appear.");
}

async function waitForResourceRequest(path: string, uri: string): Promise<void> {
	for (let index = 0; index < 200; index++) {
		const rows = (await readFile(path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
		if (rows.some(row => row.method === "resources/read" && row.params?.uri === uri)) return;
		await Bun.sleep(5);
	}
	throw new Error("Disposable MCP resource request did not appear.");
}

test("reload uses native discovery filters and publishes only live MCP metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-desktop-mcp-session-")); roots.push(root);
	const options: LoadMCPConfigsOptions[] = [];
	const { manager, marker } = await actualManager(root, options);
	const nativeSession = session({ browser: true, projectConfig: false });
	const controller = new NativeSessionMcp(nativeSession.value, manager);
	const initial = controller.read();
	const reloaded = await controller.reload({ epoch: initial.epoch, expectedRevision: initial.revision });
	const settled = await waitForCatalog(controller);

	expect(options).toEqual([{
		enableProjectConfig: false,
		filterExa: true,
		filterBrowser: true,
		extensionRoots: { explicit: ["/fixture/explicit"], mode: "merge", configured: [], configuredLevel: "project" },
	}]);
	expect(nativeSession.calls.prompts).toEqual([[]]);
	expect(nativeSession.calls.tools).toHaveLength(1);
	expect(reloaded.available).toBe(true);
	expect(reloaded.servers[0]).toMatchObject({ resourceCount: null, promptCount: null, resources: null, resourceTemplates: null, prompts: null });
	expect(settled.servers).toHaveLength(1);
	expect(settled.servers[0]).toMatchObject({
		name: "fixture",
		status: "connected",
		source: "Disposable fixture (project)",
		tools: ["mcp__fixture_tool"],
		resourceCount: 1,
		promptCount: 1,
		resources: [{ uri: "fixture://resource", name: "Fixture resource" }],
		resourceTemplates: [{ uriTemplate: "fixture://{id}", name: "Fixture template" }],
		prompts: [{ name: "fixture_prompt", description: "Fixture prompt" }],
	});
	expect(settled.servers[0]?.notifications).toMatchObject({ enabled: false, subscriptions: [] });
	expect(controller.read().revision).toBe(settled.revision);
	expect((await readFile(marker, "utf8")).trim().split("\n")).toEqual(["started"]);
	const toolResult = await manager.getTools()[0]!.execute("fixture-call", {}, undefined, {} as never);
	expect(toolResult).toMatchObject({ content: [{ type: "text", text: "fixture tool invoked" }] });

	const ticket = { epoch: settled.epoch, expectedRevision: settled.revision };
	const againPromise = controller.reload(ticket);
	const duplicate = controller.reload(ticket);
	const again = await againPromise;
	await expect(duplicate).rejects.toThrow("changed before reload");
	const changed = await waitForCatalog(controller);
	expect(again.epoch).toBe(initial.epoch);
	expect(changed.servers[0]?.tools).toEqual(["mcp__fixture_changed_tool"]);
	expect((await readFile(marker, "utf8")).trim().split("\n")).toEqual(["started", "started"]);
});

test("epoch and revision are checked before reload effects and concurrent callers cannot both pass", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-desktop-mcp-session-fence-")); roots.push(root);
	const options: LoadMCPConfigsOptions[] = [];
	const { manager, marker } = await actualManager(root, options);
	const nativeSession = session();
	const controller = new NativeSessionMcp(nativeSession.value, manager);
	const initial = controller.read();

	await expect(controller.reload({ epoch: "other", expectedRevision: initial.revision })).rejects.toThrow("changed before reload");
	expect(nativeSession.calls.prompts).toHaveLength(0);
	const first = controller.reload({ epoch: initial.epoch, expectedRevision: initial.revision });
	const second = controller.reload({ epoch: initial.epoch, expectedRevision: initial.revision });
	await first;
	await expect(second).rejects.toThrow("changed before reload");
	expect(nativeSession.calls.prompts).toHaveLength(1);
	expect(options[0]?.enableProjectConfig).toBe(true);
	expect((await readFile(marker, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("unavailable and native connection failures reveal no configuration error details", async () => {
	const nativeSession = session();
	const unavailable = new NativeSessionMcp(nativeSession.value, undefined);
	const initial = unavailable.read();
	expect(initial).toMatchObject({ available: false, servers: [], reason: "Native MCP manager is unavailable for this session." });
	await expect(unavailable.reload({ epoch: initial.epoch, expectedRevision: initial.revision })).rejects.toThrow("unavailable");

	const root = await mkdtemp(join(tmpdir(), "agent-desktop-mcp-session-failure-")); roots.push(root);
	const secret = "private-token-value";
	const manager = new MCPManager(root, null, async () => ({
		configs: { broken: { type: "stdio", command: "" } },
		sources: { broken: source(join(root, secret, ".mcp.json")) },
		exaApiKeys: [],
	}));
	managers.push(manager);
	const controller = new NativeSessionMcp(nativeSession.value, manager);
	const before = controller.read();
	const result = await controller.reload({ epoch: before.epoch, expectedRevision: before.revision });
	const serialized = JSON.stringify(result);
	expect(result.servers).toEqual([{
		name: "broken",
		status: "disconnected",
		source: "Disposable fixture (project)",
		tools: [],
		resourceCount: null,
		promptCount: null,
		resources: null,
		resourceTemplates: null,
		prompts: null,
		notifications: null,
		error: "Native MCP server could not connect.",
	}]);
	expect(serialized).not.toContain(secret);
	expect(serialized).not.toContain("command");

	const throwingManager = new MCPManager(root, null, async () => { throw new Error(`credential ${secret}`); });
	managers.push(throwingManager);
	const throwing = new NativeSessionMcp(nativeSession.value, throwingManager);
	const throwingBefore = throwing.read();
	await expect(throwing.reload({ epoch: throwingBefore.epoch, expectedRevision: throwingBefore.revision }))
		.rejects.toThrow("Native MCP reload failed.");
	const throwingAfter = throwing.read();
	expect(throwingAfter.revision).toBeGreaterThan(throwingBefore.revision);
	expect(JSON.stringify(throwingAfter)).not.toContain(secret);
	expect(throwingAfter.servers).toEqual([]);
});

test("a native discovery exception clears both prompt commands and tools without leaking its cause", async () => {
 const root=await mkdtemp(join(tmpdir(),"agent-mcp-discovery-error-")); roots.push(root);
 const manager=new MCPManager(root,null,async()=>{throw new Error('Authorization: private-discovery-value');});managers.push(manager);
 const nativeSession=session();const controller=new NativeSessionMcp(nativeSession.value,manager);const before=controller.read();
 await expect(controller.reload({epoch:before.epoch,expectedRevision:before.revision})).rejects.toThrow('Native MCP reload failed.');
 expect(nativeSession.calls.prompts).toEqual([[],[]]);expect(nativeSession.calls.tools).toEqual([[]]);
 expect(controller.read().revision).toBeGreaterThan(before.revision);
 await expect(controller.reload({epoch:before.epoch,expectedRevision:before.revision})).rejects.toThrow('changed before reload');
});

test("connected unsupported catalogs are measured empty while identities stay exact", () => {
	const connection = { capabilities: { tools: { listChanged: true } } };
	const manager = {
		getTools: () => [{ mcpServerName: " server ", name: " tool " }],
		getAllServerNames: () => [" server "],
		getConnectionStatus: () => "connected",
		getConnection: () => connection,
		getSource: () => undefined,
		getNotificationState: () => ({ enabled: true, subscriptions: new Map() }),
	} as unknown as MCPManager;
	const snapshot = new NativeSessionMcp(session().value, manager).read();
	expect(snapshot.servers).toEqual([{
		name: " server ", status: "connected", source: "Native MCP", tools: [" tool "],
		resourceCount: 0, promptCount: 0, resources: [], resourceTemplates: [], prompts: [],
		notifications: { enabled: true, toolsListChanged: true, resourcesListChanged: false, promptsListChanged: false, resourceSubscribe: false, subscriptions: [] },
	}]);
});

test("manual reconnect restarts only its exact native server and consumes one serialized ticket", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-desktop-mcp-reconnect-")); roots.push(root);
	const fixture = join(import.meta.dir, "fixtures", "mcp-server.ts");
	const alphaMarker = join(root, "alpha.txt");
	const betaMarker = join(root, "beta.txt");
	const manager = new MCPManager(root, null, async () => ({
		configs: {
			alpha: { type: "stdio", command: process.execPath, args: [fixture], env: { AGENT_DESKTOP_MCP_TEST_MARKER: alphaMarker, AGENT_DESKTOP_MCP_TEST_TOOL: "alpha_tool" } },
			beta: { type: "stdio", command: process.execPath, args: [fixture], env: { AGENT_DESKTOP_MCP_TEST_MARKER: betaMarker, AGENT_DESKTOP_MCP_TEST_TOOL: "beta_tool" } },
		},
		sources: { alpha: source(join(root, "alpha.json")), beta: source(join(root, "beta.json")) }, exaApiKeys: [],
	}));
	managers.push(manager);
	const nativeSession = session();
	const controller = new NativeSessionMcp(nativeSession.value, manager);
	const initial = controller.read();
	await controller.reload({ epoch: initial.epoch, expectedRevision: initial.revision });
	expect(await markerLines(alphaMarker)).toEqual(["started"]);
	expect(await markerLines(betaMarker)).toEqual(["started"]);

	const before = controller.read();
	const reconnected = await controller.reconnect({ epoch: before.epoch, expectedRevision: before.revision, serverName: "alpha" });
	expect(await markerLines(alphaMarker)).toEqual(["started", "started"]);
	expect(await markerLines(betaMarker)).toEqual(["started"]);
	expect(reconnected.servers.map(server => [server.name, server.status])).toEqual([["alpha", "connected"], ["beta", "connected"]]);
	expect(nativeSession.calls.tools.at(-1)?.map(tool => (tool as { mcpServerName: string }).mcpServerName).sort()).toEqual(["alpha", "beta"]);

	await expect(controller.reconnect({ epoch: before.epoch, expectedRevision: before.revision, serverName: "alpha" })).rejects.toThrow("changed before reconnect");
	const current = controller.read();
	await expect(controller.reconnect({ epoch: current.epoch, expectedRevision: current.revision, serverName: " alpha " })).rejects.toThrow("not part of this session");
	expect(await markerLines(alphaMarker)).toEqual(["started", "started"]);
	expect(await markerLines(betaMarker)).toEqual(["started"]);
});

test("failed reconnect is generic, refreshes the post-attempt registry, and keeps unrelated servers", async () => {
	const statuses = new Map<string, "connected" | "connecting" | "disconnected">([["target", "connected"], ["other", "connected"]]);
	const calls: string[] = [];
	const tools = [{ mcpServerName: "target", name: "target_tool" }, { mcpServerName: "other", name: "other_tool" }];
	const manager = {
		getTools: () => tools,
		getAllServerNames: () => ["target", "other"],
		getConnectionStatus: (name: "target" | "other") => statuses.get(name),
		getConnection: (name: "target" | "other") => statuses.get(name) === "connected" ? { capabilities: {} } : undefined,
		getSource: () => undefined,
		getNotificationState: () => ({ enabled: false, subscriptions: new Map() }),
		reconnectServer: async (name: string) => { calls.push(name); statuses.set("target", "disconnected"); return null; },
	} as unknown as MCPManager;
	const nativeSession = session();
	const controller = new NativeSessionMcp(nativeSession.value, manager);
	const before = controller.read();
	await expect(controller.reconnect({ epoch: before.epoch, expectedRevision: before.revision, serverName: "target" })).rejects.toThrow("Native MCP reconnect failed.");
	expect(calls).toEqual(["target"]);
	expect(nativeSession.calls.tools.at(-1)).toEqual(tools);
	const failed = controller.read();
	expect(failed.revision).toBeGreaterThan(before.revision);
	expect(failed.servers.find(server => server.name === "target")).toMatchObject({ status: "disconnected", error: "Native MCP server could not connect." });
	expect(failed.servers.find(server => server.name === "other")).toMatchObject({ status: "connected" });
	expect(failed.servers.find(server => server.name === "other")?.error).toBeUndefined();

	statuses.set("target", "connected");
	expect(controller.read().servers.find(server => server.name === "target")?.error).toBeUndefined();
});

test("resource reads use the exact live server and URI without restart or revision consumption", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-desktop-mcp-resource-")); roots.push(root);
	const marker = join(root, "started.txt");
	const requests = join(root, "requests.jsonl");
	const fixture = join(import.meta.dir, "fixtures", "mcp-server.ts");
	const manager = new MCPManager(root, null, async () => ({
		configs: { fixture: { type: "stdio", command: process.execPath, args: [fixture], env: {
			AGENT_DESKTOP_MCP_TEST_MARKER: marker, AGENT_DESKTOP_MCP_TEST_REQUESTS: requests, AGENT_DESKTOP_MCP_TEST_READ_DELAY: "80",
		} } },
		sources: { fixture: source(join(root, ".mcp.json")) }, exaApiKeys: [],
	}));
	managers.push(manager);
	const controller = new NativeSessionMcp(session().value, manager);
	const initial = controller.read();
	await controller.reload({ epoch: initial.epoch, expectedRevision: initial.revision });
	const before = await waitForCatalog(controller);
	const request = { epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture", uri: "fixture://custom value" };
	expect(await controller.readResource(request)).toEqual({ contents: [{ uri: "fixture://custom value", mimeType: "text/plain", text: "Fixture contents for fixture://custom value" }] });
	expect(controller.read().revision).toBe(before.revision);
	expect(await controller.readResource({ ...request, uri: "fixture://binary" })).toEqual({ contents: [{ uri: "fixture://binary", mimeType: "application/octet-stream", blob: "AAEC/w==" }] });
	expect(await markerLines(marker)).toEqual(["started"]);
	const raceRead = controller.readResource({ ...request, uri: "fixture://race" });
	const raceReconnect = controller.reconnect({ epoch: request.epoch, expectedRevision: request.expectedRevision, serverName: request.serverName });
	await waitForResourceRequest(requests, "fixture://race");
	expect(await markerLines(marker)).toEqual(["started"]);
	expect(await raceRead).toEqual({ contents: [{ uri: "fixture://race", mimeType: "text/plain", text: "Fixture contents for fixture://race" }] });
	await raceReconnect;
	expect(await markerLines(marker)).toEqual(["started", "started"]);
	const resourceRequests = (await readFile(requests, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.method === "resources/read");
	expect(resourceRequests).toEqual([
		{ method: "resources/read", params: { uri: "fixture://custom value" } },
		{ method: "resources/read", params: { uri: "fixture://binary" } },
		{ method: "resources/read", params: { uri: "fixture://race" } },
	]);
});

test("resource read preflight and native failures are fail-closed and reveal no native error", async () => {
	let status: "connected" | "disconnected" = "connected";
	let reads = 0;
	let outcome: unknown = { contents: [{ uri: "fixture://one", text: "safe" }] };
	const manager = {
		getTools: () => [], getAllServerNames: () => ["fixture"], getConnectionStatus: () => status,
		getConnection: () => status === "connected" ? { capabilities: { resources: {} } } : undefined,
		getSource: () => undefined, getNotificationState: () => ({ enabled: false, subscriptions: new Map() }),
		readServerResource: async () => { reads++; if (outcome instanceof Error) throw outcome; return outcome; },
	} as unknown as MCPManager;
	const controller = new NativeSessionMcp(session().value, manager);
	const before = controller.read();
	await expect(controller.readResource({ epoch: "stale", expectedRevision: before.revision, serverName: "fixture", uri: "fixture://one" })).rejects.toThrow("changed before resource read");
	await expect(controller.readResource({ epoch: before.epoch, expectedRevision: before.revision, serverName: "missing", uri: "fixture://one" })).rejects.toThrow("not part of this session");
	expect(reads).toBe(0);

	status = "disconnected";
	const disconnected = controller.read();
	await expect(controller.readResource({ epoch: disconnected.epoch, expectedRevision: disconnected.revision, serverName: "fixture", uri: "fixture://one" })).rejects.toThrow("not connected");
	expect(reads).toBe(0);

	status = "connected";
	outcome = new Error("Authorization: private-token-value");
	const failed = controller.read();
	await expect(controller.readResource({ epoch: failed.epoch, expectedRevision: failed.revision, serverName: "fixture", uri: "fixture://one" })).rejects.toThrow("Native MCP resource read failed.");
	outcome = { contents: [{ uri: "fixture://one", text: "x".repeat(2 * 1024 * 1024) }] };
	const oversized = controller.read();
	await expect(controller.readResource({ epoch: oversized.epoch, expectedRevision: oversized.revision, serverName: "fixture", uri: "fixture://one" })).rejects.toThrow("Native MCP resource read failed.");
	expect(reads).toBe(2);
});

test("resource reads serialize with reconnect without consuming their shared ticket", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const calls: string[] = [];
	const connection = { capabilities: { resources: {} } };
	const manager = {
		getTools: () => [], getAllServerNames: () => ["fixture"], getConnectionStatus: () => "connected",
		getConnection: () => connection, getSource: () => undefined,
		getNotificationState: () => ({ enabled: false, subscriptions: new Map() }),
		readServerResource: async () => { calls.push("read"); await gate; return { contents: [{ uri: "fixture://one", text: "one" }] }; },
		reconnectServer: async () => { calls.push("reconnect"); return connection; },
	} as unknown as MCPManager;
	const controller = new NativeSessionMcp(session().value, manager);
	const before = controller.read();
	const request = { epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture", uri: "fixture://one" };
	const read = controller.readResource(request);
	const reconnect = controller.reconnect(request);
	await Bun.sleep(0);
	expect(calls).toEqual(["read"]);
	release();
	expect(await read).toEqual({ contents: [{ uri: "fixture://one", text: "one" }] });
	await reconnect;
	expect(calls).toEqual(["read", "reconnect"]);
});

test("a real unanswered stdio resource read times out and releases queued reads and reconnect", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-desktop-mcp-resource-timeout-")); roots.push(root);
	const marker = join(root, "started.txt");
	const fixture = join(import.meta.dir, "fixtures", "mcp-server.ts");
	const manager = new MCPManager(root, null, async () => ({
		configs: { fixture: { type: "stdio", command: process.execPath, args: [fixture], env: { AGENT_DESKTOP_MCP_TEST_MARKER: marker } } },
		sources: { fixture: source(join(root, ".mcp.json")) }, exaApiKeys: [],
	}));
	managers.push(manager);
	const controller = new NativeSessionMcp(session().value, manager);
	const initial = controller.read();
	await controller.reload({ epoch: initial.epoch, expectedRevision: initial.revision });
	const before = await waitForCatalog(controller);
	const base = { epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" };
	const startedAt = performance.now();
	const hanging = controller.readResource({ ...base, uri: "fixture://hang" });
	await expect(hanging).rejects.toThrow("Native MCP resource read failed.");
	const elapsed = performance.now() - startedAt;
	expect(elapsed).toBeGreaterThanOrEqual(29_000);
	expect(elapsed).toBeLessThan(36_000);
	const afterTimeout = controller.read();
	const following = controller.readResource({ epoch: afterTimeout.epoch, expectedRevision: afterTimeout.revision, serverName: "fixture", uri: "fixture://after-timeout" });
	const reconnect = controller.reconnect({ epoch: afterTimeout.epoch, expectedRevision: afterTimeout.revision, serverName: "fixture" });
	expect(await following).toEqual({ contents: [{ uri: "fixture://after-timeout", mimeType: "text/plain", text: "Fixture contents for fixture://after-timeout" }] });
	await reconnect;
	expect(await markerLines(marker)).toEqual(["started", "started"]);

	// Reconnect returns before native resource/prompt enrichment completes.
	// Wait for this fixture's measured catalog before taking the next ticket;
	// a stale revision must still be rejected by the production controller.
	const current = await waitForCatalog(controller);
	await expect(controller.readResource({ epoch: current.epoch, expectedRevision: current.revision, serverName: "fixture", uri: "fixture://missing" }))
		.rejects.toThrow("Native MCP resource read failed.");
	expect(await controller.readResource({ epoch: current.epoch, expectedRevision: current.revision, serverName: "fixture", uri: "fixture://still-alive" }))
		.toEqual({ contents: [{ uri: "fixture://still-alive", mimeType: "text/plain", text: "Fixture contents for fixture://still-alive" }] });
}, 40_000);
