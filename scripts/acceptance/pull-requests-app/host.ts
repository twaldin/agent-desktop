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
await writeFile(
  join(fixture, "agent", "config.yml"),
  "retry:\n  enabled: false\n",
);
const executable = join(bin, "gh");
await writeFile(
  executable,
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dir, "fake-gh.ts"))} "$@"\n`,
  { mode: 0o700 },
);
await chmod(executable, 0o700);
process.env.AGENT_DESKTOP_FAKE_GH_LOG = join(fixture, "gh-calls.jsonl");
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
