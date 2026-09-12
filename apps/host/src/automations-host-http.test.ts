import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTOMATIONS_OWNER_HEADER, type AutomationMutationResult } from "../../../packages/shared/src/automations";
import { startHost } from "./server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

test("authenticated host creates one original heartbeat conversation and retains it across restart",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"automation-host-http-"))),data=join(root,"data"),agent=join(root,"agent"),cwd=join(root,"cwd");
  await Promise.all([mkdir(agent),mkdir(cwd)]);await Bun.write(join(agent,"config.yml"),"retry:\n  enabled: false\n");
  const open=()=>startHost({dataDirectory:data,agentDirectory:agent,discoveryDirectory:cwd,workerPath:fileURLToPath(new URL("./omp-workers/fixtures/no-provider-worker.ts",import.meta.url)),tailscale:false,port:0});
  let host=await open();cleanups.push(async()=>{await host.stop();await rm(root,{recursive:true,force:true});});
  const advertised=await (await fetch(host.connection.origin+"/v1/state",{headers:{Authorization:`Bearer ${host.connection.token}`}})).json() as {automations?:{capability:string}};
  expect(advertised.automations).toEqual({capability:"local-automations-v1"});
  const mutation={type:"save",requestId:"create-heartbeat",id:"heartbeat",expectedRevision:0,input:{name:"Heartbeat",prompt:"Check status",rrule:"RRULE:FREQ=HOURLY",destination:{kind:"heartbeat-new",projectId:null,execution:{type:"local"},environment:null,model:null,thinkingLevel:null,approvalMode:null},notificationPolicy:"failed-runs-only",status:"paused"}} as const;
  const request=()=>fetch(host.connection.origin+"/v1/automations",{method:"POST",headers:{Authorization:`Bearer ${host.connection.token}`,[AUTOMATIONS_OWNER_HEADER]:host.store.host.id,"Content-Type":"application/json"},body:JSON.stringify(mutation)});
  const first=await request();expect(first.status).toBe(200);const result=await first.json() as AutomationMutationResult;
  expect(result.task?.destination).toMatchObject({kind:"heartbeat"});const sessionId=result.task?.destination.kind==="heartbeat"?result.task.destination.sessionId:"";
  expect(host.store.listSessions().map(item=>item.id)).toEqual([sessionId]);
  expect(await (await request()).json()).toEqual(result);expect(host.store.listSessions()).toHaveLength(1);
  await host.stop();host=await open();
  const get=await fetch(host.connection.origin+"/v1/automations",{headers:{Authorization:`Bearer ${host.connection.token}`,[AUTOMATIONS_OWNER_HEADER]:host.store.host.id}});
  expect(get.status).toBe(200);expect((await get.json() as {tasks:Array<{destination:{kind:string;sessionId?:string}}>}).tasks[0]?.destination).toEqual({kind:"heartbeat",sessionId});
},30_000);

test("a due heartbeat runs a real native slash command without a provider",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"automation-native-run-"))),data=join(root,"data"),agent=join(root,"agent"),cwd=join(root,"cwd"),gates=join(root,"gates");
  await Promise.all([mkdir(agent),mkdir(cwd),mkdir(gates)]);
  await Bun.write(join(agent,"config.yml"),`extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./omp-workers/fixtures/automation-extension.ts",import.meta.url)))}\nretry:\n  enabled: false\n`);
  const previous=process.env.AUTOMATION_CONTRACT_GATES;process.env.AUTOMATION_CONTRACT_GATES=gates;
  const host=await startHost({dataDirectory:data,agentDirectory:agent,discoveryDirectory:cwd,workerPath:fileURLToPath(new URL("./omp-workers/fixtures/no-provider-worker.ts",import.meta.url)),tailscale:false,port:0,automationTickMs:10});
  cleanups.push(async()=>{await host.stop();if(previous===undefined)delete process.env.AUTOMATION_CONTRACT_GATES;else process.env.AUTOMATION_CONTRACT_GATES=previous;await rm(root,{recursive:true,force:true});});
  const headers={Authorization:`Bearer ${host.connection.token}`,[AUTOMATIONS_OWNER_HEADER]:host.store.host.id,"Content-Type":"application/json"};
  const mutate=async(value:unknown)=>{const response=await fetch(host.connection.origin+"/v1/automations",{method:"POST",headers,body:JSON.stringify(value)});expect(response.status).toBe(200);return response.json() as Promise<AutomationMutationResult>;};
  const due=new Date(Date.now()+5000).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
  await mutate({type:"save",requestId:"save-heartbeat",id:"heartbeat",expectedRevision:0,input:{name:"Heartbeat",prompt:"/automation-flow scheduled",rrule:`DTSTART:${due}\nRRULE:FREQ=SECONDLY;COUNT=1`,destination:{kind:"heartbeat-new",projectId:null,execution:{type:"local"},environment:null,model:null,thinkingLevel:null,approvalMode:null},notificationPolicy:"all",status:"active"}});
  for(let i=0;i<500&&!await Bun.file(join(gates,"scheduled.effect")).exists();i++)await Bun.sleep(10);expect(await Bun.file(join(gates,"scheduled.effect")).exists()).toBe(true);let terminal;
  for(let i=0;i<400;i++){const response=await fetch(host.connection.origin+"/v1/automations",{headers});terminal=(await response.json() as {runs:Array<{id:string;status:string;sessionId:string|null}>}).runs[0];if(terminal?.status==="completed")break;await Bun.sleep(10);}
  expect(terminal).toMatchObject({status:"completed",sessionId:expect.any(String)});expect(host.store.listSessions()).toHaveLength(1);
},30_000);
