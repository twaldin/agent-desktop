import { expect, test } from "bun:test";
import { ForceToolSubmissions, nativeForceWinner } from "./force-tool-submissions";
import { SubmissionController } from "./submissions";
import { DraftController } from "./drafts";
import type { CommandEnvelope, CommandResult, Draft, ForceToolReceipt, SessionSummary } from "../../../../packages/shared/src/protocol";
import type { ComposerActionsCatalog } from "../../../../packages/shared/src/composer-actions";
const draft: Draft = { id: "session:s", revision: 7, projectId: null, text: "/force read inspect this file", model: { provider: "openai", id: "model" }, thinkingLevel: "low", updatedAt: 1 };
const guard = { epoch: "worker", expectedRevision: 3, toolName: "read" };
const state = { epoch: "worker", revision: 4, nativeSessionId: "native", model: { provider: "openai", id: "model", api: "openai-responses" }, availability: { state: "supported" as const, reason: "" }, tools: [{ name: "read", available: true }], directives: [], canArm: true, canCancel: false };
const armed = (commandId: string): ForceToolReceipt => ({ commandId, epoch: "worker", directiveId: "directive", toolName: "read", arm: "armed", prompt: "not-recorded" });
const cache = () => { const map = new Map<string,string>(); return { read: (key:string)=>map.get(key)??null, write: (key:string,value:string)=>{map.set(key,value);} }; };
const unknown = (envelope:CommandEnvelope):CommandResult=>({ok:false,commandId:envelope.id,error:{code:"OUTCOME_UNKNOWN",message:"Unknown"}});
const partial = (envelope:CommandEnvelope):CommandResult=>({ok:false,commandId:envelope.id,forceToolReceipt:armed(envelope.id),error:{code:"PROMPT_FAILED",message:"Prompt not recorded"}});
const recovery = (receipt:ForceToolReceipt) => ({ text:"inspect this file",originalReceipt:receipt,ticket:{epoch:"worker",revision:4},directiveId:"directive" });

test("actual native winner preserves exact custom/extension tokens and colon alias collisions",()=>{
 const builtin={id:"builtin:force",name:"force",aliases:["force:"],insertText:"/force ",description:"",source:{kind:"builtin" as const,label:"native"},availability:"executable" as const,argumentCompletions:false};
 const catalog={commands:[builtin]} as ComposerActionsCatalog;
 expect(nativeForceWinner(catalog,"/force read")).toBe(true);
 const custom={...builtin,id:"custom",aliases:[],source:{kind:"custom" as const,label:"custom"}};
 expect(nativeForceWinner({...catalog,commands:[custom,{...builtin,availability:"shadowed"}]},"/force read")).toBe(false);
 expect(nativeForceWinner({...catalog,commands:[custom,{...builtin,availability:"shadowed"}]},"/force:read")).toBe(true);
 expect(nativeForceWinner({...catalog,commands:[{...custom,name:"force:read"},builtin]},"/force:read inspect")).toBe(false);
 expect(()=>nativeForceWinner(catalog," /force read")).toThrow("start");
});
test("prepared guard survives restart and save revision, but never silently downgrades edits, model, owner or command winner",()=>{
 const storage=cache(), one=new ForceToolSubmissions(async()=>{throw Error("no send");},"host",storage);
 one.prepare("s",draft,guard);
 const restored=new ForceToolSubmissions(async()=>{throw Error("no send");},"host",storage);
 expect(restored.selection("s",{...draft,revision:8},true)).toEqual({nativeForce:true,guard});
 for(const change of [{text:"/force read changed"},{model:{provider:"openai",id:"other"}}]) expect(()=>restored.selection("s",{...draft,...change},true)).toThrow("changed");
 expect(()=>restored.selection("other",draft,true)).toThrow("changed");
 expect(()=>restored.selection("s",draft,false)).toThrow("custom");
});
test("lost native arm reply restores exact v18 identity and captured guard despite draft edits",async()=>{
 const storage=cache(),calls:CommandEnvelope[]=[];
 const first=new SubmissionController(async e=>{calls.push(e);return unknown(e);},"host",storage);
 await expect(first.submit(draft,"s","prompt",undefined,undefined,{nativeForce:true,guard})).rejects.toThrow("uncertain");
 const restored=new SubmissionController(async e=>{calls.push(e);return partial(e);},"host",storage);
 expect(restored.cacheWarning).toBeUndefined();
 await expect(restored.submit({...draft,text:"edited"},"other","prompt")).rejects.toThrow("not recorded");
 expect(calls[1]).toEqual(calls[0]);expect(calls[0]).toMatchObject({commandVersion:18,command:{forceTool:guard,text:draft.text,sessionId:"s"}});
 expect(restored.forceRecovery("s")?.prompt).toBe("inspect this file");
 await expect(restored.submit(draft,"s","prompt")).rejects.toThrow("original armed");expect(calls).toHaveLength(2);
});
test("arm-only admission finishes once with its native receipt",async()=>{
 const calls:CommandEnvelope[]=[];const controller=new SubmissionController(async e=>{calls.push(e);return {ok:true,commandId:e.id,forceToolReceipt:{...armed(e.id),prompt:"not-requested"},admission:{kind:"native-command",command:"force"}};},"host",cache());
 await controller.submit({...draft,text:"/force read"},"s","prompt",undefined,undefined,{nativeForce:true});
 expect(controller.entries()).toHaveLength(0);expect(calls).toHaveLength(1);
});
test("new conversation resolves loaded session winner after create, then uses real native v18 or ordinary custom route",async()=>{
 for(const native of [true,false]){
 const calls:CommandEnvelope[]=[];let resolved=false;
 const controller=new SubmissionController(async e=>{calls.push(e);if(e.command.type==="session.create")return {ok:true,commandId:e.id,value:{id:"s",hostId:"host",projectId:null,model:draft.model,sessionFile:"/fixture",cwd:"/fixture",title:"fixture",status:"idle",archived:false,createdAt:1,updatedAt:1} as SessionSummary};
 expect(resolved).toBe(true);return {ok:true,commandId:e.id,...(native?{forceToolReceipt:{...armed(e.id),prompt:"recorded" as const,promptEntryId:"entry"}}:{}),admission:{kind:"user-message",entryId:"entry"}};},"host",cache(),async(id,text)=>{expect(calls).toHaveLength(1);expect(id).toBe("s");expect(text).toBe(draft.text);resolved=true;return native;});
 await controller.submit({...draft,id:"new-conversation",projectId:null},undefined,"prompt",undefined,undefined,{nativeForce:true});
 expect(calls[1]?.commandVersion).toBe(native?18:undefined);expect(calls[1]?.command).not.toHaveProperty("forceTool");
 }
});
test("partial armed recovery preserves original model and plain text, omits original draft, and reuses lost operation across restart and revision change",async()=>{
 const storage=cache(),calls:CommandEnvelope[]=[];
 const controller=new SubmissionController(async e=>{calls.push(e);return partial(e);},"host",storage);
 await expect(controller.submit(draft,"s","prompt",undefined,undefined,{nativeForce:true})).rejects.toThrow();
 const original=controller.forceRecovery("s")!.receipt;
 const lost=new SubmissionController(async e=>{calls.push(e);throw Error("lost");},"host",storage);
 await expect(lost.recoverForcePrompt("s",recovery(original))).rejects.toThrow("lost");
 const restored=new SubmissionController(async e=>{calls.push(e);return {ok:true,commandId:e.id,admission:{kind:"user-message",entryId:"recovered"}};},"host",storage);
 await restored.recoverForcePrompt("s",{...recovery(original),ticket:{epoch:"worker",revision:8}});
 expect(calls[2]).toEqual(calls[1]);expect(calls[1]).toMatchObject({commandVersion:18,command:{type:"session.prompt",text:"inspect this file",model:draft.model,thinkingLevel:"low",forceRecovery:{epoch:"worker",expectedRevision:4,directiveId:"directive"}}});
 expect(calls[1]?.command).not.toHaveProperty("forceTool");expect(calls[1]?.command).not.toHaveProperty("draft");expect(restored.entries()).toHaveLength(0);
});
test("recovery needs actual user admission and rejects corrupt attachment-bearing original",async()=>{
 const operations=new ForceToolSubmissions(async e=>({ok:true,commandId:e.id,admission:{kind:"native-command",command:"force"}}),"host",cache());
 await expect(operations.recover("s",recovery(armed("original")),draft)).rejects.toThrow("user prompt");
 await expect(operations.recover("s",recovery(armed("original")),{...draft,attachments:[{} as never]})).rejects.toThrow("attachment-bearing");
});
test("cancel retries its persisted ID after restart and changed read revision, never direct HTTP or new ID",async()=>{
 const storage=cache(),calls:CommandEnvelope[]=[];
 const first=new ForceToolSubmissions(async e=>{calls.push(e);return unknown(e);},"host",storage);
 await expect(first.cancel("s",{epoch:"worker",expectedRevision:3,directiveId:"directive"})).rejects.toThrow("Unknown");
 const restored=new ForceToolSubmissions(async e=>{calls.push(e);return {ok:true,commandId:e.id,value:{type:"session.force.cancel",state,cancelledDirectiveId:"directive"}};},"host",storage);
 await restored.cancel("s",{epoch:"worker",expectedRevision:9,directiveId:"directive"});expect(calls[1]).toEqual(calls[0]);
});
test("settled stale refusal permits a newly reviewed ticket, uncertain outcomes do not",async()=>{
 const calls:CommandEnvelope[]=[];const operations=new ForceToolSubmissions(async e=>{calls.push(e);return {ok:false,commandId:e.id,error:{code:"STALE",message:"Refresh state"}};},"host",cache());
 await expect(operations.cancel("s",{epoch:"worker",expectedRevision:3,directiveId:"directive"})).rejects.toThrow("Refresh");
 await expect(operations.cancel("s",{epoch:"worker",expectedRevision:4,directiveId:"directive"})).rejects.toThrow("Refresh");
 expect(calls[0]?.id).not.toBe(calls[1]?.id);
});
test("a restarted cancellation remains explicitly checkable after its directive leaves the queue",async()=>{
 const storage=cache(),calls:CommandEnvelope[]=[];const original=new SubmissionController(async e=>partial(e),"host",storage);
 await expect(original.submit(draft,"s","prompt",undefined,undefined,{nativeForce:true})).rejects.toThrow();
 const originalCommandId=original.forceRecovery("s")!.receipt.commandId;
 const first=new SubmissionController(async e=>{calls.push(e);throw Error("lost cancel");},"host",storage);
 await expect(first.cancelForce("s",{epoch:"worker",expectedRevision:3,directiveId:"directive"})).rejects.toThrow("lost");
 const restored=new SubmissionController(async e=>{calls.push(e);return {ok:true,commandId:e.id,value:{type:"session.force.cancel",state,cancelledDirectiveId:"directive"}};},"host",storage);
 const pending=restored.forceTools.pendingOperations("s");expect(pending).toHaveLength(1);
 const retained=await restored.checkForceOperation("s",pending[0]!.id);
 expect(retained).toMatchObject({draft:{text:draft.text},originalCommandId});expect(calls[1]).toEqual(calls[0]);expect(restored.forceTools.pendingOperations("s")).toEqual([]);expect(restored.forceRecovery("s")).toBeUndefined();
});
test("the authoritative original journal can settle a stale partial receipt without replaying its prompt",async()=>{
 const storage=cache(),controller=new SubmissionController(async e=>partial(e),"host",storage);
 await expect(controller.submit(draft,"s","prompt",undefined,undefined,{nativeForce:true})).rejects.toThrow();
 const receipt=controller.forceRecovery("s")!.receipt;
 const result=controller.observeForceReceipt("s",{commandId:receipt.commandId,state:"succeeded",forceToolReceipt:{...receipt,prompt:"recorded",promptEntryId:"entry"}});
 expect(result).toMatchObject({accepted:true,draft:{text:draft.text},commandId:receipt.commandId});expect(controller.entries()).toHaveLength(0);
});
test("an unresolved force cannot become a queued active-turn message or a fresh send after navigation",async()=>{
 const calls:CommandEnvelope[]=[];const controller=new SubmissionController(async e=>{calls.push(e);return partial(e);},"host",cache());
 await expect(controller.submit({...draft,id:"new-conversation"},"s","prompt",undefined,undefined,{nativeForce:true})).rejects.toThrow();
 await expect(controller.submitActive(draft,"s","follow-up")).rejects.toThrow("original force");
 await expect(controller.submit(draft,"s","prompt")).rejects.toThrow("original force");expect(calls).toHaveLength(1);
});
test("colon whitespace uses the actual native argument projection for recovery",async()=>{
 const controller=new SubmissionController(async e=>partial(e),"host",cache());
 await expect(controller.submit({...draft,text:"/force:  read   original prompt  "},"s","prompt",undefined,undefined,{nativeForce:true})).rejects.toThrow();
 expect(controller.forceRecovery("s")?.prompt).toBe("original prompt");
});

test("definite not-armed refusal retains its original receipt and restores settled before an edited new submission", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  const first = new SubmissionController(async envelope => {
    calls.push(structuredClone(envelope));
    return { ok: false, commandId: envelope.id,
      forceToolReceipt: { commandId: envelope.id, epoch: "worker", toolName: "read", arm: "not-armed", prompt: "not-recorded" },
      error: { code: "FORCE_TOOL_NOT_ARMED", message: "The selected tool is unavailable." } };
  }, "host", storage);
  await expect(first.submit(draft, "s", "prompt", undefined, undefined, { nativeForce: true, guard })).rejects.toThrow("unavailable");
  const refused = first.get(draft.id)!;
  expect(refused.send).toEqual(calls[0]);
  expect(refused.forceToolReceipt).toMatchObject({ commandId: calls[0]!.id, arm: "not-armed" });
  expect(refused.uncertain).toBe(false);
  const restored = new SubmissionController(async envelope => {
    calls.push(structuredClone(envelope));
    return { ok: true, commandId: envelope.id, admission: { kind: "user-message", entryId: "edited-entry" } };
  }, "host", storage);
  expect(restored.cacheWarning).toBeUndefined();
  expect(restored.get(draft.id)).toEqual(refused);
  expect(restored.forceRecovery("s")).toBeUndefined();
  // Restoring never sends or infers a missing queue. An explicit new draft can
  // replace the settled refusal without replaying its native force command.
  expect(calls).toHaveLength(1);
  const drafts = new DraftController(async envelope => {
    if (envelope.command.type !== "draft.put") throw new Error("Only draft saves expected");
    return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: 2 } };
  }, "host", storage);
  // Match App's restore treatment: a settled refusal releases any older local
  // consumption correlation instead of publishing a new in-flight marker.
  for (const pending of restored.entries()) {
    if (pending.send && pending.forceToolReceipt?.arm !== "not-armed") drafts.beginPendingSubmission(pending.draft, pending.send.id);
    else if (!pending.uncertain) { drafts.get(pending.draft.id, pending.draft); drafts.finishSubmission(pending.draft.id, pending.draft, false); }
  }
  drafts.setConnected(true);
  drafts.update(draft.id, { text: "New ordinary prompt" });
  const edited = await drafts.prepareSubmission(draft.id);
  expect(edited.text).toBe("New ordinary prompt");
  await restored.submit(edited, "s", "prompt");
  drafts.dispose();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.id).not.toBe(calls[0]!.id);
  expect(calls[1]!.command).toMatchObject({ type: "session.prompt", text: "New ordinary prompt" });
  expect(calls[1]!.command).not.toHaveProperty("forceTool");
  expect(restored.entries()).toEqual([]);
});


test("cleared Goal drafts keep v24 for native force and preserve it across an uncertain restart", async () => {
 const storage=cache(), calls:CommandEnvelope[]=[];
 const cleared={...draft,goal:null};
 const first=new SubmissionController(async e=>{calls.push(structuredClone(e));return unknown(e);},"host",storage);
 await expect(first.submit(cleared,"s","prompt",undefined,undefined,{nativeForce:true,guard})).rejects.toThrow("uncertain");
 expect(calls[0]).toMatchObject({commandVersion:24,command:{type:"session.prompt",forceTool:guard,draft:{id:cleared.id,revision:cleared.revision}}});
 expect(calls[0]!.command).not.toHaveProperty("goal");
 const restored=new SubmissionController(async e=>{calls.push(structuredClone(e));return partial(e);},"host",storage);
 expect(restored.cacheWarning).toBeUndefined();
 await expect(restored.submit({...cleared,text:"edited",goal:{tokenBudget:"5000"}},"other","prompt")).rejects.toThrow("Prompt not recorded");
 expect(calls[1]).toEqual(calls[0]);
});

test("a saved legacy cleared-Goal force receipt is retained without upgrading its command", async () => {
 const storage=cache(), calls:CommandEnvelope[]=[];
 const envelope:CommandEnvelope={id:"legacy-force",commandVersion:18,command:{type:"session.prompt",sessionId:"s",text:draft.text,forceTool:guard,model:draft.model!,thinkingLevel:draft.thinkingLevel,draft:{id:draft.id,revision:draft.revision}}};
 storage.write("agent-desktop:submissions:v1:host",JSON.stringify({[draft.id]:{draft:{...draft,goal:null},sessionId:"s",mode:"prompt",uncertain:true,force:{nativeForce:true,guard},send:envelope}}));
 const restored=new SubmissionController(async e=>{calls.push(structuredClone(e));return unknown(e);},"host",storage);
 expect(restored.cacheWarning).toBeUndefined();
 expect(restored.entries()).toHaveLength(1);
 await expect(restored.submit({...draft,text:"new input"},"s","prompt")).rejects.toThrow("uncertain");
 expect(calls).toEqual([envelope]);
});
