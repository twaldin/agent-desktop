import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TMUX_BUNDLE_SOURCES } from "../apps/host/src/terminals/bundle";
import { packageHost, type HostArtifact } from "./package-host";

const directories: string[] = [];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("new package declares schema1/2/3/4 and hashes the standalone guard; immutable output cannot be overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-package-schema-contract-")); directories.push(root);
  const repository = join(root, "repository"), native = join(root, "native-contract-fixture");
  for (const [file, value] of Object.entries({
    "package.json": JSON.stringify({ packageManager: "bun@1.3.14", dependencies: { "@oh-my-pi/pi-coding-agent": "18.1.10", "@oh-my-pi/pi-natives": "18.1.10" }, patchedDependencies: { "@oh-my-pi/pi-coding-agent@18.1.10": "patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch" } }),
    "bun.lock": "packaging-only lock fixture\n", "apps/host/package.json": "{}", "apps/desktop/package.json": "{}", "packages/shared/package.json": "{}",
    "apps/host/src/server.ts": "// Packaging-only fixture; never launched.\n", "packages/shared/src/protocol.ts": "export {};\n",
  })) { await mkdir(dirname(join(repository, file)), { recursive: true }); await writeFile(join(repository, file), value); }
  const ompPatch = "diff --git a/src/tools/browser/tab-supervisor.ts b/src/tools/browser/tab-supervisor.ts\n";
  await mkdir(join(repository, "patches"), { recursive: true });
  await writeFile(join(repository, "patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch"), ompPatch);
  for (const file of ["scripts/package-host.ts", "scripts/install-host.ts", "scripts/terminal-upgrade-guard.ts", "scripts/host-state-compatibility.ts"]) {
    await mkdir(dirname(join(repository, file)), { recursive: true }); await copyFile(join(import.meta.dir, "..", file), join(repository, file));
  }
  // Only tests metadata transport/hash coverage. No fixture terminal, host, or provider is executed.
  const files: Record<string, string> = {};
  for (const [file, value] of Object.entries({ "bin/tmux": "#!/bin/sh\nexit 97 # packaging metadata fixture, never execute\n", "terminfo/x/xterm-256color": "packaging-only terminfo fixture\n" })) {
    await mkdir(dirname(join(native, file)), { recursive: true }); await writeFile(join(native, file), value); files[file] = hash(value);
  }
  await chmod(join(native, "bin/tmux"), 0o700);
  await writeFile(join(native, "manifest.json"), JSON.stringify({ schema: 1, protocol: "tmux-v1", platform: "darwin-arm64", sources: TMUX_BUNDLE_SOURCES, files, compiler: "metadata-fixture", runtimeLibraries: [], minimumOS: "fixture", builtAt: "fixture" }));
  const output = join(root, "contract-source12.tar.gz");
  const result = await packageHost({ version: "contract-source12", output, repository, nativeBundles: [native] });
  const unpacked = join(root, "unpacked"); await mkdir(unpacked);
  expect(Bun.spawnSync(["tar", "-xzf", output, "-C", unpacked], { stdout: "pipe", stderr: "pipe" }).success).toBe(true);
  const manifest = JSON.parse(await readFile(join(unpacked, "host-artifact.json"), "utf8")) as HostArtifact;
  expect(manifest.stateSchemaVersions).toEqual([1, 2, 3, 4]);
  expect(manifest.files["scripts/host-state-compatibility.ts"]).toBe(hash(await readFile(join(repository, "scripts/host-state-compatibility.ts"))));
  expect(manifest.files["patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch"]).toBe(hash(ompPatch));
  const guard = await readFile(join(unpacked, "scripts/host-state-compatibility.ts"));
  expect(hash(guard)).toBe(manifest.files["scripts/host-state-compatibility.ts"]!);
  expect(hash(await readFile(output))).toBe(result.sha256);
  await expect(packageHost({ version: "changed-version", output, repository, nativeBundles: [native] })).rejects.toThrow("Refusing to overwrite an existing artifact");
  expect(hash(await readFile(output))).toBe(result.sha256);
});
