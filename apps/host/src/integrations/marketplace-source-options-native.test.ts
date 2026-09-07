import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
test('actual host and pinned worker preserve Git ref and literal sparse paths across restart/update',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'agent-desktop-source-options-'));
 try{
  const child=Bun.spawn([process.execPath,path.join(import.meta.dir,'fixtures/marketplace-source-options.ts'),root],{cwd:root,env:{HOME:root,PATH:process.env.PATH,TMPDIR:root,XDG_DATA_HOME:path.join(root,'xdg-data'),XDG_STATE_HOME:path.join(root,'xdg-state'),XDG_CACHE_HOME:path.join(root,'xdg-cache'),XDG_CONFIG_HOME:path.join(root,'xdg-config'),GIT_CONFIG_GLOBAL:path.join(root,'gitconfig'),GIT_CONFIG_NOSYSTEM:'1'},stdout:'pipe',stderr:'pipe'});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect({code,stderr:code?stderr:''}).toEqual({code:0,stderr:''});if(!stdout)throw new Error('Missing result; '+stderr);expect(JSON.parse(stdout)).toMatchObject({passed:true,nativeMutations:5,hostStarts:2,branchAndSha:true,sparseLiteralFiles:true});
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
