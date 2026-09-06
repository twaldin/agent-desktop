import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const repository = path.resolve(import.meta.dir, "../../..");
const artifact = JSON.parse(await readFile(path.join(import.meta.dir, "artifact.json"), "utf8"));
const source = await realpath(path.join(homedir(), `.bun/install/cache/@oh-my-pi/pi-coding-agent@${artifact.version}@@@1`));
const selected = (await readdir(path.join(repository, "node_modules/.bun"))).find(name =>
	name.startsWith(`@oh-my-pi+pi-coding-agent@${artifact.version}+`),
);
assert(selected);
const dependencies = await realpath(path.join(repository, "node_modules/.bun", selected, "node_modules"));
for (const [file, digest] of Object.entries(artifact.baselineFiles)) {
	assert.equal(createHash("sha256").update(await readFile(path.join(source, file))).digest("hex"), digest);
}
const base = path.join(repository, ".data/temp/omp-browser-create");
await mkdir(base, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(path.join(base, "candidate-check-"));
const packageRoot = path.join(directory, "package");
const runRoot = path.join(directory, "run");
await cp(source, packageRoot, { recursive: true, errorOnExist: true, force: false });
await symlink(dependencies, path.join(packageRoot, "node_modules"));
await mkdir(runRoot, { recursive: true, mode: 0o700 });
const patchPath = path.resolve(import.meta.dir, artifact.patch);
assert.equal(createHash("sha256").update(await readFile(patchPath)).digest("hex"), artifact.patchSha256);
const patch = Bun.spawn(["/usr/bin/patch", "--batch", "--fuzz=0", "-p1", "-i", patchPath], {
	cwd: packageRoot,
	stdout: "pipe",
	stderr: "pipe",
});
const [code, stdout, stderr] = await Promise.all([
	patch.exited,
	new Response(patch.stdout).text(),
	new Response(patch.stderr).text(),
]);
assert.equal(code, 0, stderr);
assert(!/offset|fuzz/i.test(stdout));
for (const [file, digest] of Object.entries(artifact.patchedFiles)) {
	assert.equal(createHash("sha256").update(await readFile(path.join(packageRoot, file))).digest("hex"), digest);
}

async function browserExecutable(): Promise<string> {
	if (
		process.env.PUPPETEER_EXECUTABLE_PATH &&
		(await stat(process.env.PUPPETEER_EXECUTABLE_PATH).catch(() => undefined))?.isFile()
	) return process.env.PUPPETEER_EXECUTABLE_PATH;
	for (const root of [path.join(homedir(), ".omp/puppeteer/chrome"), path.join(homedir(), ".cache/puppeteer/chrome")]) {
		for (const version of (await readdir(root).catch(() => [])).sort().reverse()) {
			const candidate = path.join(
				root,
				version,
				"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
			);
			if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
		}
	}
	throw new Error("No existing Chrome for Testing executable");
}

await writeFile(
	path.join(directory, "provenance.json"),
	JSON.stringify({
		checkedAt: new Date().toISOString(),
		artifact,
		patchSha256: createHash("sha256").update(await readFile(patchPath)).digest("hex"),
		patchOutput: stdout,
	}, null, 2),
	{ mode: 0o600 },
);
const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "create-contract.ts"), runRoot], {
	cwd: runRoot,
	env: {
		PATH: process.env.PATH,
		HOME: runRoot,
		TMPDIR: runRoot,
		TERM: "dumb",
		SHELL: "/bin/sh",
		BROWSER_CREATE_NATIVE_PACKAGE: packageRoot,
		PUPPETEER_EXECUTABLE_PATH: await browserExecutable(),
		PI_BROWSER_CMUX: "0",
		PI_BROWSER_RELAY: "0",
	},
	stdout: "inherit",
	stderr: "inherit",
});
assert.equal(await child.exited, 0, `Candidate contract failed; inspect ${directory}`);
const result = await Bun.file(path.join(runRoot, "result.json")).json();
assert.equal(result.passed, true);
for (const [file, digest] of Object.entries(artifact.baselineFiles)) {
	assert.equal(createHash("sha256").update(await readFile(path.join(source, file))).digest("hex"), digest);
}
console.log(JSON.stringify({ passed: true, checks: result.checks.length, result: path.join(runRoot, "result.json") }));
