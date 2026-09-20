import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { YAML } from 'bun';
import { withFileLock } from '@oh-my-pi/pi-utils/file-lock';
import { getConfigDirPaths } from '@oh-my-pi/pi-coding-agent/config';
import { inspectConfig, type LspConfigInspection } from '@oh-my-pi/pi-coding-agent/lsp/config';
import { listClaudePluginRoots } from '@oh-my-pi/pi-coding-agent/discovery/helpers';
import { clearCache } from '@oh-my-pi/pi-coding-agent/capability/fs';
import { lspServerFields, type LspValues, type NativeLspCatalog, type NativeLspMutation, type NativeLspSource, type SettingValueSchema } from '@agent-desktop/shared';
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
    case 'array': return Array.isArray(v)&&v.every(i=>matches(i,s.item));
    case 'map': return object(v)&&Object.values(v).every(i=>matches(i,s.value));
    // Native LSP retains unknown nested options; safeTree still checks their entire JSON value.
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
/** Reads and edits native configuration only. No clients, processes or sessions are reconfigured. */
export class NativeLsp {
  private secret=randomBytes(32);
  private tail: Promise<unknown>=Promise.resolve();
  private ordered<T>(fn:()=>Promise<T>):Promise<T> { const result=this.tail.catch(()=>{}).then(fn); this.tail=result;return result; }
  private async inspect(cwd: string) {
    cwd=await realpath(cwd);
    // Refresh filesystem discovery, but never rebind the worker's preloaded roots or environment.
    clearCache();
    const plugins=await listClaudePluginRoots(os.homedir(),cwd,{cache:false});
    const native=inspectConfig(cwd,plugins.roots);
    const sources: NativeLspSource[]=[], originals=new Map<string,LspConfigInspection['sources'][number]>();
    for(const source of native.sources) {
      const sourceId=id(source.kind,source.path); if(originals.has(sourceId)) continue;
      originals.set(sourceId,source);
      const structure=source.document;
      const values=source.servers ?? {};
      const valid=!source.error&&(structure===undefined||object(structure)&&safeTree(structure))&&Object.values(values).every(v=>object(v)&&safeTree(v));
      const ownPath=source.kind==='file'&&source.scope!=='plugin'&&await canonical(source.path)===source.path;
      sources.push({id:sourceId,path:source.path,kind:source.kind,scope:source.scope,
        exists:source.content!==undefined||source.servers!==undefined,writable:ownPath&&valid,
        error:source.error??(!valid?'Configuration has an unsupported structure. Repair it before saving.':undefined),
        servers:serial(values),idleTimeoutMs:source.idleTimeoutMs});
    }
    const names=new Set([...Object.keys(native.merged),...sources.flatMap(source=>Object.keys(source.servers))]);
    const servers=[...names].sort().map(name=>{
      const rows=sources.filter(source=>Object.hasOwn(source.servers,name));
      const effective=serial<LspValues>(native.merged[name]??{});
      const fieldSources: Record<string,string>={};
      for(const [key,index] of Object.entries(native.fieldSources[name]??{})) { const source=index==='builtin'?undefined:native.sources[index]; fieldSources[key]=source?id(source.kind,source.path):'builtin'; }
      return {name,builtin:Object.hasOwn(native.defaults,name),configured:rows.length>0,effective,sources:rows.map(s=>s.id),fieldSources,
        ...(native.status[name]??{applicability:'invalid' as const,rootMarkersMatch:false,resolvedCommand:null}),
        runtimeClient:name==='biome'?'Biome' as const:name==='swiftlint'?'SwiftLint' as const:undefined,
        runtimePidArguments:name==='omnisharp'&&Array.isArray(effective.args)&&effective.args.includes('$PID')};
    });
    const snapshot: NativeLspCatalog={revision:'',application:'new-sessions',sources,servers,idleTimeoutMs:native.effective.idleTimeoutMs,
      idleTimeoutSource:sources.find(source=>source.idleTimeoutMs!==undefined)?.id,
      warnings:[...plugins.warnings,...sources.filter(s=>s.error).map(s=>`${s.path}: ${s.error}`)],
      overrideTargets:{project:id('file',path.join(cwd,'lsp.json')),user:id('file',path.join(getConfigDirPaths('',{user:true,project:false})[0]!,'lsp.json'))}};
    const fingerprints=await Promise.all(native.sources.map(async source=>[source.kind,source.path,source.content,source.error,source.servers,source.kind==='file'?await identity(source.path):null]));
    clearCache();
    const nextPlugins=await listClaudePluginRoots(os.homedir(),cwd,{cache:false});
    if(JSON.stringify(plugins)!==JSON.stringify(nextPlugins)) throw new Error("Plugin sources changed while reading. Reload configuration.");
    const again=inspectConfig(cwd,nextPlugins.roots);
    if(JSON.stringify(native)!==JSON.stringify(again)) throw new Error('LSP configuration changed while reading. Reload it.');
    snapshot.revision=createHmac('sha256',this.secret).update(JSON.stringify([cwd,fingerprints,snapshot])).digest('hex');
    return {snapshot,originals,cwd,roots:plugins.roots};
  }
  read(cwd:string):Promise<NativeLspCatalog>{return this.ordered(async()=> (await this.inspect(cwd)).snapshot);}
  mutate(cwd:string,mutation:NativeLspMutation):Promise<NativeLspCatalog>{return this.ordered(async()=>{
    const observed=await this.inspect(cwd);
    if(observed.snapshot.revision!==mutation.expectedRevision) throw new Error('LSP configuration changed. Your draft is preserved; reload and review the original source.');
    const source=observed.snapshot.sources.find(source=>source.id===mutation.sourceId);
    if(!source?.writable) throw new Error('This LSP source is read only or malformed. Choose a local override source.');
    const original=observed.originals.get(source.id)!;
    await mkdir(path.dirname(source.path),{recursive:true,mode:0o700});
    return withFileLock(source.path,async()=>{
      const current=await this.inspect(cwd);
      if(current.snapshot.revision!==mutation.expectedRevision || await canonical(source.path)!==source.path) throw new Error('The original LSP source changed. Reload before saving.');
      const document=structuredClone(original.document??{servers:{}}) as Record<string,unknown>;
      const nested=object(document.servers), table=(nested?document.servers:document) as Record<string,unknown>;
      if(mutation.operation==='idle-timeout') {
        if(mutation.value===null) delete document.idleTimeoutMs;
        else { if(!Number.isFinite(mutation.value)||mutation.value<0) throw new Error('Idle timeout must be nonnegative.'); document.idleTimeoutMs=mutation.value; }
      } else {
        if(!safeKey(mutation.name)||!mutation.name.trim()||mutation.name.length>200||mutation.name==='idleTimeoutMs'||mutation.name==='servers'||mutation.name.includes('\0')) throw new Error('Invalid server name.');
        if(mutation.operation==='remove') {
          if(!Object.hasOwn(table,mutation.name)) throw new Error('The original override no longer exists.');
          delete table[mutation.name];
        } else {
          for(const [key,value] of Object.entries(mutation.changes)) {
            if(!Object.hasOwn(lspServerFields,key)||!matches(value,lspServerFields[key]!.schema)) throw new Error(`Invalid LSP field: ${key}`);
          }
          if(mutation.removeFields.some(key=>!Object.hasOwn(lspServerFields,key))) throw new Error('Only native editable fields can be removed.');
          const next={...(table[mutation.name] as Record<string,unknown>??{}),...structuredClone(mutation.changes)};
          for(const key of mutation.removeFields) delete next[key];
          const fallback=observed.snapshot.servers.find(server=>server.name===mutation.name)?.effective??{};
          const candidate={...fallback,...next};
          if(typeof candidate.command!=='string'||!candidate.command.trim()||!(Array.isArray(candidate.fileTypes)&&candidate.fileTypes.length||object(candidate.extensionToLanguage)&&Object.keys(candidate.extensionToLanguage).length)||!(Array.isArray(candidate.rootMarkers)&&candidate.rootMarkers.length||object(candidate.extensionToLanguage))) throw new Error('A server needs a command, file types and root markers (or native extension alias).');
          table[mutation.name]=next;
        }
      }
      if(!safeTree(document)) throw new Error('Unsupported configuration structure.');
      const content=/\.ya?ml$/i.test(source.path)?YAML.stringify(document):JSON.stringify(document,null,2)+'\n';
      if(mutation.operation==='save'&&!inspectConfig(cwd,current.roots,{path:source.path,content}).merged[mutation.name]) throw new Error('Removing these fields leaves no valid native server definition. Remove the override instead.');
      if(Buffer.byteLength(content)>1024*1024) throw new Error('LSP configuration exceeds 1 MiB.');
      const temporary=await mkdtemp(path.join(path.dirname(source.path),'.agent-lsp-'));
      try {
        const file=path.join(temporary,'config');
        const handle=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
        try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
        // Recheck all original sources immediately before atomic replacement.
        if((await this.inspect(cwd)).snapshot.revision!==mutation.expectedRevision || await canonical(source.path)!==source.path) throw new Error('LSP configuration changed before saving. Your draft is preserved.');
        await rename(file,source.path);
      } finally { await rm(temporary,{recursive:true,force:true}); }
      return (await this.inspect(cwd)).snapshot;
    });
  });}
}
