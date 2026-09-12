import { startHost } from "../../apps/host/src/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2]!, project = join(root, "project"), agent = join(root, "agent");
await mkdir(agent, { recursive: true, mode: 0o700 });
await writeFile(join(agent, "config.yml"), "extensions: []\n", { mode: 0o600 });
const host = await startHost({ dataDirectory: join(root, "data"), agentDirectory: agent, discoveryDirectory: project,
  workerPath: join(import.meta.dir, "../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), tailscale: false, port: 0 });
const request = async (route: string, body: unknown) => {
  const response = await fetch(host.connection.origin + route, { method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": host.connection.hostId }, body: JSON.stringify(body) });
  const result: unknown = await response.json();
  if (!response.ok || !result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new Error(`Isolated host setup failed: ${JSON.stringify(result)}`);
  return result;
};
try {
  const added = await request("/v1/commands", { id: "git-file-fixture-project", command: { type: "project.add", path: project } });
  if (!("value" in added) || !added.value || typeof added.value !== "object" || !("id" in added.value) || typeof added.value.id !== "string") throw new Error("The host did not return a project identity.");
  await request("/v5/commands", { id: "git-file-fixture-draft", commandVersion: 5, command: { type: "draft.put", draft: { id: "new-conversation", projectId: added.value.id, text: "UNSENT_GIT_FILE_ACCEPTANCE_DRAFT", model: null }, expectedRevision: 0 } });
  await writeFile(join(root, "ready.json"), JSON.stringify({ connection: host.connection, target: { projectId: added.value.id }, project }), { mode: 0o600 });
  process.on("message", () => { void host.stop().then(() => process.exit(0)); });
} catch (error) { await host.stop(); throw error; }
