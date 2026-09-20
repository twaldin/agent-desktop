import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

const fixture = resolve(process.argv[2]!);
const bin = join(fixture, "bin");
if (
  process.env.HOME !== fixture ||
  process.env.PI_CODING_AGENT_DIR !== join(fixture, "agent") ||
  process.env.PATH?.split(delimiter)[0] !== bin
)
  throw new Error("An isolated pull request host environment is required.");
for (const name of ["data", "agent", "project", "bin"])
  await mkdir(join(fixture, name), { recursive: true });
await writeFile(
  join(fixture, "project", "README.md"),
  "# Pull request App fixture\n",
);
const configPath = join(fixture, "agent", "config.yml");
if (!(await Bun.file(configPath).exists()))
  await writeFile(
    configPath,
    "retry:\n  enabled: false\nmodelRoles:\n  default: fixture/old\n  review: fixture/review\n  plan:\n    - fixture/plan\n    - fixture/plan-fallback\n",
  );
await writeFile(join(fixture, "agent", "models.yml"), `providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: old\n        name: Old fixture model\n        contextWindow: 100000\n        maxTokens: 4096\n      - id: new\n        name: New fixture model\n        contextWindow: 100000\n        maxTokens: 4096\n      - id: project\n        name: Project fixture model\n        contextWindow: 100000\n        maxTokens: 4096\n`);
const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent");
const auth = await discoverAuthStorage(join(fixture, "agent"));
try {
  for (const org of ["First organization", "Second organization"]) auth.upsertCredential("openai", {
    type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 86_400_000,
    accountId: `fixture-${org}`, email: "account@example.invalid", orgId: org, orgName: org,
  });
  auth.upsertCredential("openai", { type: "api_key", key: "fixture-key" });
} finally { auth.close(); }
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname !== "127.0.0.1")
      throw new Error(
        "Outbound provider/network fetch forbidden in pull request App fixture.",
      );
    return originalFetch(input, init);
  },
  { preconnect: () => {} },
) as typeof fetch;
const { startHost } = await import("../../../apps/host/src/server");
const host = await startHost({
  dataDirectory: join(fixture, "data"),
  agentDirectory: join(fixture, "agent"),
  discoveryDirectory: join(fixture, "project"),
  workerPath: resolve(
    import.meta.dir,
    "../../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts",
  ),
  tailscale: false,
  port: 0,
});
await writeFile(
  join(fixture, "connection.json"),
  JSON.stringify(host.connection),
  { mode: 0o600 },
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await host.stop();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void stop());
for await (const chunk of process.stdin)
  if (String(chunk).trim() === "stop") await stop();
