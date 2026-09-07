import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2]!, project = join(root, "project"), agent = join(root, "agent");
const files = { "first.ts": "const ownerBytes = 'original';\nexport const untouched = true;\n" };
await Promise.all([mkdir(project, { recursive: true, mode: 0o700 }), mkdir(agent, { recursive: true, mode: 0o700 })]);
await writeFile(join(agent, "config.yml"), "extensions: []\n"); await writeFile(join(project, "first.ts"), files["first.ts"], { mode: 0o600 });
Bun.spawnSync(["git", "init", "-q", project]); Bun.spawnSync(["git", "-C", project, "config", "user.name", "Workspace Save Copy Acceptance"]); Bun.spawnSync(["git", "-C", project, "config", "user.email", "workspace-save-copy@example.invalid"]); Bun.spawnSync(["git", "-C", project, "add", "."]); Bun.spawnSync(["git", "-C", project, "commit", "-qm", "Fixture baseline"]);
const { startHost } = await import("../../apps/host/src/server");
const host = await startHost({ dataDirectory: join(root, "data"), agentDirectory: agent, discoveryDirectory: project, workerPath: join(import.meta.dir, "../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), tailscale: false, port: 0 });
const request = async (route: string, body: unknown) => { const response = await fetch(host.connection.origin + route, { method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": host.connection.hostId }, body: JSON.stringify(body) }); const value = await response.json() as any; if (!response.ok) throw new Error(`Fixture setup failed (${response.status}): ${JSON.stringify(value)}`); return value; };
const projectResult = await request("/v1/commands", { id: "workspace-save-copy-project", command: { type: "project.add", path: project } }); if (!projectResult.ok) throw new Error("Project creation failed");
const target = { projectId: projectResult.value.id }; const draft = await request("/v5/commands", { id: "workspace-save-copy-draft", commandVersion: 5, command: { type: "draft.put", draft: { id: "new-conversation", text: "EXISTING_UNSENT_SAVE_COPY_DRAFT", projectId: target.projectId, model: null }, expectedRevision: 0 } }); if (!draft.ok) throw new Error("Draft fixture creation failed");
await writeFile(join(root, "ready.json"), JSON.stringify({ connection: host.connection, target, project, files, draft: draft.value }), { mode: 0o600 });
process.on("message", () => void host.stop().then(() => process.exit(0)));
