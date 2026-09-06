import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { getMCPConfigPath } from '@oh-my-pi/pi-utils';
import { withFileLock } from '@oh-my-pi/pi-utils/file-lock';
import { loadCapability } from '@oh-my-pi/pi-coding-agent/discovery';
import { mcpCapability, type MCPServer } from '@oh-my-pi/pi-coding-agent/capability/mcp';
import { clearCache } from '@oh-my-pi/pi-coding-agent/capability/fs';
import { validateServerConfig } from '@oh-my-pi/pi-coding-agent/mcp/config';
import { writeMCPConfigFile, validateServerName } from '@oh-my-pi/pi-coding-agent/mcp/config-writer';
import type { MCPConfigFile, MCPServerConfig } from '@oh-my-pi/pi-coding-agent/mcp/types';
import type { NativeMcpCatalog, NativeMcpMutation, NativeMcpServer } from '@agent-desktop/shared';

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const validKeys = (v: Record<string, unknown>) => !Object.keys(v).some(k => ['__proto__','constructor','prototype'].includes(k));
function safeTree(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (Array.isArray(value)) return value.every(item => safeTree(item, depth + 1));
  return !object(value) || validKeys(value) && Object.values(value).every(item => safeTree(item, depth + 1));
}
function validServer(name: string, value: unknown): value is MCPServerConfig {
  if (!object(value) || !safeTree(value) || validateServerName(name)) return false;
  if (value.command !== undefined && typeof value.command !== 'string' || value.url !== undefined && typeof value.url !== 'string' || value.enabled !== undefined && typeof value.enabled !== 'boolean') return false;
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some(item => typeof item !== 'string'))) return false;
  for (const key of ['env', 'headers']) if (value[key] !== undefined && (!object(value[key]) || Object.values(value[key]).some(item => typeof item !== 'string'))) return false;
  if (value.type !== undefined && !['stdio', 'http', 'sse'].includes(String(value.type))) return false;
  try { return validateServerConfig(name, value as unknown as MCPServerConfig).length === 0; }
  catch { return false; }
}
async function canonical(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return path.join(await canonical(path.dirname(file)),path.basename(file)); }
}
async function raw(file: string): Promise<string | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const before = await handle.stat();
    const limit = 1024 * 1024;
    if (!before.isFile() || before.size > limit) throw new Error('MCP configuration must be a regular file smaller than 1 MiB.');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    for (;;) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      size += read.bytesRead;
      if (size > limit) throw new Error('MCP configuration exceeds 1 MiB.');
      if (!read.bytesRead) break;
    }
    const after = await handle.stat(), current = await stat(file);
    if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('MCP configuration changed during the read. Reload it.');
    return buffer.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}
async function config(file: string): Promise<MCPConfigFile> {
  const text=await raw(file); if(text===null)return {mcpServers:{}};
  let value:unknown;try{value=JSON.parse(text);}catch{throw new Error('An existing native MCP configuration is not valid JSON. Repair it before editing.');}
  if(!object(value)||!validKeys(value)||value.mcpServers!==undefined&&(!object(value.mcpServers)||!validKeys(value.mcpServers))
    ||['enabledServers','disabledServers'].some(key=>value[key]!==undefined&&(!Array.isArray(value[key])||(value[key] as unknown[]).some(n=>typeof n!=='string'))))throw new Error('An existing MCP configuration has an unsupported structure.');
  if (!safeTree(value) || Object.entries(value.mcpServers ?? {}).some(([name, server]) => !validServer(name, server))) throw new Error('An existing MCP server configuration is invalid. Repair it before editing.');
  return value as MCPConfigFile;
}
const id=(name:string,file:string)=>createHash('sha256').update(JSON.stringify([name,file])).digest('hex');

/** Configuration-only native discovery. Never connects a server or evaluates a
 * command from its configuration. Values and credentials stay in this worker. */
export class NativeMcp {
  private secret=randomBytes(32);
  private tail:Promise<unknown>=Promise.resolve();
  private ordered<T>(fn:()=>Promise<T>):Promise<T>{const p=this.tail.catch(()=>{}).then(fn);this.tail=p;return p;}
  private async inspect(cwd:string){
    cwd=await realpath(cwd);
    const user=path.join(await canonical(path.dirname(getMCPConfigPath('user',cwd))),path.basename(getMCPConfigPath('user',cwd))),project=path.join(await canonical(path.dirname(getMCPConfigPath('project',cwd))),path.basename(getMCPConfigPath('project',cwd)));
    const [userConfig,projectConfig]=await Promise.all([config(user),config(project)]);
    clearCache();
    const discovered=await loadCapability<MCPServer>(mcpCapability.id,{cwd,includeDisabled:true});
    const files=new Set([user,project]);
    const rows:Array<{row:NativeMcpServer;file:string;writable:boolean}>=[];
    const deny=new Set(userConfig.disabledServers??[]),force=new Set(userConfig.enabledServers??[]);
    for(const item of discovered.all){
      const file=path.join(await canonical(path.dirname(item._source.path)),path.basename(item._source.path));files.add(file);
      if(rows.some(row=>row.row.id===id(item.name,file)))continue;
      const writable=(file===user||file===project||item._source.provider==='mcp-json') && ['mcp.json','.mcp.json'].includes(path.basename(file));
      rows.push({file,writable,row:{id:id(item.name,file),name:item.name,transport:item.transport??(item.command?'stdio':item.url?'http':'unknown'),scope:item._source.level,
        source:item._source.providerName,enabled:!deny.has(item.name)&&(item.enabled!==false||force.has(item.name)),removable:writable,shadowed:item._shadowed}});
    }
    // Native user/project entries and deny-only names must remain editable even
    // if a discovery filter hides them from the runtime's active connection set.
    for(const [file,value,scope] of [[project,projectConfig,'project'],[user,userConfig,'user']] as const){
      for(const [name,server] of Object.entries(value.mcpServers??{})){
        if(rows.some(r=>r.row.id===id(name,file)))continue;
        const shadowed=rows.some(r=>r.row.name===name&&!r.row.shadowed);
        rows.push({file,writable:true,row:{id:id(name,file),name,transport:server.type??'stdio',scope,source:'OMP',enabled:!deny.has(name)&&(server.enabled!==false||force.has(name)),removable:true,shadowed}});
      }
    }
    for(const name of new Set([...deny,...force]))if(!rows.some(r=>r.row.name===name))rows.push({file:user,writable:false,row:{id:id(name,user),name,transport:'unknown',scope:'user',source:'Saved server override',enabled:!deny.has(name),removable:false}});
    const fingerprints=await Promise.all([...files].sort().map(async file=>[file,await raw(file)]));
    const revision=createHmac('sha256',this.secret).update(JSON.stringify([cwd,fingerprints,rows])).digest('hex');
    const snapshot:NativeMcpCatalog={revision,servers:rows.map(r=>r.row).sort((a,b)=>a.name.localeCompare(b.name)||a.scope.localeCompare(b.scope)),application:'new-sessions'};
    return {snapshot,rows,user,project,files};
  }
  read(cwd:string):Promise<NativeMcpCatalog>{return this.ordered(async()=> (await this.inspect(cwd)).snapshot);}
  mutate(cwd:string,mutation:NativeMcpMutation):Promise<NativeMcpCatalog>{return this.ordered(async()=>{
    const observed=await this.inspect(cwd);
    if(observed.snapshot.revision!==mutation.expectedRevision)throw new Error('MCP configuration changed. Reload before saving.');
    const selected=mutation.operation==='add'?undefined:observed.rows.find(r=>r.row.id===mutation.serverId);
    if(mutation.operation!=='add'&&!selected)throw new Error('The selected MCP server no longer exists.');
    if(mutation.operation==='remove'&&!selected?.writable)throw new Error('This server is owned by another configuration source. Disable it here or remove it in its source.');
    const writeFile=mutation.operation==='add'?(mutation.scope==='user'?observed.user:observed.project):selected!.writable?selected!.file:observed.user;
    const locks=[...new Set([observed.user,writeFile])].sort();
    const lock=async<T>(index:number,fn:()=>Promise<T>):Promise<T>=>{if(index===locks.length)return fn();await mkdir(path.dirname(locks[index]!),{recursive:true,mode:0o700});return withFileLock(locks[index]!,()=>lock(index+1,fn));};
    return lock(0,async()=>{
      const current=await this.inspect(cwd);if(current.snapshot.revision!==mutation.expectedRevision)throw new Error('MCP configuration changed. Reload before saving.');
      if(await canonical(writeFile)!==writeFile||await canonical(observed.user)!==observed.user)throw new Error('MCP configuration ownership changed. Reload before saving.');
      const target=await config(writeFile),user=writeFile===observed.user?target:await config(observed.user);
      const originalUser=JSON.stringify(user);
      if(mutation.operation==='add'){
        if(validateServerName(mutation.name))throw new Error('Enter a valid MCP server name.');
        if(!validServer(mutation.name,mutation.config))throw new Error('The MCP server configuration is invalid.');
        if(Object.hasOwn(target.mcpServers??{},mutation.name))throw new Error('An MCP server with that name already exists in this scope.');
        target.mcpServers={...target.mcpServers,[mutation.name]:structuredClone(mutation.config) as unknown as MCPServerConfig};
      }else if(mutation.operation==='remove'){
        if(!Object.hasOwn(target.mcpServers??{},selected!.row.name))throw new Error('The original MCP server is no longer present.');
        delete target.mcpServers![selected!.row.name];
      }else{
        const name=selected!.row.name;
        if(selected!.writable){const server=target.mcpServers?.[name];if(!server)throw new Error('The original MCP server is no longer present.');target.mcpServers![name]={...server,enabled:mutation.enabled};}
        const denied=new Set(user.disabledServers??[]),forced=new Set(user.enabledServers??[]);
        if(mutation.enabled){denied.delete(name);if(selected!.writable)forced.delete(name);else forced.add(name);}
        else {forced.delete(name);if(!selected!.writable)denied.add(name);}
        if(denied.size)user.disabledServers=[...denied];else delete user.disabledServers;
        if(forced.size)user.enabledServers=[...forced];else delete user.enabledServers;
      }
      // Native atomic serialization, while our locks retain the CAS boundary.
      // No server process is launched and no saved request body enters a journal.
      await writeMCPConfigFile(writeFile,target);
      if(writeFile!==observed.user&&mutation.operation==='enabled'&&JSON.stringify(user)!==originalUser)await writeMCPConfigFile(observed.user,user);
      return (await this.inspect(cwd)).snapshot;
    });
  });}
}
