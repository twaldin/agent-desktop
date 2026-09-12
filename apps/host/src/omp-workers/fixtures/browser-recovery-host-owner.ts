import { randomBytes,randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CommandEnvelope,DraftBrowserContinuation } from "@agent-desktop/shared";
import { HostStore } from "../../store";
import { startHost } from "../../server";
import { WorkerRuntime } from "../runtime";

const [root,dataDirectory,agentDir,cwd,url,output]=process.argv.slice(2);
if(!root||!dataDirectory||!agentDir||!cwd||!url||!output)throw new Error("Missing browser recovery host fixture arguments");
const runtime=new WorkerRuntime({agentDir,workerPath:fileURLToPath(new URL("./local-browser-worker.ts",import.meta.url)),environment:{
  HOME:root,PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,PI_CODING_AGENT_DIR:agentDir,TERM:"dumb",
  PUPPETEER_EXECUTABLE_PATH:process.env.PUPPETEER_EXECUTABLE_PATH,PI_BROWSER_CMUX:"0",PI_BROWSER_RELAY:"0",
}});
const ownerId="restart-http-source",source=await runtime.createBrowserOwner({id:ownerId,cwd});
await source.createBrowserTab("desktop-restart-http",url);
const metadata=await source.getBrowserMetadata();if(metadata.availability!=="running")throw new Error("Native browser unavailable");
const tab=metadata.tabs[0]!,target={workerPid:source.workerPid,name:tab.name,targetId:tab.targetId},operationId=randomUUID();
await source.reserveBrowserEvaluation(target,operationId);
const evaluation=await source.openBrowserEvaluation(target,operationId,"cdp",30_000);
const destination=await runtime.create({cwd,interactions:true});
await destination.installBrowserContinuation({sourceOwnerId:ownerId,operationId,target,kindTag:tab.kindTag},evaluation);
const reconnectRoot=`${dataDirectory}/browser-recovery/http-command`;
const sourceEndpoint=await source.enableBrowserRecovery!(`${reconnectRoot}/source.sock`,randomBytes(32).toString("hex"),randomUUID());
const destinationEndpoint=await destination.enableBrowserRecovery!(`${reconnectRoot}/destination.sock`,randomBytes(32).toString("hex"),randomUUID());
const request={requestId:"restart-http",controlEpoch:"restart-http-epoch",observedAt:Date.now(),initialUrl:url};
const continuation:DraftBrowserContinuation={version:1,owner:{ownerId,draftId:"restart-http-draft",draftRevision:1},pages:[{request,target,backend:"worker",kindTag:tab.kindTag}]};
const envelope:CommandEnvelope={id:"restart-http-command",commandVersion:15,command:{type:"session.create",projectId:null,cwd,draft:{id:"restart-http-draft",revision:1},browserContinuation:continuation}};
const store=new HostStore(dataDirectory);const saved=store.putDraft({id:"restart-http-draft",text:"Retain this exact browser",projectId:null,model:null},0);if(!saved.ok)throw new Error("Draft setup failed");
store.claimCommand(envelope.id,Bun.SHA256.hash(JSON.stringify(envelope.command),"hex"),envelope.command);
store.recordBrowserRecovery({version:2,hostId:store.host.id,commandId:envelope.id,sessionId:destination.id,ownerId,status:"arming",source:sourceEndpoint,destination:destinationEndpoint,
  bindings:[{...target,ownerId,operationId,backend:"cdp"}],recordedAt:Date.now()});store.close();
const host=await startHost({dataDirectory,agentDirectory:agentDir,discoveryDirectory:cwd,port:0,tailscale:false,workerPath:fileURLToPath(new URL("./local-browser-worker.ts",import.meta.url))});
await writeFile(output,JSON.stringify({connection:host.connection,envelope,sourcePid:source.workerPid,destinationPid:destination.workerPid,sessionId:destination.id,tab,url,
  source:sourceEndpoint,destination:destinationEndpoint,binding:{...target,ownerId,operationId,backend:"cdp"}}));
setInterval(()=>{},60_000);
