import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";
import { SESSION_MCP_OWNER_HEADER, type CommandEnvelope, type CommandResult, type SessionSummary, type NativeMcpAuthorizationResponse } from "@agent-desktop/shared";

const root = process.argv[2]!;
const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
await Promise.all([agentDir, cwd, path.join(root,"gates")].map(dir => mkdir(dir)));
let tokens = 0, initializes = 0;
const remote = Bun.serve({ hostname:"127.0.0.1", port:0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/mcp") {
    if (request.method !== "POST") return new Response(null,{status:405});
    const body = await request.json() as {method:string;id?:number};
    if (body.method === "initialize") initializes++;
    if (request.headers.get("Authorization") !== "Bearer route-private-access") return new Response("authorization required", {status:401,headers:{"WWW-Authenticate":`Bearer resource_metadata="${url.origin}/protected"`}});
    if (body.method === "initialize") return Response.json({jsonrpc:"2.0",id:body.id,result:{protocolVersion:"2025-03-26",capabilities:{},serverInfo:{name:"auth-route",version:"1"}}});
    return new Response(null,{status:202});
  }
  if (url.pathname === "/protected" || url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({resource:`${url.origin}/mcp`,authorization_servers:[url.origin],scopes_supported:["read"]});
  if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({issuer:url.origin,authorization_endpoint:`${url.origin}/authorize`,token_endpoint:`${url.origin}/token`,client_id:"route-client"});
  if (url.pathname === "/token") { tokens++; return Response.json({access_token:"route-private-access",refresh_token:"route-private-refresh",expires_in:3600,token_type:"Bearer"}); }
  return new Response(null,{status:404});
}});
const origin = `http://127.0.0.1:${remote.port}`;
const reserved = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response(null)});
const callbackPort=reserved.port!;await reserved.stop(true);
const extension=path.join(root,"loopback.ts");
await writeFile(extension,`const nativeFetch=Bun.fetch.bind(Bun);const allowed=new Set(${JSON.stringify([origin,`http://127.0.0.1:${callbackPort}`])});export default function(){globalThis.fetch=Object.assign(async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));if(!allowed.has(url.origin))throw new Error('Unowned fixture network request');return nativeFetch(input,init);},{preconnect(){}});}\n`);
await writeFile(path.join(agentDir,"config.yml"),`extensions:\n  - ${JSON.stringify(extension)}\n  - ${JSON.stringify(path.resolve(import.meta.dir,"../omp-workers/fixtures/mcp-provider.ts"))}\nretry:\n  enabled: false\n`);
const configPath=path.join(agentDir,"mcp.json");
await writeFile(configPath,JSON.stringify({mcpServers:{fixture:{type:"http",url:`${origin}/mcp`,oauth:{clientId:"route-client",callbackPort,redirectUri:`http://127.0.0.1:${callbackPort}/callback`}}}}));
const originalConfig=await readFile(configPath,"utf8");
const {startHost}=await import("../server");
const options={dataDirectory:path.join(root,"data"),agentDirectory:agentDir,discoveryDirectory:cwd,workerPath:path.resolve(import.meta.dir,"../omp-workers/fixtures/no-provider-worker.ts"),tailscale:false};
let host=await startHost(options);
const headers=()=>({Authorization:`Bearer ${host.connection.token}`,[SESSION_MCP_OWNER_HEADER]:host.connection.hostId,"Content-Type":"application/json"});
async function command(envelope:CommandEnvelope):Promise<CommandResult>{const result=await fetch(`${host.connection.origin}/v1/commands`,{method:"POST",headers:headers(),body:JSON.stringify(envelope)});assert.equal(result.status,200);return await result.json() as CommandResult;}
async function state(sessionId:string,commandId?:string):Promise<NativeMcpAuthorizationResponse>{const response=await fetch(`${host.connection.origin}/v1/sessions/${sessionId}/mcp/authorization${commandId?`?commandId=${commandId}`:""}`,{headers:headers()});assert.equal(response.status,200);assert.equal(response.headers.get("Cache-Control"),"no-store");return await response.json() as NativeMcpAuthorizationResponse;}
async function ticket(sessionId:string){const response=await fetch(`${host.connection.origin}/v1/sessions/${sessionId}/mcp`,{headers:headers()});return (await response.json() as {value:{epoch:string;revision:number}}).value;}
async function wait(sessionId:string,read:(state:NativeMcpAuthorizationResponse)=>boolean,commandId?:string){for(let i=0;i<500;i++){const value=await state(sessionId,commandId);if(read(value))return value;await Bun.sleep(10);}throw new Error("Authorization did not settle");}
function responseBody(value:NativeMcpAuthorizationResponse){const current=value.value!,auth=new URL(current.login.auth!.url),redirect=new URL(auth.searchParams.get("redirect_uri")!);redirect.searchParams.set("code","route-private-code");redirect.searchParams.set("state",auth.searchParams.get("state")!);return {authorizationId:current.authorizationId,requestId:current.login.prompts.find(x=>x.kind==="manual-code")!.requestId,response:{value:redirect.toString()}};}
try {
  const created=await command({id:"create",command:{type:"session.create",projectId:null,cwd,model:{provider:"mcp-contract",id:"controlled"}}});assert(created.ok);
  const session=created.value as SessionSummary;
  if (process.argv[3] === "--ui") {
    await writeFile(path.join(root,"ui-ready.json"),JSON.stringify({endpoint:host.connection,sessionId:session.id,issuer:origin}));
    const deadline=Date.now()+90_000;
    while (!await Bun.file(path.join(root,"ui-done")).exists()) { if(Date.now()>deadline)throw new Error("UI acceptance timed out");await Bun.sleep(50); }
    const final=await state(session.id);
    assert.equal(final.value?.status,"succeeded");assert.equal(tokens,1);
    assert.equal((await readFile(session.sessionFile,"utf8")).includes("route-private-code"),false);
    const db=new Database(path.join(root,"data","state.sqlite"));
    const rows=db.query("SELECT * FROM commands").all();db.close();
    for(const secret of ["route-private-code","route-private-access","route-private-refresh","/authorize?"])assert(!JSON.stringify(rows).includes(secret));
    await writeFile(path.join(root,"ui-proof.json"),JSON.stringify({tokens,initializes,commands:rows.length,status:final.value?.status,reconnected:final.value?.reconnected,privateJournal:true}));
  } else {
  const beforeTranscript=await readFile(session.sessionFile,"utf8");
  const before=await ticket(session.id);
  const start:CommandEnvelope={id:"auth-once",command:{type:"session.mcp.authorize",hostId:host.connection.hostId,sessionId:session.id,serverName:"fixture",epoch:before.epoch,expectedRevision:before.revision}};
  const [first,second]=await Promise.all([command(start),command(start)]);assert(first.ok);assert.deepEqual(second,first);
  const pending=await wait(session.id,x=>Boolean(x.value?.login.auth&&x.value.login.prompts.length),start.id);
  assert.equal(pending.value!.commandId,start.id);assert.equal(pending.receipt?.state,"succeeded");assert.equal(pending.receipt?.authorizationId,pending.value!.authorizationId);
  const url=`${host.connection.origin}/v1/sessions/${session.id}/mcp/authorization/respond`;
  const answer=responseBody(pending);
  assert.equal((await fetch(url,{method:"POST",body:JSON.stringify(answer)})).status,401);
  assert.equal((await fetch(url,{method:"POST",headers:{...headers(),Origin:"https://untrusted.invalid"},body:JSON.stringify(answer)})).status,401);
  assert.equal((await fetch(url,{method:"POST",headers:{...headers(),[SESSION_MCP_OWNER_HEADER]:"wrong"},body:JSON.stringify(answer)})).status,409);
  const answered=await Promise.all([0,1].map(()=>fetch(url,{method:"POST",headers:headers(),body:JSON.stringify(answer)})));
  assert.deepEqual(answered.map(x=>x.status).sort(),[200,409]);
  const completed=await wait(session.id,x=>x.value?.status==="succeeded",start.id);assert.equal(completed.value!.reconnected,true);assert.equal(tokens,1);
  assert.deepEqual(await command(start),first);assert.equal(tokens,1);
  assert.equal(await readFile(session.sessionFile,"utf8"),beforeTranscript);
  assert.equal(await readFile(configPath,"utf8"),originalConfig);
  const db=new Database(path.join(root,"data","state.sqlite"));
  const journal=JSON.stringify(db.query("SELECT * FROM commands").all());
  for(const secret of ["route-private-access","route-private-refresh","route-private-code","/authorize?"])assert(!journal.includes(secret));
  assert.equal((await state(session.id,"create")).receipt?.state,"absent");
  const current=await ticket(session.id);
  const lost:CommandEnvelope={id:"auth-lost-receipt",command:{type:"session.mcp.authorize",hostId:host.connection.hostId,sessionId:session.id,serverName:"fixture",epoch:current.epoch,expectedRevision:current.revision}};
  db.exec("CREATE TRIGGER reject_auth_receipt BEFORE UPDATE ON commands WHEN OLD.id='auth-lost-receipt' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
  const uncertain=await command(lost);assert(!uncertain.ok);assert.equal(uncertain.error.code,"OUTCOME_UNKNOWN");
  const original=await wait(session.id,x=>Boolean(x.value?.login.auth&&x.value.login.prompts.length),lost.id);assert.equal(original.receipt?.state,"unknown");assert.equal(original.value!.commandId,lost.id);
  const initializationsBeforeDuplicate=initializes;
  const duplicateLost=await command(lost);assert(!duplicateLost.ok);assert.equal(duplicateLost.error.code,"OUTCOME_UNKNOWN");assert.equal(initializes,initializationsBeforeDuplicate);
  db.close();
  await host.stop();
  const countBeforeRestart=initializes;
  host=await startHost(options);
  const recovered=await state(session.id,lost.id);assert.equal(recovered.value,null);assert.equal(recovered.receipt?.state,"unknown");
  const succeededReceipt=await state(session.id,start.id);assert.equal(succeededReceipt.receipt?.state,"succeeded");assert.equal(succeededReceipt.value,null);
  const noReplay=await command(lost);assert(!noReplay.ok);assert.equal(noReplay.error.code,"OUTCOME_UNKNOWN");assert.equal(initializes,countBeforeRestart);assert.equal(tokens,1);
  assert.equal((await fetch(`${host.connection.origin}/v1/sessions/${session.id}/mcp/authorization/respond`,{method:"POST",headers:headers(),body:JSON.stringify(responseBody(original))})).status,409);
  assert.equal(initializes,countBeforeRestart);
  await writeFile(path.join(root,"authorization-route.passed"),"real host authorization receipts and private answers passed\n");
  }
} finally {await host.stop();await remote.stop(true);}
