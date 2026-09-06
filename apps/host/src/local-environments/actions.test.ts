import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { LocalEnvironmentActions } from "./actions";

const roots: string[] = [];
const stores: HostStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-actions-")); roots.push(root);
  const project = join(root, "project"); await mkdir(join(project, ".agent-desktop", "environments"), { recursive: true });
  await writeFile(join(project, ".agent-desktop", "environments", "environment.toml"), 'version = 1\nname = "Default"\n[setup]\nscript = "true"\n[[actions]]\nname = "Build"\ncommand = "printf build"\nicon = "run"\n');
  const store = new HostStore(join(root, "state")); stores.push(store); const record = store.addProject({ path: project });
  return { root, project, store, record, service: new LocalEnvironmentActions(store, () => undefined) };
}

describe("LocalEnvironmentActions", () => {
  test("catalogs the default config and preserves unavailable native state", async () => {
    const { service, record } = await fixture();
    await expect(service.catalog({ projectId: record.id })).resolves.toMatchObject({
      selectionRevision: 0, selectedConfigPath: join(record.path, ".agent-desktop/environments/environment.toml"),
      configRevision: expect.any(String), actions: [{ index: 0, name: "Build", icon: "run" }], available: false,
    });
  });

  test("uses CAS for selection and rejects stale action requests", async () => {
    const { service, record } = await fixture(); const target = { projectId: record.id };
    const state = await service.catalog(target);
    const selected = await service.select(target, state.selectedConfigPath, state.selectionRevision);
    await expect(service.select(target, null, state.selectionRevision)).rejects.toThrow("changed");
    await expect(service.run(target, { configPath: selected.selectedConfigPath!, configRevision: selected.configRevision!, selectionRevision: state.selectionRevision, actionIndex: 0 })).rejects.toMatchObject({ code: "STALE_ENVIRONMENT_SELECTION" });
  });

  test("does not fall back from a missing session target", async () => {
    const { service } = await fixture();
    await expect(service.catalog({ sessionId: crypto.randomUUID() })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  test("keeps a selected config visible as an error when it is deleted", async () => {
    const { service, record, project } = await fixture(); const target = { projectId: record.id };
    const initial = await service.catalog(target); await service.select(target, initial.selectedConfigPath, 0);
    await rm(initial.selectedConfigPath!, { force: true });
    await expect(service.catalog(target)).resolves.toMatchObject({
      selectedConfigPath: initial.selectedConfigPath,
      environments: [{ configPath: initial.selectedConfigPath, error: expect.any(String) }],
    });
    expect(project).toContain("project");
  });

  test("retains broken configs without exposing executable actions", async () => {
    const { service, record, project } = await fixture();
    const broken = join(project, ".agent-desktop/environments/broken.toml"); await writeFile(broken, "name = [broken");
    const state = await service.catalog({ projectId: record.id });
    await service.select({ projectId: record.id }, broken, state.selectionRevision);
    const canonicalBroken = await realpath(broken);
    const refreshed = await service.catalog({ projectId: record.id });
    expect(refreshed.selectedConfigPath).toBe(canonicalBroken); expect(refreshed.actions).toEqual([]);
    const brokenItem = refreshed.environments.find(item => item.configPath === canonicalBroken);
    expect(brokenItem?.error).toEqual(expect.any(String));
  });

  test("filters platform actions while preserving original indices", async () => {
    const { service, record, project } = await fixture();
    const path = join(project, ".agent-desktop/environments/environment.toml");
    const opposite = process.platform === "darwin" ? "linux" : "darwin";
    await writeFile(path, `version = 1\nname = "Platforms"\n[setup]\nscript = "true"\n[[actions]]\nname = "Other platform"\ncommand = "false"\nplatform = "${opposite}"\n[[actions]]\nname = "Current platform"\ncommand = "true"\n`);
    const state = await service.catalog({ projectId: record.id });
    expect(state.actions).toEqual([{ index: 1, name: "Current platform", icon: null }]);
  });

  test("persists explicit no-environment selection across store reopen", async () => {
    const { service, record, root, store } = await fixture(); const target = { projectId: record.id };
    const state = await service.catalog(target); await service.select(target, null, state.selectionRevision); store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new HostStore(join(root, "state")); stores.push(reopened);
    await expect(new LocalEnvironmentActions(reopened, () => undefined).catalog(target)).resolves.toMatchObject({ selectionRevision: 1, selectedConfigPath: null, actions: [] });
  });

  test("resolves a session through its owning project", async () => {
    const { service, record, store } = await fixture();
    const session = store.upsertSession({ id: crypto.randomUUID(), hostId: store.host.id, projectId: record.id, cwd: record.path, title: "session", status: "idle", sessionFile: join(record.path, "session.jsonl"), model: null, createdAt: Date.now(), updatedAt: Date.now(), archived: false });
    await expect(service.catalog({ sessionId: session.id })).resolves.toMatchObject({ available: false, selectedConfigPath: expect.any(String) });
  });
  test("projectless sessions resolve their own folder and symlink configs remain errors", async () => {
    const { service, record, store } = await fixture();
    const session = store.upsertSession({ id: crypto.randomUUID(), hostId: store.host.id, projectId: null, cwd: record.path, title: "projectless", status: "idle", sessionFile: join(record.path, "session.jsonl"), model: null, createdAt: Date.now(), updatedAt: Date.now(), archived: false });
    const target = { sessionId: session.id }, state = await service.catalog(target);
    expect(state.actions).toHaveLength(1);
    const link = join(record.path, ".agent-desktop/environments/linked.toml");
    await symlink(state.selectedConfigPath!, link);
    const linked = await service.select(target, link, 0);
    expect(linked.actions).toEqual([]);
    expect(linked.environments.find(item => item.configPath === linked.selectedConfigPath)?.error).toContain("symlink");
    await service.select(target, null, 1);
    await expect(service.run(target, { configPath: state.selectedConfigPath!, configRevision: state.configRevision!, selectionRevision: 2, actionIndex: 0 })).rejects.toMatchObject({ code: "STALE_ENVIRONMENT_SELECTION" });
  });

});
