import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ProbeResult {
	loaded: Record<string, boolean>;
	homePreserved: boolean;
	agentDirPreserved: boolean;
	managedRolePreserved: boolean;
	explicitParseWorks: boolean;
	childValuePreserved: boolean;
	execArgvNoEnvFile: boolean;
}

test("managed native imports opt out of automatic dotenv while interactive imports retain it", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-no-dotenv-")));
	const testHome = path.join(root, "home"), project = path.join(root, "project"), agent = path.join(root, "agent");
	try {
		for (const directory of [testHome, project, agent, path.join(testHome, ".omp")]) await mkdir(directory, { recursive: true });
		await writeFile(path.join(project, ".env"), [
			"PROJECT_DOTENV_SENTINEL=present",
			"PI_CONFIG_FILES=/injected/config.yml",
			"OPENAI_API_KEY=fixture-only",
			"MANAGED_ROLE=dotenv",
			"",
		].join("\n"));
		await writeFile(path.join(agent, ".env"), "AGENT_DOTENV_SENTINEL=present\n");
		await writeFile(path.join(testHome, ".omp", ".env"), "CONFIG_DOTENV_SENTINEL=present\n");
		await writeFile(path.join(testHome, ".env"), "HOME_DOTENV_SENTINEL=present\n");
		const explicitFile = path.join(root, "explicit.env");
		await writeFile(explicitFile, "EXPLICIT_PARSE_SENTINEL=present\n");
		const probe = fileURLToPath(new URL("./fixtures/dotenv-isolation-probe.ts", import.meta.url));
		const baseEnvironment = {
			HOME: testHome,
			PI_CODING_AGENT_DIR: agent,
			EXPECTED_AGENT_DIR: agent,
			MANAGED_ROLE: "explicit",
			PATH: process.env.PATH,
		};
		const run = async (name: string, args: string[], cwd: string, extra: Record<string, string> = {}): Promise<ProbeResult> => {
			const child = Bun.spawn([process.execPath, ...args, probe, project, explicitFile], {
				cwd, env: { ...baseEnvironment, ...extra }, stdout: "pipe", stderr: "pipe",
			});
			let timedOut = false;
			const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2_000);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
			]);
			clearTimeout(deadline);
			if (timedOut || exitCode !== 0) throw new Error(`${name} failed${timedOut ? " after blocking on dotenv" : ""}: ${stderr}`);
			return JSON.parse(stdout) as ProbeResult;
		};

		const normal = await run("normal", [], project);
		const bunDisabled = await run("bun-disabled", ["--no-env-file"], project);

		// Starting this process outside the project prevents Bun itself from seeing
		// the project dotenv. The FIFO then proves both pi-utils automatic paths
		// return without opening it when only the SDK opt-in is supplied.
		await rename(path.join(project, ".env"), path.join(project, ".env.regular"));
		const fifo = Bun.spawnSync(["mkfifo", path.join(project, ".env")]);
		expect(fifo.exitCode).toBe(0);
		const sdkDisabled = await run("sdk-disabled", [], root, { PI_DISABLE_DOTENV: "1" });

		const names = ["PROJECT_DOTENV_SENTINEL", "AGENT_DOTENV_SENTINEL", "CONFIG_DOTENV_SENTINEL", "HOME_DOTENV_SENTINEL", "PI_CONFIG_FILES", "OPENAI_API_KEY"];
		expect(names.every(name => normal.loaded[name])).toBe(true);
		for (const result of [bunDisabled, sdkDisabled]) {
			expect(names.some(name => result.loaded[name])).toBe(false);
			expect(result).toMatchObject({ homePreserved: true, agentDirPreserved: true, managedRolePreserved: true,
				explicitParseWorks: true, childValuePreserved: true });
		}
		expect(bunDisabled.execArgvNoEnvFile).toBe(true);
		expect(sdkDisabled.execArgvNoEnvFile).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
