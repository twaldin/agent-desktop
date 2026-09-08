import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WorkspaceFileOpenRuntime } from "../../apps/host/src/workspace-open";

const root = process.argv[2]!;
const filesDirectory = join(root, "files");
const discoveryDirectory = join(root, "empty-discovery");
const agentDirectory = join(root, "agent");
const ordinaryPath = join(filesDirectory, "ordinary outside.ts");
const literalPath = join(filesDirectory, "literal #?%: café π.ts");
const missingPath = join(filesDirectory, "missing outside.ts");
const ordinaryText = ["export const alpha = 1;", "const bravo = 'selection target';", "export const omega = 3;", ""].join("\n");
const literalText = "export const literalSpecialPath = true;\n";
const launchesPath = join(root, "launches.jsonl");

await Promise.all([
  mkdir(filesDirectory, { recursive: true, mode: 0o700 }),
  mkdir(discoveryDirectory, { recursive: true, mode: 0o700 }),
  mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
]);
await Promise.all([
  writeFile(join(agentDirectory, "config.yml"), "extensions: []\n", { mode: 0o600 }),
  writeFile(ordinaryPath, ordinaryText, { mode: 0o600 }),
  writeFile(literalPath, literalText, { mode: 0o600 }),
  writeFile(launchesPath, "", { mode: 0o600 }),
]);

const workspaceFileOpen: WorkspaceFileOpenRuntime = {
  platform: "darwin",
  environment: {},
  homeDirectory: root,
  async available(path) { return path === "/usr/bin/open"; },
  async launch(executable, args, cwd) {
    await appendFile(launchesPath, JSON.stringify({ executable, args, cwd }) + "\n");
  },
};
const { startHost } = await import("../../apps/host/src/server");
const host = await startHost({
  dataDirectory: join(root, "host-data"),
  agentDirectory,
  discoveryDirectory,
  workerPath: join(import.meta.dir, "../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts"),
  tailscale: false,
  port: 0,
  workspaceFileOpen,
});

await writeFile(join(root, "ready.json"), JSON.stringify({
  connection: host.connection,
  paths: { ordinary: ordinaryPath, literal: literalPath, missing: missingPath },
  names: { ordinary: basename(ordinaryPath), literal: basename(literalPath), missing: basename(missingPath) },
  texts: { ordinary: ordinaryText, literal: literalText },
  filesDirectory,
  discoveryDirectory,
  launchesPath,
}), { mode: 0o600 });

process.on("message", () => void host.stop().then(() => process.exit(0)));
