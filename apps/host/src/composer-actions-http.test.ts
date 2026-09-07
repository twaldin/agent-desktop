import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPOSER_OWNER_HEADER } from "@agent-desktop/shared";
import { ComposerActionsHttp } from "./composer-actions-http";

const catalog = (cwd: string) => ({ protocolVersion: 1 as const, cwd, revision: "a".repeat(64), commands: [], skills: [], diagnostics: [] });
const inventory = (cwd: string) => ({ protocolVersion: 1 as const, cwd, revision: "9".repeat(64), skills: [], enabled: true, commandsEnabled: true, diagnostics: [] });
const request = (body: unknown, owner = "owner", path = "/v1/composer/actions") => new Request(`http://host${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", [COMPOSER_OWNER_HEADER]: owner }, body: JSON.stringify(body),
});

test("composer HTTP refuses stale owners and targets before native discovery", async () => {
  let calls = 0;
  const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: target => {
    if (target && "projectId" in target && target.projectId === "gone") throw new Error("gone");
    return "/owned";
  }, getHandle: async () => { throw new Error("unexpected session"); }, runtime: {
    getComposerActions: async cwd => { calls++; return catalog(cwd ?? "/owned"); },
    getSkillInventory: async cwd => inventory(cwd ?? "/owned"), getComposerCompletions: async () => { throw new Error("unexpected completions"); },
  } });
  const wrong = await http.route(request({}, "other"));
  expect(wrong?.status).toBe(409); expect(await wrong?.json()).toMatchObject({ error: { code: "OWNER_MISMATCH" } });
  const stale = await http.route(request({ target: { projectId: "gone" } }));
  expect(stale?.status).toBe(409); expect(await stale?.json()).toMatchObject({ error: { code: "STALE_TARGET" } });
  expect(calls).toBe(0);
});

test("composer HTTP rechecks target ownership after native discovery", async () => {
  let current = "/owned";
  const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => current,
    getHandle: async () => { throw new Error("unexpected session"); }, runtime: {
      getComposerActions: async cwd => { current = "/moved"; return catalog(cwd ?? "/owned"); },
      getSkillInventory: async cwd => inventory(cwd ?? "/owned"), getComposerCompletions: async () => { throw new Error("unexpected completions"); },
    } });
  const response = await http.route(request({ target: { projectId: "project" } }));
  expect(response?.status).toBe(409); expect(await response?.json()).toMatchObject({ error: { code: "STALE_TARGET" } });
});

test("skill detail reads the discovered file, rechecks revision, and never starts a session", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "composer-skill-"));
  try {
    const file = join(root, "skill.md"); await writeFile(file, "# Native skill\n\ncontent\n");
    const revision = "b".repeat(64);
    const source = { kind: "skill" as const, label: "Personal", path: file };
    const make = () => ({ ...catalog("/owned"), revision, skills: [{ id: "skill:one", name: "one", description: "", insertText: "/skill:one ", source, availability: "executable" as const, argumentCompletions: false }] });
    let discovery = 0;
    const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => "/owned", getHandle: async () => { throw new Error("must not start a session worker"); }, runtime: {
      getComposerActions: async () => { discovery++; return make(); }, getSkillInventory: async cwd => inventory(cwd ?? "/owned"), getComposerCompletions: async () => { throw new Error("unexpected"); },
    } });
    const response = await http.route(request({ skillId: "skill:one", catalogRevision: revision }, "owner", "/v1/composer/skill-detail"));
    expect(response?.status).toBe(200); expect(await response?.json()).toMatchObject({ skillId: "skill:one", content: "# Native skill\n\ncontent\n", revision }); expect(discovery).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skill detail rejects oversized and changed files without exposing source paths", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "composer-skill-"));
  try {
    const file = join(root, "large.md"); await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 97));
    const revision = "c".repeat(64); const make = () => ({ ...catalog("/owned"), revision, skills: [{ id: "skill:large", name: "large", description: "", insertText: "/skill:large ", source: { kind: "skill" as const, label: "Personal", path: file }, availability: "executable" as const, argumentCompletions: false }] });
    const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => "/owned", getHandle: async () => { throw new Error("unexpected session"); }, runtime: { getComposerActions: async () => make(), getSkillInventory: async cwd => inventory(cwd ?? "/owned"), getComposerCompletions: async () => { throw new Error("unexpected"); } } });
    const response = await http.route(request({ skillId: "skill:large", catalogRevision: revision }, "owner", "/v1/composer/skill-detail")); const body = await response?.json() as { error?: { message?: string } };
    expect(response?.status).toBe(413); expect(body.error?.message).not.toContain(file);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skill detail accepts a discovered symlink but rejects missing and directory sources", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "composer-skill-"));
  try {
    const target = join(root, "target.md"); const link = join(root, "link.md"); await writeFile(target, "linked"); await symlink(target, link);
    const revision = "d".repeat(64); const catalogFor = (path: string) => ({ ...catalog("/owned"), revision, skills: [{ id: "skill:x", name: "x", description: "", insertText: "/skill:x ", source: { kind: "skill" as const, label: "Personal", path }, availability: "executable" as const, argumentCompletions: false }] });
    const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => "/owned", getHandle: async () => { throw new Error("unexpected session"); }, runtime: { getComposerActions: async () => catalogFor(link), getSkillInventory: async cwd => inventory(cwd ?? "/owned"), getComposerCompletions: async () => { throw new Error("unexpected"); } } });
    const linked = await http.route(request({ skillId: "skill:x", catalogRevision: revision }, "owner", "/v1/composer/skill-detail")); expect(linked?.status).toBe(200); expect((await linked?.json()).content).toBe("linked");
    await rm(link); const missing = await http.route(request({ skillId: "skill:x", catalogRevision: revision }, "owner", "/v1/composer/skill-detail")); expect(missing?.status).toBe(404);
    const directory = join(root, "directory"); await mkdir(directory); const directoryHttp = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => "/owned", getHandle: async () => { throw new Error("unexpected session"); }, runtime: { getComposerActions: async () => catalogFor(directory), getSkillInventory: async cwd => inventory(cwd ?? "/owned"), getComposerCompletions: async () => { throw new Error("unexpected"); } } });
    const bad = await directoryHttp.route(request({ skillId: "skill:x", catalogRevision: revision }, "owner", "/v1/composer/skill-detail")); expect(bad?.status).toBe(404);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skill detail fences target changes and encoded JSON expansion", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "composer-skill-"));
  try {
    const file = join(root, "nul.md"); await writeFile(file, Buffer.alloc(400_000, 0)); const revision = "e".repeat(64); let current = "/owned";
    const make = () => ({ ...catalog("/owned"), revision, skills: [{ id: "skill:nul", name: "nul", description: "", insertText: "/skill:nul ", source: { kind: "skill" as const, label: "Personal", path: file }, availability: "executable" as const, argumentCompletions: false }] });
    let calls = 0; let moveOnSecond = true; const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => current, getHandle: async () => { throw new Error("unexpected session"); }, runtime: { getComposerActions: async () => { calls++; if (moveOnSecond && calls === 2) current = "/moved"; return make(); }, getSkillInventory: async cwd => inventory(cwd ?? "/owned"), getComposerCompletions: async () => { throw new Error("unexpected"); } } });
    const moved = await http.route(request({ skillId: "skill:nul", catalogRevision: revision }, "owner", "/v1/composer/skill-detail")); expect(moved?.status).toBe(409);
    current = "/owned"; calls = 0; moveOnSecond = false; const huge = await http.route(request({ skillId: "skill:nul", catalogRevision: revision }, "owner", "/v1/composer/skill-detail")); expect(huge?.status).toBe(413);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skill detail rejects a same-path replacement that happens during the second catalog read", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "composer-skill-"));
  try {
    const file = join(root, "replace.md"); await writeFile(file, "before"); const revision = "f".repeat(64); let calls = 0;
    const make = () => ({ ...catalog("/owned"), revision, skills: [{ id: "skill:replace", name: "replace", description: "", insertText: "/skill:replace ", source: { kind: "skill" as const, label: "Personal", path: file }, availability: "executable" as const, argumentCompletions: false }] });
    const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => "/owned", getHandle: async () => { throw new Error("unexpected session"); }, runtime: { getComposerActions: async () => { calls++; if (calls === 2) await writeFile(file, "after"); return make(); }, getSkillInventory: async cwd => inventory(cwd ?? "/owned"), getComposerCompletions: async () => { throw new Error("unexpected"); } } });
    const response = await http.route(request({ skillId: "skill:replace", catalogRevision: revision }, "owner", "/v1/composer/skill-detail")); expect(response?.status).toBe(409);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skill inventory and inventory detail use discovery for a selected session without activating its worker", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "composer-skill-inventory-"));
  try {
    const file = join(root, "SKILL.md"); await writeFile(file, "# Disabled but configured\n");
    const revision = "8".repeat(64); let reads = 0;
    const row = { id: "skill:configured", name: "configured", description: "", insertText: "/skill:configured ", source: { kind: "skill" as const, label: "Project", path: file }, availability: "disabled" as const, reason: "Disabled by name", argumentCompletions: false, disabledByName: true };
    const readInventory = async () => { reads++; return { ...inventory("/owned"), revision, enabled: false, commandsEnabled: false, skills: [row] }; };
    const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => "/owned", getHandle: async () => { throw new Error("inventory must not activate a selected session"); }, runtime: {
      getComposerActions: async cwd => catalog(cwd ?? "/owned"), getSkillInventory: readInventory, getComposerCompletions: async () => { throw new Error("unexpected"); },
    } });
    const invalid = await http.route(request({ target: { sessionId: "idle" }, skillId: row.id, catalogRevision: revision, inventory: "true" }, "owner", "/v1/composer/skill-detail"));
    expect(invalid?.status).toBe(400);
    const listed = await http.route(request({ target: { sessionId: "idle" }, refresh: true }, "owner", "/v1/composer/skill-inventory"));
    expect(listed?.status).toBe(200); expect(await listed?.json()).toMatchObject({ hostId: "owner", target: { sessionId: "idle" }, revision, skills: [{ id: row.id, disabledByName: true }] });
    const detail = await http.route(request({ target: { sessionId: "idle" }, skillId: row.id, catalogRevision: revision, inventory: true }, "owner", "/v1/composer/skill-detail"));
    expect(detail?.status).toBe(200); expect(await detail?.json()).toMatchObject({ target: { sessionId: "idle" }, skillId: row.id, content: "# Disabled but configured\n" });
    expect(reads).toBe(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
