import {expect,test} from 'bun:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('LSP native layers, structured writes, aliases, applicability and authenticated discovery worker',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-lsp-fixture-')));
 try{const process=Bun.spawn([globalThis.process.execPath,'--no-env-file',path.join(import.meta.dir,'fixtures/lsp-settings.ts')],{cwd:path.resolve(import.meta.dir,'../../../..'),env:{HOME:root,PI_CODING_AGENT_DIR:path.join(root,'agent'),LSP_TEST_ROOT:root,PATH:'/usr/bin:/bin',TMPDIR:root,TERM:'dumb',PI_DISABLE_DOTENV:'1',AGENT_DESKTOP_NATIVE_TERMINALS:'0'},stdout:'pipe',stderr:'pipe'});
 const [code,stdout,stderr]=await Promise.all([process.exited,new Response(process.stdout).text(),new Response(process.stderr).text()]);expect({code,output:code?stdout+'\n'+stderr:''}).toEqual({code:0,output:''});expect(stdout).toContain('"nativeOracle":true');
 }finally{await rm(root,{recursive:true,force:true});}
},90000);
