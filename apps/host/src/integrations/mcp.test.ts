import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkerRuntime} from '../omp-workers/runtime';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'agent-desktop-mcp-contract-'));
  cleanups.push(()=>rm(root,{recursive:true,force:true}));
  const agentDir=path.join(root,'agent'),cwd=path.join(root,'project'),user=path.join(agentDir,'mcp.json'),project=path.join(cwd,'.omp','mcp.json');
  await mkdir(agentDir,{recursive:true});await mkdir(path.dirname(project),{recursive:true});await mkdir(path.join(cwd,'.git'));
  await writeFile(path.join(agentDir,'config.yml'),'extensions: []\n');
  const sentinel=path.join(root,'must-not-execute');
  await writeFile(user,json({preserved:'user-field',disabledServers:['disabled','orphan'],mcpServers:{alpha:{command:'/bin/sh',args:['-c',`touch '${sentinel}'`],env:{TOKEN:'user-secret'}},disabled:{type:'http',url:'https://invalid.example',headers:{Authorization:'secret-header'},enabled:false}}}));
  await writeFile(project,json({preserved:'project-field',mcpServers:{alpha:{command:'/bin/false',enabled:false},local:{command:'/bin/false'}}}));
  const runtime=new WorkerRuntime({agentDir,workerPath:fileURLToPath(new URL('../omp-workers/fixtures/no-provider-worker.ts',import.meta.url)),environment:{HOME:root,PATH:process.env.PATH,TMPDIR:tmpdir(),PI_CODING_AGENT_DIR:agentDir,TERM:'dumb'},startupTimeoutMs:30000});
  cleanups.push(()=>runtime.dispose());
  return {root,agentDir,cwd,user,project,runtime,sentinel};
}
test('native discovery retains disabled/project/shadowed rows while never exposing or executing connection configuration',async()=>{
  const f=await fixture(),catalog=await f.runtime.getMcpServers(f.cwd);
  expect(catalog.application).toBe('new-sessions');
  expect(catalog.servers.filter(s=>s.name==='alpha')).toHaveLength(2);
  expect(catalog.servers.find(s=>s.name==='alpha'&&s.scope==='user')?.shadowed).toBe(true);
  expect(catalog.servers.find(s=>s.name==='disabled')).toMatchObject({enabled:false,transport:'http'});
  expect(catalog.servers.find(s=>s.name==='orphan')).toMatchObject({enabled:false,removable:false,transport:'unknown'});
  const publicText=JSON.stringify(catalog);for(const secret of ['user-secret','secret-header','/bin/sh','invalid.example'])expect(publicText).not.toContain(secret);
  await expect(access(f.sentinel)).rejects.toThrow();
},30000);
test('actual worker edits exact native owners, preserves secrets and unrelated fields, rejects stale writes',async()=>{
  const f=await fixture();let catalog=await f.runtime.getMcpServers(f.cwd);
  const selected=catalog.servers.find(s=>s.name==='alpha'&&s.scope==='project')!;
  const originalUser=await readFile(f.user,'utf8');
  catalog=await f.runtime.mutateMcpServer(f.cwd,{operation:'enabled',serverId:selected.id,enabled:true,expectedRevision:catalog.revision});
  expect(JSON.parse(await readFile(f.project,'utf8'))).toMatchObject({preserved:'project-field',mcpServers:{alpha:{enabled:true},local:{command:'/bin/false'}}});
  expect(JSON.parse(await readFile(f.user,'utf8'))).toEqual(JSON.parse(originalUser));
  const stale=catalog.revision;
  catalog=await f.runtime.mutateMcpServer(f.cwd,{operation:'add',scope:'project',name:'added',config:{type:'sse',url:'https://invalid.example/sse',headers:{Authorization:'new-secret'}},expectedRevision:catalog.revision});
  expect(catalog.servers.find(s=>s.name==='added')).toMatchObject({transport:'sse',scope:'project'});
  expect(JSON.stringify(catalog)).not.toContain('new-secret');
  await expect(f.runtime.mutateMcpServer(f.cwd,{operation:'remove',serverId:selected.id,expectedRevision:stale})).rejects.toThrow('changed');
  catalog=await f.runtime.mutateMcpServer(f.cwd,{operation:'remove',serverId:catalog.servers.find(s=>s.name==='added')!.id,expectedRevision:catalog.revision});
  expect(catalog.servers.some(s=>s.name==='added')).toBe(false);
  const orphan=catalog.servers.find(s=>s.name==='orphan')!;
  await f.runtime.mutateMcpServer(f.cwd,{operation:'enabled',serverId:orphan.id,enabled:true,expectedRevision:catalog.revision});
  expect(JSON.parse(await readFile(f.user,'utf8'))).toMatchObject({enabledServers:['orphan'],disabledServers:['disabled'],mcpServers:{alpha:{env:{TOKEN:'user-secret'}}}});
  await expect(access(f.sentinel)).rejects.toThrow();
},30000);
test('external edits and malformed native configuration are not overwritten',async()=>{
  const f=await fixture(),catalog=await f.runtime.getMcpServers(f.cwd);
  const malformed='{"mcpServers": broken sensitive-value';await writeFile(f.user,malformed);
  await expect(f.runtime.mutateMcpServer(f.cwd,{operation:'add',scope:'user',name:'lost',config:{command:'/bin/false'},expectedRevision:catalog.revision})).rejects.toThrow('valid JSON');
  expect(await readFile(f.user,'utf8')).toBe(malformed);
},30000);
test('configuration HTTP uses catalog targets, masks native failures, and rejects unsafe mutations before writes',async()=>{
  const {IntegrationsHttp}=await import('../integrations-http');
  const f=await fixture();let changes=0;
  const service=new IntegrationsHttp({runtime:f.runtime,resolveCwd:target=>{if(!target||'projectId' in target&&target.projectId==='admitted')return f.cwd;throw new Error('private-owner-path');},changed:()=>{changes++;}});
  cleanups.push(()=>service.dispose());
  const post=async(suffix:string,body:unknown)=>{
    const url=new URL(`http://localhost/v1/integrations/${suffix}`);
    return (await service.route(new Request(url,{method:'POST',body:JSON.stringify(body)}),url))!;
  };
  const first=await post('mcp/read',{target:{projectId:'admitted'}});expect(first.status).toBe(200);
  const catalog=await first.json() as import('@agent-desktop/shared').NativeMcpCatalog;
  const original=await readFile(f.user,'utf8');
  expect((await post('mcp/read',{target:{cwd:f.root}})).status).toBe(400);
  expect((await post('mcp/read',{target:{projectId:'missing'}})).status).toBe(400);
  expect((await post('mcp/mutate',{mutation:{expectedRevision:catalog.revision,operation:'add',scope:'project',name:'wrong',config:{command:'/bin/false'}}})).status).toBe(400);
  const unsafe=JSON.parse('{"__proto__":{"polluted":true}}');
  expect((await post('mcp/mutate',{target:{projectId:'admitted'},mutation:{expectedRevision:catalog.revision,operation:'add',scope:'user',name:'bad',config:unsafe}})).status).toBe(400);
  expect(await readFile(f.user,'utf8')).toBe(original);expect(changes).toBe(0);
  const saved=await post('mcp/mutate',{target:{projectId:'admitted'},mutation:{expectedRevision:catalog.revision,operation:'add',scope:'user',name:'saved',config:{command:'/bin/false',env:{SECRET:'never-public'}}}});
  expect(saved.status).toBe(200);expect(await saved.text()).not.toContain('never-public');expect(changes).toBe(1);
  await writeFile(f.user,'{"mcpServers": "private-invalid-secret');
  const failed=await post('mcp/read',{});expect(failed.status).toBe(400);expect(await failed.text()).not.toContain('private-invalid-secret');
  await service.dispose();expect((await post('mcp/read',{})).status).toBe(503);
},30000);
test('concurrent catalogs share the same native revision and only one same-revision save succeeds',async()=>{
  const f=await fixture();
  const [a,b]=await Promise.all([f.runtime.getMcpServers(f.cwd),f.runtime.getMcpServers(f.cwd)]);
  expect(a.revision).toBe(b.revision);
  const saves=await Promise.allSettled(['first','second'].map(name=>f.runtime.mutateMcpServer(f.cwd,{operation:'add',scope:'user',name,config:{command:'/bin/false'},expectedRevision:a.revision})));
  expect(saves.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(saves.filter(r=>r.status==='rejected')).toHaveLength(1);
  const stored=JSON.parse(await readFile(f.user,'utf8'));expect(['first','second'].filter(name=>stored.mcpServers[name])).toHaveLength(1);
},30000);
test('native configuration rejects FIFOs, external links and invalid nested entries without modifying them',async()=>{
  const {symlink}=await import('node:fs/promises');const f=await fixture();
  const external=path.join(f.root,'outside.json'),bytes='{"mcpServers":{"keep":{"command":"/bin/false"}}}';
  await writeFile(external,bytes);await rm(f.user);await symlink(external,f.user);
  await expect(f.runtime.getMcpServers(f.cwd)).rejects.toThrow();expect(await readFile(external,'utf8')).toBe(bytes);
  await rm(f.user);const fifo=Bun.spawnSync(['/usr/bin/mkfifo',f.user]);expect(fifo.exitCode).toBe(0);
  await expect(f.runtime.getMcpServers(f.cwd)).rejects.toThrow();await rm(f.user);
  for(const raw of ['{"mcpServers":{"bad":{"type":"smtp","command":"x"}}}','{"mcpServers":{"bad":{"command":"x","env":{"__proto__":{}}}}}','{"mcpServers":{"bad":{"command":23}}}']){
    await writeFile(f.user,raw);await expect(f.runtime.getMcpServers(f.cwd)).rejects.toThrow();expect(await readFile(f.user,'utf8')).toBe(raw);
  }
},30000);
test('configuration shutdown drains its admitted write and rejects new work',async()=>{
 const {IntegrationsHttp}=await import('../integrations-http');let release!:()=>void,entered!:()=>void,finished=false;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const service=new IntegrationsHttp({runtime:{getPlugins:async()=>({revision:'r',plugins:[],application:'new-sessions'}),getMcpServers:async()=>({revision:'r',servers:[],application:'new-sessions'}),mutatePlugin:async()=>{throw new Error('Unused');},mutateMcpServer:async()=>{entered();await gate;finished=true;return {revision:'done',servers:[],application:'new-sessions'};}},resolveCwd:()=>'/admitted',changed:()=>{}});
 const url=new URL('http://localhost/v1/integrations/mcp/mutate');const pending=service.route(new Request(url,{method:'POST',body:JSON.stringify({mutation:{operation:'add',expectedRevision:'r',scope:'user',name:'server',config:{command:'/bin/false'}}})}),url);
 await started;let disposed=false;const closing=service.dispose().then(()=>{disposed=true;});await Promise.resolve();expect(disposed).toBe(false);
 const rejected=await service.route(new Request(url,{method:'POST',body:'{}'}),url);expect(rejected?.status).toBe(503);
 release();expect((await pending)?.status).toBe(200);await closing;expect(finished).toBe(true);expect(disposed).toBe(true);
});
