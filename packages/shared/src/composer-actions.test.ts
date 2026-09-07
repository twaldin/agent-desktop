import { expect, test } from "bun:test";
import { parseNativeSkillInventory } from "./composer-actions";

const inventory = () => ({ protocolVersion: 1, hostId: "host", target: { projectId: "project" }, cwd: "/tmp/project", revision: "a".repeat(64),
  enabled: false, commandsEnabled: true, diagnostics: ["configured warning"], skills: [{ id: "skill:one", name: "one", description: "One", insertText: "/skill:one ", source: { kind: "skill", label: "Project", path: "/tmp/project/.omp/skills/one/SKILL.md", ignored: "private" }, availability: "disabled", reason: "Disabled by name", argumentCompletions: false, disabledByName: true, private: "drop" }] });

test("native skill inventory parser preserves bounded public state and drops unknown fields", () => {
  expect(parseNativeSkillInventory(inventory())).toEqual({ protocolVersion: 1, hostId: "host", target: { projectId: "project" }, cwd: "/tmp/project", revision: "a".repeat(64),
    enabled: false, commandsEnabled: true, diagnostics: ["configured warning"], skills: [{ id: "skill:one", name: "one", description: "One", insertText: "/skill:one ", source: { kind: "skill", label: "Project", path: "/tmp/project/.omp/skills/one/SKILL.md" }, availability: "disabled", reason: "Disabled by name", argumentCompletions: false, disabledByName: true }] });
});

test("native skill inventory parser rejects malformed identities and oversized projections", () => {
  expect(() => parseNativeSkillInventory({ ...inventory(), revision: "bad" })).toThrow();
  expect(() => parseNativeSkillInventory({ ...inventory(), target: { projectId: "project", sessionId: "session" } })).toThrow();
  expect(() => parseNativeSkillInventory({ ...inventory(), skills: [{ ...inventory().skills[0], disabledByName: "yes" }] })).toThrow();
  expect(() => parseNativeSkillInventory({ ...inventory(), diagnostics: ["x".repeat(4097)] })).toThrow();
  expect(() => parseNativeSkillInventory({ ...inventory(), skills: Array.from({ length: 2049 }, () => inventory().skills[0]) })).toThrow();
});
