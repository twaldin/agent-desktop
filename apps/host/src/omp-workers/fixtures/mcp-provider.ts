// Deterministic provider transport; the agent, tool registry, MCP subprocess,
// tool execution and persisted native session remain production OMP.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
export default function(pi: ExtensionAPI) {
  const gates = process.env.MCP_CONTRACT_GATES;
  if (!gates) throw new Error("MCP fixture requires isolated gates");
  pi.registerCommand("fixture-tool-selection", { description: "Controlled native tool selection", handler: async args => {
    if (args === "read") await pi.setActiveTools(["read"]);
    writeFileSync(path.join(gates, "active-tools.json"), JSON.stringify(pi.getActiveTools()));
  } });
  pi.registerProvider("mcp-contract", {baseUrl:"https://controlled.invalid", apiKey:"inert-local-fixture-key",api:"mcp-contract-api" as Api,
    models:[{id:"controlled",name:"Controlled native MCP fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024}],
    streamSimple(model,context,options) {
      const stream = new AssistantMessageEventStream();
      void (async()=>{
        writeFileSync(path.join(gates,"provider-started"),"");
        while(existsSync(path.join(gates,"hold")) && !options?.signal?.aborted) await Bun.sleep(5);
        const lastUser = context.messages.findLastIndex(message=>message.role==='user');
        const results = context.messages.slice(lastUser+1).filter(message=>message.role==='toolResult');
        const listed = results.length > 0;
        const mounted = listed && JSON.stringify(results[0]).includes('mcp__fixture_tool');
        const answered = results.length > 1;
        const tool = !listed ? {name:'read',arguments:{path:'xd://'}} : mounted && !answered ? {name:'write',arguments:{path:'xd://mcp__fixture_tool',content:'{}'}} : undefined;
        writeFileSync(path.join(gates,"tools.json"),JSON.stringify(context.tools?.map(tool=>tool.name)));
        const aborted = options?.signal?.aborted;
        const message:AssistantMessage={role:"assistant",content:aborted?[]:answered?[{type:"text",text:"Native MCP tool completed."}]:tool?[{type:"toolCall",id:crypto.randomUUID(),name:tool.name,arguments:tool.arguments}]:[{type:"text",text:"No MCP tools registered."}],
          api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:aborted?"aborted":answered||!tool?"stop":"toolUse",timestamp:Date.now()};
        stream.push({type:"start",partial:{...message,content:[]}});
        const call = message.content[0];
        if(call?.type==='toolCall') {
          stream.push({type:'toolcall_start',contentIndex:0,partial:{...message,content:[{...call,arguments:{}}]}});
          stream.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:message});
        }
        if(aborted) stream.push({type:"error",reason:"aborted",error:message});
        else stream.push({type:"done",reason:answered||!tool?"stop":"toolUse",message});
      })().catch(error=>{stream.end();throw error;});
      return stream;
    }});
}
