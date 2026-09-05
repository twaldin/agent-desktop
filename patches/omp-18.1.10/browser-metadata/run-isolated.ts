// Candidate-only native metadata proof. It copies the pinned package and never
// edits node_modules, browser profiles, normal CLI selection, or host services.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const repository = path.resolve(import.meta.dir, "../../..");
const baseline = JSON.parse(await readFile(path.join(import.meta.dir, "baseline.json"), "utf8"));
const artifact = JSON.parse(await readFile(path.join(import.meta.dir, "artifact.json"), "utf8"));
// The workspace deliberately selects this patch. Candidate proof needs Bun's
// unpatched cached package so it can still verify an exact zero-fuzz apply.
const source = await realpath(path.join(homedir(), `.bun/install/cache/@oh-my-pi/pi-coding-agent@${baseline.version}@@@1`));
const bunPackages = path.join(repository, "node_modules/.bun");
const selectedPackage = (await readdir(bunPackages)).find(name => name.startsWith(`@oh-my-pi+pi-coding-agent@${baseline.version}+`));
assert(selectedPackage, "The selected OMP package has no isolated dependency graph.");
const dependencies = await realpath(path.join(bunPackages, selectedPackage, "node_modules"));
assert.deepEqual({ package: artifact.package, version: artifact.version, commit: artifact.commit, baseline: artifact.baseline, patch: artifact.patch, entry: artifact.entry, requiredExport: artifact.requiredExport }, { package: "@oh-my-pi/pi-coding-agent", version: baseline.version, commit: baseline.commit, baseline: "baseline.json", patch: "owner-tab-metadata.patch", entry: "src/tools/browser/tab-supervisor.ts", requiredExport: "listTabsForOwner" });
assert.equal(JSON.parse(await readFile(path.join(source, "package.json"), "utf8")).version, baseline.version);
for (const [file, hash] of Object.entries(baseline.files)) assert.equal(createHash("sha256").update(await readFile(path.join(source, file as string))).digest("hex"), hash, `Native baseline drift: ${file}`);
const base = path.join(repository, ".data/temp/omp-browser-metadata");
await mkdir(base, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(path.join(base, "candidate-check-"));
const packageRoot = path.join(directory, "package");
const runRoot = path.join(directory, "run");
async function browserExecutable(): Promise<string> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) { assert((await stat(process.env.PUPPETEER_EXECUTABLE_PATH)).isFile()); return process.env.PUPPETEER_EXECUTABLE_PATH; }
  for (const root of [path.join(homedir(), ".omp/puppeteer/chrome"), path.join(homedir(), ".cache/puppeteer/chrome")]) for (const version of (await readdir(root).catch(() => [])).sort().reverse()) {
    const candidate = path.join(root, version, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (await stat(candidate).then(info => info.isFile(), () => false)) return candidate;
  }
  throw new Error("No existing Chrome for Testing executable; this candidate never downloads one.");
}

{
  await cp(source, packageRoot, { recursive: true, errorOnExist: true, force: false });
  await symlink(dependencies, path.join(packageRoot, "node_modules"));
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const patchPath = path.join(import.meta.dir, "owner-tab-metadata.patch");
  const patch = Bun.spawn(["/usr/bin/patch", "--batch", "--fuzz=0", "-p1", "-i", patchPath], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([patch.exited, new Response(patch.stdout).text(), new Response(patch.stderr).text()]);
  assert.equal(code, 0, error); assert(!/offset|fuzz/i.test(output), "Candidate patch did not apply exactly");
  await writeFile(path.join(directory, "provenance.json"), JSON.stringify({ checkedAt: new Date().toISOString(), artifact, baseline, patchSha256: createHash("sha256").update(await readFile(patchPath)).digest("hex"), packageRoot, patchOutput: output }, null, 2), { mode: 0o600 });
  const executable = await browserExecutable();
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "owner-tab-metadata-contract.ts"), runRoot], { cwd: runRoot, env: { PATH: process.env.PATH, HOME: runRoot, TMPDIR: runRoot, TERM: "dumb", SHELL: "/bin/sh", BROWSER_METADATA_NATIVE_PACKAGE: packageRoot, PUPPETEER_EXECUTABLE_PATH: executable, PI_BROWSER_CMUX: "0", PI_BROWSER_RELAY: "0" }, stdout: "inherit", stderr: "inherit" });
  assert.equal(await child.exited, 0, `Candidate contract failed; inspect ${directory}`);
  const result = await Bun.file(path.join(runRoot, "result.json")).json();
  assert.equal(result.passed, true);
  for (const [file, hash] of Object.entries(baseline.files)) assert.equal(createHash("sha256").update(await readFile(path.join(source, file as string))).digest("hex"), hash, `Original package changed: ${file}`);
  console.log(JSON.stringify({ passed: true, checks: result.checks?.length, result: path.join(runRoot, "result.json") }));
}
