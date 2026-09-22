import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TMUX_BUNDLE_SOURCES } from "../apps/host/src/terminals/bundle";
import { unpackHostArtifact, verifyArtifact } from "./install-host";
import { assertHostRuntimePins, packageHost, type HostArtifact } from "./package-host";
import { HostStore } from "../apps/host/src/store";
import { checkHostStateCompatibility } from "./host-state-compatibility";
import { Database } from "bun:sqlite";

const directories: string[] = [];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("new package admits current Goal state, rejects future state and hashes the guard; immutable output cannot be overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-package-schema-contract-")); directories.push(root);
  const repository = join(root, "repository"), native = join(root, "native-contract-fixture");
  for (const [file, value] of Object.entries({
    "package.json": JSON.stringify({ packageManager: "bun@1.3.14", scripts: { postinstall: "bun scripts/restore-pinned-omp-cli-mode.ts" }, dependencies: { "@oh-my-pi/pi-ai": "18.1.10", "@oh-my-pi/pi-coding-agent": "18.1.10", "@oh-my-pi/pi-natives": "18.1.10", "@oh-my-pi/pi-tui": "18.1.10", "@oh-my-pi/pi-utils": "18.1.10" }, patchedDependencies: { "@oh-my-pi/pi-coding-agent@18.1.10": "patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch" } }),
    "bun.lock": "packaging-only lock fixture\n", "apps/host/package.json": "{}", "apps/desktop/package.json": "{}", "packages/shared/package.json": "{}",
    "apps/host/src/server.ts": "// Packaging-only fixture; never launched.\n", "apps/host/src/packaged-entry.ts": "// inert packaged entry fixture; never launched.\n",
    "apps/host/src/runtime-ownership.ts": "export {};\n", "apps/host/src/omp-workers/packaged-entry.ts": "// inert worker entry fixture; never launched.\n",
    "packages/shared/src/protocol.ts": "export {};\n",
  })) { await mkdir(dirname(join(repository, file)), { recursive: true }); await writeFile(join(repository, file), value); }
  const ompPatch = "diff --git a/src/tools/browser/tab-supervisor.ts b/src/tools/browser/tab-supervisor.ts\n";
  await mkdir(join(repository, "patches"), { recursive: true });
  await writeFile(join(repository, "patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch"), ompPatch);
  for (const file of ["scripts/package-host.ts", "scripts/install-host.ts", "scripts/restore-pinned-omp-cli-mode.ts", "scripts/terminal-upgrade-guard.ts", "scripts/host-state-compatibility.ts"]) {
    await mkdir(dirname(join(repository, file)), { recursive: true }); await copyFile(join(import.meta.dir, "..", file), join(repository, file));
  }
  // Only tests metadata transport/hash coverage. No fixture terminal, host, or provider is executed.
  const files: Record<string, string> = {};
  for (const [file, value] of Object.entries({ "bin/tmux": "#!/bin/sh\nexit 97 # packaging metadata fixture, never execute\n", "terminfo/x/xterm-256color": "packaging-only terminfo fixture\n" })) {
    await mkdir(dirname(join(native, file)), { recursive: true }); await writeFile(join(native, file), value); files[file] = hash(value);
  }
  await chmod(join(native, "bin/tmux"), 0o700);
  await writeFile(join(native, "manifest.json"), JSON.stringify({ schema: 1, protocol: "tmux-v1", platform: `${process.platform}-${process.arch}`, sources: TMUX_BUNDLE_SOURCES, files, compiler: "metadata-fixture", runtimeLibraries: [], minimumOS: "fixture", builtAt: "fixture" }));
  const output = join(root, "contract-source12.tar.gz");
  const result = await packageHost({ version: "contract-source12", output, repository, nativeBundles: [native] });
  const unpacked = join(root, "unpacked"); await mkdir(unpacked);
  await unpackHostArtifact(output, unpacked);
  expect(Bun.spawnSync(["tar", "-xzf", output, "-C", unpacked], { stdout: "pipe", stderr: "pipe" }).success).toBe(true);
  const manifest = JSON.parse(await readFile(join(unpacked, "host-artifact.json"), "utf8")) as HostArtifact;
  const stateRoot = join(root, "goal-state"), store = new HostStore(stateRoot);
  try {
    store.putDraft({ id: "goal-draft", text: "Keep this objective", projectId: null, model: null, goal: { tokenBudget: "1200" } }, 0);
    expect(checkHostStateCompatibility(manifest, stateRoot).checkedSchemaVersion).toBe(27);
    expect(store.getDraft("goal-draft")?.goal).toEqual({ tokenBudget: "1200" });
    store.upsertSession({ id: "process-session", hostId: store.host.id, projectId: null, cwd: stateRoot, title: "Process fixture",
      status: "idle", sessionFile: join(stateRoot, "never-opened.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false });
    store.processOperations.claim({ action: "stop", operationId: "packaging-operation", owner: { nativeSessionId: "process-session", epoch: "fixture", projectDir: stateRoot },
      target: { brokerId: "fixture", name: "server", id: "original", generation: 1 } });
    expect(checkHostStateCompatibility(manifest, stateRoot).checkedSchemaVersion).toBe(28);
    expect(store.processOperations.get("process-session", "packaging-operation")?.status).toBe("pending");
  } finally { store.close(); }
  const future = new Database(join(stateRoot, "state.sqlite"));
  try { future.exec("PRAGMA user_version = 29"); } finally { future.close(); }
  expect(() => checkHostStateCompatibility(manifest, stateRoot)).toThrow("schema 29");
  expect(manifest.stateSchemaVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
  expect(manifest.files["scripts/host-state-compatibility.ts"]).toBe(hash(await readFile(join(repository, "scripts/host-state-compatibility.ts"))));
  expect(manifest.files["scripts/restore-pinned-omp-cli-mode.ts"]).toBe(hash(await readFile(join(repository, "scripts/restore-pinned-omp-cli-mode.ts"))));
  expect(manifest.files["patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch"]).toBe(hash(ompPatch));
  const guard = await readFile(join(unpacked, "scripts/host-state-compatibility.ts"));
  expect(hash(guard)).toBe(manifest.files["scripts/host-state-compatibility.ts"]!);
  const packagedManifest = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8"));
  expect(packagedManifest.scripts.postinstall).toBe("bun scripts/restore-pinned-omp-cli-mode.ts");
  expect(hash(await readFile(join(unpacked, "scripts/restore-pinned-omp-cli-mode.ts"))))
    .toBe(manifest.files["scripts/restore-pinned-omp-cli-mode.ts"]!);
  expect(hash(await readFile(output))).toBe(result.sha256);
  await writeFile(join(unpacked, "package.json"), "tampered\n");
  await expect(verifyArtifact(unpacked)).rejects.toThrow("Artifact verification failed: package.json");
  await expect(packageHost({ version: "changed-version", output, repository, nativeBundles: [native] })).rejects.toThrow("Refusing to overwrite an existing artifact");
  expect(hash(await readFile(output))).toBe(result.sha256);
});

test("host packaging rejects any missing or unpinned OMP package", () => {
  const dependencies = Object.fromEntries(["pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"].map(name => [`@oh-my-pi/${name}`, "18.1.10"]));
  assertHostRuntimePins({ packageManager: "bun@1.3.14", dependencies });
  for (const name of Object.keys(dependencies)) {
    const changed = { ...dependencies };
    delete changed[name];
    expect(() => assertHostRuntimePins({ packageManager: "bun@1.3.14", dependencies: changed })).toThrow();
  }
  expect(() => assertHostRuntimePins({ packageManager: "bun@1.3.14", dependencies: { ...dependencies, "@oh-my-pi/pi-ai": "latest" } })).toThrow();
});
