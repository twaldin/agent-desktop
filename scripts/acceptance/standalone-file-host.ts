import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const root = process.argv[2]!;
const filesDirectory = join(root, "files");
const discoveryDirectory = join(root, "empty-discovery");
const agentDirectory = join(root, "agent");
const filePath = join(filesDirectory, "outside project.ts");
const initialText = "export const standalone = true;\n";

await Promise.all([
  mkdir(filesDirectory, { recursive: true, mode: 0o700 }),
  mkdir(discoveryDirectory, { recursive: true, mode: 0o700 }),
  mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
]);
await writeFile(join(agentDirectory, "config.yml"), "extensions: []\n", { mode: 0o600 });
await writeFile(filePath, initialText, { mode: 0o600 });

const { startHost } = await import("../../apps/host/src/server");
const host = await startHost({
  dataDirectory: join(root, "host-data"),
  agentDirectory,
  discoveryDirectory,
  workerPath: join(import.meta.dir, "../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts"),
  tailscale: false,
  port: 0,
});

await writeFile(join(root, "ready.json"), JSON.stringify({
  connection: host.connection,
  target: { filePath },
  filePath,
  fileName: basename(filePath),
  filesDirectory,
  discoveryDirectory,
  initialText,
}), { mode: 0o600 });

process.on("message", () => void host.stop().then(() => process.exit(0)));
