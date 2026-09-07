import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("native slash reauth waits for actual OAuth, deduplicates admission and cancels on Stop", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-mcp-authorization-slash-")));
	try {
		const child = Bun.spawn([
			process.execPath,
			fileURLToPath(new URL("./fixtures/mcp-authorization-route.ts", import.meta.url)),
			root, "--slash",
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
		expect(await readFile(path.join(root, "slash-authorization.passed"), "utf8"))
			.toBe("native slash reauth, receipt dedupe and Stop passed\n");
		expect(stderr).toBe("");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
