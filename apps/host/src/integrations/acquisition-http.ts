import type { WorkspaceTarget } from '@agent-desktop/shared';
import type { NativePluginAcquisition, NativePluginAcquisitionRequest, NativeMarketplaceCatalog } from '../../../../packages/shared/src/plugin-acquisition';
import { assertMarketplaceGitSource, parseMarketplaceSourceOptions } from '../../../../packages/shared/src/plugin-acquisition';
import { parseWorkspaceTarget } from '../workspace-http';
import { readIntegrationBody } from '../integrations-http';
import { PluginAcquisitionOperations } from './acquisition-operations';

function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string,unknown>;
}
function keys(value: Record<string,unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported request field.');
}
function text(value: unknown, max=200): string {
  if (typeof value !== 'string' || !value.trim() || value.length>max || value.includes('\0')) throw new Error('Invalid request value.');
  return value;
}
function id(value: unknown): string {
  const result=text(value,36);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result)) throw new Error('Invalid operation ID.');
  return result;
}
function name(value: unknown): string {
  const result=text(value,64);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(result)) throw new Error('Invalid native name.');
  return result;
}
function scope(value: unknown): 'user'|'project' {
  if (value!=='user' && value!=='project') throw new Error('Invalid native scope.');
  return value;
}
export function parsePluginAcquisition(value: unknown): NativePluginAcquisitionRequest {
  const input=object(value);keys(input,['id','expectedRevision','action']);
  const raw=object(input.action);let action: NativePluginAcquisition;
  switch(raw.operation) {
    case 'marketplace.add': keys(raw,['operation','source','sourceOptions']);action={operation:raw.operation,source:text(raw.source,8192),...(raw.sourceOptions === undefined ? {} : {sourceOptions:parseMarketplaceSourceOptions(raw.sourceOptions)})};if(action.sourceOptions)assertMarketplaceGitSource(action.source);break;
    case 'marketplace.update': case 'marketplace.remove': keys(raw,['operation','name']);action={operation:raw.operation,name:name(raw.name)};break;
    case 'plugin.install': keys(raw,['operation','name','marketplace','scope']);action={operation:raw.operation,name:name(raw.name),marketplace:name(raw.marketplace),scope:scope(raw.scope)};break;
    case 'plugin.uninstall': {
      keys(raw,['operation','pluginId','scope']);const pluginId=text(raw.pluginId,129),parts=pluginId.split('@');
      if(parts.length!==2)throw new Error('Invalid plugin identity.');name(parts[0]);name(parts[1]);
      action={operation:raw.operation,pluginId,scope:scope(raw.scope)};break;
    }
    default: throw new Error('Unknown plugin acquisition operation.');
  }
  return {id:id(input.id),expectedRevision:text(input.expectedRevision),action};
}
export class PluginAcquisitionHttp {
  private stopping=false;
  private pending=new Set<Promise<unknown>>();
  constructor(private options: { operations: PluginAcquisitionOperations; read(cwd:string):Promise<NativeMarketplaceCatalog>; resolveCwd(target?:WorkspaceTarget):Promise<string>|string }) {}
  route(request:Request,url:URL):Promise<Response|undefined> {
    if(!url.pathname.startsWith('/v1/integrations/acquisition/'))return Promise.resolve(undefined);
    const work=this.handle(request,url);this.pending.add(work);
    void work.finally(()=>this.pending.delete(work)).catch(()=>{});return work;
  }
  private async handle(request:Request,url:URL):Promise<Response> {
    const respond=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
    if(this.stopping)return respond({error:'The host is stopping.'},503);
    if(request.method!=='POST')return respond({error:'Not found.'},404);
    const method=url.pathname.slice('/v1/integrations/acquisition/'.length);
    if(!['catalog','start','operations','review','close-request'].includes(method))return respond({error:'Not found.'},404);
    try {
      const input=await readIntegrationBody(request);
      keys(input,method==='start'?['target','request']:method==='review'?['target','id','expectedRevision']:method==='close-request'?['target','id','operation']:['target']);
      const target=input.target===undefined?undefined:parseWorkspaceTarget(input.target);
      if(method==='operations'&&target===undefined)return respond(this.options.operations.list());
      const cwd=await this.options.resolveCwd(target);
      if(this.stopping)return respond({error:'The host is stopping.'},503);
      if(method==='close-request') {
        if (!['marketplace.add','marketplace.update','marketplace.remove','plugin.install','plugin.uninstall'].includes(String(input.operation))) throw new Error('Invalid operation.');
        return respond(this.options.operations.closeRequest(cwd,id(input.id),input.operation as NativePluginAcquisition['operation'],target));
      }
      if(method==='catalog')return respond(await this.options.read(cwd));
      if(method==='operations')return respond(this.options.operations.list());
      if(method==='review')return respond(await this.options.operations.review(cwd,id(input.id),text(input.expectedRevision)));
      const operation=parsePluginAcquisition(input.request);
      if('scope' in operation.action && operation.action.scope==='project' && !target)throw new Error('A project target is required.');
      return respond(this.options.operations.start(cwd,operation,target),202);
    } catch { return respond({error:'Plugin acquisition could not complete. Reload the catalog and inspect operation status before trying another action.'},400); }
  }
  async dispose():Promise<void> {
    this.stopping=true;
    await Promise.allSettled([...this.pending]);
    await this.options.operations.dispose();
  }
}
