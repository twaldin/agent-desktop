import assert from 'node:assert/strict';
import {chmod,mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import path from 'node:path';
const root=process.env.LSP_TEST_ROOT!;
if(!root||process.env.HOME!==root||process.env.PI_CODING_AGENT_DIR!==path.join(root,'agent')) throw new Error('Disposable environment required');
const cwd=path.join(root,'project'),bin=path.join(cwd,'node_modules/.bin'),agent=path.join(root,'agent');
await mkdir(bin,{recursive:true});await mkdir(agent,{recursive:true});await mkdir(path.join(cwd,'.git'));
await writeFile(path.join(cwd,'package.json'),'{}');
await writeFile(path.join(bin,'fixture-server'),'#!/bin/sh\necho DO_NOT_START >&2\nexit 91\n');await chmod(path.join(bin,'fixture-server'),0o755);
const {getConfigDirPaths}=await import('@oh-my-pi/pi-coding-agent/config');
const {getPluginsDir}=await import('@oh-my-pi/pi-utils');
const userFile=path.join(getConfigDirPaths('',{user:true,project:false})[0]!,'lsp.json');
const extensions={vendor:{values:[null,true,3,'native',{enabled:false}]},toString:'native-owned'};
const nested={capabilities:{...extensions,flycheck:true},workspaceReadyTimings:{...extensions,timeoutMs:100}};
const base={command:'fixture-server',fileTypes:['.fixture'],rootMarkers:['package.json']};
const put=async(file:string,data:unknown)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(data));};
await put(userFile,{meta:{kept:true},servers:{shared:{...base,args:['user'],opaque:{retain:true},...nested},alias:{command:'fixture-server',extensionToLanguage:{'.alias':'alias'},initializationOptions:{alias:true}}},idleTimeoutMs:500});
await mkdir(path.join(cwd,'.claude'));
await writeFile(path.join(cwd,'.claude','.lsp.yaml'),Bun.YAML.stringify({servers:{shared:{args:['project-yaml'],...nested}},idleTimeoutMs:300}));
await put(path.join(cwd,'lsp.json'),{servers:{shared:{disabled:true},missing:{...base,command:'missing-command'},unmatched:{...base,rootMarkers:['does-not-exist']}}});
const plugin=path.join(root,'plugins','fixture');await mkdir(plugin,{recursive:true});
await put(path.join(plugin,'lsp.json'),{servers:{plugin:base,shared:{...base,args:['plugin']}}});
await put(path.join(getPluginsDir(),'installed_plugins.json'),{version:2,plugins:{'fixture@local':[{scope:'user',installPath:plugin,version:'1',enabled:true}]}});
const {NativeLsp}=await import('../lsp');
const {loadConfig,inspectConfig}=await import('@oh-my-pi/pi-coding-agent/lsp/config');
const {preloadPluginRoots,listClaudePluginRoots}=await import('@oh-my-pi/pi-coding-agent/discovery/helpers');
await preloadPluginRoots(root,cwd);
const native=new NativeLsp();let catalog=await native.read(cwd);
const inspection=inspectConfig(cwd,(await listClaudePluginRoots(root,cwd)).roots);
assert.deepEqual(JSON.parse(JSON.stringify(inspection.effective)),JSON.parse(JSON.stringify(loadConfig(cwd))));
assert.equal(catalog.servers.find(s=>s.name==='shared')?.applicability,'disabled');
assert.deepEqual(catalog.servers.find(s=>s.name==='shared')?.effective.args,['project-yaml']);
assert.equal(catalog.servers.find(s=>s.name==='missing')?.applicability,'missing-binary');
assert.equal(catalog.servers.find(s=>s.name==='unmatched')?.applicability,'missing-root');
assert.equal(catalog.servers.find(s=>s.name==='alias')?.applicability,'ready');
assert.equal(catalog.servers.find(s=>s.name==='alias')?.fieldSources.fileTypes,catalog.sources.find(s=>s.path===userFile)?.id);
assert.deepEqual(catalog.servers.find(s=>s.name==='alias')?.effective.initOptions,{alias:true});
assert.ok(catalog.servers.some(s=>s.builtin));assert.equal(catalog.idleTimeoutMs,300);
const project=catalog.overrideTargets.project,user=catalog.overrideTargets.user;
const pluginSource=catalog.sources.find(s=>s.path===path.join(plugin,'lsp.json'))!;
assert.ok(pluginSource);assert.equal(pluginSource.writable,false);
await assert.rejects(native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:pluginSource.id,operation:'remove',name:'plugin'}),/read only/);
await assert.rejects(native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:user,operation:'save',name:'alias',changes:{},removeFields:['command']}),/no valid native/);
// The pinned native consumer accepts these unknown nested values before any mutation.
assert.deepEqual(inspectConfig(cwd).merged.shared?.capabilities,nested.capabilities);
assert.deepEqual(inspectConfig(cwd).merged.shared?.workspaceReadyTimings,nested.workspaceReadyTimings);
const editedNested={capabilities:{...nested.capabilities,flycheck:false},workspaceReadyTimings:{...nested.workspaceReadyTimings,timeoutMs:250}};
for(const sourceId of [user,catalog.sources.find(s=>s.path.endsWith('.claude/.lsp.yaml'))!.id]) {
 catalog=await native.mutate(cwd,{expectedRevision:catalog.revision,sourceId,operation:'save',name:'shared',changes:editedNested,removeFields:[]});
 const source=catalog.sources.find(s=>s.id===sourceId)!;
 const text=await readFile(source.path,'utf8');
 const document=source.path.endsWith('.yaml')?Bun.YAML.parse(text) as any:JSON.parse(text);
 for(const field of ['capabilities','workspaceReadyTimings'] as const) {
  assert.deepEqual(document.servers.shared[field],editedNested[field]);
  assert.deepEqual(source.servers.shared![field],editedNested[field]);
 }
}
assert.deepEqual(inspectConfig(cwd).merged.shared?.capabilities,editedNested.capabilities);
assert.deepEqual(inspectConfig(cwd).merged.shared?.workspaceReadyTimings,editedNested.workspaceReadyTimings);
const firstRevision=catalog.revision;
catalog=await native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:project,operation:'save',name:'shared',changes:{disabled:false,warmupTimeoutMs:25,capabilities:{flycheck:true},settings:{fixture:{arbitrary:[1,true,null]}}},removeFields:[]});
assert.equal(catalog.servers.find(s=>s.name==='shared')?.applicability,'ready');
await assert.rejects(native.mutate(cwd,{expectedRevision:firstRevision,sourceId:project,operation:'remove',name:'shared'}),/changed/);
catalog=await native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:user,operation:'save',name:'shared',changes:{languageId:'fixture'},removeFields:[]});
let saved=JSON.parse(await readFile(userFile,'utf8'));assert.deepEqual(saved.servers.shared.opaque,{retain:true});assert.deepEqual(saved.meta,{kept:true});
catalog=await native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:project,operation:'remove',name:'shared'});
assert.deepEqual(catalog.servers.find(s=>s.name==='shared')?.effective.args,['project-yaml']);assert.equal(catalog.servers.find(s=>s.name==='shared')?.effective.warmupTimeoutMs,undefined);
const yaml=catalog.sources.find(s=>s.path.endsWith('.claude/.lsp.yaml'))!;
catalog=await native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:yaml.id,operation:'save',name:'shared',changes:{args:['changed-yaml']},removeFields:[]});assert.deepEqual(loadConfig(cwd).servers.shared?.args,['changed-yaml']);
catalog=await native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:yaml.id,operation:'idle-timeout',value:null});assert.equal(catalog.idleTimeoutMs,500);
let tooDeep:unknown=true;for(let i=0;i<26;i++)tooDeep={next:tooDeep};
const invalidChanges=[
 {capabilities:{...extensions,flycheck:'false'}},
 {workspaceReadyTimings:{...extensions,timeoutMs:'250'}},
 {workspaceReadyTimings:{...extensions,pollMs:-1}},
 {capabilities:{vendor:Infinity}},
 {capabilities:{vendor:tooDeep}},
 ...['__proto__','constructor','prototype'].map(key=>({workspaceReadyTimings:JSON.parse(`{"vendor":{"${key}":true}}`)})),
 {unknownTopLevel:{safe:true}},
];
const unchanged=await readFile(path.join(cwd,'lsp.json'),'utf8');
for(const changes of invalidChanges) {
 await assert.rejects(native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:project,operation:'save',name:'shared',changes:changes as any,removeFields:[]}),/Invalid LSP field/);
 assert.equal(await readFile(path.join(cwd,'lsp.json'),'utf8'),unchanged);
}
assert.equal((await native.read(cwd)).revision,catalog.revision);
await writeFile(path.join(cwd,'lsp.json'),'{broken');catalog=await native.read(cwd);assert.ok(catalog.warnings.some(s=>s.includes('lsp.json')));await assert.rejects(native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:project,operation:'idle-timeout',value:100}),/malformed/);assert.equal(await readFile(path.join(cwd,'lsp.json'),'utf8'),'{broken');
await put(path.join(cwd,'lsp.json'),{servers:{}});catalog=await native.read(cwd);
await put(path.join(cwd,'lsp.json'),{servers:{external:{...base,...nested}}});await assert.rejects(native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:project,operation:'idle-timeout',value:100}),/changed/);
await symlink(path.join(root,'foreign'),path.join(agent,'lsp.json.tmp'));catalog=await native.read(cwd);catalog=await native.mutate(cwd,{expectedRevision:catalog.revision,sourceId:user,operation:'idle-timeout',value:700});assert.equal(await Bun.file(path.join(root,'foreign')).exists(),false);
// Native TypeScript 7 choice uses package layout, without executing a binary.
await mkdir(path.join(cwd,'node_modules/typescript/bin'),{recursive:true});await put(path.join(cwd,'node_modules/typescript/package.json'),{name:'typescript',version:'7.0.0'});
await writeFile(path.join(cwd,'node_modules/typescript/bin/tsc'),'#!/bin/sh\nexit 92\n');await chmod(path.join(cwd,'node_modules/typescript/bin/tsc'),0o755);await symlink('../typescript/bin/tsc',path.join(bin,'tsc'));
await writeFile(path.join(bin,'typescript-language-server'),'#!/bin/sh\nexit 93\n');await chmod(path.join(bin,'typescript-language-server'),0o755);
await writeFile(path.join(cwd,'tsconfig.json'),'{}');catalog=await native.read(cwd);
assert.equal(catalog.servers.find(s=>s.name==='typescript-native')?.applicability,'ready');assert.equal(catalog.servers.find(s=>s.name==='typescript-language-server')?.applicability,'typescript-alternative');
const {startHost}=await import('../../server');
const host=await startHost({dataDirectory:path.join(root,'data'),agentDirectory:agent,discoveryDirectory:cwd,tailscale:false,port:0});
try {
 const request=async(route:string,body:unknown,auth=true)=>fetch(host.connection.origin+route,{method:'POST',headers:{'content-type':'application/json',...(auth?{Authorization:`Bearer ${host.connection.token}`}:{})},body:JSON.stringify(body)});
 assert.equal((await request('/v1/integrations/lsp/read',{},false)).status,401);
 const projectResponse=await request('/v1/commands',{id:crypto.randomUUID(),command:{type:'project.add',path:cwd,name:'LSP fixture'}});const projectResult=await projectResponse.json() as any;assert.equal(projectResult.ok,true);const target={projectId:projectResult.value.id};
 const response=await request('/v1/integrations/lsp/read',{target});assert.equal(response.status,200);const current=await response.json() as typeof catalog;assert.ok(current.servers.find(s=>s.name==='external'));
 const save=await request('/v1/integrations/lsp/mutate',{target,mutation:{operation:'save',sourceId:current.overrideTargets.project,expectedRevision:current.revision,name:'external',changes:{disabled:true,...editedNested},removeFields:[]}});assert.equal(save.status,200);const savedCatalog=await save.json() as typeof catalog;assert.equal(savedCatalog.servers.find(s=>s.name==='external')?.applicability,'disabled');
 const savedDocument=JSON.parse(await readFile(path.join(cwd,'lsp.json'),'utf8'));
 for(const field of ['capabilities','workspaceReadyTimings'] as const) {
  assert.deepEqual(savedCatalog.servers.find(s=>s.name==='external')?.effective[field],editedNested[field]);
  assert.deepEqual(savedDocument.servers.external[field],editedNested[field]);
  assert.deepEqual(inspectConfig(cwd).merged.external?.[field],editedNested[field]);
 }
 const bad=await request('/v1/integrations/lsp/mutate',{target,mutation:{operation:'save',sourceId:'/tmp/arbitrary-path',expectedRevision:current.revision,name:'external',changes:{},removeFields:[]}});assert.notEqual(bad.status,200);
}finally{await host.stop();}
console.log(JSON.stringify({passed:true,nativeOracle:true,realDiscoveryWorker:true,unknownNestedPreserved:['json','yaml','authenticated-http'],invalidNestedNoWrite:invalidChanges.length,providerCalls:0,serverStarts:0}));
