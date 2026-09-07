import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const repo=resolve(import.meta.dir,'../..'),output=resolve(process.argv[2]??`.data/mcp-authorization-ui-${Date.now()}`);
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw new Error('Output must be empty');
const root=await mkdtemp(join(tmpdir(),'agent-mcp-auth-ui-'));
let host:ReturnType<typeof Bun.spawn>|undefined,desktop:ReturnType<typeof Bun.spawn>|undefined;
try{
 const entry=join(output,'index.html');await writeFile(entry,`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${join(repo,'scripts/acceptance/mcp-authorization-browser.tsx')}"></script></body></html>`);
 await build({configFile:false,plugins:[react(),tailwindcss()],root:output,base:'./',build:{outDir:join(output,'web'),rollupOptions:{input:entry}}});
 const transportEntry=join(output,'transport.ts');await writeFile(transportEntry,`export * from ${JSON.stringify(join(repo,'apps/desktop/src/main/session-mcp-transport.ts'))};export * from ${JSON.stringify(join(repo,'apps/desktop/src/main/session-mcp-authorization-transport.ts'))};export * from ${JSON.stringify(join(repo,'apps/desktop/src/main/host-transport.ts'))};`);
 const built=await Bun.build({entrypoints:[transportEntry],target:'node',format:'cjs'});if(!built.success)throw new Error('Transport build failed');await writeFile(join(output,'transport.cjs'),await built.outputs[0]!.text());
 await writeFile(join(output,'preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',Object.fromEntries(['getSessionMcp','getSessionMcpAuthorization','respondSessionMcpAuthorization','cancelSessionMcpAuthorization','command','openExternal'].map(name=>[name,(...args)=>ipcRenderer.invoke('fixture',name,...args)])));`);
 host=Bun.spawn([process.execPath,join(repo,'apps/host/src/fixtures/mcp-authorization-route.ts'),root,process.argv[3]==='--conversation'?'--ui-slash':'--ui'],{cwd:root,env:{HOME:root,PI_CODING_AGENT_DIR:join(root,'agent'),MCP_CONTRACT_GATES:join(root,'gates'),PATH:process.env.PATH,SHELL:'/bin/sh',TMPDIR:tmpdir(),TERM:'dumb'},stdout:Bun.file(join(output,'host.log')),stderr:Bun.file(join(output,'host-error.log'))});
 for(let i=0;!await Bun.file(join(root,'ui-ready.json')).exists();i++){if(i>300||host.exitCode!==null)throw new Error('Native fixture failed readiness');await Bun.sleep(50);}
 desktop=Bun.spawn([process.execPath,join(repo,'node_modules/electron/cli.js'),join(repo,'scripts/acceptance/mcp-authorization-electron.cjs'),output,root],{stdout:Bun.file(join(output,'electron.log')),stderr:Bun.file(join(output,'electron-error.log'))});
 if(await desktop.exited!==0)throw new Error('Electron interaction failed');
 if(await host.exited!==0)throw new Error('Native authorization proof failed');
 await writeFile(join(output,'native-proof.json'),await readFile(join(root,'ui-proof.json')));
 console.log(JSON.stringify({passed:true,result:join(output,'result.json')}));
}finally{if(desktop&&desktop.exitCode===null){desktop.kill();await desktop.exited;}if(host&&host.exitCode===null){host.kill();await host.exited;}await rm(root,{recursive:true,force:true});}
