import { expect, test } from "bun:test";
import { COMPOSER_OWNER_HEADER, type NativeSkillFileDocument, type NativeSkillFileRef } from "@agent-desktop/shared";
import { ComposerActionsHttp } from "./composer-actions-http";

const ref: NativeSkillFileRef = { skillId: "skill:one", sourcePath: "/native/skills/one/SKILL.md", inventory: true };
const file: NativeSkillFileDocument = { protocolVersion: 1, hostId: "owner", ref, catalogRevision: "a".repeat(64),
  document: { kind: "text", path: "SKILL.md", text: "# One\n", revision: "b".repeat(64), bom: false, encoding: "utf8", size: 6, modifiedAt: 1, mode: 0o644 },
  reveal: { label: "Reveal in Finder", available: true } };
const request = (body: unknown, owner = "owner") => new Request("http://host/v1/composer/skill-file", { method: "POST",
  headers: { "Content-Type": "application/json", [COMPOSER_OWNER_HEADER]: owner }, body: JSON.stringify(body) });
const runtime = { getComposerActions: async () => { throw new Error("unexpected discovery"); }, getSkillInventory: async () => { throw new Error("unexpected discovery"); },
  getComposerCompletions: async () => { throw new Error("unexpected completion"); } };

test("skill file HTTP enforces owner and exact bounded ref body before dispatch", async () => {
  const reads: NativeSkillFileRef[] = [];
  const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => "/owned", getHandle: async () => { throw new Error("unexpected session"); }, runtime,
    skillFiles: { read: async value => { reads.push(value); return file; } } });
  const wrong = await http.route(request({ ref }, "other"));
  expect(wrong?.status).toBe(409); expect(await wrong?.json()).toMatchObject({ error: { code: "OWNER_MISMATCH" } });
  const extra = await http.route(request({ ref, path: "/arbitrary" }));
  expect(extra?.status).toBe(400);
  const invalid = await http.route(request({ ref: { ...ref, sourcePath: "relative" } }));
  expect(invalid?.status).toBe(400);
  expect(reads).toEqual([]);
  const response = await http.route(request({ ref }));
  expect(response?.status).toBe(200); expect(await response?.json()).toEqual(file); expect(reads).toEqual([ref]);
});
