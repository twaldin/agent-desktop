// Explicit native patch experiment. Never edits root node_modules or selects a
// normal CLI command; runs actual copied SessionManager APIs without providers.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const repository = path.resolve(import.meta.dir, "../.."), base = path.join(repository, ".data/temp/omp-ownership-native");
const source = await realpath(path.join(repository, "node_modules/@oh-my-pi/pi-coding-agent"));
const baseline = JSON.parse(await readFile(path.join(import.meta.dir, "baseline.json"), "utf8"));
assert.equal(JSON.parse(await readFile(path.join(source, "package.json"), "utf8")).version, baseline.version);
for (const [file, hash] of Object.entries(baseline.files)) assert.equal(createHash("sha256").update(await readFile(path.join(source, file))).digest("hex"), hash, `Native baseline drift: ${file}`);
await mkdir(base, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(path.join(base, "candidate-check-")), packageRoot = path.join(directory, "package"), runRoot = path.join(directory, "run");
await cp(source, packageRoot, { recursive: true, errorOnExist: true, force: false });
await symlink(path.resolve(source, "../.."), path.join(packageRoot, "node_modules"));
const patch = Bun.spawn(["/usr/bin/patch", "--batch", "--fuzz=0", "-p1", "-i", path.join(import.meta.dir, "session-ownership-candidate.patch")], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" });
const [patchCode, patchOutput, patchError] = await Promise.all([patch.exited, new Response(patch.stdout).text(), new Response(patch.stderr).text()]);
assert.equal(patchCode, 0, patchError); assert(!/offset|fuzz/i.test(patchOutput), "Candidate patch did not apply exactly");
await mkdir(path.join(runRoot, "agent"), { recursive: true, mode: 0o700 });
await writeFile(path.join(directory, "provenance.json"), JSON.stringify({ checkedAt: new Date().toISOString(), baseline,
  patchSha256: createHash("sha256").update(await readFile(path.join(import.meta.dir, "session-ownership-candidate.patch"))).digest("hex"), packageRoot, patchOutput }, null, 2), { mode: 0o600 });
const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "ownership-contract.ts"), runRoot], { cwd: runRoot,
  env: { HOME: runRoot, PI_CODING_AGENT_DIR: path.join(runRoot, "agent"), OWNERSHIP_NATIVE_PACKAGE: packageRoot, PATH: process.env.PATH, TMPDIR: runRoot, TERM: "dumb", SHELL: "/bin/sh" }, stdout: "inherit", stderr: "inherit" });
process.exitCode = await child.exited;
for (const [file, hash] of Object.entries(baseline.files)) assert.equal(createHash("sha256").update(await readFile(path.join(source, file))).digest("hex"), hash, `Original package changed: ${file}`);
