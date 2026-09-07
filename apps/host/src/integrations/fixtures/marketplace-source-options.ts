import assert from 'node:assert/strict';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {startHost} from '../../server';
import type {NativeMarketplaceCatalog,NativePluginAcquisitionReceipt,NativePluginAcquisition} from '../../../../../packages/shared/src/plugin-acquisition';
const root=await realpath(process.argv[2]!),repository=path.join(root,'repository'),project=path.join(root,'project'),agent=path.join(root,'agent');
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const git=async(args:string[])=>{const child=Bun.spawn(['git',...args],{cwd:repository,stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(code,0,err);return out.trim();};
await Promise.all([mkdir(path.join(repository,'.omp-plugin'),{recursive:true}),mkdir(path.join(repository,'selected','plugin'),{recursive:true}),mkdir(path.join(repository,'skipped'),{recursive:true}),mkdir(project,{recursive:true}),mkdir(agent,{recursive:true})]);
const writeCatalog=async(version:string)=>{
 await writeFile(path.join(repository,'.omp-plugin','marketplace.json'),json({name:'options-market',owner:{name:'Fixture'},metadata:{description:version},plugins:[{name:'sample',version,source:'./selected/plugin'}]}));
 await writeFile(path.join(repository,'selected','plugin','package.json'),json({name:'source-options-fixture',version}));
 await writeFile(path.join(repository,'selected','plugin','content.txt'),version+'\n');
};
await writeCatalog('1.0.0');await writeFile(path.join(repository,'skipped','private.txt'),'excluded\n');await writeFile(path.join(repository,'literal[1].txt'),'literal path\n');await writeFile(path.join(repository,'literal1.txt'),'not requested\n');
await writeFile(path.join(repository,' spaced.txt '),'exact spaced path\n');await writeFile(path.join(repository,'spaced.txt'),'not requested\n');
await git(['init','-q','--initial-branch=main']);await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','default']);
await git(['checkout','-qb','release/selected']);await writeCatalog('2.0.0');await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','selected']);const pinned=await git(['rev-parse','HEAD']);await git(['tag','pinned']);await git(['checkout','-q','main']);
await writeFile(path.join(root,'gitconfig'),`[url "file://${root}/"]\n\tinsteadOf = https://marketplace.fixture/\n`);
await writeFile(path.join(agent,'config.yml'),'extensions: []\n');assert.equal(Bun.spawnSync(['git','init','-q',project]).exitCode,0);
const baseline={head:await git(['rev-parse','HEAD']),index:await readFile(path.join(repository,'.git','index')),status:await git(['status','--porcelain'])};
let host=await startHost({dataDirectory:path.join(root,'data'),agentDirectory:agent,discoveryDirectory:project,tailscale:false});
// Bun does not keep a process alive for a pending top-level promise alone. The
// first host is deliberately fully stopped before its replacement starts, so
// retain one fixture-owned handle across that handle-free restart gap.
const fixtureKeepAlive=setInterval(()=>{},1_000);
const post=async(route:string,value:unknown)=>fetch(host.connection.origin+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${host.connection.token}`},body:json(value)});
try{
 const created=await post('/v1/commands',{id:'options-project',command:{type:'project.add',path:project}});assert.equal(created.status,200);const target={projectId:(await created.json() as any).value.id};
 const prefix='/v1/integrations/acquisition/';
 const catalog=async()=>{const response=await post(prefix+'catalog',{target});assert.equal(response.status,200);return await response.json() as NativeMarketplaceCatalog;};
 const run=async(action:NativePluginAcquisition)=>{
  const request={id:crypto.randomUUID(),expectedRevision:(await catalog()).revision,action};const response=await post(prefix+'start',{target,request});assert.equal(response.status,202);
  for(let i=0;i<600;i++){const rows=await (await post(prefix+'operations',{})).json() as NativePluginAcquisitionReceipt[];const receipt=rows.find(row=>row.id===request.id)!;if(receipt.state!=='running'){assert.equal(receipt.state,'succeeded',`Native ${action.operation} did not succeed (${action.operation==='marketplace.add'?action.sourceOptions?.ref??'default':''})`);return;}await Bun.sleep(25);}throw new Error('Native operation timeout');
 };
 const options={ref:'release/selected',sparsePaths:['selected','literal[1].txt',' spaced.txt ']};
 for(const source of [project,'https://marketplace.fixture/catalog.json']){const refused=await post(prefix+'start',{target,request:{id:crypto.randomUUID(),expectedRevision:(await catalog()).revision,action:{operation:'marketplace.add',source,sourceOptions:{ref:'main'}}}});assert.equal(refused.status,400);}
 const invalid=await post(prefix+'start',{target,request:{id:crypto.randomUUID(),expectedRevision:(await catalog()).revision,action:{operation:'marketplace.add',source:'https://marketplace.fixture/repository',sourceOptions:{sparsePaths:['../escape']}}}});assert.equal(invalid.status,400);assert.deepEqual(await (await post(prefix+'operations',{})).json(),[]);
 await run({operation:'marketplace.add',source:'https://marketplace.fixture/repository',sourceOptions:options});
 let snapshot=await catalog();assert.deepEqual(snapshot.marketplaces[0]?.sourceOptions,options);assert.equal(snapshot.marketplaces[0]?.description,'2.0.0');
 const dirs=await import('@oh-my-pi/pi-utils');dirs.refreshDirsFromEnv();const registry=()=>Bun.file(dirs.getMarketplacesRegistryPath()).json();
 let entry=(await registry()).marketplaces[0];assert.deepEqual(entry.sourceOptions,options);let cache=path.dirname(entry.catalogPath);
 const inspectCache=async(version:string)=>{assert.equal(await Bun.file(path.join(cache,'selected/plugin/content.txt')).text(),version+'\n');assert.equal(await Bun.file(path.join(cache,'skipped/private.txt')).exists(),false);assert.equal(await Bun.file(path.join(cache,'literal[1].txt')).text(),'literal path\n');assert.equal(await Bun.file(path.join(cache,'literal1.txt')).exists(),false);assert.equal(await Bun.file(path.join(cache,' spaced.txt ')).text(),'exact spaced path\n');assert.equal(await Bun.file(path.join(cache,'spaced.txt')).exists(),false);};
 await inspectCache('2.0.0');await run({operation:'plugin.install',name:'sample',marketplace:'options-market',scope:'project'});assert.equal((await catalog()).installed[0]?.version,'2.0.0');
 // Advance only the selected fixture branch; the default branch and its index/working tree return unchanged.
 await git(['checkout','-q','release/selected']);await writeCatalog('3.0.0');await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','advance']);await git(['checkout','-q','main']);
 await host.stop();host=await startHost({dataDirectory:path.join(root,'data'),agentDirectory:agent,discoveryDirectory:project,tailscale:false});
 await run({operation:'marketplace.update',name:'options-market'});snapshot=await catalog();assert.equal(snapshot.marketplaces[0]?.description,'3.0.0');assert.deepEqual(snapshot.marketplaces[0]?.sourceOptions,options);await inspectCache('3.0.0');assert.equal(snapshot.installed[0]?.version,'2.0.0');
 await run({operation:'marketplace.remove',name:'options-market'});
 await run({operation:'marketplace.add',source:'https://marketplace.fixture/repository',sourceOptions:{ref:pinned,sparsePaths:['selected']}});assert.equal((await catalog()).marketplaces[0]?.description,'2.0.0');
 assert.equal(await git(['rev-parse','HEAD']),baseline.head);assert.equal(await git(['status','--porcelain']),baseline.status);
 // Checkout itself rewrites the source index; no blanket raw-index equality is claimed across the intentional fixture edits.
 const receipts=await (await post(prefix+'operations',{})).json() as NativePluginAcquisitionReceipt[];assert.equal(receipts.length,5);assert.ok(receipts.every(row=>row.state==='succeeded'));assert.ok(!JSON.stringify(receipts).includes('release/selected'));assert.ok(!JSON.stringify(receipts).includes('marketplace.fixture'));
 const result=json({passed:true,nativeMutations:5,hostStarts:2,branchAndSha:true,sparseLiteralFiles:true,updatesPreserveOptions:true,installedVersionUnchangedByMarketplaceUpdate:true,providerCalls:0});
 await new Promise<void>((resolve,reject)=>process.stdout.write(result,error=>error?reject(error):resolve()));
}catch(error){console.error(error);process.exitCode=1;throw error;}finally{try{await host.stop();}finally{clearInterval(fixtureKeepAlive);}}
