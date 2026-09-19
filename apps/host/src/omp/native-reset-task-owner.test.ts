import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("native TaskExecutor children and lifecycle revives retain their original reset-policy owner", async () => {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-task-reset-owner-")));
	try {
		const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./fixtures/native-reset-task-owner.ts", import.meta.url)), directory], {
			cwd: directory,
			stdout: "pipe",
			stderr: "pipe",
			env: { HOME: directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: directory, TERM: "dumb", NO_COLOR: "1",
				PI_DISABLE_DOTENV: "1", PI_NO_TITLE: "1", PI_TELEMETRY_DISABLED: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent"),
				XDG_CONFIG_HOME: path.join(directory, "xdg-config"), XDG_DATA_HOME: path.join(directory, "xdg-data"),
				XDG_CACHE_HOME: path.join(directory, "xdg-cache"), XDG_STATE_HOME: path.join(directory, "xdg-state") },
		});
		const deadline = setTimeout(() => child.kill(), 45_000);
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		clearTimeout(deadline);
		if (code !== 0) throw new Error(`Native child-owner fixture failed (${code}):\n${stdout}\n${stderr}`);
		const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
		expect(result.blockedFetches).toBe(0);
		expect(result.unowned.absentError).toContain("requires a configured codexResetPolicyOwner");
		expect(result.ownerA.filter((entry: { phase: string }) => entry.phase === "started")).toHaveLength(3);
		expect(result.ownerB.filter((entry: { phase: string }) => entry.phase === "started")).toHaveLength(3);
		expect(result.ownerA.every((entry: { settingsIsRoot: boolean }) => entry.settingsIsRoot === false)).toBe(true);
		expect(result.ownerB.every((entry: { settingsIsRoot: boolean }) => entry.settingsIsRoot === false)).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);
