import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const repo=resolve(import.meta.dir,'../..'),output=resolve(process.argv[2]??`.data/directory-ui-${Date.now()}`);
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw new Error('Output must be empty');
const root=await mkdtemp(join(tmpdir(),'agent-desktop-directory-ui-'));
const env={HOME:root,PATH:process.env.PATH,TMPDIR:root,XDG_DATA_HOME:join(root,'xdg-data'),XDG_STATE_HOME:join(root,'xdg-state'),XDG_CONFIG_HOME:join(root,'xdg-config'),XDG_CACHE_HOME:join(root,'xdg-cache')};
const host=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/directory-host.ts'),root],{cwd:root,env,ipc:()=>{},stdout:Bun.file(join(output,'host.log')),stderr:Bun.file(join(output,'host-errors.log'))});
let proxy:ReturnType<typeof Bun.serve>|undefined;
try{
 for(let i=0;!(await Bun.file(join(root,'ready.json')).exists());i++){if(i>400||host.exitCode!==null)throw new Error('Host not ready');await Bun.sleep(50);}
 const ready=JSON.parse(await readFile(join(root,'ready.json'),'utf8'));
 const capability=crypto.randomUUID(),cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'};
 const calls:string[]=[];let held=false,holdRoute:string|undefined,release:(()=>void)|undefined,fail=false;
 proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;if(!path.startsWith('/'+capability+'/'))return new Response(null,{status:404});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  const route=path.slice(capability.length+1),input=await request.json() as any;
  if(route==='/test/hold'){holdRoute=input.route;held=false;return Response.json({ok:true},{headers:cors});}
  if(route==='/test/release'){release?.();release=undefined;return Response.json({ok:true},{headers:cors});}
  if(route==='/test/fail'){fail=input.value;return Response.json({ok:true},{headers:cors});}
  if(route==='/test/state')return Response.json({held,calls},{headers:cors});
  if(!/^\/v1\/(composer\/(actions|skill-detail)|integrations\/(acquisition\/(catalog|operations)|plugins\/read|mcp\/read))$/.test(route))return new Response(null,{status:403});
  calls.push(route);
  if(holdRoute===route){holdRoute=undefined;held=true;await new Promise<void>(resolve=>{release=resolve;});}
  if(fail)return Response.json({error:{message:'Controlled directory read outage'}},{status:503,headers:cors});
  const response=await fetch(ready.connection.origin+route,{method:'POST',headers:{Authorization:`Bearer ${ready.connection.token}`,'Content-Type':'application/json','X-Agent-Host-Id':ready.connection.hostId},body:JSON.stringify(input)});
  return new Response(await response.arrayBuffer(),{status:response.status,headers:{...cors,'Content-Type':'application/json'}});
 }});
 await writeFile(join(output,'index.html'),`<html><body><div id="root"></div><script type="module" src="${join(import.meta.dir,'directory-browser.tsx')}"></script></body></html>`);
 await build({configFile:false,root:output,plugins:[react(),tailwindcss()],base:'./',build:{outDir:join(output,'web'),rollupOptions:{input:join(output,'index.html')}}});
 await writeFile(join(output,'launch.json'),JSON.stringify({endpoint:`http://127.0.0.1:${proxy.port}/${capability}`,target:ready.target,secondTarget:ready.secondTarget,hostId:ready.connection.hostId,profile:join(root,'electron-profile')}));
 const electron=Bun.spawn([process.execPath,join(repo,'node_modules/electron/cli.js'),join(import.meta.dir,'directory-electron.cjs'),output],{stdout:Bun.file(join(output,'electron.log')),stderr:Bun.file(join(output,'electron-errors.log'))});
 const code=await electron.exited,result=await Bun.file(join(output,'result.json')).json();
 const response=await fetch(ready.connection.origin+'/v1/integrations/acquisition/operations',{method:'POST',headers:{Authorization:`Bearer ${ready.connection.token}`,'Content-Type':'application/json'},body:'{}'});
 result.receipts=await response.json();result.calls=calls;result.scope='Production directory/management components in hidden Electron, capability HTTP bridge to real isolated authenticated host/native OMP discovery. Two native acquisition mutations seed fixtures; directory actions are read-only. Native OS-window/main routing and full pixel parity unverified.';
 result.passed&&=code===0&&result.receipts.length===2;await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));if(!result.passed)throw new Error('Directory acceptance failed');console.log(JSON.stringify({passed:true,output}));
}finally{proxy?.stop(true);host.send({stop:true});await host.exited;await rm(root,{recursive:true,force:true});await rm(join(output,'launch.json'),{force:true});}
