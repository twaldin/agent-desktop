import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const standalone=process.argv.includes('--plugin-standalone');
const skillDialogToggle=process.argv.includes('--skill-dialog-toggle');
const repo=resolve(import.meta.dir,'../..'),output=resolve(process.argv[2]??`.data/directory-ui-${Date.now()}`);
const sources=['apps/desktop/src/renderer/NativeIntegrations.tsx','apps/desktop/src/renderer/NativeSkillDialog.tsx','apps/desktop/src/renderer/native-skill-dialog.css','apps/desktop/src/renderer/NativePluginDirectory.tsx','apps/desktop/src/renderer/native-plugin-directory.css','apps/desktop/src/renderer/NativeSwitch.tsx','apps/desktop/src/renderer/native-switch.css','apps/desktop/src/renderer/theme.css','packages/shared/src/preferences.ts','scripts/acceptance/directory.ts','scripts/acceptance/directory-browser.tsx','scripts/acceptance/directory-electron.cjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(sources.map(async file=>[file,createHash('sha256').update(await readFile(join(repo,file))).digest('hex')])));
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw new Error('Output must be empty');
const root=await mkdtemp(join(tmpdir(),'agent-desktop-directory-ui-'));
const env={PLUGIN_STANDALONE_FIXTURE:standalone?'1':'0',HOME:root,PATH:process.env.PATH,TMPDIR:root,XDG_DATA_HOME:join(root,'xdg-data'),XDG_STATE_HOME:join(root,'xdg-state'),XDG_CONFIG_HOME:join(root,'xdg-config'),XDG_CACHE_HOME:join(root,'xdg-cache')};
const host=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/directory-host.ts'),root],{cwd:root,env,ipc:()=>{},stdout:Bun.file(join(output,'host.log')),stderr:Bun.file(join(output,'host-errors.log'))});
let proxy:ReturnType<typeof Bun.serve>|undefined;let eventsSocket:WebSocket|undefined;
try{
 for(let i=0;!(await Bun.file(join(root,'ready.json')).exists());i++){if(i>400||host.exitCode!==null)throw new Error('Host not ready');await Bun.sleep(50);}
 const ready=JSON.parse(await readFile(join(root,'ready.json'),'utf8'));
 const nativeEvents:any[]=[];const pendingEvents:any[]=[];
 eventsSocket=new WebSocket(ready.connection.origin.replace('http:','ws:')+'/v1/events',['agent-desktop',ready.connection.token]);
 eventsSocket.addEventListener('message',event=>{const value=JSON.parse(String(event.data));if(value.type==='settings'){const owned={...value,hostId:ready.connection.hostId};nativeEvents.push(owned);pendingEvents.push(owned);}});
 await new Promise<void>((resolve,reject)=>{eventsSocket!.addEventListener('open',()=>resolve(),{once:true});eventsSocket!.addEventListener('error',()=>reject(new Error('Native event stream unavailable')),{once:true});});
 const capability=crypto.randomUUID(),cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'};
 const calls:string[]=[];const mutationCalls:any[]=[];const externalOpenAttempts:string[]=[];let held=false,holdRoute:string|undefined,release:(()=>void)|undefined,fail=false;
 proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;if(!path.startsWith('/'+capability+'/'))return new Response(null,{status:404});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  const route=path.slice(capability.length+1),input=await request.json() as any;
  if(route==='/test/external-open'){externalOpenAttempts.push(input.url);return Response.json({recorded:true},{headers:cors});}
  if(route==='/test/events')return Response.json(pendingEvents.splice(0),{headers:cors});
  if(route==='/test/hold'){holdRoute=input.route;held=false;return Response.json({ok:true},{headers:cors});}
  if(route==='/test/release'){release?.();release=undefined;return Response.json({ok:true},{headers:cors});}
  if(route==='/test/fail'){fail=input.value;return Response.json({ok:true},{headers:cors});}
  if(route==='/test/state')return Response.json({held,calls},{headers:cors});
  if(route==='/v1/integrations/plugins/mutate'||route==='/v1/integrations/acquisition/start'){if(!standalone||input.target?.projectId!==ready.target.projectId)return new Response(null,{status:403});mutationCalls.push({route,mutation:input.mutation,request:input.request});}
  if(route==='/v5/commands'&&input.command?.type!=='draft.put')return new Response(null,{status:403});
  if(route==='/v1/settings/mutate'&&(input.mutation?.scope!=='project'||!['disabledExtensions','skills.enabled','skills.enableSkillCommands'].includes(input.mutation?.path)||input.target?.projectId!==ready.target.projectId))return new Response(null,{status:403});
  if(route!=='/v5/commands'&&!/^\/v1\/(settings\/(read|mutate)|composer\/(actions|skill-detail|skill-inventory)|integrations\/(acquisition\/(catalog|operations|start)|plugins\/(read|mutate)|mcp\/read))$/.test(route))return new Response(null,{status:403});
  calls.push(route);
  if(holdRoute===route){holdRoute=undefined;held=true;await new Promise<void>(resolve=>{release=resolve;});}
  if(fail)return Response.json({error:{message:'Controlled directory read outage'}},{status:503,headers:cors});
  const response=await fetch(ready.connection.origin+route,{method:'POST',headers:{Authorization:`Bearer ${ready.connection.token}`,'Content-Type':'application/json','X-Agent-Host-Id':ready.connection.hostId},body:JSON.stringify(input)});
  return new Response(await response.arrayBuffer(),{status:response.status,headers:{...cors,'Content-Type':'application/json'}});
 }});
 const sourceAtBuild=await hashes();await writeFile(join(output,'index.html'),`<html><body><div id="root"></div><script type="module" src="${join(import.meta.dir,'directory-browser.tsx')}"></script></body></html>`);
 await build({configFile:false,root:output,plugins:[react(),tailwindcss()],base:'./',build:{outDir:join(output,'web'),rollupOptions:{input:join(output,'index.html')}}});
 await writeFile(join(output,'launch.json'),JSON.stringify({endpoint:`http://127.0.0.1:${proxy.port}/${capability}`,draft:ready.draft,target:ready.target,secondTarget:ready.secondTarget,hostId:ready.connection.hostId,profile:join(root,'electron-profile'),skillDialogToggle}));
 const electron=Bun.spawn([process.execPath,join(repo,'node_modules/electron/cli.js'),join(import.meta.dir,standalone?'plugin-standalone-electron.cjs':'directory-electron.cjs'),output],{stdout:Bun.file(join(output,'electron.log')),stderr:Bun.file(join(output,'electron-errors.log'))});
 const code=await electron.exited,result=await Bun.file(join(output,'result.json')).json();
 const response=await fetch(ready.connection.origin+'/v1/integrations/acquisition/operations',{method:'POST',headers:{Authorization:`Bearer ${ready.connection.token}`,'Content-Type':'application/json'},body:'{}'});
 result.receipts=await response.json();result.externalOpenAttempts=externalOpenAttempts;result.calls=calls;result.mutationCalls=mutationCalls;result.nativeSettingsEvents=nativeEvents;result.nativeProjectSettings=Bun.YAML.parse(await readFile(join(root,'project/.omp/config.yml'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}));result.userSettingsUnchanged=(await readFile(join(root,'agent/config.yml'),'utf8'))==='extensions: []\ndisabledExtensions:\n  - skill:unrelated\n';result.passed&&=result.userSettingsUnchanged;const stateResponse=await fetch(ready.connection.origin+'/v1/state',{headers:{Authorization:`Bearer ${ready.connection.token}`}});if(!stateResponse.ok)throw new Error('Final state read failed');const finalState=await stateResponse.json() as any;result.finalDrafts=finalState.drafts;result.sessionCount=finalState.sessions.length;const finalDraft=finalState.drafts.find((draft:any)=>draft.id==='new-conversation');const draftChanged=!standalone&&!skillDialogToggle;result.draftPersisted=finalDraft?.text===(draftChanged?'/skill:directory-skill EXISTING_UNSENT_SKILL_DRAFT':'EXISTING_UNSENT_SKILL_DRAFT')&&finalDraft?.projectId===ready.target.projectId&&finalDraft?.model===null&&finalDraft?.revision===(draftChanged?2:1);result.passed&&=result.sessionCount===0&&result.draftPersisted;result.scope='Production directory/management components in hidden Electron, capability HTTP bridge to real isolated authenticated host/native OMP discovery. Two native acquisition mutations and an initial draft seed fixtures. Directory reads remain read-only; Try sends only a draft.put through the real DraftController, with zero sessions verified afterward. Skill-management UI uses only project-scope native settings CAS against its temporary project. Native OS-window/main routing and full pixel parity unverified.';
 if(standalone)result.scope='Standalone directory/detail production components, real isolated authenticated host/OMP worker, hidden Electron. Native fixture seeds marketplace add/install/update and draft. UI upgrade/uninstall, cached offline detail and owner/focus behavior tested; no session/provider, installed main/preload, OS-window or pixel-parity claim.';
 if(skillDialogToggle)result.scope='Production skill directory and skill dialog in hidden Electron against the real isolated authenticated host/native OMP discovery and project settings writer. Four successful project-scope disabledExtensions writes plus one controlled transport failure exercise dialog-native off/on, close-pending and controlled project-owner fencing. The pre-existing user disable remains unchanged; no draft send, session, provider, installed profile, main/preload, OS-window or pixel-parity claim.';
 const sourceAfterBuild=await hashes();result.sourceAtBuild=sourceAtBuild;result.sourceAfterBuild=sourceAfterBuild;result.sourceHashesStable=JSON.stringify(sourceAtBuild)===JSON.stringify(sourceAfterBuild);result.passed&&=result.sourceHashesStable;
 if(skillDialogToggle){const settingAttempts=calls.filter(route=>route==='/v1/settings/mutate').length,ownedEvents=nativeEvents.filter(event=>event.scope==='project'&&event.target?.projectId===ready.target.projectId);result.skillDialogNativeWrites=ownedEvents.length;result.skillDialogSettingAttempts=settingAttempts;result.passed&&=ownedEvents.length===4&&settingAttempts===5&&JSON.stringify(result.nativeProjectSettings.disabledExtensions)===JSON.stringify(['skill:unrelated']);}
 result.passed&&=code===0&&result.receipts.length===(standalone?5:2);await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));if(!result.passed)throw new Error('Directory acceptance failed');console.log(JSON.stringify({passed:true,output}));
}finally{eventsSocket?.close();proxy?.stop(true);if(host.exitCode===null){try{host.send({stop:true});}catch{}}await host.exited;await rm(root,{recursive:true,force:true});await rm(join(output,'launch.json'),{force:true});}
