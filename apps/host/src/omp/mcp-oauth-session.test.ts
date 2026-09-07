import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { LoadMCPConfigsResult } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getMCPConfigPath, refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import { NativeSessionMcp } from "./mcp-session";

const roots: string[] = [];
const managers: MCPManager[] = [];
const controllers: NativeSessionMcp[] = [];
const servers: Bun.Server<unknown>[] = [];
const databases: Database[] = [];
let savedAgentDir: string | undefined;

beforeEach(() => { savedAgentDir = process.env.PI_CODING_AGENT_DIR; });
afterEach(async () => {
	await Promise.all(controllers.splice(0).map(controller => controller.dispose()));
	await Promise.all(managers.splice(0).map(manager => manager.disconnectAll()));
	await Promise.all(servers.splice(0).map(server => server.stop(true)));
	for (const database of databases.splice(0)) database.close();
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	refreshDirsFromEnv();
});

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function unusedPort(): Promise<number> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
	const port = server.port!;
	await server.stop(true);
	return port;
}

function oauthFixture(options: { protectedTool?: boolean; rejectReconnect?: boolean; alwaysChallenge?: boolean } = {}) {
	const requests: Array<{ path: string; method: string; authorization: string | null }> = [];
	let issued = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const url = new URL(request.url);
		const authorization = request.headers.get("authorization");
		if (url.pathname === "/mcp") {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = await request.json() as { id?: number; method: string };
			requests.push({ path: url.pathname, method: body.method, authorization });
			if (!options.protectedTool && authorization !== "Bearer session-oauth-access") return new Response("authorization required", {
				status: 401,
				headers: { "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/protected", scope="fixture:read"` },
			});
			if (body.method === "initialize" && issued && options.rejectReconnect) return new Response("reconnect rejected", { status: 503 });
			if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: {
				protocolVersion: "2025-03-26", capabilities: options.protectedTool ? { tools: {} } : {}, serverInfo: { name: "session-oauth", version: "1" },
			} });
			if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: {
				tools: [{ name: "tool", description: "Protected fixture read", inputSchema: { type: "object", properties: {} } }],
			} });
			if (body.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, result:
				authorization === "Bearer session-oauth-access" && !options.alwaysChallenge
					? { content: [{ type: "text", text: "Native authorized tool completed." }] }
					: { isError: true, content: [{ type: "text", text: "Authorization required" }],
						_meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${url.origin}/protected", scope="fixture:read"`] } },
			});
			return new Response(null, { status: 202 });
		}
		requests.push({ path: url.pathname, method: request.method, authorization });
		if (url.pathname === "/protected" || url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin], scopes_supported: ["fixture:read"] });
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({
			issuer: url.origin,
			authorization_endpoint: `${url.origin}/authorize`,
			token_endpoint: `${url.origin}/token`,
			client_id: "session-oauth-client",
		});
		if (url.pathname === "/token") {
			issued++;
			return Response.json({ access_token: "session-oauth-access", refresh_token: "session-oauth-refresh", expires_in: 3600, token_type: "Bearer" });
		}
		return new Response(null, { status: 404 });
	} });
	servers.push(server);
	return { origin: `http://127.0.0.1:${server.port}`, requests, issued: () => issued };
}

async function harness(options: { existingCredentialId?: string; protectedTool?: boolean; rejectReconnect?: boolean; alwaysChallenge?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "agent-desktop-mcp-oauth-session-"));
	roots.push(root);
	const cwd = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	refreshDirsFromEnv();
	await mkdir(cwd, { recursive: true });
	await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	const fixture = oauthFixture(options);
	const callbackPort = await unusedPort();
	const configPath = getMCPConfigPath("user", cwd);
	const config: MCPServerConfig = {
		type: "http",
		url: `${fixture.origin}/mcp`,
		oauth: { clientId: "session-oauth-client", callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback` },
		...(options.existingCredentialId ? { auth: { type: "oauth", credentialId: options.existingCredentialId } } : {}),
	};
	await writeFile(configPath, json({ marker: "preserved", mcpServers: { fixture: config } }));
	const database = new Database(":memory:");
	databases.push(database);
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(database));
	const loader = async (): Promise<LoadMCPConfigsResult> => {
		const parsed = JSON.parse(await readFile(configPath, "utf8"));
		return {
			configs: { fixture: parsed.mcpServers.fixture },
			sources: { fixture: { provider: "fixture", providerName: "Session OAuth fixture", path: configPath, level: "user" } },
			exaApiKeys: [],
		};
	};
	const manager = new MCPManager(cwd, null, loader);
	managers.push(manager);
	manager.setAuthStorage(authStorage);
	await manager.discoverAndConnect();
	const calls = { refresh: 0 };
	const session = {
		settings: { get: () => true },
		getEvalPreludes: () => [],
		effectiveExtensionRoots: { explicit: [], configured: [], configuredLevel: "user", mode: "merge" },
		setMCPPromptCommands: () => {},
		refreshMCPTools: async () => { calls.refresh++; },
	} as unknown as AgentSession;
	const controller = new NativeSessionMcp(session, manager);
	controllers.push(controller);
	return { root, cwd, fixture, callbackPort, configPath, config, authStorage, manager, controller, calls };
}

async function waitForManual(operation: ReturnType<NativeSessionMcp["startAuthorization"]>) {
	for (let attempt = 0; attempt < 400; attempt++) {
		const snapshot = operation.snapshot();
		const prompt = snapshot.login.prompts.find(item => item.kind === "manual-code");
		if (snapshot.login.auth && prompt) return { auth: snapshot.login.auth, prompt };
		if (["failed", "cancelled", "succeeded"].includes(snapshot.status)) throw new Error(`Authorization finished before manual input: ${JSON.stringify(snapshot)}`);
		await Bun.sleep(5);
	}
	throw new Error("Native authorization did not request a manual redirect.");
}

function completeManually(operation: ReturnType<NativeSessionMcp["startAuthorization"]>, pending: Awaited<ReturnType<typeof waitForManual>>) {
	const auth = new URL(pending.auth.url);
	const redirect = new URL(auth.searchParams.get("redirect_uri")!);
	redirect.searchParams.set("code", "session-oauth-code");
	redirect.searchParams.set("state", auth.searchParams.get("state")!);
	operation.respond(pending.prompt.requestId, { value: redirect.toString() });
	return () => operation.respond(pending.prompt.requestId, { value: redirect.toString() });
}

describe("native session MCP authorization", () => {
	test("manual redirect stores the grant, updates an existing auth pointer, reconnects, and responds only once", async () => {
		const value = await harness({ existingCredentialId: "mcp_oauth:old-pointer" });
		const old = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
		await value.authStorage.set("mcp_oauth:old-pointer", old);
		const before = value.controller.read();
		const snapshots: unknown[] = [];
		const operation = value.controller.startAuthorization({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" }, {
			cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {}, notify: snapshot => snapshots.push(snapshot),
		});
		expect(value.controller.getAuthorization()).toBe(operation);
		const pending = await waitForManual(operation);
		const duplicate = completeManually(operation, pending);
		expect(duplicate).toThrow("no longer pending");
		const result = await operation.completion;
		expect(result).toMatchObject({ status: "succeeded", phase: "finished", credentialsStored: true, credentialWrite: "stored", configuration: "saved", reconnected: true });
		const id = mcpOAuthCredentialId(value.config.url!);
		expect(value.authStorage.get(id)).toMatchObject({ type: "oauth", access: "session-oauth-access", refresh: "session-oauth-refresh" });
		expect(value.authStorage.get("mcp_oauth:old-pointer")).toEqual(old);
		const saved = JSON.parse(await readFile(value.configPath, "utf8"));
		expect(saved).toMatchObject({ marker: "preserved", mcpServers: { fixture: { auth: { type: "oauth", credentialId: id } } } });
		expect(value.manager.getConnectionStatus("fixture")).toBe("connected");
		expect(value.fixture.issued()).toBe(1);
		expect(JSON.stringify(snapshots)).not.toContain("session-oauth-access");
		expect(JSON.stringify(snapshots)).not.toContain("session-oauth-refresh");
	});

	test("an already-correct definition remains byte-identical while authorization replaces its private credential", async () => {
		const value = await harness();
		const id = mcpOAuthCredentialId(value.config.url!);
		const bytes = await readFile(value.configPath, "utf8");
		const before = value.controller.read();
		const operation = value.controller.startAuthorization({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" }, {
			cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {},
		});
		completeManually(operation, await waitForManual(operation));
		expect(await operation.completion).toMatchObject({ status: "succeeded", configuration: "not-needed" });
		expect(value.authStorage.get(id)).toMatchObject({ access: "session-oauth-access" });
		expect(await readFile(value.configPath, "utf8")).toBe(bytes);
	});

	test("a stale native config is rejected before credential storage and retains the old grant", async () => {
		const value = await harness({ existingCredentialId: "mcp_oauth:old-pointer" });
		const old = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
		await value.authStorage.set("mcp_oauth:old-pointer", old);
		const before = value.controller.read();
		const operation = value.controller.startAuthorization({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" }, {
			cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {},
		});
		const pending = await waitForManual(operation);
		const parsed = JSON.parse(await readFile(value.configPath, "utf8"));
		parsed.concurrentEdit = true;
		await writeFile(value.configPath, json(parsed));
		completeManually(operation, pending);
		const result = await operation.completion;
		expect(result).toMatchObject({ status: "failed", credentialsStored: false, credentialWrite: "not-started", configuration: "untouched" });
		expect(value.authStorage.get("mcp_oauth:old-pointer")).toEqual(old);
		expect(value.authStorage.get(mcpOAuthCredentialId(value.config.url!))).toBeUndefined();
	});

	test("cancellation and disposal release callback listeners, retain credentials, and do not reconnect", async () => {
		for (const mode of ["cancel", "dispose"] as const) {
			const value = await harness({ existingCredentialId: "mcp_oauth:old-pointer" });
			const old = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
			await value.authStorage.set("mcp_oauth:old-pointer", old);
			const before = value.controller.read();
			const operation = value.controller.startAuthorization({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" }, {
				cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {},
			});
			await waitForManual(operation);
			if (mode === "cancel") value.controller.cancelAuthorization();
			else await value.controller.dispose();
			expect(await operation.completion).toMatchObject({ status: "cancelled", credentialsStored: false, reconnected: false });
			expect(value.authStorage.get("mcp_oauth:old-pointer")).toEqual(old);
			const rebound = Bun.serve({ hostname: "127.0.0.1", port: value.callbackPort, fetch: () => new Response("rebound") });
			await rebound.stop(true);
		}
	});

	test("authorization owns the mutation ticket and serializes duplicate authorization and reload", async () => {
		const value = await harness();
		const before = value.controller.read();
		const ticket = { epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" };
		const operation = value.controller.startAuthorization(ticket, { cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {} });
		expect(() => value.controller.startAuthorization(ticket, { cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {} }))
			.toThrow("already pending");
		const staleReload = value.controller.reload({ epoch: ticket.epoch, expectedRevision: ticket.expectedRevision });
		completeManually(operation, await waitForManual(operation));
		expect((await operation.completion).status).toBe("succeeded");
		await expect(staleReload).rejects.toThrow("changed before reload");
		expect(value.fixture.issued()).toBe(1);
	});
	test("cancellation after credential storage reports the partial result without config save or reconnect", async () => {
		const value = await harness({ existingCredentialId: "mcp_oauth:old-pointer" });
		const bytes = await readFile(value.configPath, "utf8");
		const before = value.controller.read();
		const operation = value.controller.startAuthorization({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" }, {
			cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {},
			notify: snapshot => { if (snapshot.phase === "saving") value.controller.cancelAuthorization(); },
		});
		completeManually(operation, await waitForManual(operation));
		expect(await operation.completion).toMatchObject({ status: "cancelled", credentialWrite: "stored", credentialsStored: true, configuration: "untouched", reconnected: false });
		expect(value.authStorage.get(mcpOAuthCredentialId(value.config.url!))).toMatchObject({ access: "session-oauth-access" });
		expect(await readFile(value.configPath, "utf8")).toBe(bytes);
		expect(value.calls.refresh).toBe(0);
	});

	test("an unacknowledged store write remains unknown and cannot claim unchanged credentials or reconnect", async () => {
		const value = await harness();
		const bytes = await readFile(value.configPath, "utf8");
		const nativeSet = value.authStorage.set.bind(value.authStorage);
		// Failure injection after the actual native store write reproduces an
		// acknowledgement loss; the adapter cannot infer rollback from a throw.
		value.authStorage.set = async (...args) => { await nativeSet(...args); throw new Error("private store acknowledgement failed"); };
		const before = value.controller.read();
		const operation = value.controller.startAuthorization({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" }, {
			cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {},
		});
		completeManually(operation, await waitForManual(operation));
		const result = await operation.completion;
		expect(result).toMatchObject({ status: "failed", credentialWrite: "unknown", credentialsStored: false, configuration: "untouched", reconnected: false });
		expect(result.error).not.toContain("retained");
		expect(JSON.stringify(result)).not.toContain("private store acknowledgement");
		expect(value.authStorage.get(mcpOAuthCredentialId(value.config.url!))).toMatchObject({ access: "session-oauth-access" });
		expect(await readFile(value.configPath, "utf8")).toBe(bytes);
		expect(value.calls.refresh).toBe(0);
	});

	test("an observer exception cannot orphan an active native callback or poison the MCP queue", async () => {
		const value = await harness();
		const before = value.controller.read();
		const operation = value.controller.startAuthorization({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" }, {
			cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {}, notify: () => { throw new Error("observer detached"); },
		});
		await waitForManual(operation);
		await value.controller.dispose();
		expect((await operation.completion).status).toBe("cancelled");
		const rebound = Bun.serve({ hostname: "127.0.0.1", port: value.callbackPort, fetch: () => new Response("rebound") });
		await rebound.stop(true);
	});

});

async function toolHarness(options: { rejectReconnect?: boolean; alwaysChallenge?: boolean } = {}) {
	const value = await harness({ ...options, protectedTool: true });
	await value.manager.waitForConnection("fixture");
	for (let i = 0; i < 200 && !value.manager.getTools().length; i++) await Bun.sleep(5);
	expect(value.manager.getTools()).toHaveLength(1);
	let callbacks = 0;
	value.manager.setAuthHandler(async (name, challenge, context) => {
		callbacks++;
		if (!context) throw new Error("Missing native reconnect lifecycle");
		const pending = value.controller.startToolAuthorization(name, challenge, context, {
			cwd: value.cwd, authStorage: value.authStorage, assertOwner: () => {},
		});
		return pending.config;
	});
	const execute = (signal?: AbortSignal) => value.manager.getTools()[0]!.execute(crypto.randomUUID(), {}, undefined, {} as never, signal);
	const pending = async () => {
		for (let i = 0; i < 400; i++) {
			const operation = value.controller.getAuthorization();
			if (operation) return { operation, manual: await waitForManual(operation) };
			await Bun.sleep(5);
		}
		throw new Error("Native tool did not request authorization");
	};
	return { ...value, execute, pending, callbacks: () => callbacks };
}

describe("session-owned native tool authorization", () => {
	test("real protected tool resumes once through the native manager without a full reload", async () => {
		const value = await toolHarness();
		const epoch = value.controller.read().epoch;
		const run = value.execute();
		const { operation, manual } = await value.pending();
		expect(operation.snapshot()).toMatchObject({ status: "running", reconnected: false, credentialWrite: "not-started" });
		completeManually(operation, manual);
		expect((await run).content).toEqual([{ type: "text", text: "Native authorized tool completed." }]);
		expect(await operation.completion).toMatchObject({ status: "succeeded", reconnected: true, credentialsStored: true });
		expect(value.callbacks()).toBe(1);
		expect(value.fixture.issued()).toBe(1);
		expect(value.fixture.requests.filter(row => row.method === "tools/call").map(row => row.authorization)).toEqual([null, "Bearer session-oauth-access"]);
		expect(value.calls.refresh).toBe(0); // Native manager owns registry updates; no adapter rediscovery.
		expect(value.controller.read().epoch).toBe(epoch);
	});


	test("two simultaneous tools share native server authorization and each retries only its own call", async () => {
		const value = await toolHarness();
		const runs = [value.execute(), value.execute()];
		const { operation, manual } = await value.pending();
		for (let i=0;i<200&&value.fixture.requests.filter(row=>row.method==="tools/call").length<2;i++) await Bun.sleep(5);
		expect(value.fixture.requests.filter(row => row.method === "tools/call")).toHaveLength(2);
		completeManually(operation, manual);
		for (const result of await Promise.all(runs)) expect(result.content).toEqual([{ type: "text", text: "Native authorized tool completed." }]);
		expect(await operation.completion).toMatchObject({ status: "succeeded", reconnected: true });
		expect(value.callbacks()).toBe(1);
		expect(value.fixture.issued()).toBe(1);
		expect(value.fixture.requests.filter(row => row.method === "tools/call")).toHaveLength(4);
	});

	test("a discarded native manager cannot receive a grant from its stale consent card", async () => {
		const value = await toolHarness();
		const bytes = await readFile(value.configPath, "utf8");
		const run = value.execute();
		const { operation, manual } = await value.pending();
		await value.manager.disconnectAll();
		completeManually(operation, manual);
		await run;
		expect(await operation.completion).toMatchObject({ status: "failed", credentialsStored: false, credentialWrite: "not-started", configuration: "untouched", reconnected: false });
		expect(value.fixture.requests.filter(row => row.method === "tools/call")).toHaveLength(1);
		expect(await readFile(value.configPath, "utf8")).toBe(bytes);
	});

	test.each(["tool-abort", "cancel", "dispose"])("%s before consent settles the original call without a token or retry", async mode => {
		const value = await toolHarness();
		const bytes = await readFile(value.configPath, "utf8");
		const abort = new AbortController();
		const run = value.execute(abort.signal).then(result => ({ result }), error => ({ error }));
		const { operation } = await value.pending();
		if (mode === "tool-abort") abort.abort();
		else if (mode === "dispose") await value.controller.dispose();
		else operation.cancel();
		const completed = await Promise.race([run, Bun.sleep(1500).then(() => "timeout")]);
		expect(completed).not.toBe("timeout");
		expect(await operation.completion).toMatchObject({ status: "cancelled", credentialsStored: false, reconnected: false });
		expect(value.fixture.issued()).toBe(0);
		expect(value.fixture.requests.filter(row => row.method === "tools/call")).toHaveLength(1);
		expect(await readFile(value.configPath, "utf8")).toBe(bytes);
		const rebound = Bun.serve({ hostname: "127.0.0.1", port: value.callbackPort, fetch: () => new Response(null) });
		await rebound.stop(true);
	});

	test("stored credentials do not imply a successful native reconnect or a tool retry", async () => {
		const value = await toolHarness({ rejectReconnect: true });
		const run = value.execute();
		const { operation, manual } = await value.pending();
		completeManually(operation, manual);
		await run;
		expect(await operation.completion).toMatchObject({ status: "failed", credentialsStored: true, reconnected: false, configuration: "not-needed" });
		expect(value.fixture.issued()).toBe(1);
		expect(value.fixture.requests.filter(row => row.method === "tools/call")).toHaveLength(1);
	}, 20_000);

	test("a second protected error does not trigger another authorization or replay", async () => {
		const value = await toolHarness({ alwaysChallenge: true });
		const run = value.execute();
		const { operation, manual } = await value.pending();
		completeManually(operation, manual);
		const result = await run;
		expect(JSON.stringify(result)).toContain("Authorization required");
		expect(await operation.completion).toMatchObject({ status: "succeeded", reconnected: true });
		expect(value.callbacks()).toBe(1);
		expect(value.fixture.requests.filter(row => row.method === "tools/call")).toHaveLength(2);
	});
});
