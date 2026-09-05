// Disposable native host. The parent starts this with a complete isolated environment.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const fixture = resolve(process.argv[2]!), root = resolve(import.meta.dir, "../..");
if (process.env.HOME !== fixture || process.env.PI_CODING_AGENT_DIR !== join(fixture, "agent")) throw new Error("This fixture requires an isolated HOME and native configuration root.");
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "127.0.0.1") throw new Error("Outbound fetch forbidden in App startup acceptance");
  return originalFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;
for (const name of ["data", "agent", "project"]) await mkdir(join(fixture, name), { recursive: true, mode: 0o700 });
await writeFile(join(fixture, "agent/config.yml"), `extensions:\n  - ${JSON.stringify(join(root, "scripts/acceptance/app-startup-extension.ts"))}\ntools:\n  approvalMode: always-ask\n`);
const { startHost } = await import("../../apps/host/src/server");
const host = await startHost({ dataDirectory: join(fixture, "data"), agentDirectory: join(fixture, "agent"), discoveryDirectory: join(fixture, "project"),
  workerPath: join(root, "apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), tailscale: false });
await writeFile(join(fixture, "fixture-connection.json"), JSON.stringify(host.connection), { mode: 0o600 });
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; try { await host.stop(); process.exit(0); } catch (error) { console.error(error); process.exit(1); } };
process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
for await (const chunk of process.stdin) if (String(chunk).trim() === "stop") await stop();
