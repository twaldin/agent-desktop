import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startHost} from '../../../apps/host/src/server';
const root=process.argv[2]!,project=join(root,'project'),agent=join(root,'agent'),market=join(root,'market');
await Promise.all([mkdir(join(project,'.omp','skills','directory-skill'),{recursive:true}),mkdir(agent,{recursive:true}),mkdir(join(market,'.omp-plugin'),{recursive:true}),mkdir(join(market,'sample'),{recursive:true})]);
Bun.spawnSync(['git','init','-q',project]);
await writeFile(join(agent,'config.yml'),'extensions: []\n');
await writeFile(join(project,'.omp','skills','directory-skill','SKILL.md'),'---\nname: directory-skill\ndescription: Read the fixture checklist before changing files\n---\n# Directory skill\n\nDIRECTORY_SKILL_CONTENT from the actual owning project.\n');
await writeFile(join(market,'sample','package.json'),JSON.stringify({name:'directory-sample',version:'1.0.0',omp:{name:'Directory sample',description:'Installed native package for browsing'}}));
await writeFile(join(market,'.omp-plugin','marketplace.json'),JSON.stringify({name:'directory-market',owner:{name:'Fixture'},plugins:[{name:'sample',description:'Native marketplace sample',version:'1.0.0',source:'./sample'}]}));
const host=await startHost({dataDirectory:join(root,'data'),agentDirectory:agent,discoveryDirectory:project,tailscale:false});
const request=async(route:string,body:unknown)=>{const r=await fetch(host.connection.origin+route,{method:'POST',headers:{Authorization:`Bearer ${host.connection.token}`,'Content-Type':'application/json','X-Agent-Host-Id':host.connection.hostId},body:JSON.stringify(body)});const v=await r.json() as any;if(!r.ok)throw new Error('Fixture native setup failed '+r.status);return v;};
const response=await request('/v1/commands',{id:'directory-project',command:{type:'project.add',path:project}});if(!response.ok)throw new Error('Project creation failed');
const target={projectId:response.value.id};
const secondProject=join(root,'second-project');await mkdir(join(secondProject,'.omp','skills','other-skill'),{recursive:true});await writeFile(join(secondProject,'.omp','skills','other-skill','SKILL.md'),'---\nname: other-skill\ndescription: A different owning workspace\n---\nSECOND_OWNER_SKILL_CONTENT\n');const secondResponse=await request('/v1/commands',{id:'directory-second-project',command:{type:'project.add',path:secondProject}});if(!secondResponse.ok)throw new Error('Second project creation failed');const secondTarget={projectId:secondResponse.value.id};
for(const action of [{operation:'marketplace.add',source:market},{operation:'plugin.install',name:'sample',marketplace:'directory-market',scope:'user'}]){
 const catalog=await request('/v1/integrations/acquisition/catalog',{target});const id=crypto.randomUUID();
 await request('/v1/integrations/acquisition/start',{target,request:{id,expectedRevision:catalog.revision,action}});
 for(let i=0;;i++){const rows=await request('/v1/integrations/acquisition/operations',{});const row=rows.find((x:any)=>x.id===id);if(row.state==='succeeded')break;if(row.state!=='running'||i>400)throw new Error('Native fixture mutation did not settle');await Bun.sleep(25);}
}
await writeFile(join(root,'ready.json'),JSON.stringify({connection:host.connection,target,secondTarget}));
process.on('message',()=>void host.stop().then(()=>process.exit(0)));
