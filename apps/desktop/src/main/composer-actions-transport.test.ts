import { afterAll, expect, test } from "bun:test";
import { COMPOSER_OWNER_HEADER } from "@agent-desktop/shared";
import { requestComposerActions, requestSkillDetail, requestSkillInventory, requestSkillFile, requestSkillFileOpenOptions, requestSkillImage } from "./composer-actions-transport";
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
  if(path.endsWith("/v1/composer/skill-file-open-options")){
    const body=await request.json() as any;
    const value={protocolVersion:1,hostId:"owner",ref:body.ref,options:{type:"file.open-options",path:body.ref.sourcePath,targets:[{id:"vscode",label:"VS Code",kind:"editor"}],preferredTargetId:"vscode"}};
    if(path.startsWith("/wrong-open-file/"))value.options.path="/other/SKILL.md";
    if(path.startsWith("/wrong-open-host/"))value.hostId="other";
    if(path.startsWith("/duplicate-open/"))value.options.targets.push({...value.options.targets[0]!});
    if(path.startsWith("/invalid-open-kind/"))value.options.targets[0]!.kind="shell-command";
    if(path.startsWith("/missing-open-preferred/"))value.options.preferredTargetId="missing";
    return Response.json(value,{headers:{[COMPOSER_OWNER_HEADER]:"owner"}});
  }
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

test("skill image reads serialize per host and skip a revoked queued grant",async()=>{
  let active=0,maximum=0,release!:()=>void;const paths:string[]=[];
  const gate=new Promise<void>(resolve=>release=resolve);
  const imageServer=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const input=await request.json() as {path:string};paths.push(input.path);active++;maximum=Math.max(maximum,active);
    if(input.path==="one.svg")await gate;
    active--;return Response.json({type:"file.copy-info",path:input.path,absolutePath:"/skills/"+input.path,size:0,revision:"a".repeat(64)},{headers:{[COMPOSER_OWNER_HEADER]:"owner"}});
  }});
  try{
    const endpoint={origin:`http://127.0.0.1:${imageServer.port}`,hostId:"owner"},ref={skillId:"one",sourcePath:"/skills/SKILL.md",inventory:true};
    const first=requestSkillImage(endpoint,ref,"one.svg");
    const abort=new AbortController(),second=requestSkillImage(endpoint,ref,"two.svg",undefined,abort.signal).catch(error=>error);
    const third=requestSkillImage(endpoint,ref,"three.svg");abort.abort(new Error("grant revoked"));
    for(let i=0;i<100&&!paths.length;i++)await Bun.sleep(5);
    await Bun.sleep(20);expect(paths).toEqual(["one.svg"]);
    release();await first;expect(await second).toBeInstanceOf(Error);await third;
    expect(paths).toEqual(["one.svg","three.svg"]);expect(maximum).toBe(1);
  }finally{release();imageServer.stop(true);}
});


test("skill Open response validates exact owner/ref/path and bounded typed application catalog",async()=>{
 const ref={skillId:"demo",sourcePath:"/skills/demo/SKILL.md",inventory:true};
 const endpoint={origin:server.url.origin,hostId:"owner",token:"fixture"};
 expect(await requestSkillFileOpenOptions(endpoint,ref)).toMatchObject({hostId:"owner",ref,options:{preferredTargetId:"vscode"}});
 for(const prefix of ["wrong-open-file","wrong-open-host","duplicate-open","invalid-open-kind","missing-open-preferred"]){
  await expect(requestSkillFileOpenOptions({...endpoint,origin:server.url.origin+"/"+prefix},ref)).rejects.toThrow();
 }
});
