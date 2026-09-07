import {SessionMcpResourceHttp} from "../../apps/host/src/session-mcp-resource-http";
import {mkdir,mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {WorkerRuntime} from '../../apps/host/src/omp-workers/runtime';
import {SessionMcpHttp} from '../../apps/host/src/session-mcp-http';
import type {CommandEnvelope,NativeSessionMcpReceipt} from '../../packages/shared/src/protocol';
const loseAck=process.argv[3]==='--lose-ack';
const repo=resolve(import.meta.dir,'../..'),output=resolve(process.argv[2]??`.data/session-mcp-ui-${Date.now()}`);
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw new Error('Output must be empty');
const root=await mkdtemp(join(tmpdir(),'agent-session-mcp-ui-')),agentDir=join(root,'agent'),cwd=join(root,'project'),gates=join(root,'gates');
await Promise.all([agentDir,cwd,gates].map(p=>mkdir(p)));
await writeFile(join(agentDir,'config.yml'),`extensions:\n  - ${JSON.stringify(join(repo,'apps/host/src/omp-workers/fixtures/mcp-provider.ts'))}\n`);
const marker=join(root,'mcp-starts');
await writeFile(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[join(repo,'apps/host/src/omp/fixtures/mcp-server.ts')],env:{AGENT_DESKTOP_MCP_TEST_MARKER:marker,AGENT_DESKTOP_MCP_TEST_RESOURCE_DELAY:'400',AGENT_DESKTOP_MCP_TEST_REQUESTS:join(root,'mcp-requests')}}}}));
const sources=['apps/desktop/src/renderer/SessionMcpResource.tsx','apps/host/src/session-mcp-resource-http.ts','packages/shared/src/session-mcp-resource.ts','apps/desktop/src/renderer/SessionMcp.tsx','apps/desktop/src/renderer/SessionMcpDetails.tsx','apps/desktop/src/renderer/native-integrations.css','apps/host/src/omp/mcp-session.ts','apps/host/src/omp/runtime.ts','apps/host/src/omp/fixtures/mcp-server.ts','apps/host/src/session-mcp-http.ts','packages/shared/src/session-mcp.ts','scripts/acceptance/session-mcp.ts','scripts/acceptance/session-mcp-browser.tsx','scripts/acceptance/session-mcp-electron.cjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(sources.map(async file=>[file,createHash('sha256').update(await readFile(join(repo,file))).digest('hex')])));
const runtime=new WorkerRuntime({agentDir,workerPath:join(repo,'apps/host/src/omp-workers/fixtures/no-provider-worker.ts'),environment:{HOME:root,PATH:process.env.PATH,TMPDIR:tmpdir(),PI_CODING_AGENT_DIR:agentDir,MCP_CONTRACT_GATES:gates,TERM:'dumb'}});
let proxy:ReturnType<typeof Bun.serve>|undefined;
try{
 const before=await hashes(),session=await runtime.create({cwd,interactions:true}),receipts=new Map<string,NativeSessionMcpReceipt>();let reloads=0,reconnects=0,receiptReads=0,lostAcknowledgements=0;
 const service=new SessionMcpHttp({hostId:'fixture',sessionExists:id=>id===session.id,existing:async()=>session,receipt:(_id,commandId)=>receipts.get(commandId)??{commandId,state:'absent'}});
 const resources=new SessionMcpResourceHttp({hostId:'fixture',sessionExists:id=>id===session.id,existing:async()=>session});
 const capability=crypto.randomUUID(),cors={'Access-Control-Allow-Origin':'null','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'content-type'};
 proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const url=new URL(request.url);if(!url.pathname.startsWith('/'+capability+'/'))return new Response(null,{status:404});if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});const route=url.pathname.slice(capability.length+1);
  if(route==='/read'){if(url.searchParams.has('commandId'))receiptReads++;const target=new URL('http://fixture/v1/sessions/'+session.id+'/mcp'+url.search);const result=await service.route(new Request(target,{headers:{'X-Agent-Host-Id':'fixture'}}),target);return new Response(await result!.arrayBuffer(),{status:result!.status,headers:{...cors,'Content-Type':'application/json'}});}
  if(route==='/resource'&&request.method==='POST'){const result=await resources.route(new Request('http://fixture/v1/sessions/'+session.id+'/mcp/resource',{method:'POST',headers:{'X-Agent-Host-Id':'fixture'},body:await request.text()}));return new Response(await result!.arrayBuffer(),{status:result!.status,headers:{...cors,'Content-Type':'application/json'}});}
  if(route==='/reload'&&request.method==='POST'){const envelope=await request.json() as CommandEnvelope;const command=envelope.command;if((command.type!=='session.mcp.reload'&&command.type!=='session.mcp.reconnect')||command.sessionId!==session.id||receipts.has(envelope.id))throw new Error('Invalid or duplicate UI dispatch');receipts.set(envelope.id,{commandId:envelope.id,state:'pending'});if(command.type==='session.mcp.reload')reloads++;else reconnects++;try{const snapshot=command.type==='session.mcp.reconnect'?await session.reconnectSessionMcp({epoch:command.epoch,expectedRevision:command.expectedRevision,serverName:command.serverName}):await session.reloadSessionMcp({epoch:command.epoch,expectedRevision:command.expectedRevision});receipts.set(envelope.id,{commandId:envelope.id,state:'succeeded'});if(loseAck){lostAcknowledgements++;return new Response('Injected lost acknowledgement after native completion',{status:503,headers:cors});}return Response.json({ok:true,commandId:envelope.id,value:{type:'session.mcp',snapshot}},{headers:cors});}catch{receipts.set(envelope.id,{commandId:envelope.id,state:'failed'});return Response.json({ok:false,commandId:envelope.id,error:{code:'FAILED',message:'Controlled UI reload failed'}},{headers:cors});}}
  return new Response(null,{status:404});}});
 const entry=join(output,'index.html');await writeFile(entry,`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${join(repo,'scripts/acceptance/session-mcp-browser.tsx')}"></script></body></html>`);
 await build({configFile:false,plugins:[react(),tailwindcss()],root:output,base:'./',build:{outDir:join(output,'web'),emptyOutDir:true,rollupOptions:{input:entry}}});
 await writeFile(join(output,'launch.json'),JSON.stringify({endpoint:`http://127.0.0.1:${proxy.port}/${capability}`,sessionId:session.id,profile:join(root,'electron-profile')}));
 const child=Bun.spawn([process.execPath,join(repo,'node_modules/electron/cli.js'),join(repo,'scripts/acceptance/session-mcp-electron.cjs'),output],{stdout:Bun.file(join(output,'electron.log')),stderr:Bun.file(join(output,'electron-errors.log'))});const code=await child.exited;
 const result=await Bun.file(join(output,'result.json')).json(),after=await hashes();
 const resourceReads=(await readFile(join(root,'mcp-requests'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(call=>call.method==='resources/read').map(call=>call.params.uri);
 const starts=(await readFile(marker,'utf8')).trim().split('\n').length;
 Object.assign(result,{sourceAtBuild:before,sourceAfterBuild:after,sourceHashesStable:JSON.stringify(before)===JSON.stringify(after),native:{resourceReads,starts,reloads,reconnects,receiptReads,lostAcknowledgements,messages:(await session.getMessages()).length},scope:'Controlled hidden Electron component with real isolated native worker/MCP stdio server. Scoped adapter bypasses desktop main IPC and full host durable command dispatch (separately tested). No provider prompts, native OS window or pixel-parity claim.'});
 result.passed&&=code===0&&result.sourceHashesStable&&JSON.stringify(resourceReads)===JSON.stringify(['fixture://resource','fixture://binary','fixture://missing'])&&starts===3&&reloads===1&&reconnects===1&&receiptReads>=2&&lostAcknowledgements===(loseAck?2:0);await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,result:join(output,'result.json')}));if(!result.passed)throw new Error('MCP UI acceptance failed');
}finally{await proxy?.stop(true);await runtime.dispose();await rm(root,{recursive:true,force:true});await rm(join(output,'launch.json'),{force:true});}
