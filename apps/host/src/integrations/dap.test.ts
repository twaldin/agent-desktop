import {expect,test} from 'bun:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
test('native DAP layers, guarded editor, authenticated worker and actual same-session DebugTool launch/attach',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-dap-fixture-')));
 try{const child=Bun.spawn([process.execPath,'--no-env-file',path.join(import.meta.dir,'fixtures/dap-settings.ts')],{cwd:path.resolve(import.meta.dir,'../../../..'),env:{HOME:root,PI_CODING_AGENT_DIR:path.join(root,'agent'),DAP_TEST_ROOT:root,PATH:'/usr/bin:/bin',TMPDIR:root,TERM:'dumb',PI_DISABLE_DOTENV:'1',AGENT_DESKTOP_NATIVE_TERMINALS:'0'},stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
 const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timer);if(code===0)console.log(stdout);expect({code,output:code?stdout+'\n'+stderr:''}).toEqual({code:0,output:''});expect(stdout).toContain('"nativeConsumer":true');
 }finally{await rm(root,{recursive:true,force:true});}
},90000);
