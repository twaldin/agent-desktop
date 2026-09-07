import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const repo=resolve(import.meta.dir,'../..'),output=resolve(process.argv[2]??`.data/notification-settings-${Date.now()}`);
await mkdir(output,{recursive:true,mode:0o700});if((await readdir(output)).length)throw Error('Output must be empty');
const root=await mkdtemp(join(tmpdir(),'agent-notification-settings-'));
const host=Bun.spawn([process.execPath,join(import.meta.dir,'notification-settings-host.ts'),root],{cwd:root,
 env:{HOME:root,PATH:process.env.PATH,TMPDIR:root,PI_CODING_AGENT_DIR:join(root,'agent'),PI_DISABLE_DOTENV:'1',TERM:'dumb',XDG_CONFIG_HOME:join(root,'config'),XDG_STATE_HOME:join(root,'state'),XDG_DATA_HOME:join(root,'data-home'),XDG_CACHE_HOME:join(root,'cache')},
 ipc:()=>{},stdout:Bun.file(join(output,'host.log')),stderr:Bun.file(join(output,'host-errors.log'))});
let proxy:ReturnType<typeof Bun.serve>|undefined;
const sources=['packages/shared/src/preferences.ts','apps/desktop/src/renderer/GeneralSettings.tsx','apps/desktop/src/renderer/general-settings.css','apps/desktop/src/renderer/theme.css','apps/desktop/src/renderer/SettingsSidebar.tsx','apps/desktop/src/renderer/preferences-state.ts'];
const hashes=async()=>Object.fromEntries(await Promise.all(sources.map(async p=>[p,createHash('sha256').update(await readFile(join(repo,p))).digest('hex')])));
try{
 for(let i=0;!await Bun.file(join(root,'ready.json')).exists();i++){if(i>700||host.exitCode!==null)throw Error('Host readiness failed');await Bun.sleep(50);}
 const connection=JSON.parse(await readFile(join(root,'ready.json'),'utf8'));
 const capability=crypto.randomUUID(),headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'};
 const writes:unknown[]=[];
 proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const path=new URL(request.url).pathname;if(!path.startsWith(`/${capability}/`))return new Response(null,{status:404});if(request.method==='OPTIONS')return new Response(null,{status:204,headers});const route=path.slice(capability.length+1),input=await request.json() as any;
 if(route!=='/preferences'&&route!=='/command'||route==='/command'&&input.command?.type!=='preferences.put')return new Response(null,{status:403,headers});
 if(route==='/command')writes.push(input);
 const response=await fetch(connection.origin+(route==='/preferences'?'/v1/preferences':'/v1/commands'),{method:route==='/preferences'?'GET':'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json','X-Agent-Host-Id':connection.hostId},...(route==='/command'?{body:JSON.stringify(input)}:{})});return new Response(await response.arrayBuffer(),{status:response.status,headers:{...headers,'Content-Type':'application/json'}});}});
 const before=await hashes();
 await writeFile(join(output,'index.html'),`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="${relative(output,join(import.meta.dir,'notification-settings-browser.tsx'))}"></script>`);
 await build({configFile:false,root:output,plugins:[react(),tailwindcss()],base:'./',build:{outDir:join(output,'web'),rollupOptions:{input:join(output,'index.html')}}});
 await writeFile(join(output,'launch.json'),JSON.stringify({endpoint:`http://127.0.0.1:${proxy.port}/${capability}`,hostId:connection.hostId,profile:join(root,'electron-profile')}),{mode:0o600});
 const electron=Bun.spawn([process.execPath,join(repo,'node_modules/electron/cli.js'),join(import.meta.dir,'notification-settings-electron.cjs'),output],{stdout:Bun.file(join(output,'electron.log')),stderr:Bun.file(join(output,'electron-errors.log'))});
 const timer=setTimeout(()=>electron.kill('SIGTERM'),90000),code=await electron.exited;clearTimeout(timer);
 const result=JSON.parse(await readFile(join(output,'result.json'),'utf8'));
 const response=await fetch(connection.origin+'/v1/state',{headers:{Authorization:`Bearer ${connection.token}`}}),state=await response.json() as any;
 const after=await hashes();Object.assign(result,{writes,sessionCount:state.sessions.length,sourceBefore:before,sourceAfter:after,sourceStable:JSON.stringify(before)===JSON.stringify(after)});
 result.passed&&=code===0&&result.sourceStable&&state.sessions.length===0&&writes.length===4;
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks,output}));if(!result.passed)process.exitCode=1;
}finally{proxy?.stop(true);if(host.exitCode===null){host.send('stop');await Promise.race([host.exited,Bun.sleep(5000)]);if(host.exitCode===null)host.kill('SIGTERM');}await rm(root,{recursive:true,force:true});}
