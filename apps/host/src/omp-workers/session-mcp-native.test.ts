import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerRuntime } from './runtime';

test('real worker reload rebinds native MCP tools, fences active turns and retires its manager',async()=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-session-mcp-native-')));
  const agentDir=path.join(root,'agent'),cwd=path.join(root,'project'),gates=path.join(root,'gates');
  await Promise.all([agentDir,cwd,gates].map(p=>mkdir(p)));
  await writeFile(path.join(agentDir,'config.yml'),`extensions:\n  - ${JSON.stringify(path.join(import.meta.dir,'fixtures/mcp-provider.ts'))}\nretry:\n  enabled: false\n`);
  const config=path.join(agentDir,'mcp.json');
  await writeFile(config,JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[path.join(import.meta.dir,'../omp/fixtures/mcp-server.ts')]}}}));
  const runtime=new WorkerRuntime({agentDir,workerPath:path.join(import.meta.dir,'fixtures/no-provider-worker.ts'),environment:{HOME:root,PATH:process.env.PATH,TMPDIR:tmpdir(),PI_CODING_AGENT_DIR:agentDir,MCP_CONTRACT_GATES:gates,TERM:'dumb'}});
  try {
    const session=await runtime.create({cwd,interactions:true,approvalOverride:'yolo'});
    const before=await session.getSessionMcp();
    expect(before.available).toBe(true);expect(before.servers[0]?.status).toBe('connected');
    const model={provider:'mcp-contract',id:'controlled'};
    expect(await session.prompt('Invoke the disposable MCP tool once.',{model})).toBe(true);
    const messages=await session.getMessages();
    expect(JSON.stringify(messages)).toContain('Native MCP tool completed.');
    expect(JSON.stringify(messages)).toContain('fixture tool invoked');
    expect(messages.filter(message=>message.tool).every(message=>!message.tool!.isError)).toBe(true);
    await writeFile(path.join(gates,'hold'),'');
    const run=session.startPrompt('Hold this native turn.',{model});await run.accepted;
    const current=await session.getSessionMcp();
    await expect(session.reloadSessionMcp({epoch:current.epoch,expectedRevision:current.revision})).rejects.toThrow('busy');
    await session.abort();await run.completion.catch(()=>false);await rm(path.join(gates,'hold'));
    await writeFile(config,JSON.stringify({mcpServers:{}}));
    const ticket=await session.getSessionMcp();
    const reloaded=await session.reloadSessionMcp({epoch:ticket.epoch,expectedRevision:ticket.revision});
    expect(reloaded.servers).toEqual([]);
    await expect(session.reloadSessionMcp({epoch:ticket.epoch,expectedRevision:ticket.revision})).rejects.toThrow('changed');
    expect(await session.prompt('Inspect the now empty native MCP registry.',{model})).toBe(true);
    expect(JSON.parse(await readFile(path.join(gates,'tools.json'),'utf8')).some((name:string)=>name.startsWith('mcp__'))).toBe(false);
    expect(JSON.stringify(await session.getMessages())).toContain('No MCP tools registered.');
    await session.dispose();await expect(session.getSessionMcp()).rejects.toThrow();
  } finally {await rm(path.join(gates,'hold'),{force:true});await runtime.dispose();await rm(root,{recursive:true,force:true});}
},30000);
