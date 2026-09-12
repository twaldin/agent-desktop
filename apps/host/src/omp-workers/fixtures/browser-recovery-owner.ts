import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "../runtime";

const [root,agentDir,cwd,url,output,arm]=process.argv.slice(2);
if(!root||!agentDir||!cwd||!url||!output)throw new Error("Missing browser recovery fixture arguments");
const runtime=new WorkerRuntime({agentDir,workerPath:fileURLToPath(new URL("./local-browser-worker.ts",import.meta.url)),environment:{
  HOME:root,PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,PI_CODING_AGENT_DIR:agentDir,TERM:"dumb",
  PUPPETEER_EXECUTABLE_PATH:process.env.PUPPETEER_EXECUTABLE_PATH,BROWSER_FRAME_TEST_URL:url,PI_BROWSER_CMUX:"0",PI_BROWSER_RELAY:"0",
}});
const source=await runtime.createBrowserOwner({id:"restart-source-owner",cwd});
await source.createBrowserTab("desktop-restart-continuation",url);
const metadata=await source.getBrowserMetadata();if(metadata.availability!=="running")throw new Error("Native browser unavailable");
const tab=metadata.tabs[0]!,target={workerPid:source.workerPid,name:tab.name,targetId:tab.targetId},operationId=randomUUID();
await source.reserveBrowserEvaluation(target,operationId);
const evaluation=await source.openBrowserEvaluation(target,operationId,"cdp",30_000);
const destination=await runtime.create({cwd,interactions:true});
await destination.installBrowserContinuation({sourceOwnerId:source.id,operationId,target,kindTag:tab.kindTag},evaluation);
const dir=`${root}/reconnect`;
const sourceEndpoint=await source.enableBrowserRecovery!(`${dir}/source.sock`,randomBytes(32).toString("hex"),randomUUID());
const destinationEndpoint=await destination.enableBrowserRecovery!(`${dir}/destination.sock`,randomBytes(32).toString("hex"),randomUUID());
await writeFile(output,JSON.stringify({source:sourceEndpoint,destination:destinationEndpoint,sessionId:destination.id,
  binding:{...target,ownerId:source.id,operationId,backend:"cdp"},tab,url}));
if(arm){const run=destination.startPrompt(`/hold-retained-browser-contract ${tab.name}`);await writeFile(arm,"submitted");void run.accepted.catch(()=>{});void run.completion.catch(()=>{});}
setInterval(()=>{},60_000);
