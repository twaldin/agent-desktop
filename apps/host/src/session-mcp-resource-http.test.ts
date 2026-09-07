import { expect, test } from "bun:test";
import { SESSION_MCP_OWNER_HEADER } from "@agent-desktop/shared";
import { SessionMcpResourceHttp } from "./session-mcp-resource-http";
import { requestSessionMcpResource } from "../../desktop/src/main/session-mcp-resource-transport";
const ticket={epoch:"epoch",expectedRevision:1,serverName:"server",uri:"fixture://body"};

test("resource route authenticates owners, validates before dispatch and never loads a worker",async()=>{
  let lookups=0,reads=0,loaded=false,fails=false;
  const service=new SessionMcpResourceHttp({hostId:"host",sessionExists:id=>id==="session",existing:async()=>{lookups++;return loaded?{readSessionMcpResource:async input=>{reads++;expect(input).toEqual(ticket);if(fails)throw new Error("Bearer native-secret");return {contents:[{uri:input.uri,text:"<script>inert</script>"}]};}}:undefined;}});
  const request=(owner="host",body:unknown=ticket,method="POST")=>service.route(new Request("http://localhost/v1/sessions/session/mcp/resource",{method,headers:{[SESSION_MCP_OWNER_HEADER]:owner},...(method==="POST"?{body:JSON.stringify(body)}:{})}));
  expect((await request("other"))?.status).toBe(409);
  expect((await request("host",ticket,"GET"))?.status).toBe(405);
  expect((await request("host",{...ticket,uri:"x".repeat(33000)}))?.status).toBe(400);
  expect(lookups).toBe(0);
  expect((await request())?.status).toBe(409);expect(reads).toBe(0);
  loaded=true;const result=(await request())!;expect(result.headers.get("Cache-Control")).toBe("no-store");expect((await result.json()).value.contents[0].text).toBe("<script>inert</script>");expect(reads).toBe(1);
  fails=true;const failed=(await request())!;expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("native-secret");
});

test("desktop resource transport fences response identity and sends exactly one authenticated read",async()=>{
 let calls=0,mode="good";
 const server=Bun.serve({port:0,hostname:"127.0.0.1",async fetch(request){calls++;expect(request.method).toBe("POST");expect(request.headers.get("Authorization")).toBe("Bearer fixture-token");expect(await request.json()).toEqual(ticket);
 return Response.json({protocolVersion:1,hostId:"host",sessionId:mode==="owner"?"other":"session",value:{contents:[mode==="invalid"?{uri:ticket.uri,blob:"***"}:{uri:ticket.uri,text:"Actual content"}]}},{headers:{[SESSION_MCP_OWNER_HEADER]:"host"}});}});
 try{const endpoint={hostId:"host",origin:`http://127.0.0.1:${server.port}`,token:"fixture-token"};
 expect(await requestSessionMcpResource(endpoint,"session",ticket)).toEqual({contents:[{uri:ticket.uri,text:"Actual content"}]});expect(calls).toBe(1);
 for(const bad of ["owner","invalid"]){mode=bad;await expect(requestSessionMcpResource(endpoint,"session",ticket)).rejects.toThrow();}
 expect(calls).toBe(3);
 }finally{await server.stop(true);}
});
