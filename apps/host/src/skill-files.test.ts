import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComposerActionsCatalog, NativeSkillFileRef } from "@agent-desktop/shared";
import { SkillFiles, type SkillFileAuthorization } from "./skill-files";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const revision = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-skill-file-")); roots.push(root);
  const project = join(root, "project"), globalSkills = join(root, "global-skills"), sourcePath = join(globalSkills, "review", "SKILL.md");
  await mkdir(project); await mkdir(join(globalSkills, "review"), { recursive: true });
  await writeFile(sourcePath, "\uFEFForiginal\n"); await chmod(sourcePath, 0o640);
  const ref: NativeSkillFileRef = { skillId: "skill:review", sourcePath, inventory: true, target: { projectId: "project" } };
  let catalogCalls = 0;
  let catalogPath = sourcePath;
  const catalog = (): ComposerActionsCatalog => ({ protocolVersion: 1, hostId: "ignored", target: ref.target, cwd: project,
    revision: revision(catalogPath), commands: [], skills: [{ id: ref.skillId, name: "review", description: "Review", insertText: "/skill:review ",
      source: { kind: "skill", label: "Global", path: catalogPath }, availability: "executable", argumentCompletions: false }], diagnostics: [] });
  const runtime = { getSkillInventory: async () => { catalogCalls++; return { ...catalog(), skills: catalog().skills.map(skill => ({ ...skill, disabledByName: false })), enabled: true, commandsEnabled: true }; },
    getComposerActions: async () => { catalogCalls++; return catalog(); } };
  const revealed: string[] = [];
  let authorization: SkillFileAuthorization | undefined;
  const createService = () => new SkillFiles({ hostId: "host-a", resolveCwd: target => {
    if (!target || !("projectId" in target) || target.projectId !== "project") throw new Error("stale owner"); return project;
  }, runtime: runtime as never, reveal: async path => { revealed.push(path); }, authorizations: { get: () => authorization, put: (_ref, value) => { authorization = value; } } });
  const service = createService();
  return { root, project, sourcePath, ref, service, createService, revealed, runtime, setCatalogPath(path: string) { catalogPath = path; }, calls: () => catalogCalls };
}

describe("owner-bound native skill files", () => {
  test("edits a discovered skill outside the project with CAS while preserving BOM and mode", async () => {
    const f = await fixture();
    const opened = await f.service.read(f.ref);
    expect(opened).toMatchObject({ protocolVersion: 1, hostId: "host-a", ref: f.ref, document: { text: "original\n", bom: true, mode: 0o640 }, reveal: { available: true } });
    const saved = await f.service.write(f.ref, { expectedRevision: opened.document.revision, text: "updated\n" });
    expect(saved).toMatchObject({ type: "skill.file.write", conflict: false, file: { document: { text: "updated\n", bom: true, mode: 0o640 } } });
    expect(await readFile(f.sourcePath, "utf8")).toBe("\uFEFFupdated\n");
    expect((await stat(f.sourcePath)).mode & 0o777).toBe(0o640);
  });

  test("returns current text for a stale file revision without overwriting it", async () => {
    const f = await fixture(), opened = await f.service.read(f.ref);
    await writeFile(f.sourcePath, "external\n");
    const result = await f.service.write(f.ref, { expectedRevision: opened.document.revision, text: "must-not-win\n" });
    expect(result).toMatchObject({ type: "skill.file.write", conflict: true, file: { document: { text: "external\n" } } });
    expect(await readFile(f.sourcePath, "utf8")).toBe("external\n");
  });

  test("rejects stale owners and a symlink whose canonical identity changes before mutation", async () => {
    const f = await fixture();
    await expect(f.service.read({ ...f.ref, target: { projectId: "other" } })).rejects.toMatchObject({ code: "STALE_TARGET" });
    const first = join(f.root, "first.md"), second = join(f.root, "second.md"), link = join(f.root, "skill-link.md");
    await writeFile(first, "first\n"); await writeFile(second, "second\n"); await symlink(first, link); f.setCatalogPath(link);
    let reads = 0;
    const original = f.runtime.getSkillInventory;
    f.runtime.getSkillInventory = async () => {
      const value = await original();
      if (++reads === 2) { await unlink(link); await symlink(second, link); }
      return value;
    };
    await expect(f.service.write({ ...f.ref, sourcePath: link }, { expectedRevision: revision("first\n"), text: "changed\n" })).rejects.toMatchObject({ code: "SKILL_FILE_CHANGED" });
    expect(await readFile(first, "utf8")).toBe("first\n"); expect(await readFile(second, "utf8")).toBe("second\n");
  });

  test("uses the injected host reveal and retains the opened resource after catalog changes", async () => {
    const f = await fixture();
    await f.service.reveal(f.ref);
    expect(f.revealed).toEqual([await realpath(f.sourcePath)]);
    f.setCatalogPath(join(f.root, "replacement.md"));
    await f.service.reveal(f.ref);
    expect(f.revealed).toEqual([await realpath(f.sourcePath), await realpath(f.sourcePath)]);
  });

  test("keeps an opened file editable across renamed, invalid, repaired inventory and service restart", async () => {
    const f = await fixture();
    const original = await f.service.read(f.ref);
    let mode: "renamed" | "invalid" | "repaired" = "renamed";
    f.runtime.getSkillInventory = async () => ({ protocolVersion: 1, hostId: "ignored", cwd: f.project, revision: revision(`${mode}:${await readFile(f.sourcePath, "utf8")}`), commands: [],
      skills: mode === "invalid" ? [] : [{ id: mode === "renamed" ? "skill:renamed" : f.ref.skillId, name: mode, description: "", insertText: `/skill:${mode} `,
        source: { kind: "skill" as const, label: "Global", path: f.sourcePath }, availability: "executable" as const, argumentCompletions: false, disabledByName: false }],
      enabled: true, commandsEnabled: true, diagnostics: [] });
    const renamed = await f.service.write(f.ref, { expectedRevision: original.document.revision, text: "renamed\n" });
    expect(renamed).toMatchObject({ conflict: false, file: { ref: f.ref, document: { text: "renamed\n" } } });
    mode = "invalid";
    const broken = await f.service.write(f.ref, { expectedRevision: renamed.file.document.revision, text: "invalid frontmatter\n" });
    expect(broken).toMatchObject({ conflict: false, file: { ref: f.ref, document: { text: "invalid frontmatter\n" } } });
    const restarted = f.createService();
    expect(await restarted.read(f.ref)).toMatchObject({ ref: f.ref, document: { text: "invalid frontmatter\n" } });
    mode = "repaired";
    const repaired = await restarted.write(f.ref, { expectedRevision: broken.file.document.revision, text: "repaired\n" });
    expect(repaired).toMatchObject({ conflict: false, file: { ref: f.ref, document: { text: "repaired\n" } } });
  });

  test("does not reauthorize the same catalog row after its canonical parent is replaced", async () => {
    const f = await fixture(); await f.service.read(f.ref);
    const parent = join(f.root, "global-skills", "review"), moved = join(f.root, "global-skills", "review-old");
    await rename(parent, moved); await mkdir(parent); await writeFile(f.sourcePath, "original\n");
    await expect(f.service.read(f.ref)).rejects.toMatchObject({ code: "SKILL_FILE_CHANGED" });
  });

  test("rejects a parent replacement during a request even when the catalog row persists", async () => {
    const f = await fixture();
    const parent = join(f.root, "global-skills", "review"), moved = join(f.root, "global-skills", "review-old");
    let reads = 0;
    const original = f.runtime.getSkillInventory;
    f.runtime.getSkillInventory = async () => {
      const value = await original();
      if (++reads === 2) {
        await rename(parent, moved); await mkdir(parent); await writeFile(f.sourcePath, "replacement\n");
      }
      return value;
    };
    await expect(f.service.write(f.ref, { expectedRevision: revision("original\n"), text: "must-not-win\n" })).rejects.toMatchObject({ code: "SKILL_FILE_CHANGED" });
    expect(await readFile(f.sourcePath, "utf8")).toBe("replacement\n");
    expect(await readFile(join(moved, "SKILL.md"), "utf8")).toBe("\uFEFForiginal\n");
  });
});
