import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2]!;
const files = join(root, "outside catalog");
const discovery = join(root, "empty-discovery");
const agent = join(root, "agent");
const firstPath = join(files, "first image.svg");
const secondPath = join(files, "second-image.svg");
const missingPath = join(files, "missing-image.png");
const first = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#496b91"/><circle cx="80" cy="80" r="48" fill="#d6e8ff"/></svg>';
const second = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="240"><rect width="180" height="240" fill="#be8d52"/><path d="M20 200 L90 30 L160 200 Z" fill="#fff4d6"/></svg>';
await Promise.all([mkdir(files, { recursive: true, mode: 0o700 }), mkdir(discovery, { recursive: true, mode: 0o700 }), mkdir(agent, { recursive: true, mode: 0o700 })]);
await writeFile(join(agent, "config.yml"), "extensions: []\n", { mode: 0o600 });
await Promise.all([writeFile(firstPath, first, { mode: 0o600 }), writeFile(secondPath, second, { mode: 0o600 })]);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const { startHost } = await import("../../apps/host/src/server");
const host = await startHost({ dataDirectory: join(root, "host-data"), agentDirectory: agent, discoveryDirectory: discovery,
  workerPath: join(import.meta.dir, "../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), tailscale: false, port: 0 });
await writeFile(join(root, "ready.json"), JSON.stringify({ connection: host.connection, files, discovery, firstPath, secondPath, missingPath,
  hashes: { first: sha256(first), second: sha256(second) } }), { mode: 0o600 });
process.on("message", () => void host.stop().then(() => process.exit(0)));
