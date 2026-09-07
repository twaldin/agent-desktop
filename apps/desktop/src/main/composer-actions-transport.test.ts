import { afterAll, expect, test } from "bun:test";
import { COMPOSER_OWNER_HEADER } from "@agent-desktop/shared";
import { requestComposerActions, requestSkillDetail, requestSkillInventory, requestSkillFile } from "./composer-actions-transport";
import { HostRequestError } from "./host-transport";

const seen: Array<{ path: string; owner: string | null; authorization: string | null }> = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  seen.push({ path, owner: request.headers.get(COMPOSER_OWNER_HEADER), authorization: request.headers.get("authorization") });
  if (path === "/plain-404/v1/composer/actions") return Response.json({ error: "Not found" }, { status: 404 });
  if (path === "/plain-404/v1/composer/skill-inventory") return Response.json({ error: "Not found" }, { status: 404 });
  if (path === "/coded-404/v1/composer/actions") return Response.json({ error: { code: "COMPOSER_UNAVAILABLE", message: "Composer disabled" } }, { status: 404 });
  if (path === "/auth/v1/composer/actions") return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (path === "/wrong-owner/v1/composer/actions") return Response.json({ protocolVersion: 1, hostId: "other", cwd: "/tmp", revision: "a".repeat(64), commands: [], skills: [], diagnostics: [] }, { headers: { [COMPOSER_OWNER_HEADER]: "other" } });
  if (path.endsWith("/v1/composer/skill-file")) {
    const body = await request.json() as {ref:Record<string,unknown>};
    const ref = {...body.ref};
    if (path.startsWith("/wrong-file/")) ref.sourcePath = "/different/SKILL.md";
    if (path.startsWith("/wrong-target/")) ref.target = {projectId:"other"};
    return Response.json({protocolVersion:1,hostId:path.startsWith("/wrong-file-owner/")?"other":"owner",ref,catalogRevision:"a".repeat(64),
      document:{kind:"text",text:"# skill",revision:"b".repeat(64),path:"SKILL.md",size:7,mode:420,modifiedAt:123,bom:false,encoding:"utf8"},
      reveal:{label:"Reveal in Finder",available:true}}, {headers:{[COMPOSER_OWNER_HEADER]:"owner"}});
  }
  if (path === "/detail/v1/composer/skill-detail") {
    const body = await request.json() as { target?: { projectId: string } };
    return Response.json({ protocolVersion: 1, hostId: "owner", target: body.target, cwd: "/tmp", revision: "a".repeat(64), skillId: "skill:one", content: "# skill" }, { headers: { [COMPOSER_OWNER_HEADER]: "owner" } });
  }
  if (path.endsWith("/v1/composer/skill-inventory")) {
    const body = await request.json() as { target?: { projectId: string } };
    return Response.json({ protocolVersion: 1, hostId: path.startsWith("/wrong-inventory-owner/") ? "other" : "owner", target: body.target, cwd: "/tmp", revision: "9".repeat(64), enabled: false, commandsEnabled: true, skills: [{ id: "skill:one", name: "one", description: "One", insertText: "/skill:one ", source: { kind: "skill", label: "Project", path: "/tmp/SKILL.md" }, availability: "disabled", reason: "Disabled by name", argumentCompletions: false, disabledByName: true }], diagnostics: [] }, { headers: { [COMPOSER_OWNER_HEADER]: path.startsWith("/wrong-inventory-owner/") ? "other" : "owner" } });
  }
  if (path === "/bad-detail-revision/v1/composer/skill-detail") return Response.json({ protocolVersion: 1, hostId: "owner", cwd: "/tmp", revision: "f".repeat(64), skillId: "skill:one", content: "# skill" }, { headers: { [COMPOSER_OWNER_HEADER]: "owner" } });
  if (path === "/bad-detail-id/v1/composer/skill-detail") return Response.json({ protocolVersion: 1, hostId: "owner", cwd: "/tmp", revision: "a".repeat(64), skillId: "skill:other", content: "# skill" }, { headers: { [COMPOSER_OWNER_HEADER]: "owner" } });
  return Response.json({ protocolVersion: 1, hostId: "owner", cwd: "/tmp", revision: "a".repeat(64), commands: [], skills: [], diagnostics: [] }, { headers: { [COMPOSER_OWNER_HEADER]: "owner" } });
} });
const endpoint = (prefix: string) => ({ origin: `http://127.0.0.1:${server.port}/${prefix}`, hostId: "owner", token: "transport-secret" });
afterAll(() => server.stop(true));

test("composer transport binds requests and responses to the selected owner", async () => {
  expect(await requestComposerActions(endpoint("ok"))).toMatchObject({ hostId: "owner", cwd: "/tmp" });
  expect(seen.at(-1)).toEqual({ path: "/ok/v1/composer/actions", owner: "owner", authorization: "Bearer transport-secret" });
  await expect(requestComposerActions(endpoint("wrong-owner"))).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" });
});

test("only an uncoded route 404 is treated as an older host", async () => {
  expect(await requestComposerActions(endpoint("plain-404"))).toBeNull();
  await expect(requestComposerActions(endpoint("coded-404"))).rejects.toBeInstanceOf(HostRequestError);
  await expect(requestComposerActions(endpoint("auth"))).rejects.toMatchObject({ status: 401 });
  expect(await requestSkillInventory(endpoint("plain-404"))).toBeNull();
});

test("skill inventory transport validates and binds its complete configured projection", async () => {
  const result = await requestSkillInventory(endpoint("inventory"), { projectId: "project" }, true);
  expect(result).toMatchObject({ hostId: "owner", target: { projectId: "project" }, enabled: false, commandsEnabled: true, skills: [{ id: "skill:one", disabledByName: true }] });
  await expect(requestSkillInventory(endpoint("wrong-inventory-owner"))).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" });
});

test("skill detail transport preserves owner, target and bounded content", async () => {
  const result = await requestSkillDetail(endpoint("detail"), { projectId: "project" }, "skill:one", "a".repeat(64));
  expect(result).toMatchObject({ hostId: "owner", skillId: "skill:one", content: "# skill" });
  expect(seen.at(-1)?.path).toBe("/detail/v1/composer/skill-detail");
  await requestSkillDetail(endpoint("detail"), { projectId: "project" }, "skill:one", "a".repeat(64), true);
});

test("skill detail transport rejects stale revision and wrong skill identity", async () => {
  await expect(requestSkillDetail(endpoint("bad-detail-revision"), undefined, "skill:one", "a".repeat(64))).rejects.toThrow("invalid");
  await expect(requestSkillDetail(endpoint("bad-detail-id"), undefined, "skill:one", "a".repeat(64))).rejects.toThrow("invalid");
});

test("editable skill file transport checks host and exact native resource independently of workspace files", async () => {
  const ref = {inventory:true,sourcePath:"/outside-project/SKILL.md",skillId:"skill:one",target:{projectId:"project"}};
  const result = await requestSkillFile(endpoint("file"),ref);
  expect(result.ref).toEqual(ref);
  expect(seen.at(-1)).toEqual({path:"/file/v1/composer/skill-file",owner:"owner",authorization:"Bearer transport-secret"});
  for (const prefix of ["wrong-file","wrong-target","wrong-file-owner"]) await expect(requestSkillFile(endpoint(prefix),ref)).rejects.toThrow("different owner");
  await expect(requestSkillFile(endpoint("file"),{...ref,sourcePath:"relative.md"})).rejects.toThrow("invalid");
  const global = await requestSkillFile(endpoint("file"),{skillId:ref.skillId,sourcePath:ref.sourcePath,inventory:true});
  expect(global.ref.target).toBeUndefined();
});
