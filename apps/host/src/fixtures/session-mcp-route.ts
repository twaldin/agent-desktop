import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import type {
	CommandEnvelope,
	CommandResult,
	NativeSessionMcpResponse,
	SessionSummary,
} from "@agent-desktop/shared";
import { SESSION_MCP_OWNER_HEADER } from "@agent-desktop/shared";

type RpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string };

async function runMcpServer(): Promise<never> {
	const marker = process.env.AGENT_DESKTOP_MCP_ROUTE_MARKER;
	if (!marker) throw new Error("Missing isolated MCP marker.");
	appendFileSync(marker, "started\n", { mode: 0o600 });
	const send = (id: string | number, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of Bun.stdin.stream()) {
		buffered += decoder.decode(chunk, { stream: true });
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line) as RpcRequest;
			if (message.id === undefined) continue;
			switch (message.method) {
				case "initialize":
					send(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} },
						serverInfo: { name: "session-mcp-route", version: "1.0.0" } });
					break;
				case "tools/list":
					while (process.env.AGENT_DESKTOP_MCP_ROUTE_GATE && existsSync(process.env.AGENT_DESKTOP_MCP_ROUTE_GATE)) await Bun.sleep(5);
					send(message.id, { tools: [{ name: "route_tool", inputSchema: { type: "object" } }] });
					break;
				case "resources/list": send(message.id, { resources: [] }); break;
				case "resources/templates/list": send(message.id, { resourceTemplates: [] }); break;
				case "prompts/list": send(message.id, { prompts: [] }); break;
				case "tools/call": send(message.id, { content: [{ type: "text", text: "route fixture" }] }); break;
				default:
					process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
			}
		}
	}
	process.exit(0);
}

if (process.argv[2] === "--mcp-server") await runMcpServer();

const root = process.argv[2]!;
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "project");
const gates = path.join(root, "gates");
const marker = path.join(root, "mcp-starts.txt");
const gate = path.join(root, "hold-tools");
await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
const provider = fileURLToPath(new URL("../omp-workers/fixtures/mcp-provider.ts", import.meta.url));
await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(provider)}\nretry:\n  enabled: false\n`);
await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { route: {
	type: "stdio",
	command: process.execPath,
	args: [fileURLToPath(import.meta.url), "--mcp-server"],
	env: { AGENT_DESKTOP_MCP_ROUTE_MARKER: marker, AGENT_DESKTOP_MCP_ROUTE_GATE: gate },
	timeout: 5000,
} } }));

const options = {
	dataDirectory: path.join(root, "data"),
	agentDirectory: agentDir,
	discoveryDirectory: cwd,
	workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)),
	tailscale: false,
};
const { startHost } = await import("../server");
let host = await startHost(options);

async function command(envelope: CommandEnvelope): Promise<{ status: number; result: CommandResult }> {
	const response = await fetch(`${host.connection.origin}/v1/commands`, {
		method: "POST",
		headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" },
		body: JSON.stringify(envelope),
	});
	return { status: response.status, result: await response.json() as CommandResult };
}

async function mcp(sessionId: string, commandId?: string): Promise<{ status: number; owner: string | null; body: NativeSessionMcpResponse }> {
	const suffix = commandId ? `?commandId=${encodeURIComponent(commandId)}` : "";
	const response = await fetch(`${host.connection.origin}/v1/sessions/${encodeURIComponent(sessionId)}/mcp${suffix}`, {
		headers: { Authorization: `Bearer ${host.connection.token}`, [SESSION_MCP_OWNER_HEADER]: host.connection.hostId },
	});
	const body = await response.json();
	if (!response.ok) throw new Error(`MCP metadata request failed with ${response.status}: ${JSON.stringify(body)}`);
	return { status: response.status, owner: response.headers.get(SESSION_MCP_OWNER_HEADER), body: body as NativeSessionMcpResponse };
}

async function create(id: string): Promise<SessionSummary> {
	const response = await command({ id, command: { type: "session.create", projectId: null, cwd,
		model: { provider: "mcp-contract", id: "controlled" } } });
	assert(response.result.ok);
	return response.result.value as SessionSummary;
}

async function waitConnected(sessionId: string): Promise<NativeSessionMcpResponse> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const current = await mcp(sessionId);
		if (current.body.value?.servers[0]?.status === "connected") return current.body;
		await Bun.sleep(10);
	}
	throw new Error("Native MCP session did not connect.");
}

function starts(): Promise<number> {
	return readFile(marker, "utf8").then(value => value.trim().split("\n").filter(Boolean).length, () => 0);
}

try {
	const session = await create("create-session-mcp");
	const otherSession = await create("create-other-session-mcp");
	const initial = await waitConnected(session.id);
	await waitConnected(otherSession.id);
	assert.equal(initial.hostId, host.connection.hostId);
	assert.equal((await mcp(session.id)).owner, host.connection.hostId);
	const rejectedOwner = await fetch(`${host.connection.origin}/v1/sessions/${encodeURIComponent(session.id)}/mcp`, {
		headers: { Authorization: `Bearer ${host.connection.token}` },
	});
	assert.equal(rejectedOwner.status, 409);
	const baselineStarts = await starts(); assert.equal(baselineStarts, 2);

	await writeFile(gate, "hold");
	const reload: CommandEnvelope = { id: "reload-once", command: { type: "session.mcp.reload", sessionId: session.id,
		epoch: initial.value!.epoch, expectedRevision: initial.value!.revision } };
	const reloadRequest = command(reload);
	let pendingSeen = false;
	for (let index = 0; index < 100 && !pendingSeen; index++) {
		const inspected = await mcp(session.id, reload.id);
		pendingSeen = inspected.body.receipt?.state === "pending";
		if (!pendingSeen) await Bun.sleep(2);
	}
	assert.equal(pendingSeen, true);
	await rm(gate);
	const completed = await reloadRequest;
	assert.equal(completed.status, 200); assert(completed.result.ok);
	const launched = await starts(); assert.equal(launched, baselineStarts + 1);
	assert.equal((await mcp(session.id, reload.id)).body.receipt?.state, "succeeded");
	assert.equal((await mcp(otherSession.id, reload.id)).body.receipt?.state, "absent");
	assert.deepEqual((await command(reload)).result, completed.result);
	assert.equal(await starts(), launched);

	const stale = await command({ id: "reload-stale", command: { type: "session.mcp.reload", sessionId: session.id,
		epoch: initial.value!.epoch, expectedRevision: initial.value!.revision } });
	assert(stale.result && !stale.result.ok); assert.equal(stale.result.error.code, "COMMAND_FAILED");
	assert.equal((await mcp(session.id, "reload-stale")).body.receipt?.state, "failed");
	assert.equal(await starts(), launched);
	assert.equal((await mcp(session.id, "missing-command")).body.receipt?.state, "absent");
	assert.equal((await mcp(session.id, "create-session-mcp")).body.receipt?.state, "absent");

	const current = await waitConnected(session.id);
	const lost: CommandEnvelope = { id: "reload-lost-receipt", command: { type: "session.mcp.reload", sessionId: session.id,
		epoch: current.value!.epoch, expectedRevision: current.value!.revision } };
	const databasePath = path.join(root, "data", "state.sqlite");
	const database = new Database(databasePath);
	database.exec("CREATE TRIGGER reject_mcp_command_receipt BEFORE UPDATE ON commands WHEN OLD.id = 'reload-lost-receipt' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
	const lostResult = await command(lost);
	assert(lostResult.result && !lostResult.result.ok); assert.equal(lostResult.result.error.code, "OUTCOME_UNKNOWN");
	assert.equal(await starts(), launched + 1);
	assert.equal((await mcp(session.id, lost.id)).body.receipt?.state, "unknown");
	database.close();

	await host.stop();
	const beforeRestart = await starts();
	host = await startHost(options);
	assert.equal(await starts(), beforeRestart);
	const recovered = await mcp(session.id, lost.id);
	assert.equal(recovered.status, 200);
	assert.equal(recovered.body.receipt?.state, "unknown");
	assert.equal(recovered.body.value, null);
	assert("unavailable" in recovered.body);
	assert.equal(await starts(), beforeRestart);
	assert.equal((await command(lost)).result.ok, false);
	assert.equal(await starts(), beforeRestart);
	await writeFile(path.join(root, "session-mcp-route.passed"), "native session MCP HTTP contracts passed\n");
} finally {
	await rm(gate, { force: true });
	await host.stop();
}
