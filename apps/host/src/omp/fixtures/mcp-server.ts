export {};

type RpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: { name?: string; uri?: string; arguments?: Record<string, string> } };

if (process.env.AGENT_DESKTOP_MCP_TEST_MARKER) {
	await Bun.write(
		process.env.AGENT_DESKTOP_MCP_TEST_MARKER,
		`${await Bun.file(process.env.AGENT_DESKTOP_MCP_TEST_MARKER).text().catch(() => "")}started\n`,
	);
}

const send = (id: string | number, result: unknown) => {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

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
		if (process.env.AGENT_DESKTOP_MCP_TEST_REQUESTS) {
			const { appendFileSync } = await import("node:fs");
			appendFileSync(process.env.AGENT_DESKTOP_MCP_TEST_REQUESTS, JSON.stringify({ method: message.method, params: message.params }) + "\n");
		}
		switch (message.method) {
			case "initialize":
				send(message.id, {
					protocolVersion: "2025-11-25",
					capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true } },
					serverInfo: { name: "agent-desktop-test-mcp", version: "1.0.0" },
				});
				break;
			case "tools/list":
				send(message.id, { tools: [{ name: process.env.AGENT_DESKTOP_MCP_TEST_TOOL ?? "fixture_tool", description: "Fixture tool", inputSchema: { type: "object" } }] });
				break;
			case "tools/call":
				send(message.id, { content: [{ type: "text", text: "fixture tool invoked" }] });
				break;
			case "resources/list":
				if (process.env.AGENT_DESKTOP_MCP_TEST_RESOURCE_DELAY) {
					await Bun.sleep(Number(process.env.AGENT_DESKTOP_MCP_TEST_RESOURCE_DELAY));
				}
				send(message.id, { resources: [{ uri: "fixture://resource", name: "Fixture resource", description: "A resource from this live connection", mimeType: "text/plain" }] });
				break;
			case "resources/templates/list":
				send(message.id, { resourceTemplates: [{ uriTemplate: "fixture://{id}", name: "Fixture template", description: "Select a fixture identifier", mimeType: "text/plain" }] });
				break;
			case "resources/read":
				if (message.params?.uri === "fixture://hang") break;
				if (message.params?.uri === "fixture://missing") {
					process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Fixture resource not found" } })}\n`);
					break;
				}
				if (process.env.AGENT_DESKTOP_MCP_TEST_READ_DELAY) await Bun.sleep(Number(process.env.AGENT_DESKTOP_MCP_TEST_READ_DELAY));
				send(message.id, { contents: message.params?.uri === "fixture://binary"
					? [{ uri: "fixture://binary", mimeType: "application/octet-stream", blob: "AAEC/w==" }]
					: [{ uri: message.params?.uri ?? "fixture://missing", mimeType: "text/plain", text: `Fixture contents for ${message.params?.uri ?? "missing"}` }] });
				break;
			case "prompts/list":
				send(message.id, { prompts: [{ name: "fixture_prompt", description: "Fixture prompt", arguments: [{ name: "topic", description: "Subject for this prompt", required: true }] }] });
				break;
			case "prompts/get":
				send(message.id, { messages: message.params?.arguments?.topic === "empty" ? [] : [{ role: "user", content: { type: "text", text: `Native MCP prompt topic: ${message.params?.arguments?.topic ?? "none"}` } }] });
				break;
			case "resources/subscribe":
			case "resources/unsubscribe":
				send(message.id, {});
				break;
			default:
				process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
		}
	}
}
