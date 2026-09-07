import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';

test('authenticated host uses the actual pinned discovery worker for durable marketplace acquisition',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'agent-desktop-acquisition-host-'));
 try{
  const child=Bun.spawn([process.execPath,path.join(import.meta.dir,'fixtures/acquisition-host.ts'),root],{
   cwd:root,env:{HOME:root,PATH:process.env.PATH,TMPDIR:root,XDG_DATA_HOME:path.join(root,'xdg-data'),XDG_CACHE_HOME:path.join(root,'xdg-cache'),XDG_CONFIG_HOME:path.join(root,'xdg-config'),XDG_STATE_HOME:path.join(root,'xdg-state'),PI_CODING_AGENT_DIR:path.join(root,'agent')},stdout:'pipe',stderr:'pipe',
  });
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,stderr:code?stderr:''}).toEqual({code:0,stderr:''});
  expect(stdout).toContain('"passed":true');expect(stdout).toContain('"nativeMutations":4');
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
