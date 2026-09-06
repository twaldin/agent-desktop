export {};

type RpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string };

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
		switch (message.method) {
			case "initialize":
				send(message.id, {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {}, resources: {}, prompts: {} },
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
				send(message.id, { resources: [{ uri: "fixture://resource", name: "Fixture resource" }] });
				break;
			case "resources/templates/list":
				send(message.id, { resourceTemplates: [{ uriTemplate: "fixture://{id}", name: "Fixture template" }] });
				break;
			case "prompts/list":
				send(message.id, { prompts: [{ name: "fixture_prompt", description: "Fixture prompt" }] });
				break;
			default:
				process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
		}
	}
}
