import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const repository = path.resolve(import.meta.dir, "../../.."), artifact = JSON.parse(await readFile(path.join(import.meta.dir, "artifact.json"), "utf8"));
const baseline = JSON.parse(await readFile(path.resolve(import.meta.dir, artifact.baseline), "utf8"));
const source = await realpath(path.join(homedir(), `.bun/install/cache/@oh-my-pi/pi-coding-agent@${baseline.version}@@@1`));
const selected = (await readdir(path.join(repository, "node_modules/.bun"))).find(name => name.startsWith(`@oh-my-pi+pi-coding-agent@${baseline.version}+`)); assert(selected);
const dependencies = await realpath(path.join(repository, "node_modules/.bun", selected, "node_modules"));
for (const [file, digest] of Object.entries(baseline.files)) assert.equal(createHash("sha256").update(await readFile(path.join(source, file as string))).digest("hex"), digest);
const base = path.join(repository, ".data/temp/omp-browser-frame"); await mkdir(base, { recursive: true, mode: 0o700 }); const directory = await mkdtemp(path.join(base, "candidate-check-"));
const packageRoot = path.join(directory, "package"), runRoot = path.join(directory, "run"); await cp(source, packageRoot, { recursive: true, errorOnExist: true, force: false }); await symlink(dependencies, path.join(packageRoot, "node_modules")); await mkdir(runRoot, { recursive: true, mode: 0o700 });
const patchPath = path.resolve(import.meta.dir, artifact.patch), patch = Bun.spawn(["/usr/bin/patch", "--batch", "--fuzz=0", "-p1", "-i", patchPath], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" });
const [code, stdout, stderr] = await Promise.all([patch.exited, new Response(patch.stdout).text(), new Response(patch.stderr).text()]); assert.equal(code, 0, stderr); assert(!/offset|fuzz/i.test(stdout));
async function browserExecutable() { if (process.env.PUPPETEER_EXECUTABLE_PATH && (await stat(process.env.PUPPETEER_EXECUTABLE_PATH).catch(() => undefined))?.isFile()) return process.env.PUPPETEER_EXECUTABLE_PATH; for (const root of [path.join(homedir(), ".omp/puppeteer/chrome"), path.join(homedir(), ".cache/puppeteer/chrome")]) for (const version of (await readdir(root).catch(() => [])).sort().reverse()) { const candidate = path.join(root, version, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"); if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate; } throw new Error("No existing Chrome for Testing executable"); }
await writeFile(path.join(directory, "provenance.json"), JSON.stringify({ checkedAt: new Date().toISOString(), artifact, baseline, patchSha256: createHash("sha256").update(await readFile(patchPath)).digest("hex"), patchOutput: stdout }, null, 2), { mode: 0o600 });
const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "viewport-contract.ts"), runRoot], { cwd: runRoot, env: { PATH: process.env.PATH, HOME: runRoot, TMPDIR: runRoot, TERM: "dumb", SHELL: "/bin/sh", BROWSER_FRAME_NATIVE_PACKAGE: packageRoot, PUPPETEER_EXECUTABLE_PATH: await browserExecutable(), PI_BROWSER_CMUX: "0", PI_BROWSER_RELAY: "0" }, stdout: "inherit", stderr: "inherit" }); assert.equal(await child.exited, 0, `Candidate contract failed; inspect ${directory}`);
const result = await Bun.file(path.join(runRoot, "result.json")).json(); assert.equal(result.passed, true); for (const [file, digest] of Object.entries(baseline.files)) assert.equal(createHash("sha256").update(await readFile(path.join(source, file as string))).digest("hex"), digest); console.log(JSON.stringify({ passed: true, checks: result.checks.length, result: path.join(runRoot, "result.json") }));
