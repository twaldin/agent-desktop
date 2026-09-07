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
    await expect(session.reconnectSessionMcp({epoch:current.epoch,expectedRevision:current.revision,serverName:'fixture'})).rejects.toThrow('busy');
    await session.abort();await run.completion.catch(()=>false);await rm(path.join(gates,'hold'));
    expect(await session.prompt('/fixture-tool-selection read')).toBe(false);
    const selectedTools = JSON.parse(await readFile(path.join(gates, 'active-tools.json'), 'utf8'));
    expect(selectedTools).toEqual(['read']);
    const reconnectTicket = await session.getSessionMcp();
    expect(reconnectTicket.canReconnect).toBe(true);
    expect((await session.reconnectSessionMcp({epoch:reconnectTicket.epoch,expectedRevision:reconnectTicket.revision,serverName:'fixture'})).servers[0]?.status).toBe('connected');
    // Pinned session-tools.ts refreshMCPTools enables connected manager tools;
    // the TUI controller's older preservation comment contradicts its implementation.
    // Keep the actual native behavior while preserving the non-MCP selection.
    const refreshedTools = [...selectedTools, 'mcp__fixture_tool'];
    expect(await session.prompt('/fixture-tool-selection inspect')).toBe(false);
    expect(JSON.parse(await readFile(path.join(gates, 'active-tools.json'), 'utf8'))).toEqual(refreshedTools);
    expect(await session.prompt('/fixture-tool-selection read')).toBe(false);
    const nativeReconnect = session.startPrompt('/mcp reconnect fixture');
    const reconnectReceipt = await nativeReconnect.accepted;
    expect(reconnectReceipt).toMatchObject({kind:'native-command',command:'mcp',output:expect.stringContaining('Reconnected to "fixture"')});
    expect(await nativeReconnect.completion).toBe(false);
    expect(await session.prompt('/fixture-tool-selection inspect')).toBe(false);
    expect(JSON.parse(await readFile(path.join(gates, 'active-tools.json'), 'utf8'))).toEqual(refreshedTools);
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

test('typed native MCP help and reload persist output without a model turn and respect extension precedence', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-session-mcp-command-')));
  const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
  await Promise.all([agentDir, cwd].map(p => mkdir(p)));
  const marker = path.join(root, 'starts');
  await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: {
    command: process.execPath, args: [path.join(import.meta.dir, '../omp/fixtures/mcp-server.ts')],
    env: { AGENT_DESKTOP_MCP_TEST_MARKER: marker },
  } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath: path.join(import.meta.dir, 'fixtures/no-provider-worker.ts'),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: 'dumb' } });
  try {
    const session = await runtime.create({ cwd, interactions: true });
    const catalog = await session.getComposerActions();
    const mcp = catalog.commands.find(row => row.id === 'builtin:mcp')!;
    expect(mcp.availability).toBe('partial');
    expect(mcp.subcommands?.filter(row => row.availability === 'executable').map(row => row.name).sort()).toEqual(['help', 'notifications', 'prompts', 'reconnect', 'reload', 'resources']);
    expect((await session.getComposerCompletions({ kind: 'command-argument', commandName: 'mcp', query: 'reconnect fi', catalogRevision: catalog.revision })).items).toMatchObject([{ label: 'fixture', insertText: 'reconnect fixture ' }]);
    const receipts: string[] = [];
    for (const text of ['/mcp', '/mcp help', '/mcp reload']) {
      const run = session.startPrompt(text);
      const receipt = await run.accepted;
      expect(await run.completion).toBe(false);
      if (receipt?.kind !== 'native-command' || !receipt.entryId) throw new Error('Expected persisted MCP command output');
      expect(receipt.command).toBe('mcp');
      expect(receipt.output).toContain(text.endsWith('reload') ? 'MCP runtime reload requested.' : '/mcp help');
      receipts.push(receipt.entryId);
    }
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(2);
    const unsupported = session.startPrompt('/mcp reauth fixture');
    await expect(unsupported.accepted).rejects.toThrow('not connected');
    await expect(unsupported.completion).rejects.toThrow();
    expect((await session.getMessages()).filter(row => row.role === 'user')).toHaveLength(0);
    await session.dispose();
    const reopened = await runtime.open({ sessionFile: session.sessionFile, interactions: true });
    expect((await reopened.getMessages()).filter(row => receipts.includes(row.id)).map(row => row.commandOutput?.command)).toEqual(['mcp', 'mcp', 'mcp']);
    await reopened.dispose();

    const extension = path.join(root, 'shadow.ts'), shadowMarker = path.join(root, 'shadow');
    await writeFile(extension, `import {writeFileSync} from 'node:fs';\nexport default function(pi) { pi.registerCommand('mcp', {description:'Shadow native MCP', handler:async args=>writeFileSync(${JSON.stringify(shadowMarker)},args)}); }\n`);
    await writeFile(path.join(agentDir, 'config.yml'), `extensions:\n  - ${JSON.stringify(extension)}\n`);
    const shadow = await runtime.create({ cwd, interactions: true });
    const before = await readFile(marker, 'utf8');
    expect((await shadow.getComposerActions()).commands.find(row => row.id === 'builtin:mcp')?.availability).toBe('shadowed');
    expect((await shadow.getComposerCompletions({ kind: 'command-argument', commandName: 'mcp', query: 'reconnect fi' })).items).toEqual([]);
    const run = shadow.startPrompt('/mcp reload');
    expect(await run.accepted).toEqual({ kind: 'native-command', command: 'mcp' });
    expect(await run.completion).toBe(false);
    expect(await readFile(shadowMarker, 'utf8')).toBe('reload');
    expect(await readFile(marker, 'utf8')).toBe(before);
    expect((await shadow.getMessages()).filter(row => row.role === 'user')).toHaveLength(0);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test('live MCP inspection reuses cached resources/prompts/notifications and prompt invocation retains native argument semantics', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-session-mcp-details-')));
  const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project'), gates = path.join(root, 'gates');
  await Promise.all([agentDir, cwd, gates].map(p => mkdir(p)));
  const requests = path.join(root, 'requests'), marker = path.join(root, 'starts');
  await writeFile(path.join(agentDir, 'config.yml'), `extensions:\n  - ${JSON.stringify(path.join(import.meta.dir, 'fixtures/mcp-provider.ts'))}\nmcp:\n  notifications: true\nretry:\n  enabled: false\n`);
  await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: {
    command: process.execPath, args: [path.join(import.meta.dir, '../omp/fixtures/mcp-server.ts')],
    env: { AGENT_DESKTOP_MCP_TEST_MARKER: marker, AGENT_DESKTOP_MCP_TEST_REQUESTS: requests, AGENT_DESKTOP_MCP_TEST_RESOURCE_DELAY: '100' },
  } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath: path.join(import.meta.dir, 'fixtures/no-provider-worker.ts'),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, MCP_CONTRACT_GATES: gates, TERM: 'dumb' } });
  try {
    const session = await runtime.create({ cwd, interactions: true, approvalOverride: 'yolo' });
    let snapshot = await session.getSessionMcp();
    for (let index = 0; index < 200 && !snapshot.servers[0]?.prompts?.length; index++) {
      await Bun.sleep(5); snapshot = await session.getSessionMcp();
    }
    expect(snapshot.servers[0]?.resources?.[0]).toMatchObject({ uri: 'fixture://resource', description: 'A resource from this live connection', mimeType: 'text/plain' });
    expect(snapshot.servers[0]?.resourceTemplates?.[0]?.uriTemplate).toBe('fixture://{id}');
    expect(snapshot.servers[0]?.prompts?.[0]?.arguments).toEqual([{ name: 'topic', description: 'Subject for this prompt', required: true }]);
    expect(snapshot.servers[0]?.notifications).toMatchObject({ enabled: true, toolsListChanged: true, resourcesListChanged: true, promptsListChanged: true, resourceSubscribe: true, subscriptions: ['fixture://resource'] });
    const before = await readFile(requests, 'utf8');
    const outputs = new Map<string, string>();
    for (const verb of ['resources', 'prompts', 'notifications']) {
      const run = session.startPrompt(`/mcp ${verb}`), receipt = await run.accepted;
      expect(await run.completion).toBe(false);
      if (receipt?.kind !== 'native-command' || !receipt.entryId || !receipt.output) throw new Error('Expected durable native inspection output');
      outputs.set(verb, receipt.output);
    }
    expect(outputs.get('resources')).toContain('fixture://{id}');
    expect(outputs.get('prompts')).toContain('topic= (required)');
    expect(outputs.get('notifications')).toContain('resources/subscribe: 1 active subscriptions');
    expect(await readFile(requests, 'utf8')).toBe(before);
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect((await session.getMessages()).filter(row => row.role === 'user')).toHaveLength(0);
    expect(await Bun.file(path.join(gates, 'provider-started')).exists()).toBe(false);
    const catalog = await session.getComposerActions();
    expect(catalog.commands.find(row => row.name === 'fixture:fixture_prompt')).toMatchObject({ availability: 'executable', source: { kind: 'mcp-prompt' } });
    const run = session.startPrompt('/fixture:fixture_prompt topic=Blue topic="Cobalt detail" ignored', { model: { provider: 'mcp-contract', id: 'controlled' } });
    expect((await run.accepted)?.kind).toBe('user-message'); expect(await run.completion).toBe(true);
    const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === 'prompts/get').map(call => call.params)).toEqual([{ name: 'fixture_prompt', arguments: { topic: 'Cobalt detail' } }]);
    expect((await session.getMessages()).find(row => row.role === 'user')?.text).toBe('Native MCP prompt topic: Cobalt detail');
    const messagesBefore = (await session.getMessages()).length;
    const empty = session.startPrompt('/fixture:fixture_prompt topic=empty');
    expect(await empty.accepted).toEqual({ kind: 'native-command', command: 'fixture:fixture_prompt' });
    expect(await empty.completion).toBe(false); expect((await session.getMessages()).length).toBe(messagesBefore);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30000);
