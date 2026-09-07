import { expect, test } from "bun:test";
import type { OmpSettingsSnapshot } from "@agent-desktop/shared";
import { skillEnabledMutation, skillToggleState } from "./skill-settings";

const make = (overrides: Partial<OmpSettingsSnapshot["entries"][number]>[] = []): OmpSettingsSnapshot => ({
  revision: "rev-1", cwd: "/project", entries: [
    { path: "skills.enabled", effective: true, global: true, configured: true, globalConfigured: true, projectConfigured: false, credential: false, origin: "global" },
    { path: "skills.enableSkillCommands", effective: true, global: true, configured: true, globalConfigured: true, projectConfigured: false, credential: false, origin: "global" },
    { path: "disabledExtensions", effective: ["ext:off", "skill:old", "skill:old"], global: ["ext:off", "skill:old"], project: undefined, configured: true, globalConfigured: true, projectConfigured: false, credential: false, origin: "global" },
    ...overrides.map(item => ({ path: "unused", effective: null, configured: false, globalConfigured: false, projectConfigured: false, credential: false, origin: "default" as const, ...item })),
  ], sources: { globalPath: "/agent/config.yml", projectWritePath: "/project/.omp/config.yml", projectRead: "native-capability-merged", overlays: "native-process-configuration" }, mutationEffects: "new-sessions-read-updated-config",
});

test("disabling uses effective inherited list, preserves order, and deduplicates", () => {
  const mutation = skillEnabledMutation(make(), "new", false, "project");
  expect(mutation).toMatchObject({ expectedRevision: "rev-1", scope: "project", path: "disabledExtensions", operation: "set", value: ["ext:off", "skill:old", "skill:new"] });
});

test("project configured list replaces inherited global list and enabling removes only the target", () => {
  const snapshot = make().entries.map(item => item.path === "disabledExtensions" ? { ...item, effective: ["ext:off", "skill:project"], project: ["skill:project", "skill:remove"], projectConfigured: true, configured: true, origin: "project" as const } : item) as OmpSettingsSnapshot["entries"];
  const value = skillEnabledMutation({ ...make(), entries: snapshot }, "remove", true, "project").value;
  expect(value).toEqual(["skill:project"]);
});

test("global toggle reports project override and uses global list only", () => {
  const snapshot = make();
  snapshot.entries = snapshot.entries.map(item => item.path === "disabledExtensions" ? { ...item, effective: ["skill:target"], project: ["skill:target"], projectConfigured: true } : item);
  const state = skillToggleState(snapshot, "target", "global");
  expect(state).toMatchObject({ disabled: true, overriddenByProject: true, scope: "global" });
  expect(state.warning).toContain("overrides");
  expect(skillEnabledMutation(snapshot, "target", true, "global").value).toEqual(["ext:off", "skill:old"]);
});

test("global unset does not copy project-only effective disables", () => {
  const snapshot = make();
  snapshot.entries = snapshot.entries.map(item => item.path === "disabledExtensions"
    ? { ...item, effective: ["skill:project-only"], global: undefined, project: ["skill:project-only"], configured: true, globalConfigured: false, projectConfigured: true, origin: "project" as const }
    : item);
  expect(skillEnabledMutation(snapshot, "global-new", false, "global").value).toEqual(["skill:global-new"]);
  expect(skillToggleState(snapshot, "project-only", "global")).toMatchObject({ disabled: true, scopedDisabled: false });
});

test("malformed or unsupported snapshots are rejected", () => {
  expect(() => skillEnabledMutation(make().entries.length ? { ...make(), revision: "" } : make(), "x", false)).toThrow("Invalid native skill settings snapshot");
  const snapshot = make(); snapshot.entries = snapshot.entries.filter(item => item.path !== "disabledExtensions");
  expect(() => skillToggleState(snapshot, "x")).toThrow("missing disabledExtensions");
  const bad = make(); bad.entries = bad.entries.map(item => item.path === "disabledExtensions" ? { ...item, effective: "bad" } : item);
  expect(() => skillEnabledMutation(bad, "x", false)).toThrow("disabledExtensions must be an array");
  expect(() => skillEnabledMutation(make(), "has space", false)).toThrow("skill name is invalid");
  expect(() => skillEnabledMutation(make(), "x", "false" as never)).toThrow("enabled must be boolean");
  expect(() => skillEnabledMutation(make(), "x", false, "session" as never)).toThrow("scope is invalid");
});
