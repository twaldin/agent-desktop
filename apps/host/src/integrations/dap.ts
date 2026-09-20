import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { YAML } from 'bun';
import { withFileLock } from '@oh-my-pi/pi-utils/file-lock';
import { getConfigDirPaths } from '@oh-my-pi/pi-coding-agent/config';
import { inspectAdapterConfigs, type DapConfigInspection } from '@oh-my-pi/pi-coding-agent/dap/config';
import { listClaudePluginRoots } from '@oh-my-pi/pi-coding-agent/discovery/helpers';
import { clearCache } from '@oh-my-pi/pi-coding-agent/capability/fs';
import { dapAdapterFields, type DapValues, type NativeDapCatalog, type NativeDapMutation, type NativeDapSource, type SettingValueSchema } from '@agent-desktop/shared';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const safeKey = (key: string) => !['__proto__','constructor','prototype'].includes(key);
function safeTree(v: unknown, depth=0): boolean {
  return depth<=24 && (v===null || typeof v==='string' || typeof v==='boolean' || typeof v==='number'&&Number.isFinite(v) || Array.isArray(v)&&v.every(i=>safeTree(i,depth+1)) || object(v)&&Object.entries(v).every(([k,i])=>safeKey(k)&&safeTree(i,depth+1)));
}
function matches(v: unknown,s: SettingValueSchema): boolean {
  if (!safeTree(v)) return false;
  switch(s.kind) {
    case 'string': return typeof v==='string';
    case 'boolean': return typeof v==='boolean';
    case 'number': return typeof v==='number'&&Number.isFinite(v)&&(s.minimum===undefined||v>=s.minimum);
    case 'enum': return typeof v==='string'&&s.values.includes(v);
    case 'array': return Array.isArray(v)&&v.every(i=>matches(i,s.item));
    case 'map': return object(v)&&Object.values(v).every(i=>matches(i,s.value));
    // Native DAP retains unknown nested options; safeTree still checks their entire JSON value.
    case 'object': return object(v)&&Object.entries(v).every(([k,i])=>!Object.hasOwn(s.fields,k)||matches(i,s.fields[k]!.schema));
    case 'json': return true;
    default: return false;
  }
}
const serial = <T>(value: unknown): T => JSON.parse(JSON.stringify(value));
const id = (kind: string,file: string) => createHash('sha256').update(JSON.stringify([kind,file])).digest('hex');
async function canonical(file: string): Promise<string> {
  try { return await realpath(file); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; return path.join(await canonical(path.dirname(file)),path.basename(file)); }
}
async function identity(file: string) {
  try { const s=await lstat(file); return [s.dev,s.ino,s.birthtimeMs,s.mode,s.size,s.mtimeMs]; }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error; }
}
/** Reads and edits native configuration only. No adapters, debuggees or active sessions are started or reconfigured. */
export class NativeDap {
  private secret=randomBytes(32);
  private tail: Promise<unknown>=Promise.resolve();
  private ordered<T>(fn:()=>Promise<T>):Promise<T> { const result=this.tail.catch(()=>{}).then(fn); this.tail=result;return result; }
  private async inspect(cwd: string) {
    cwd=await realpath(cwd);
    // Refresh filesystem discovery, but never rebind the worker's preloaded roots or environment.
    clearCache();
    const plugins=await listClaudePluginRoots(os.homedir(),cwd,{cache:false});
    const native=inspectAdapterConfigs(cwd,plugins.roots);
    const sources: NativeDapSource[]=[], originals=new Map<string,DapConfigInspection['sources'][number]>();
    for(const source of native.sources) {
      const sourceId=id('file',source.path); if(originals.has(sourceId)) continue;
      originals.set(sourceId,source);
      const structure=source.document;
      const values=source.adapters ?? {};
      const valid=!source.error&&(structure===undefined||object(structure)&&safeTree(structure));
      const ownPath=source.scope!=='plugin'&&await canonical(source.path)===source.path;
      sources.push({id:sourceId,path:source.path,scope:source.scope,
        exists:source.content!==undefined||source.adapters!==undefined,writable:ownPath&&valid,
        error:source.error??(!valid?'Configuration has an unsupported structure. Repair it before saving.':undefined),
        adapters:serial(values),ignoredAdapters:source.ignoredAdapters??[]});
    }
    const names=new Set([...Object.keys(native.merged),...sources.flatMap(source=>Object.keys(source.adapters))]);
    const adapters=[...names].sort().map(name=>{
      const rows=sources.filter(source=>Object.hasOwn(source.adapters,name));
      const effective=serial<DapValues>(native.merged[name]??{});
      const fieldSources: Record<string,string>={};
      for(const [key,index] of Object.entries(native.fieldSources[name]??{})) { const source=index==='builtin'?undefined:native.sources[index]; fieldSources[key]=source?id('file',source.path):'builtin'; }
      const mapSource=(index:number|'builtin')=>index==='builtin'?'builtin':id('file',native.sources[index]!.path);
      const nativeDefaults=native.defaultSources[name]??{launchDefaults:{},attachDefaults:{}};
      return {name,builtin:Object.hasOwn(native.defaults,name),configured:rows.length>0,effective,sources:rows.map(s=>s.id),fieldSources,
        defaultSources:{launchDefaults:Object.fromEntries(Object.entries(nativeDefaults.launchDefaults).map(([key,index])=>[key,mapSource(index)])),attachDefaults:Object.fromEntries(Object.entries(nativeDefaults.attachDefaults).map(([key,index])=>[key,mapSource(index)]))},
        resolved:serial<DapValues|null>(native.resolved[name]??null),applicability:!native.merged[name]?'invalid' as const:native.resolved[name]?'ready' as const:'missing-command' as const};
    });
    const snapshot: NativeDapCatalog={revision:'',application:'next-launch-or-attach',sources,adapters,
      warnings:[...plugins.warnings,...sources.flatMap(s=>[...(s.error?[`${s.path}: ${s.error}`]:[]),...s.ignoredAdapters.map(name=>`${s.path}: native loader ignores invalid adapter override ${name}.`)])],
      overrideTargets:{project:id('file',path.join(cwd,'dap.json')),user:id('file',path.join(getConfigDirPaths('',{user:true,project:false})[0]!,'dap.json'))}};
    const fingerprints=await Promise.all(native.sources.map(async source=>[source.path,source.content,source.error,source.adapters,await identity(source.path)]));
    clearCache();
    const nextPlugins=await listClaudePluginRoots(os.homedir(),cwd,{cache:false});
    if(JSON.stringify(plugins)!==JSON.stringify(nextPlugins)) throw new Error("Plugin sources changed while reading. Reload configuration.");
    const again=inspectAdapterConfigs(cwd,nextPlugins.roots);
    if(JSON.stringify(native)!==JSON.stringify(again)) throw new Error('DAP configuration changed while reading. Reload it.');
    snapshot.revision=createHmac('sha256',this.secret).update(JSON.stringify([cwd,fingerprints,snapshot])).digest('hex');
    return {snapshot,originals,cwd,roots:plugins.roots};
  }
  read(cwd:string):Promise<NativeDapCatalog>{return this.ordered(async()=> (await this.inspect(cwd)).snapshot);}
  mutate(cwd:string,mutation:NativeDapMutation):Promise<NativeDapCatalog>{return this.ordered(async()=>{
    const observed=await this.inspect(cwd);
    if(observed.snapshot.revision!==mutation.expectedRevision) throw new Error('DAP configuration changed. Your draft is preserved; reload and review the original source.');
    const source=observed.snapshot.sources.find(source=>source.id===mutation.sourceId);
    if(!source?.writable) throw new Error('This DAP source is read only or malformed. Choose a local override source.');
    const original=observed.originals.get(source.id)!;
    await mkdir(path.dirname(source.path),{recursive:true,mode:0o700});
    return withFileLock(source.path,async()=>{
      const current=await this.inspect(cwd);
      if(current.snapshot.revision!==mutation.expectedRevision || await canonical(source.path)!==source.path) throw new Error('The original DAP source changed. Reload before saving.');
      const document=structuredClone(original.document??{adapters:{}}) as Record<string,unknown>;
      const nested=object(document.adapters), table=(nested?document.adapters:document) as Record<string,unknown>;
        if(!safeKey(mutation.name)||!mutation.name.trim()||mutation.name.length>200||mutation.name==='adapters'||mutation.name.includes('\0')) throw new Error('Invalid adapter name.');
        if(mutation.operation==='remove') {
          if(!Object.hasOwn(table,mutation.name)) throw new Error('The original override no longer exists.');
          delete table[mutation.name];
        } else {
          for(const [key,value] of Object.entries(mutation.changes)) {
            if(!Object.hasOwn(dapAdapterFields,key)||!matches(value,dapAdapterFields[key]!.schema)) throw new Error(`Invalid DAP field: ${key}`);
          }
          if(mutation.removeFields.some(key=>!Object.hasOwn(dapAdapterFields,key))) throw new Error('Only native editable fields can be removed.');
          if(Object.hasOwn(table,mutation.name)&&!object(table[mutation.name])) throw new Error('This adapter entry has an unsupported structure. Repair the original source before saving.');
          const next={...(table[mutation.name] as Record<string,unknown>??{}),...structuredClone(mutation.changes)};
          for(const key of mutation.removeFields) delete next[key];
          table[mutation.name]=next;
        }
      if(!safeTree(document)) throw new Error('Unsupported configuration structure.');
      const content=/\.ya?ml$/i.test(source.path)?YAML.stringify(document):JSON.stringify(document,null,2)+'\n';
      if(mutation.operation==='save') {
        const preflight=inspectAdapterConfigs(cwd,current.roots,{path:source.path,content});
        if(!preflight.merged[mutation.name]||preflight.sources.find(item=>item.path===source.path)?.ignoredAdapters?.includes(mutation.name)) throw new Error('This override is not a valid native adapter definition. Set a nonempty command or remove the override.');
      }
      if(Buffer.byteLength(content)>1024*1024) throw new Error('DAP configuration exceeds 1 MiB.');
      const temporary=await mkdtemp(path.join(path.dirname(source.path),'.agent-dap-'));
      try {
        const file=path.join(temporary,'config');
        const handle=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
        try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
        // Recheck all original sources immediately before atomic replacement.
        if((await this.inspect(cwd)).snapshot.revision!==mutation.expectedRevision || await canonical(source.path)!==source.path) throw new Error('DAP configuration changed before saving. Your draft is preserved.');
        await rename(file,source.path);
      } finally { await rm(temporary,{recursive:true,force:true}); }
      return (await this.inspect(cwd)).snapshot;
    });
  });}
}
