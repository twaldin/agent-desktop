import { expect, test } from "bun:test";
import { commandEndpoint, requestVersionedCommand } from "./command-endpoints";
import { HostRequestError } from "./host-transport";
import type { CommandEnvelope } from "../../../../packages/shared/src/protocol";
test("force arm, recovery, cancel and raw native v18 never use an older command endpoint",async()=>{
 const envelopes:CommandEnvelope[]=[
 {id:"raw",commandVersion:18,command:{type:"session.prompt",sessionId:"s",text:"/force:read inspect"}},
 {id:"arm",command:{type:"session.prompt",sessionId:"s",text:"/force read",forceTool:{epoch:"worker",expectedRevision:2,toolName:"read"}}},
 {id:"recovery",command:{type:"session.prompt",sessionId:"s",text:"inspect",forceRecovery:{epoch:"worker",expectedRevision:2,directiveId:"d"}}},
 {id:"cancel",command:{type:"session.force.cancel",sessionId:"s",ticket:{epoch:"worker",revision:2},directiveId:"d"}},
 ];
 for(const envelope of envelopes){
  expect(commandEndpoint(envelope)).toBe("/v18/commands");const calls:string[]=[];
  const result=await requestVersionedCommand(async path=>{calls.push(path);throw new HostRequestError("Missing",404);},envelope);
  expect(calls).toEqual(["/v18/commands"]);expect(result).toMatchObject({ok:false,commandId:envelope.id,error:{code:"FORCE_TOOL_PROTOCOL_UNSUPPORTED"}});
 }
 expect(commandEndpoint({id:"custom",command:{type:"session.prompt",sessionId:"s",text:"/force read"}})).toBe("/v1/commands");
});
