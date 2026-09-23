// Runs the original-session admission contract in a disposable native copy.
// Accepts either the pinned pre-slice tree or the already-installed final net
// patch. Never edits node_modules, the lock, CLI selection or retained profiles.
// Optional first argument selects one exact named contract check.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const repository = path.resolve(import.meta.dir, "../../..");
const base = path.join(repository, ".data/temp/original-session-admission");
const source = await realpath(path.join(repository, "node_modules/@oh-my-pi/pi-coding-agent"));
const slice = path.join(import.meta.dir, "original-session-admission.patch");
const baseline = JSON.parse(await readFile(path.join(import.meta.dir, "baseline.json"), "utf8")) as {
	version: string;
	modified: Record<string, string>;
	authored: Record<string, string>;
	sliceSha256: string;
};

const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

assert.equal(JSON.parse(await readFile(path.join(source, "package.json"), "utf8")).version, baseline.version);
let installedIsAuthored = true;
for (const [file, hash] of Object.entries(baseline.authored)) {
	try { if (await digest(path.join(source, file)) !== hash) installedIsAuthored = false; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		installedIsAuthored = false;
	}
}
const installedManifest = installedIsAuthored ? baseline.authored : baseline.modified;
for (const [file, hash] of Object.entries(installedManifest)) {
	assert.equal(await digest(path.join(source, file)), hash, `Native baseline drift: ${file}`);
}
assert.equal(await digest(slice), baseline.sliceSha256, "Slice patch does not match its recorded digest");

await mkdir(base, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(path.join(base, "admission-check-"));
const packageRoot = path.join(directory, "package");
const runRoot = path.join(directory, "run");
await cp(source, packageRoot, { recursive: true, errorOnExist: true, force: false });
await symlink(path.resolve(source, "../.."), path.join(packageRoot, "node_modules"));

let patchOutput = "Installed native package already matches the authored admission slice.";
if (!installedIsAuthored) {
	const patch = Bun.spawn(["/usr/bin/patch", "--batch", "--fuzz=0", "-p1", "-i", slice], {
		cwd: packageRoot, stdout: "pipe", stderr: "pipe",
	});
	const [patchCode, output, patchError] = await Promise.all([
		patch.exited, new Response(patch.stdout).text(), new Response(patch.stderr).text(),
	]);
	assert.equal(patchCode, 0, patchError);
	assert.ok(!/offset|fuzz/i.test(output), "Slice patch did not apply exactly");
	patchOutput = output;
}
for (const [file, hash] of Object.entries(baseline.authored)) {
	assert.equal(await digest(path.join(packageRoot, file)), hash, `Staged native drift: ${file}`);
}

await mkdir(path.join(runRoot, "agent"), { recursive: true, mode: 0o700 });
await writeFile(
	path.join(directory, "provenance.json"),
	`${JSON.stringify({ checkedAt: new Date().toISOString(), baseline, installedIsAuthored, packageRoot, patchOutput }, null, 2)}\n`,
	{ mode: 0o600 },
);

const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "original-admission-contract.ts"), runRoot, ...process.argv.slice(2)], {
	cwd: runRoot,
	env: {
		HOME: runRoot,
		PI_CODING_AGENT_DIR: path.join(runRoot, "agent"),
		ORIGINAL_ADMISSION_PACKAGE: packageRoot,
		PATH: process.env.PATH,
		TMPDIR: runRoot,
		TERM: "dumb",
		SHELL: "/bin/sh",
	},
	stdout: "inherit",
	stderr: "inherit",
});
process.exitCode = await child.exited;

for (const [file, hash] of Object.entries(installedManifest)) {
	assert.equal(await digest(path.join(source, file)), hash, `Installed package changed during the run: ${file}`);
}
console.log(JSON.stringify({ directory, packageRoot, runRoot }, null, 2));
