import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('native SSH catalog uses the pinned SDK without touching personal configuration or SSH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-desktop-ssh-native-'));
  try {
    const script = `
import assert from 'node:assert/strict';
import {mkdir,readFile,stat,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.env.SSH_TEST_ROOT; const cwd=path.join(root,'project');
try {
await mkdir(path.join(cwd,'.git'),{recursive:true});
const {getSSHConfigPath}=await import('@oh-my-pi/pi-utils');
const {NativeSsh}=await import(${JSON.stringify(path.join(import.meta.dir, 'ssh.ts'))});
const user=getSSHConfigPath('user',cwd), project=getSSHConfigPath('project',cwd);
const put=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));};
await put(user,{preserved:{user:true},hosts:{shared:{host:'user.invalid'},user:{host:'user.invalid',key:'legacy-key'}}});
await put(project,{opaque:{nested:true},hosts:{shared:{host:'project.invalid',username:'project',port:2222,keyPath:'~/.ssh/key',description:'raw',compat:true,unknownHostField:{kept:true}},project:{host:'project-only.invalid'}}});
await put(path.join(cwd,'ssh.json'),{hosts:{shared:{host:'legacy.invalid'},legacy:{host:'legacy-only.invalid',port:'2201',compat:'yes'}}});
const native=new NativeSsh(), first=await native.read(cwd);
assert.equal(first.hosts.filter(row=>row.name==='shared').length,3); assert.equal(first.hosts.filter(row=>row.name==='shared'&&row.shadowed).length,2);
assert.deepEqual(first.warnings,[]);
const projectRow=first.hosts.find(row=>row.name==='shared'&&row.scope==='project'&&!row.shadowed); const legacy=first.hosts.find(row=>row.name==='legacy');
assert.ok(projectRow&&legacy); assert.equal(legacy.editable,false);
const detail=await native.detail(cwd,{hostId:projectRow.id,expectedRevision:first.revision}); assert.equal(detail.config.keyPath,'~/.ssh/key'); assert.equal(detail.config.host,'project.invalid'); assert.deepEqual(detail.config.unknownHostField,{kept:true});
const legacyPath=path.join(cwd,'ssh.json'), legacyBytes=await readFile(legacyPath,'utf8'); const legacyDetail=await native.detail(cwd,{hostId:legacy.id,expectedRevision:first.revision}); assert.equal(legacyDetail.host.editable,false); assert.equal(legacyDetail.config.port,'2201'); assert.equal(legacyDetail.config.compat,'yes');
await assert.rejects(native.mutate(cwd,{operation:'remove',hostId:legacy.id,expectedRevision:first.revision}),/owned by another/); assert.equal(await readFile(legacyPath,'utf8'),legacyBytes);
const added=await native.mutate(cwd,{operation:'add',scope:'user',name:'added',config:{host:'added.invalid',port:2223,compat:false},expectedRevision:first.revision});
assert.equal(JSON.parse(await readFile(user,'utf8')).preserved.user,true); assert.equal((await stat(user)).mode&0o777,0o600); assert.ok(added.hosts.some(row=>row.name==='added'));
await assert.rejects(native.mutate(cwd,{operation:'add',scope:'user',name:'bad/name',config:{host:'x'},expectedRevision:added.revision}),/valid/);
await assert.rejects(native.mutate(cwd,{operation:'add',scope:'user',name:'bad-port',config:{host:'x',port:'22'},expectedRevision:added.revision}),/valid/);
await assert.rejects(native.mutate(cwd,{operation:'add',scope:'user',name:'bad-target',config:{host:'x\\ninvalid'},expectedRevision:added.revision}),/valid/);
const changed=await native.mutate(cwd,{operation:'update',hostId:projectRow.id,config:{host:'project.invalid',description:'changed'},expectedRevision:added.revision}); const saved=JSON.parse(await readFile(project,'utf8')).hosts.shared; assert.deepEqual(saved.unknownHostField,{kept:true}); assert.equal(saved.username,undefined);
await writeFile(project,'{broken'); const malformed=await native.read(cwd); assert.ok(malformed.warnings.some(message=>message.includes('not valid JSON')));
const stale=added.revision; await writeFile(project,JSON.stringify({hosts:{project:{host:'changed.invalid'}}})); await assert.rejects(native.mutate(cwd,{operation:'add',scope:'user',name:'stale',config:{host:'x'},expectedRevision:stale}),/changed/);
const fresh=await native.read(cwd); const outside=path.join(root,'foreign'); await symlink(outside,user+'.tmp');
await assert.rejects(native.mutate(cwd,{operation:'add',scope:'user',name:'unsafe',config:{host:'x',nested:{constructor:'bad'}},expectedRevision:fresh.revision}),/valid/);
const contender=new NativeSsh(), contenderRevision=(await contender.read(cwd)).revision;
const races=await Promise.allSettled([native.mutate(cwd,{operation:'add',scope:'user',name:'race-a',config:{host:'a.invalid'},expectedRevision:fresh.revision}),contender.mutate(cwd,{operation:'add',scope:'user',name:'race-b',config:{host:'b.invalid'},expectedRevision:contenderRevision})]); assert.equal(races.filter(result=>result.status==='fulfilled').length,1); assert.equal(await Bun.file(outside).exists(),false);
const nearValue={padding:'x'.repeat(1024*1024-40),hosts:{}}; const nearBytes=JSON.stringify(nearValue); assert.ok(Buffer.byteLength(nearBytes)<=1024*1024); await writeFile(user,nearBytes); const nearCatalog=await native.read(cwd); await assert.rejects(native.mutate(cwd,{operation:'add',scope:'user',name:'too-large',config:{host:'large.invalid'},expectedRevision:nearCatalog.revision}),/exceed 1 MiB/); assert.equal(await readFile(user,'utf8'),nearBytes);
assert.ok(changed.hosts.some(row=>row.name==='shared'));
console.log(JSON.stringify({passed:true,hosts:first.hosts.length,rawConfig:true,unknownFieldsPreserved:true,shadowed:true,readonlyLegacy:true,malformedWarning:true,staleCas:true,tmpNoFollow:true,sameRevisionOneCommit:true}));
} catch(error) { await writeFile(path.join(root,'failure.txt'),String(error?.stack??error)); process.exitCode=1; }
`;
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], { cwd: path.resolve(import.meta.dir, '../../../..'), stdout: 'pipe', stderr: 'pipe', env: { HOME: root, PI_CODING_AGENT_DIR: path.join(root, 'agent'), SSH_TEST_ROOT: root, PATH: path.join(root, 'bin'), TMPDIR: root, TERM: 'dumb' } });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const failure = await readFile(path.join(root, 'failure.txt'), 'utf8').catch(() => '');
    expect({ code, stderr: code ? `${stderr}\n${stdout}\n${failure}` : '' }, `${stderr}\n${stdout}\n${failure}`).toEqual({ code: 0, stderr: '' });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
