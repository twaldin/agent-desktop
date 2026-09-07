import assert from 'node:assert/strict';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {startHost} from '../../server';
import type {NativeMarketplaceCatalog,NativePluginAcquisitionReceipt,NativePluginAcquisition} from '../../../../../packages/shared/src/plugin-acquisition';

const root=await realpath(process.argv[2]!);
const projectPath=path.join(root,'project'),market=path.join(root,'market'),agentDirectory=path.join(root,'agent');
await Promise.all([mkdir(projectPath,{recursive:true}),mkdir(agentDirectory,{recursive:true}),mkdir(path.join(market,'.omp-plugin'),{recursive:true}),mkdir(path.join(market,'sample'),{recursive:true})]);
assert.equal(Bun.spawnSync(['git','init','-q',projectPath]).exitCode,0);
await writeFile(path.join(agentDirectory,'config.yml'),'extensions: []\n');
await writeFile(path.join(market,'sample','package.json'),JSON.stringify({name:'acquisition-fixture',version:'1.0.0',scripts:{postinstall:`touch ${root}/executed`}}));
await writeFile(path.join(market,'.omp-plugin','marketplace.json'),JSON.stringify({name:'local-fixture',owner:{name:'Fixture'},plugins:[{name:'sample',source:'./sample',version:'1.0.0'}]}));
const dataDirectory=path.join(root,'data');
let host=await startHost({dataDirectory,agentDirectory,discoveryDirectory:projectPath,tailscale:false});
const post=async(route:string,value:unknown,auth=true)=>fetch(host.connection.origin+route,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${host.connection.token}`}:{})},body:JSON.stringify(value)});
try{
 const added=await post('/v1/commands',{id:'add-project',command:{type:'project.add',path:projectPath}});
 assert.equal(added.status,200);const target={projectId:(await added.json() as any).value.id};
 const prefix='/v1/integrations/acquisition/';
 assert.equal((await post(prefix+'catalog',{target},false)).status,401);
 assert.equal((await post(prefix+'catalog',{target:{projectId:'not-owned'}})).status,400);
 const catalog=async()=>{
  const response=await post(prefix+'catalog',{target});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  return await response.json() as NativeMarketplaceCatalog;
 };
 const wait=async(id:string)=>{
  for(let i=0;i<200;i++){
   const response=await post(prefix+'operations',{target});assert.equal(response.status,200);
   const receipt=(await response.json() as NativePluginAcquisitionReceipt[]).find(row=>row.id===id)!;
   if(receipt.state!=='running')return receipt;
   await Bun.sleep(25);
  }throw new Error('Native acquisition did not settle');
 };
 const execute=async(action:NativePluginAcquisition)=>{
  const request={id:crypto.randomUUID(),expectedRevision:(await catalog()).revision,action};
  const response=await post(prefix+'start',{target,request});assert.equal(response.status,202);
  assert.equal((await response.json() as NativePluginAcquisitionReceipt).id,request.id);
  assert.equal((await wait(request.id)).state,'succeeded');return request;
 };
 await execute({operation:'marketplace.add',source:market});
 const installed=await execute({operation:'plugin.install',name:'sample',marketplace:'local-fixture',scope:'project'});
 assert.equal((await catalog()).installed.length,1);
 const link=path.join(projectPath,'.omp','plugins','node_modules','acquisition-fixture');
 const cache=await realpath(link);assert.ok(cache.startsWith(root));
 assert.equal(JSON.parse(await readFile(path.join(cache,'package.json'),'utf8')).name,'acquisition-fixture');
 // Receipts survive actual host + discovery worker restart; an old ID cannot repeat installation.
 await host.stop();host=await startHost({dataDirectory,agentDirectory,discoveryDirectory:projectPath,tailscale:false});
 const duplicate=await post(prefix+'start',{target,request:installed});assert.equal(duplicate.status,202);
 assert.equal((await duplicate.json() as NativePluginAcquisitionReceipt).state,'succeeded');
 assert.equal((await catalog()).installed.length,1);assert.equal(await realpath(link),cache);
 await execute({operation:'plugin.uninstall',pluginId:'sample@local-fixture',scope:'project'});
 assert.equal((await catalog()).installed.length,0);assert.ok(await Bun.file(path.join(cache,'package.json')).exists());
 await execute({operation:'marketplace.remove',name:'local-fixture'});
 assert.equal((await catalog()).marketplaces.length,0);
 assert.equal(await Bun.file(path.join(root,'executed')).exists(),false);
 const receipts=await (await post(prefix+'operations',{target})).json() as NativePluginAcquisitionReceipt[];
 assert.equal(receipts.length,4);assert.ok(receipts.every(row=>row.state==='succeeded'));
 assert.ok(!JSON.stringify(receipts).includes(market));
 console.log(JSON.stringify({passed:true,nativeMutations:4,hostStarts:2,duplicateReplayed:false,pluginCodeExecuted:false}));
}finally{await host.stop();}
