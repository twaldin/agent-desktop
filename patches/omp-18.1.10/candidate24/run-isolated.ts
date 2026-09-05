// Separate candidate24 experiment; candidate23 and installed source are immutable.
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,realpath,symlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const repository=path.resolve(import.meta.dir,'../../..'), parent=path.dirname(import.meta.dir);
const source=await realpath(path.join(repository,'node_modules/@oh-my-pi/pi-coding-agent'));
const baseline=JSON.parse(await readFile(path.join(parent,'baseline.json'),'utf8'));
const additionalBaseline=JSON.parse(await readFile(path.join(import.meta.dir,'baseline.json'),'utf8'));
Object.assign(baseline.files,additionalBaseline.files);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const checkOriginal=async()=>{for(const [file,digest] of Object.entries(baseline.files))assert.equal(hash(await readFile(path.join(source,file))),digest,`Original drift: ${file}`);};
await checkOriginal();
const candidate23=path.join(parent,'session-ownership-candidate.patch');
assert.equal(hash(await readFile(candidate23)),'abbb86cb3cd949b44046fd2e64bfa9c1c118c1f620e653b0c029e6e308051751');
const mode=process.argv[2]??'candidate24';assert(['candidate23','candidate24'].includes(mode));
const base=path.join(repository,'.data/temp/omp-ownership-native');await mkdir(base,{recursive:true});
const directory=await mkdtemp(path.join(base,mode==='candidate23'?'move-red-':'move-candidate24-'));
const packageRoot=path.join(directory,'package'), runRoot=path.join(directory,'run');
await cp(source,packageRoot,{recursive:true,errorOnExist:true,force:false});
await symlink(path.resolve(source,'../..'),path.join(packageRoot,'node_modules'));
const patches=[];
for(const patchPath of [candidate23,...(mode==='candidate24'?[path.join(import.meta.dir,'move-transaction.patch')]:[])]){
 const child=Bun.spawn(['/usr/bin/patch','--batch','--fuzz=0','-p1','-i',patchPath],{cwd:packageRoot,stdout:'pipe',stderr:'pipe'});
 const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 assert.equal(code,0,stderr);assert(!/offset|fuzz/i.test(stdout));patches.push({path:patchPath,sha256:hash(await readFile(patchPath)),stdout});
}
await mkdir(path.join(runRoot,'agent'),{recursive:true});
await writeFile(path.join(directory,'provenance.json'),JSON.stringify({mode,baseline,patches,packageRoot,checkedAt:new Date().toISOString()},null,2));
console.log(JSON.stringify({mode,directory,packageRoot}));
let failed=false;
for(const contract of [path.join(import.meta.dir,'move-contract.ts'),...(process.argv.includes('--full')?[path.join(parent,'ownership-contract.ts')]:[])]){
 const contractRoot=contract.endsWith('/ownership-contract.ts')?path.join(directory,'regression'):runRoot;
 await mkdir(path.join(contractRoot,'agent'),{recursive:true});
 const child=Bun.spawn([process.execPath,contract,contractRoot],{cwd:contractRoot,env:{HOME:contractRoot,PI_CODING_AGENT_DIR:path.join(contractRoot,'agent'),OWNERSHIP_NATIVE_PACKAGE:packageRoot,PATH:process.env.PATH,TMPDIR:contractRoot,TERM:'dumb',SHELL:'/bin/sh'},stdout:'inherit',stderr:'inherit'});
 if(await child.exited!==0)failed=true;
}
await checkOriginal();process.exitCode=failed?1:0;
