import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConfig, MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";

const roots: string[] = [];
const managers: MCPManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.disconnectAll()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function connectedManager(): Promise<{ manager: MCPManager; config: MCPServerConfig }> {
	const root = await mkdtemp(join(tmpdir(), "agent-desktop-mcp-reconnect-"));
	roots.push(root);
	const config: MCPServerConfig = {
		type: "stdio",
		command: process.execPath,
		args: [join(import.meta.dir, "fixtures/mcp-server.ts")],
	};
	const manager = new MCPManager(root, null, async () => ({
		configs: { fixture: config },
		sources: { fixture: { provider: "fixture", providerName: "Fixture", path: join(root, "mcp.json"), level: "project" } },
		exaApiKeys: [],
	}));
	managers.push(manager);
	await manager.discoverAndConnect();
	await manager.waitForConnection("fixture");
	return { manager, config };
}

test("auth reconnect passes the invoking signal and reports the actual connection exactly once", async () => {
	const { manager, config } = await connectedManager();
	const abort = new AbortController();
	const observed: Array<MCPServerConnection | null> = [];
	let handlerCalls = 0;
	manager.setAuthHandler(async (name, challenge, context) => {
		handlerCalls += 1;
		expect(name).toBe("fixture");
		expect(challenge.wwwAuthenticate).toEqual(["Bearer scope=fixture"]);
		expect(context?.signal).toBe(abort.signal);
		context?.onReconnect(connection => observed.push(connection));
		return config;
	});

	const connection = await manager.reconnectServer("fixture", {
		authChallenge: { wwwAuthenticate: ["Bearer scope=fixture"] },
		signal: abort.signal,
	});
	expect(connection).not.toBeNull();
	expect(handlerCalls).toBe(1);
	expect(observed).toEqual([connection]);
});

test("abort while authorization is pending prevents config adoption and reports a null reconnect once", async () => {
	const { manager, config } = await connectedManager();
	const abort = new AbortController();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const observed: Array<MCPServerConnection | null> = [];
	manager.setAuthHandler(async (_name, _challenge, context) => {
		context?.onReconnect(connection => observed.push(connection));
		started.resolve();
		await release.promise;
		return { ...config, env: { AFTER_ABORT: "must-not-be-adopted" } };
	});

	const pending = manager.reconnectServer("fixture", {
		authChallenge: { wwwAuthenticate: ["Bearer scope=fixture"] },
		signal: abort.signal,
	});
	await started.promise;
	abort.abort(new Error("cancel native authorization fixture"));
	expect(await pending).toBeNull();
	expect(observed).toEqual([null]);
	expect(manager.getServerConfig("fixture")).toEqual(config);
	release.resolve();
	await Bun.sleep(0);
	expect(observed).toEqual([null]);
	expect(manager.getServerConfig("fixture")).toEqual(config);
});

test("disconnectAll during authorization fences the late config and reports no recreated connection", async () => {
	const { manager, config } = await connectedManager();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const observed: Array<MCPServerConnection | null> = [];
	manager.setAuthHandler(async (_name, _challenge, context) => {
		context?.onReconnect(connection => observed.push(connection));
		started.resolve();
		await release.promise;
		return { ...config, env: { STALE_CONFIG: "must-not-be-adopted" } };
	});

	const pending = manager.reconnectServer("fixture", {
		authChallenge: { wwwAuthenticate: ["Bearer scope=fixture"] },
	});
	await started.promise;
	await manager.disconnectAll();
	release.resolve();
	expect(await pending).toBeNull();
	expect(observed).toEqual([null]);
	expect(manager.getServerConfig("fixture")).toBeUndefined();
	expect(manager.getConnectionStatus("fixture")).toBe("disconnected");
});

test("a tool authorization challenge forwards its signal and retries the native call exactly once", async () => {
	const abort = new AbortController();
	let firstCalls = 0;
	let secondCalls = 0;
	let reconnectSignal: AbortSignal | undefined;
	const connection = (request: () => unknown): MCPServerConnection => ({
		name: "fixture",
		config: { type: "http", url: "http://127.0.0.1/fixture" },
		serverInfo: { name: "fixture", version: "1" },
		capabilities: { tools: {} },
		transport: { connected: true, request: async () => request(), notify: async () => {}, close: async () => {} },
	} as MCPServerConnection);
	const initial = connection(() => {
		firstCalls += 1;
		return { isError: true, content: [{ type: "text", text: "Authorization required" }], _meta: { "mcp/www_authenticate": ["Bearer scope=fixture"] } };
	});
	const reconnected = connection(() => {
		secondCalls += 1;
		return { content: [{ type: "text", text: "authorized result" }] };
	});
	const tool = new MCPTool(initial, { name: "protected", inputSchema: { type: "object" } }, async options => {
		reconnectSignal = options?.signal;
		return reconnected;
	});

	const result = await tool.execute("call", {}, undefined, {} as never, abort.signal);
	expect(reconnectSignal).toBe(abort.signal);
	expect(firstCalls).toBe(1);
	expect(secondCalls).toBe(1);
	expect(result.content).toEqual([{ type: "text", text: "authorized result" }]);
});
