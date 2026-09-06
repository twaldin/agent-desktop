import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Exercise Bun's actual patch installer: /usr/bin/patch alone does not prove
// that a frozen installation produces the same native dependency source.
const repository = resolve(import.meta.dir, "../../..");
const artifact = JSON.parse(await readFile(join(import.meta.dir, "artifact.json"), "utf8"));
const output = resolve(process.argv[2] ?? join(repository, ".data/temp/browser-create-frozen", String(Date.now())));
assert(output.startsWith(join(repository, ".data/")), "Evidence must remain in ignored .data");
await mkdir(output, { recursive: true, mode: 0o700 });
const stage = await mkdtemp(join(tmpdir(), "agent-browser-frozen-"));
let result: Record<string, unknown> = { passed: false };
try {
  const patch = resolve(import.meta.dir, artifact.patch);
  const patchRelative = "patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch";
  assert.equal(createHash("sha256").update(await readFile(patch)).digest("hex"), artifact.patchSha256);
  for (const file of ["package.json", "bun.lock", "apps/desktop/package.json", "apps/host/package.json", "packages/shared/package.json", patchRelative]) {
    await mkdir(dirname(join(stage, file)), { recursive: true });
    await copyFile(join(repository, file), join(stage, file));
  }
  const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], { cwd: stage,
    stdout: Bun.file(join(output, "install.log")), stderr: Bun.file(join(output, "install-errors.log")) });
  assert.equal(await install.exited, 0, "Frozen install failed");
  const native = await realpath(join(stage, "node_modules/@oh-my-pi/pi-coding-agent"));
  assert(native.startsWith(await realpath(stage) + "/"), "Native dependency escaped the fresh stage");
  const hashes: Record<string, string> = {};
  for (const [file, expected] of Object.entries(artifact.patchedFiles)) {
    hashes[file] = createHash("sha256").update(await readFile(join(native, file))).digest("hex");
    assert.equal(hashes[file], expected, `Bun produced different patched bytes: ${file}`);
  }
  result = { passed: true, bunVersion: Bun.version, stage, native, patchSha256: artifact.patchSha256, patchedFiles: hashes,
    scope: "Fresh external-stage frozen Bun installation; exact patched source byte checks, no provider requests or running app changes." };
} catch (error) {
  result = { passed: false, error: String(error), stage };
  throw error;
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  await rm(stage, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: true, result: join(output, "result.json") }));
