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
    skillFiles: { read: async value => { reads.push(value); return file; }, image: async () => { throw new Error("unexpected image"); } } });
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


const imageRequest = (body: unknown, owner = "owner") => new Request("http://host/v1/composer/skill-file-image", { method: "POST",
  headers: { "Content-Type": "application/json", [COMPOSER_OWNER_HEADER]: owner }, body: JSON.stringify(body) });
test("skill image HTTP validates an exact request shape and preserves copy result modes", async () => {
  const calls: unknown[][] = [];
  const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => "/owned", getHandle: async () => { throw new Error("unexpected session"); }, runtime,
    skillFiles: { read: async () => file, image: async (...input) => {
      calls.push(input);
      const [, path, revision, offset] = input;
      return revision === undefined
        ? { type: "file.copy-info" as const, path, absolutePath: "/native/skills/one/image.png", size: 4, revision: "c".repeat(64) }
        : { type: "file.copy-chunk" as const, path, size: 4, revision, offset: offset!, dataBase64: "AQIDBA==" };
    } },
  });
  for (const body of [{ ref, path: "../outside.png" }, { ref, path: "image.png", revision: "a".repeat(64) }, { ref, path: "image.png", offset: 0 }, { ref, path: "image.png", revision: "bad", offset: 0 }, { ref, path: "image.png", offset: 0, extra: true }]) {
    const response = await http.route(imageRequest(body)); expect(response?.status).toBe(400);
  }
  const info = await http.route(imageRequest({ ref, path: "images/one.png" }));
  expect(info?.status).toBe(200); expect(await info?.json()).toMatchObject({ type: "file.copy-info", path: "images/one.png", size: 4 });
  const chunk = await http.route(imageRequest({ ref, path: "images/one.png", revision: "c".repeat(64), offset: 0 }));
  expect(chunk?.status).toBe(200); expect(await chunk?.json()).toMatchObject({ type: "file.copy-chunk", path: "images/one.png", dataBase64: "AQIDBA==" });
  expect(calls).toEqual([[ref, "images/one.png", undefined, undefined], [ref, "images/one.png", "c".repeat(64), 0]]);
});

test("four active skill image reads leave a composer skill-file read admitted", async () => {
  let release!: () => void, started = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => "/owned", getHandle: async () => { throw new Error("unexpected session"); }, runtime,
    skillFiles: { read: async () => file, image: async (_ref, path) => {
      started++; await hold;
      return { type: "file.copy-info" as const, path, absolutePath: "/native/skills/one/image.png", size: 4, revision: "c".repeat(64) };
    } },
  });
  const images = Array.from({ length: 4 }, (_, index) => http.route(imageRequest({ ref, path: `images/${index}.png` })));
  while (started !== 4) await Bun.sleep(1);
  const normal = await http.route(request({ ref }));
  expect(normal?.status).toBe(200); expect(await normal?.json()).toEqual(file);
  const fifth = await http.route(imageRequest({ ref, path: "images/fifth.png" }));
  expect(fifth?.status).toBe(429); expect(await fifth?.json()).toMatchObject({ error: { code: "COMPOSER_BUSY" } });
  release();
  for (const image of await Promise.all(images)) expect(image?.status).toBe(200);
});


test("skill Open/copy routes reject wrong owner, extra paths and malformed chunks before dispatch",async()=>{
 const calls:string[]=[];
 const http=new ComposerActionsHttp({hostId:"owner",resolveCwd:()=>"/owned",getHandle:async()=>{throw Error("unexpected session");},runtime,
  skillFiles:{read:async()=>file,image:async()=>{throw Error("unexpected image");},openOptions:async resource=>{calls.push("options");return {protocolVersion:1,hostId:"owner",ref:resource,options:{type:"file.open-options",path:resource.sourcePath,targets:[]}};},copy:async()=>{calls.push("copy");return {type:"file.copy-info",path:"SKILL.md",absolutePath:ref.sourcePath,size:4,revision:"a".repeat(64)};}},
 });
 const send=(suffix:string,body:unknown,owner="owner")=>http.route(new Request("http://host/v1/composer/skill-file-"+suffix,{method:"POST",headers:{[COMPOSER_OWNER_HEADER]:owner},body:JSON.stringify(body)}));
 expect((await send("open-options",{ref},"other"))?.status).toBe(409);
 for(const [route,body] of [["open-options",{ref,path:"/other"}],["copy",{ref,path:"other.md"}],["copy",{ref,revision:"a".repeat(64)}],["copy",{ref,revision:"a".repeat(64),offset:-1}]] as const)expect((await send(route,body))?.status).toBe(400);
 expect(calls).toEqual([]);expect((await send("open-options",{ref}))?.status).toBe(200);expect((await send("copy",{ref}))?.status).toBe(200);expect(calls).toEqual(["options","copy"]);
});
