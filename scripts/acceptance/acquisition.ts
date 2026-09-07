import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const repo=resolve(import.meta.dir,'../..'),output=resolve(process.argv[2]??`.data/acquisition-ui-${Date.now()}`);
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw new Error('Output must be empty');
const root=await mkdtemp(join(tmpdir(),'agent-desktop-acquisition-ui-'));
const env={HOME:root,PATH:process.env.PATH,TMPDIR:root,XDG_DATA_HOME:join(root,'xdg-data'),XDG_STATE_HOME:join(root,'xdg-state'),XDG_CONFIG_HOME:join(root,'xdg-config'),XDG_CACHE_HOME:join(root,'xdg-cache')};
const host=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/acquisition-host.ts'),root],{cwd:root,env,ipc:()=>{},stdout:Bun.file(join(output,'host.log')),stderr:Bun.file(join(output,'host-errors.log'))});
let proxy:ReturnType<typeof Bun.serve>|undefined;
try{
 for(let i=0;!(await Bun.file(join(root,'ready.json')).exists());i++){if(i>200||host.exitCode!==null)throw new Error('Host not ready');await Bun.sleep(50);}
 const ready=JSON.parse(await readFile(join(root,'ready.json'),'utf8'));
 const capability=crypto.randomUUID(),cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'};
 const calls:Array<{route:string;operation?:string;id?:string}>=[];let lose=false,hold=false,held=false,failStatus=false;const gate=Promise.withResolvers<void>();
 proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;if(!path.startsWith('/'+capability+'/'))return new Response(null,{status:404});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  const route=path.slice(capability.length+1);const input=await request.json() as any;
  if(route==='/test/fail-status'){failStatus=true;return Response.json({ok:true},{headers:cors});}
  if(route==='/test/lose'){lose=true;return Response.json({ok:true},{headers:cors});}
  if(route==='/test/hold'){hold=true;return Response.json({ok:true},{headers:cors});}
  if(route==='/test/release'){gate.resolve();return Response.json({ok:true},{headers:cors});}
  if(route==='/test/state')return Response.json({calls,held,market:ready.market},{headers:cors});
  if(!/^\/v1\/integrations\/(acquisition\/(catalog|start|operations|review|close-request)|plugins\/read|mcp\/read)$/.test(route))return new Response(null,{status:403});
  if(route.endsWith('/operations')&&failStatus){failStatus=false;return Response.json({error:'Read outage fixture'},{status:503,headers:cors});}
  calls.push({route,operation:input.request?.action?.operation??input.operation,id:input.request?.id??input.id});
  if(route.endsWith('/start')&&hold){hold=false;held=true;await gate.promise;}
  const response=await fetch(ready.connection.origin+route,{method:'POST',headers:{Authorization:`Bearer ${ready.connection.token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
  if(route.endsWith('/start')&&lose){lose=false;return Response.json({error:'Lost acknowledgement fixture'},{status:503,headers:cors});}
  return new Response(await response.arrayBuffer(),{status:response.status,headers:{...cors,'Content-Type':'application/json'}});
 }});
 await writeFile(join(output,'index.html'),`<html><body><div id="root"></div><script type="module" src="${join(import.meta.dir,'acquisition-browser.tsx')}"></script></body></html>`);
 await build({configFile:false,root:output,plugins:[react(),tailwindcss()],base:'./',build:{outDir:join(output,'web'),rollupOptions:{input:join(output,'index.html')}}});
 await writeFile(join(output,'launch.json'),JSON.stringify({endpoint:`http://127.0.0.1:${proxy.port}/${capability}`,target:ready.target,profile:join(root,'electron-profile')}));
 const electron=Bun.spawn([process.execPath,join(repo,'node_modules/electron/cli.js'),join(import.meta.dir,'acquisition-electron.cjs'),output],{stdout:Bun.file(join(output,'electron.log')),stderr:Bun.file(join(output,'electron-errors.log'))});
 const code=await electron.exited;
 const result=await Bun.file(join(output,'result.json')).json();
 const response=await fetch(ready.connection.origin+'/v1/integrations/acquisition/operations',{method:'POST',headers:{Authorization:`Bearer ${ready.connection.token}`,'Content-Type':'application/json'},body:'{}'});
 result.receipts=await response.json();result.calls=calls;result.scope='Production UI in hidden Electron with capability HTTP bridge to real isolated authenticated host and OMP worker. Full main IPC/native OS-window/matched pixel parity unverified.';
 result.passed&&=code===0;await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));if(!result.passed)throw new Error('UI acceptance failed');console.log(JSON.stringify({passed:true,output}));
}finally{proxy?.stop(true);host.send({stop:true});await host.exited;await rm(root,{recursive:true,force:true});await rm(join(output,'launch.json'),{force:true});}
