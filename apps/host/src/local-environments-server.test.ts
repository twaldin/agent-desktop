import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serializeLocalEnvironment, type CommandEnvelope, type CommandResult } from '@agent-desktop/shared';
import { startHost } from './server';

test('environment catalog and revisioned save use authenticated owning workspace and durable command receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-environment-http-'));
  const a = join(root, 'a'), b = join(root, 'b'), dataDirectory = join(root, 'data'), agentDirectory = join(root, 'agent');
  await Promise.all([a,b,agentDirectory].map(path => mkdir(path)));
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const start = () => startHost({ dataDirectory, agentDirectory, discoveryDirectory: a, port: 0, tailscale: false });
    host = await start();
    const request = (path: string, body?: unknown, authenticated = true) => fetch(host!.connection.origin + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${host!.connection.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const send = async (envelope: CommandEnvelope): Promise<CommandResult> => {
      const response = await request('/v1/commands', envelope); expect(response.status).toBe(200); return response.json();
    };
    const add = async (path: string) => {
      const result = await send({ id: crypto.randomUUID(), command: { type:'project.add', path } });
      if (!result.ok || !result.value || !('path' in result.value)) throw new Error('Project creation failed');
      return result.value.id;
    };
    const projectA = await add(a), projectB = await add(b);
    const query = (projectId: string, authenticated = true) => request('/v1/workspace/query', { target:{projectId}, query:{type:'environments.list'} }, authenticated);
    expect((await query(projectA,false)).status).toBe(401);
    expect(await (await query(projectA)).json()).toEqual({type:'environments.list',environments:[]});
    expect((await query('missing-owner')).ok).toBe(false);
    const raw = serializeLocalEnvironment({ version:1, name:'Web project', setup:{script:'touch SHOULD_NOT_EXECUTE'}, actions:[{name:'Run',icon:'run',command:'node server.js'}] });
    const create: CommandEnvelope = { id:'environment-create', command:{type:'workspace.mutate',target:{projectId:projectA},action:{type:'environment.save',expectedRevision:null,raw}} };
    const first = await send(create);
    if (!first.ok || !first.value || !('type' in first.value) || first.value.type !== 'environment.save' || first.value.result.type !== 'saved') throw new Error('Environment save failed');
    const saved = first.value.result;
    expect(await readFile(saved.configPath,'utf8')).toBe(raw);
    expect(await send(create)).toEqual(first);
    expect(await readdir(join(a,'.agent-desktop','environments'))).toEqual(['web-project.toml']);
    expect(await readdir(a)).toEqual(['.agent-desktop']);
    const brokenPath = join(dirname(saved.configPath),'broken.toml');
    await writeFile(brokenPath, 'name = [\n');
    const readConfig = (projectId: string, configPath: string) => request('/v1/workspace/query',{target:{projectId},query:{type:'environment.read',configPath}});
    expect(await (await readConfig(projectA,brokenPath)).json()).toMatchObject({type:'environment.read',configPath:brokenPath,raw:'name = [\n'});
    expect((await readConfig(projectB,brokenPath)).ok).toBe(false);
    const linked = join(dirname(saved.configPath),'link.toml');
    await symlink(saved.configPath,linked);
    expect((await readConfig(projectA,linked)).ok).toBe(false);
    await rm(linked); await rm(brokenPath);

    const foreign = await send({id:'foreign-path',command:{type:'workspace.mutate',target:{projectId:projectB},action:{type:'environment.save',configPath:saved.configPath,expectedRevision:saved.revision,raw}}});
    expect(foreign.ok).toBe(false);
    const editRaw = raw.replace('Web project','Saved edit');
    const edit = await send({id:'environment-edit',command:{type:'workspace.mutate',target:{projectId:projectA},action:{type:'environment.save',configPath:saved.configPath,expectedRevision:saved.revision,raw:editRaw}}});
    expect(edit).toMatchObject({ok:true,value:{type:'environment.save',result:{type:'saved',environment:{name:'Saved edit'}}}});
    const stale = await send({id:'environment-stale',command:{type:'workspace.mutate',target:{projectId:projectA},action:{type:'environment.save',configPath:saved.configPath,expectedRevision:saved.revision,raw:raw.replace('Web project','My unsaved edit')}}});
    expect(stale).toMatchObject({ok:true,value:{result:{type:'conflict',current:{environment:{name:'Saved edit'}},attempted:{environment:{name:'My unsaved edit'}}}}});
    expect(await readFile(saved.configPath,'utf8')).toBe(editRaw);
    await host.stop(); host=undefined; host=await start();
    expect(await send(create)).toEqual(first);
    expect(await readFile(saved.configPath,'utf8')).toBe(editRaw);
    expect(await (await query(projectA)).json()).toMatchObject({type:'environments.list',environments:[{type:'environment',environment:{name:'Saved edit'}}]});
    const nativePath = join(await realpath(a), '.codex', 'environments', 'environment.toml');
    await mkdir(dirname(nativePath), { recursive: true }); await writeFile(nativePath, raw);
    const nativeCatalog = await (await query(projectA)).json();
    expect(nativeCatalog.environments.map((item: { configPath: string }) => item.configPath)).toEqual([nativePath, saved.configPath]);
    const nativeRead = await (await readConfig(projectA, nativePath)).json();
    expect(nativeRead.raw).toBe(raw);
    expect((await readConfig(projectB, nativePath)).ok).toBe(false);
    const nativeEdit: CommandEnvelope = { id: 'native-environment-edit', command: { type: 'workspace.mutate', target: { projectId: projectA }, action: { type: 'environment.save', configPath: nativePath, expectedRevision: nativeRead.revision, raw: editRaw } } };
    const nativeSaved = await send(nativeEdit);
    expect(nativeSaved).toMatchObject({ ok: true, value: { result: { type: 'saved', configPath: nativePath } } });
    expect(await send(nativeEdit)).toEqual(nativeSaved);
    expect(await readFile(nativePath, 'utf8')).toBe(editRaw);
    expect(await readdir(dirname(nativePath))).toEqual(['environment.toml']);
    expect(await readFile(join(a, 'SHOULD_NOT_EXECUTE'), 'utf8').catch(() => null)).toBeNull();
    const state=await (await request('/v1/state')).json();
    expect(state.localEnvironments).toEqual({configuration:true,execution:{commandVersion:5,scriptOutput:true,scriptCancellation:true}}); expect(state.sessions).toHaveLength(0);
  } finally { await host?.stop(); await rm(root,{recursive:true,force:true}); }
},30_000);
