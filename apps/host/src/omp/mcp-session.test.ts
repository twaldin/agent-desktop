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
