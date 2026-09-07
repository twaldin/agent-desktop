import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2]!;
const project = join(root, "project");
const agent = join(root, "agent");
const skillPath = join(root, ".agents", "skills", "skill-file-acceptance", "SKILL.md");
await Promise.all([
  mkdir(project, { recursive: true, mode: 0o700 }),
  mkdir(agent, { recursive: true, mode: 0o700 }),
  mkdir(join(root, ".agents", "skills", "skill-file-acceptance"), { recursive: true, mode: 0o700 }),
]);
Bun.spawnSync(["git", "init", "-q", project]);
await writeFile(join(agent, "config.yml"), "extensions: []\n");
const initialText = `---\nname: skill-file-acceptance\ndescription: A disposable user skill for native file acceptance\n---\n# Skill file acceptance\n\nINITIAL_NATIVE_SKILL_BYTES\n\n![Skill illustration](assets/diagram.svg "Owning skill image")\n![Missing image](assets/missing.svg)\n` + Array.from({length:80},(_,i)=>`\nScroll paragraph ${i+1}. Native skill text remains on its owning host.\n`).join("");
await writeFile(skillPath, initialText, { mode: 0o600 });
await mkdir(join(root,".agents","skills","skill-file-acceptance","assets"),{recursive:true});
await writeFile(join(root,".agents","skills","skill-file-acceptance","assets","diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100"><rect width="320" height="100" rx="12" fill="#245579"/><text x="20" y="56" fill="white" font-size="20">Native skill illustration</text></svg>');

const { startHost } = await import("../../apps/host/src/server");
const host = await startHost({
  dataDirectory: join(root, "data"), agentDirectory: agent, discoveryDirectory: project,
  workerPath: join(import.meta.dir, "../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), tailscale: false, port: 0,
});
const request = async (route: string, body: unknown) => {
  const response = await fetch(host.connection.origin + route, { method: "POST", headers: {
    Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": host.connection.hostId,
  }, body: JSON.stringify(body) });
  const value = await response.json() as any;
  if (!response.ok) throw new Error(`Fixture setup failed (${response.status}): ${JSON.stringify(value)}`);
  return value;
};
const projectResult = await request("/v1/commands", { id: "skill-file-project", command: { type: "project.add", path: project } });
if (!projectResult.ok) throw new Error("Project creation failed");
const target = { projectId: projectResult.value.id };
const inventory = await request("/v1/composer/skill-inventory", { target, refresh: true });
const action = inventory.skills.find((item: any) => item.name === "skill-file-acceptance" && item.source.path === skillPath);
if (!action) throw new Error(`OMP did not discover the disposable user skill at ${skillPath}`);
if (skillPath.startsWith(project + "/")) throw new Error("Skill fixture must remain outside the project");
const draft = await request("/v5/commands", { id: "skill-file-draft", commandVersion: 5, command: {
  type: "draft.put", draft: { id: "new-conversation", text: "EXISTING_UNSENT_SKILL_DRAFT", projectId: target.projectId, model: null }, expectedRevision: 0,
} });
if (!draft.ok) throw new Error("Draft fixture creation failed");
await writeFile(join(root, "ready.json"), JSON.stringify({ connection: host.connection, target, draft: draft.value, skillPath, initialText,
  ref: { skillId: action.id, sourcePath: skillPath, inventory: true, target } }), { mode: 0o600 });
process.on("message", () => void host.stop().then(() => process.exit(0)));
