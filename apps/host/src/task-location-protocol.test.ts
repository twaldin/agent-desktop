import { expect, test } from "bun:test";
import { parseCommandEnvelope } from "./validation";
import { commandEndpoint } from "../../desktop/src/main/command-endpoints";

const move={id:"move-1",commandVersion:14 as const,command:{type:"session.location.move" as const,sessionId:"session",expectedRevision:"revision",target:{kind:"worktree" as const,branch:"feature",localCheckoutBranch:"main"}}};
test("location commands require and retain the dedicated v14 command contract",()=>{
  expect(commandEndpoint(move)).toBe("/v14/commands"); expect(parseCommandEnvelope(move,14)).toEqual(move);
  expect(()=>parseCommandEnvelope({...move,commandVersion:13},13)).toThrow("version 14");
  expect(()=>parseCommandEnvelope({...move,command:{...move.command,target:{...move.command.target,extra:true}}},14)).toThrow("target fields");
});
