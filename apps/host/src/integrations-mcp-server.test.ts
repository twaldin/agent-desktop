import {expect,test} from 'bun:test';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {CommandResult,NativeMcpCatalog,NativeMcpDetail,Project} from '@agent-desktop/shared';
import {startHost} from './server';

test('authenticated MCP detail is bound to the selected host project and is never cached',async()=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-desktop-mcp-detail-route-')));
  const dataDirectory=path.join(root,'data'),agentDirectory=path.join(root,'agent'),projectPath=path.join(root,'project');
  await Promise.all([mkdir(dataDirectory,{recursive:true}),mkdir(agentDirectory,{recursive:true}),mkdir(projectPath,{recursive:true})]);
  await writeFile(path.join(agentDirectory,'config.yml'),'extensions: []\n');
  Bun.spawnSync(['git','init','-q',projectPath]);
  await mkdir(path.join(projectPath,'.omp'),{recursive:true});
  await writeFile(path.join(projectPath,'.omp','mcp.json'),JSON.stringify({mcpServers:{owned:{command:'/bin/false',env:{PRIVATE_VALUE:'unexpanded-${PRIVATE_VALUE}'}}}},null,2)+'\n');
  const host=await startHost({dataDirectory,agentDirectory,discoveryDirectory:projectPath,tailscale:false});
  const headers={Authorization:`Bearer ${host.connection.token}`,'Content-Type':'application/json'};
  const post=(route:string,value:unknown,authenticated=true)=>fetch(host.connection.origin+route,{method:'POST',headers:authenticated?headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  try{
    const added=await post('/v1/commands',{id:'add-project',command:{type:'project.add',path:projectPath}});
    expect(added.status).toBe(200);
    const project=((await added.json()) as CommandResult & {ok:true;value:Project}).value;
    const read=await post('/v1/integrations/mcp/read',{target:{projectId:project.id}});
    expect(read.status).toBe(200);
    const catalog=await read.json() as NativeMcpCatalog,server=catalog.servers.find(item=>item.name==='owned')!;
    expect((await post('/v1/integrations/mcp/detail',{target:{projectId:project.id},request:{serverId:server.id,expectedRevision:catalog.revision}},false)).status).toBe(401);
    expect((await post('/v1/integrations/mcp/detail',{target:{projectId:'wrong-owner'},request:{serverId:server.id,expectedRevision:catalog.revision}})).status).toBe(400);
    const response=await post('/v1/integrations/mcp/detail',{target:{projectId:project.id},request:{serverId:server.id,expectedRevision:catalog.revision}});
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    const detail=await response.json() as NativeMcpDetail;
    expect(detail).toMatchObject({revision:catalog.revision,server:{id:server.id,editable:true},config:{env:{PRIVATE_VALUE:'unexpanded-${PRIVATE_VALUE}'}}});
  }finally{await host.stop();await rm(root,{recursive:true,force:true});}
},30000);
