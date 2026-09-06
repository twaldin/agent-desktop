import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("authenticated host reloads a live session MCP manager once and exposes durable scoped receipts", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-session-mcp-route-")));
	try {
		const child = Bun.spawn([
			process.execPath,
			fileURLToPath(new URL("./fixtures/session-mcp-route.ts", import.meta.url)),
			root,
		], {
			cwd: root,
			env: {
				HOME: root,
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				MCP_CONTRACT_GATES: path.join(root, "gates"),
				PATH: process.env.PATH,
				SHELL: "/bin/sh",
				TMPDIR: tmpdir(),
				TERM: "dumb",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, , stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).arrayBuffer(),
			new Response(child.stderr).text(),
		]);
		if (code !== 0) throw new Error(`Isolated native MCP route failed: ${stderr}`);
		expect(await readFile(path.join(root, "session-mcp-route.passed"), "utf8"))
			.toBe("native session MCP HTTP contracts passed\n");
		expect(stderr).toBe("");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
