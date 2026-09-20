import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

const fixture = resolve(process.argv[2]!);
const bin = join(fixture, "bin");
if (
  process.env.HOME !== fixture ||
  process.env.PI_CODING_AGENT_DIR !== join(fixture, "agent") ||
  process.env.USAGE_FIXTURE_DIRECTORY !== fixture ||
  process.env.PATH?.split(delimiter)[0] !== bin
)
  throw new Error("An isolated usage-command App environment is required.");
for (const name of ["data", "agent", "project", "bin"])
  await mkdir(join(fixture, name), { recursive: true });
await writeFile(join(fixture, "project", "README.md"), "# Provider usage App fixture\n");
await writeFile(join(fixture, "agent", "config.yml"), "extensions: []\ncodexResets:\n  autoRedeem: yes\n");
await writeFile(join(fixture, "agent", "models.yml"), JSON.stringify({ providers: { "openai-codex": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none",
  models: [{ id: "gpt-5.4", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(join(fixture, "wire-mode"), "normal");

const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent");
const auth = await discoverAuthStorage(join(fixture, "agent"));
try {
  await auth.set("openai-codex", ["first", "second"].map(id => ({
    type: "oauth" as const,
    access: `fixture-access-${id}`,
    refresh: `fixture-refresh-${id}`,
    accountId: id,
    orgId: `org-${id}`,
    email: "same@fixture.invalid",
    expires: Date.now() + 86_400_000,
  })));
  await writeFile(join(fixture, "credential-id"), String(auth.listOAuthAccounts("openai-codex")[0]!.credentialId));
} finally {
  auth.close();
}

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") throw new Error("Nonlocal network is forbidden in the usage-command App fixture.");
  return originalFetch(input, init);
}, { preconnect: () => { throw new Error("Fixture preconnect is prohibited."); } }) as typeof fetch;

const { startHost } = await import("../../../apps/host/src/server");
const options = {
  dataDirectory: join(fixture, "data"),
  agentDirectory: join(fixture, "agent"),
  discoveryDirectory: join(fixture, "project"),
  workerPath: resolve(import.meta.dir, "worker.ts"),
  tailscale: false,
  port: 0,
};
let host = await startHost(options);
const fixedPort = Number(new URL(host.connection.origin).port);
await writeFile(join(fixture, "connection.json"), JSON.stringify(host.connection), { mode: 0o600 });
let stopping = false, restarting = false, handledRestart = "";
const restartTimer = setInterval(() => void (async () => {
  if (stopping || restarting) return;
  const request = await readFile(join(fixture, "restart-host"), "utf8").catch(() => "");
  if (!request || request === handledRestart) return;
  restarting = true;
  try {
    await host.stop();
    host = await startHost({ ...options, port: fixedPort });
    await writeFile(join(fixture, "connection.json"), JSON.stringify(host.connection), { mode: 0o600 });
    handledRestart = request;
    await writeFile(join(fixture, "restart-complete"), request);
  } catch (error) {
    await writeFile(join(fixture, "restart-error"), String(error));
  } finally { restarting = false; }
})(), 20);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(restartTimer);
  try { await host.stop(); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
}
process.on("SIGTERM", () => void stop());
for await (const chunk of process.stdin)
  if (String(chunk).trim() === "stop") await stop();
