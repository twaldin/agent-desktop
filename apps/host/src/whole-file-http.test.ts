import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult, DraftInput, HostCommand, HostState, SessionSummary, TranscriptMessage } from "@agent-desktop/shared";
import { serializeWholeFilePrompt } from "@agent-desktop/shared";
import { startHost } from "./server";

const model = { provider: "selected-text-contract", id: "controlled" };
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "whole-file-http-")));
  const options = { dataDirectory: path.join(root, "data"), agentDirectory: path.join(root, "agent"), discoveryDirectory: path.join(root, "project"),
    workerPath: fileURLToPath(new URL("./fixtures/selected-text-http-worker.ts", import.meta.url)), tailscale: false, port: 0 };
  const gates = path.join(options.agentDirectory, "gates");
  await Promise.all([options.dataDirectory, options.agentDirectory, options.discoveryDirectory, gates].map(p => mkdir(p, { recursive: true })));
  await writeFile(path.join(options.agentDirectory, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./omp-workers/fixtures/selected-text-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  let host = await startHost(options);
  const request = (route: string, init: RequestInit = {}) => fetch(`${host.connection.origin}${route}`, { ...init,
    headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", ...init.headers } });
  const command = async (command: HostCommand, id: string = crypto.randomUUID(), version = 7): Promise<CommandResult> => {
    const response = await request(`/v${version}/commands`, { method: "POST", body: JSON.stringify({ id, command }) });
    expect(response.status).toBe(200); return response.json() as Promise<CommandResult>;
  };
  const create = await command({ type: "session.create", projectId: null, cwd: options.discoveryDirectory });
  if (!create.ok || !create.value || !("sessionFile" in create.value)) { await host.stop(); await rm(root, {recursive:true,force:true}); throw new Error(`Expected native session: ${JSON.stringify(create)}`); }
  const session = create.value as SessionSummary;
  const filePath = path.join(options.discoveryDirectory, "literal # % :.ts");
  await writeFile(filePath, "FILE_CONTENT_AT_SEND\n");
  const draft: DraftInput = { id: `session:${session.id}`, text: "Explain this file.", model, projectId: null,
    wholeFileAttachments: [{ id: "whole-one", source: { kind: "file", hostId: host.store.host.id, path: filePath } }] };
  const raw = async () => (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const settled = async () => {
    const until = Date.now() + 5000;
    while (host.store.getSession(session.id)?.status === "running" && Date.now() < until) await Bun.sleep(10);
    expect(host.store.getSession(session.id)?.status).not.toBe("running");
  };
  return { root, gates, request, command, session, draft, raw, settled, get host() { return host; },
    restart: async () => { await host.stop(); host = await startHost(options); },
    close: async () => { await host.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("whole-file intent crosses authenticated HTTP and native context once, then survives receipt replay and restart", async () => {
 const f = await fixture();
 try {
  const state = await (await f.request("/v1/state")).json() as HostState;
  expect(state.wholeFiles).toMatchObject({commandVersion:7,ordinaryPrompt:true});
  const put:HostCommand={type:"draft.put",draft:f.draft,expectedRevision:0};
  for(const version of [1,2,3,4,5,6]) {
   const response=await f.request(`/v${version}/commands`,{method:"POST",body:JSON.stringify({id:`old-${version}`,command:put})});
   expect(response.status).toBe(422);expect(f.host.store.getCommand(`old-${version}`)).toBeUndefined();
  }
  expect((await f.command(put)).ok).toBe(true);
  const {wholeFileAttachments:files,...legacy}=f.draft;
  expect(await f.command({type:"draft.put",draft:legacy,expectedRevision:1},"old-writer",6)).toMatchObject({ok:false,error:{code:"WHOLE_FILE_PROTOCOL_REQUIRED"}});
  const send:HostCommand={type:"session.prompt",sessionId:f.session.id,text:f.draft.text,model,wholeFileAttachments:files,draft:{id:f.draft.id,revision:1}};
  expect(await f.command({...send,wholeFileAttachments:[]})).toMatchObject({ok:false,error:{code:"DRAFT_CONTENT_MISMATCH"}});
  expect(await f.command({...send,draft:undefined,wholeFileAttachments:files?.map(file=>({...file,source:{...file.source,hostId:"other-host"}}))})).toMatchObject({ok:false,error:{code:"WHOLE_FILE_OWNER_MISMATCH"}});
  const result=await f.command(send,"whole-send");expect(result).toMatchObject({ok:true,admission:{kind:"user-message"}});
  await f.settled();
  const entries=await f.raw(), mentions=entries.filter(row=>row.type==="message"&&row.message.role==="fileMention");
  expect(mentions).toHaveLength(1);
  expect(JSON.stringify(mentions[0])).toContain("FILE_CONTENT_AT_SEND");
  const users=entries.filter(row=>row.type==="message"&&row.message.role==="user");expect(users).toHaveLength(1);
  expect(users[0].message.content).toEqual([{type:"text",text:f.draft.text}]);
  expect(entries.find(row=>row.type==="message"&&row.message.role==="assistant").message.content[0].text).toContain("FILE_CONTENT_AT_SEND");
  expect(f.host.store.getDraft(f.draft.id)).toMatchObject({revision:2,text:"",wholeFileAttachments:[],lastConsumption:{commandId:"whole-send",submittedRevision:1}});
  expect(await f.command(send,"whole-send")).toEqual(result);
  await f.restart();expect(await f.command(send,"whole-send")).toEqual(result);
  expect((await f.raw()).filter(row=>row.type==="message"&&row.message.role==="fileMention")).toHaveLength(1);
 }finally{await f.close();}
},30000);

test("lost whole-file native receipt preserves the draft and never replays after host restart",async()=>{
 const f=await fixture();try{
  expect((await f.command({type:"draft.put",draft:f.draft,expectedRevision:0})).ok).toBe(true);
  await writeFile(path.join(f.gates,"lose-receipt"),"");
  const send:HostCommand={type:"session.prompt",sessionId:f.session.id,text:f.draft.text,model,wholeFileAttachments:f.draft.wholeFileAttachments,draft:{id:f.draft.id,revision:1}};
  const result=await f.command(send,"lost-whole");expect(result).toMatchObject({ok:false,error:{code:"OUTCOME_UNKNOWN"}});
  expect(f.host.store.getDraft(f.draft.id)).toMatchObject({revision:1,text:f.draft.text,wholeFileAttachments:f.draft.wholeFileAttachments});
  await f.restart();expect(await f.command(send,"lost-whole")).toEqual(result);
  expect((await f.raw()).filter(row=>row.type==="message"&&row.message.role==="fileMention")).toHaveLength(1);
  expect((await f.raw()).filter(row=>row.type==="message"&&row.message.role==="user")).toHaveLength(1);
 }finally{await f.close();}
},30000);

test("files-only empty authored text delivers actual OMP context and preserves empty user text",async()=>{
 const f=await fixture();try{
  const result=await f.command({type:"session.prompt",sessionId:f.session.id,text:"",model,wholeFileAttachments:f.draft.wholeFileAttachments},"files-only");
  expect(result).toMatchObject({ok:true,admission:{kind:"user-message"}});await f.settled();
  const entries=await f.raw();expect(entries.filter(row=>row.type==="message"&&row.message.role==="fileMention")).toHaveLength(1);
  expect(entries.find(row=>row.type==="message"&&row.message.role==="assistant").message.content[0].text).toContain("FILE_CONTENT_AT_SEND");
 }finally{await f.close();}
},30000);

test("inline whole-file positions require v8, retain exact drafts, and consume only an accepted v8 prompt",async()=>{
 const f=await fixture();try{
  const state=await (await f.request("/v1/state")).json() as HostState;
  expect(state.wholeFiles).toEqual({commandVersion:7,ordinaryPrompt:true,maxFiles:100,inlineMentions:{commandVersion:8}});
  const inlinePath=path.join(path.dirname(f.draft.wholeFileAttachments![0]!.source.path),'@literal # % :42.ts');
  await writeFile(inlinePath,'INLINE_CONTENT_AT_SEND\n');
  const inlineFile={...f.draft.wholeFileAttachments![0]!,source:{...f.draft.wholeFileAttachments![0]!.source,path:inlinePath},textOffset:8};
  const inlineDraft:DraftInput={...f.draft,wholeFileAttachments:[inlineFile]};
  const put:HostCommand={type:"draft.put",draft:inlineDraft,expectedRevision:0};

  const oldDirect=await f.request("/v7/commands",{method:"POST",body:JSON.stringify({id:"inline-v7-direct",command:put})});
  expect(oldDirect.status).toBe(422);
  expect(await oldDirect.json()).toMatchObject({code:"INLINE_FILE_PROTOCOL_REQUIRED"});
  expect(f.host.store.getCommand("inline-v7-direct")).toBeUndefined();
  expect(f.host.store.getDraft(inlineDraft.id)).toBeUndefined();

  const invalid={...put,draft:{...inlineDraft,wholeFileAttachments:[{...inlineFile,textOffset:inlineDraft.text.length+1}]}};
  const outOfBounds=await f.request("/v8/commands",{method:"POST",body:JSON.stringify({id:"inline-out-of-bounds",command:invalid})});
  expect(outOfBounds.status).toBe(400);
  expect(await outOfBounds.json()).toMatchObject({error:expect.stringContaining("UTF-16")});
  expect(f.host.store.getCommand("inline-out-of-bounds")).toBeUndefined();
  expect(f.host.store.getDraft(inlineDraft.id)).toBeUndefined();

  expect(await f.command(put,"inline-put",8)).toMatchObject({ok:true,value:{text:inlineDraft.text,wholeFileAttachments:[inlineFile]}});
  expect(f.host.store.getDraft(inlineDraft.id)).toMatchObject({revision:1,text:inlineDraft.text,wholeFileAttachments:[inlineFile]});

  const referenced:HostCommand={type:"session.prompt",sessionId:f.session.id,text:inlineDraft.text,model,draft:{id:inlineDraft.id,revision:1}};
  expect(await f.command(referenced,"inline-v7-reference",7)).toMatchObject({ok:false,error:{code:"INLINE_FILE_PROTOCOL_REQUIRED"}});
  expect(f.host.store.getCommand("inline-v7-reference")).toMatchObject({state:"done",result:{ok:false,error:{code:"INLINE_FILE_PROTOCOL_REQUIRED"}}});
  expect(f.host.store.getDraft(inlineDraft.id)).toMatchObject({revision:1,text:inlineDraft.text,wholeFileAttachments:[inlineFile]});
  expect(f.host.store.getDraft(inlineDraft.id)?.lastConsumption).toBeUndefined();

  const send:HostCommand={...referenced,wholeFileAttachments:[inlineFile]};
  const receipt=await f.command(send,"inline-v8-send",8);
  expect(receipt).toMatchObject({ok:true,admission:{kind:"user-message"}});
  await f.settled();
  expect(f.host.store.getDraft(inlineDraft.id)).toMatchObject({revision:2,text:"",wholeFileAttachments:[],lastConsumption:{commandId:"inline-v8-send",submittedRevision:1}});
  const wire=serializeWholeFilePrompt(inlineDraft.text,[inlineFile]),entries=await f.raw();
  const users=entries.filter(row=>row.type==='message'&&row.message.role==='user');
  expect(users).toHaveLength(1);expect(users[0].message.content).toEqual([{type:'text',text:wire}]);
  const fileRows=entries.filter(row=>row.type==='message'&&row.message.role==='fileMention');
  expect(fileRows).toHaveLength(1);expect(fileRows[0].message.files).toHaveLength(1);
  expect(fileRows[0].message.files[0].path).toBe(inlinePath);
  const providerContext=JSON.parse(entries.find(row=>row.type==='message'&&row.message.role==='assistant').message.content[0].text);
  expect(providerContext.some((message:any)=>message.role==='user'&&message.content.some((block:any)=>block.type==='text'&&block.text===wire))).toBe(true);
  expect(JSON.stringify(providerContext)).toContain('INLINE_CONTENT_AT_SEND');
  const messages=await (await f.request(`/v1/sessions/${f.session.id}/messages`)).json() as TranscriptMessage[];
  expect(messages.some(message=>message.role==='fileMention')).toBe(false);
  expect(messages.find(message=>message.role==='user')).toMatchObject({text:wire,wholeFiles:{authoredText:inlineDraft.text,attachments:[inlineFile]}});
  expect(await f.command(send,'inline-v8-send',8)).toEqual(receipt);
  await f.restart();expect(await f.command(send,'inline-v8-send',8)).toEqual(receipt);
  const reopened=await (await f.request(`/v1/sessions/${f.session.id}/messages`)).json() as TranscriptMessage[];
  expect(reopened.find(message=>message.role==='user')).toMatchObject({text:wire,wholeFiles:{authoredText:inlineDraft.text,attachments:[inlineFile]}});
  expect((await f.raw()).filter(row=>row.type==='message'&&row.message.role==='user')).toHaveLength(1);
  expect((await f.raw()).filter(row=>row.type==='message'&&row.message.role==='fileMention')).toHaveLength(1);
 }finally{await f.close();}
},30000);
