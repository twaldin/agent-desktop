import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceFileOpenRuntime } from "../../apps/host/src/workspace-open";

const root = process.argv[2]!, project = join(root, "project"), agent = join(root, "agent"), controlPath = join(root, "open-control.json"), launchesPath = join(root, "launches.jsonl");
const files = { "first.ts": "const alpha = 1;\nconst bravo = 2;\n", "second.ts": "export const second = true;\n" };
await Promise.all([mkdir(project, { recursive: true, mode: 0o700 }), mkdir(agent, { recursive: true, mode: 0o700 })]);
await writeFile(join(agent, "config.yml"), "extensions: []\n");
await Promise.all(Object.entries(files).map(([path, text]) => writeFile(join(project, path), text, { mode: 0o600 })));
await writeFile(controlPath, JSON.stringify({ availability: "normal", launch: "success" }), { mode: 0o600 }); await writeFile(launchesPath, "", { mode: 0o600 });
Bun.spawnSync(["git", "init", "-q", project]); Bun.spawnSync(["git", "-C", project, "config", "user.name", "Workspace File Open Acceptance"]); Bun.spawnSync(["git", "-C", project, "config", "user.email", "workspace-file-open@example.invalid"]); Bun.spawnSync(["git", "-C", project, "add", "."]); Bun.spawnSync(["git", "-C", project, "commit", "-qm", "Fixture baseline"]);
const control = async () => JSON.parse(await readFile(controlPath, "utf8")) as { availability: "normal" | "none" | "error"; launch: "success" | "unknown" };
const workspaceFileOpen: WorkspaceFileOpenRuntime = {
  platform: "darwin", environment: {}, homeDirectory: join(root, "home"),
  async available(path) {
    const state = await control(); if (state.availability === "error") throw new Error("Injected application inventory failure"); if (state.availability === "none") return false;
    return path === "/usr/bin/open" || path === "/Applications/Visual Studio Code.app" || /(?:Terminal|iTerm|Warp)\.app$/.test(path);
  },
  async launch(executable, args, cwd) {
    const state = await control(); await appendFile(launchesPath, JSON.stringify({ executable, args, cwd, at: Date.now(), behavior: state.launch }) + "\n");
    if (state.launch === "unknown") throw new Error("Injected launch acknowledgement failure");
  },
};
const { startHost } = await import("../../apps/host/src/server");
const host = await startHost({ dataDirectory: join(root, "data"), agentDirectory: agent, discoveryDirectory: project, workerPath: join(import.meta.dir, "../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), tailscale: false, port: 0, workspaceFileOpen });
const request = async (route: string, body: unknown) => { const response = await fetch(host.connection.origin + route, { method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": host.connection.hostId }, body: JSON.stringify(body) }); const value = await response.json() as any; if (!response.ok) throw new Error(`Fixture setup failed (${response.status}): ${JSON.stringify(value)}`); return value; };
const projectResult = await request("/v1/commands", { id: "workspace-file-open-project", command: { type: "project.add", path: project } }); if (!projectResult.ok) throw new Error("Project creation failed");
const target = { projectId: projectResult.value.id }; const draft = await request("/v5/commands", { id: "workspace-file-open-draft", commandVersion: 5, command: { type: "draft.put", draft: { id: "new-conversation", text: "EXISTING_UNSENT_OPEN_DRAFT", projectId: target.projectId, model: null }, expectedRevision: 0 } }); if (!draft.ok) throw new Error("Draft fixture creation failed");
await writeFile(join(root, "ready.json"), JSON.stringify({ connection: host.connection, target, project, files, draft: draft.value, controlPath, launchesPath }), { mode: 0o600 });
process.on("message", () => void host.stop().then(() => process.exit(0)));
