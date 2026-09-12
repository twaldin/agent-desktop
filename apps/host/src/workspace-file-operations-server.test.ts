import {expect,test} from "bun:test";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {CommandEnvelope,CommandResult,WorkspacePathContext} from "@agent-desktop/shared";
import {startHost} from "./server";

test("authenticated path operations retain exact owner receipts across retry and restart",async()=>{
 const root=await mkdtemp(join(tmpdir(),"agent-file-operations-http-")),workspace=join(root,"workspace"),dataDirectory=join(root,"data"),agentDirectory=join(root,"agent");
 await Promise.all([workspace,agentDirectory].map(path=>mkdir(path)));
 let host:Awaited<ReturnType<typeof startHost>>|undefined;
 try{
  const start=()=>startHost({dataDirectory,agentDirectory,discoveryDirectory:workspace,port:0,tailscale:false});host=await start();
  const request=(path:string,body:unknown,authenticated=true)=>fetch(host!.connection.origin+path,{method:"POST",headers:{"content-type":"application/json",...(authenticated?{authorization:`Bearer ${host!.connection.token}`}:{})},body:JSON.stringify(body)});
  const send=async(envelope:CommandEnvelope):Promise<CommandResult>=>{const response=await request("/v1/commands",envelope);expect(response.status).toBe(200);return response.json()};
  const add=await send({id:"add-project",command:{type:"project.add",path:workspace}});
  if(!add.ok||!add.value||!("id" in add.value))throw new Error("Project add failed");
  const target={projectId:add.value.id};
  expect((await request("/v1/workspace/query",{target,query:{type:"file.operation-context",path:"missing.txt"}},false)).status).toBe(401);
  const create:CommandEnvelope={id:"create-once",command:{type:"workspace.mutate",target,action:{type:"file.create",path:"created.txt"}}};
  const receipt=await send(create);expect(receipt).toMatchObject({ok:true,commandId:create.id,value:{type:"file.create",context:{entry:{path:"created.txt"}}}});
  await writeFile(join(workspace,"created.txt"),"changed after receipt\n");
  expect(await send(create)).toEqual(receipt);expect(await readFile(join(workspace,"created.txt"),"utf8")).toBe("changed after receipt\n");
  await host.stop();host=undefined;host=await start();
  expect(await send(create)).toEqual(receipt);expect(await readFile(join(workspace,"created.txt"),"utf8")).toBe("changed after receipt\n");
  const contextResponse=await request("/v1/workspace/query",{target,query:{type:"file.operation-context",path:"created.txt"}});expect(contextResponse.status).toBe(200);
  const context=(await contextResponse.json() as {type:"file.operation-context";context:WorkspacePathContext}).context;
  const rename:CommandEnvelope={id:"rename-once",command:{type:"workspace.mutate",target,action:{type:"path.rename",path:"created.txt",destination:"renamed.txt",expectedRevision:context.revision}}};
  const renamed=await send(rename);expect(renamed).toMatchObject({ok:true,value:{type:"path.rename",previousPath:"created.txt",context:{entry:{path:"renamed.txt"}}}});
  expect(await send({...rename,id:"rename-stale"})).toMatchObject({ok:false,error:{code:"COMMAND_FAILED"}});
  expect(await send(rename)).toEqual(renamed);
  expect(host.store.getCommand(create.id)?.command).toEqual(create.command);expect(host.store.getCommand(rename.id)?.command).toEqual(rename.command);
 }finally{await host?.stop();await rm(root,{recursive:true,force:true})}
});
