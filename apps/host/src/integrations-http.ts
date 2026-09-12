import type { NativePluginMutation, NativeMcpDetailRequest, NativeMcpMutation, WorkspaceTarget } from '@agent-desktop/shared';
import type { WorkerRuntime } from './omp-workers';
import { parseWorkspaceTarget } from './workspace-http';

class InvalidRequest extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidRequest('Invalid integration request.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new InvalidRequest('Unsupported integration request field.');
}
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new InvalidRequest('Invalid integration identifier.');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new InvalidRequest('Invalid enabled state.');
  return value;
}
function safeJson(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new InvalidRequest('Configuration is too deeply nested.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => safeJson(item, depth + 1));
  const record = object(value), result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new InvalidRequest('Unsupported configuration key.');
    result[key] = safeJson(item, depth + 1);
  }
  return result;
}
export function parsePluginMutation(value: unknown): NativePluginMutation {
  const input = object(value), base = { expectedRevision: text(input.expectedRevision), pluginId: text(input.pluginId, 1024) };
  switch (input.operation) {
    case 'enabled': keys(input, ['expectedRevision','pluginId','operation','enabled']); return {...base, operation:'enabled', enabled:boolean(input.enabled)};
    case 'features': {
      keys(input, ['expectedRevision','pluginId','operation','features']);
      if (input.features !== null && (!Array.isArray(input.features) || input.features.length > 1000)) throw new InvalidRequest('Invalid plugin features.');
      return {...base, operation:'features', features:input.features === null ? null : (input.features as unknown[]).map(item => text(item))};
    }
    case 'setting': {
      keys(input, ['expectedRevision','pluginId','operation','key','value']);
      if (!['string','boolean','number'].includes(typeof input.value) || typeof input.value === 'number' && !Number.isFinite(input.value)) throw new InvalidRequest('Invalid plugin setting value.');
      return {...base, operation:'setting', key:text(input.key), value:input.value as string | number | boolean};
    }
    case 'reset-setting': keys(input,['expectedRevision','pluginId','operation','key']); return {...base, operation:'reset-setting', key:text(input.key)};
    default: throw new InvalidRequest('Unknown plugin operation.');
  }
}
export function parseMcpMutation(value: unknown): NativeMcpMutation {
  const input = object(value), expectedRevision = text(input.expectedRevision);
  switch (input.operation) {
    case 'enabled': keys(input,['expectedRevision','serverId','operation','enabled']); return {expectedRevision, operation:'enabled', serverId:text(input.serverId), enabled:boolean(input.enabled)};
    case 'remove': keys(input,['expectedRevision','serverId','operation']); return {expectedRevision, operation:'remove', serverId:text(input.serverId)};
    case 'update': keys(input,['expectedRevision','serverId','operation','config']); return {expectedRevision, operation:'update', serverId:text(input.serverId), config:object(safeJson(object(input.config)))};
    case 'add': {
      keys(input,['expectedRevision','operation','scope','name','config']);
      if (input.scope !== 'user' && input.scope !== 'project') throw new InvalidRequest('Invalid MCP scope.');
      return {expectedRevision, operation:'add', scope:input.scope, name:text(input.name), config:object(safeJson(object(input.config)))};
    }
    default: throw new InvalidRequest('Unknown MCP operation.');
  }
}
export function parseSshMutation(value: unknown): import('@agent-desktop/shared').NativeSshMutation {
  const input = object(value), expectedRevision = text(input.expectedRevision);
  switch (input.operation) {
    case 'remove': keys(input, ['expectedRevision','operation','hostId']); return {expectedRevision, operation:'remove', hostId:text(input.hostId)};
    case 'update': keys(input, ['expectedRevision','operation','hostId','config']); return {expectedRevision, operation:'update', hostId:text(input.hostId), config:object(safeJson(object(input.config)))};
    case 'add': {
      keys(input, ['expectedRevision','operation','scope','name','config']);
      if (input.scope !== 'user' && input.scope !== 'project') throw new InvalidRequest('Invalid SSH configuration scope.');
      return {expectedRevision, operation:'add', scope:input.scope, name:text(input.name, 100), config:object(safeJson(object(input.config)))};
    }
    default: throw new InvalidRequest('Unknown SSH configuration operation.');
  }
}
export function parseSshDetailRequest(value: unknown): import('@agent-desktop/shared').NativeSshDetailRequest {
  const input = object(value); keys(input, ['hostId','expectedRevision']);
  return {hostId:text(input.hostId), expectedRevision:text(input.expectedRevision)};
}
export function parseMcpDetailRequest(value: unknown): NativeMcpDetailRequest {
  const input=object(value);keys(input,['serverId','expectedRevision']);
  return {serverId:text(input.serverId),expectedRevision:text(input.expectedRevision)};
}
export async function readIntegrationBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new InvalidRequest('A request body is required.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new InvalidRequest('Integration request exceeds 1 MiB.'); }
      chunks.push(next.value);
    }
    try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { throw new InvalidRequest('Invalid integration JSON.'); }
  } finally { reader.releaseLock(); }
}
interface Options {
  runtime: Pick<WorkerRuntime, 'getPlugins'|'mutatePlugin'|'getMcpServers'|'getMcpServerDetail'|'mutateMcpServer'> & Partial<Pick<WorkerRuntime, 'getSshHosts'|'getSshHostDetail'|'mutateSshHost'>>;
  resolveCwd(target?: WorkspaceTarget): string | Promise<string>;
  changed(target?: WorkspaceTarget): void;
}
/** Authenticated owner-scoped configuration transport. Mutation bodies and
 * secret values never enter the ordinary session command/event journal. */
export class IntegrationsHttp {
  private pending = new Set<Promise<unknown>>();
  private stopping = false;
  constructor(private options: Options) {}
  route(request: Request, url: URL): Promise<Response | undefined> {
    if (!url.pathname.startsWith('/v1/integrations/')) return Promise.resolve(undefined);
    const operation = this.handle(request,url);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }
  private async handle(request: Request,url: URL): Promise<Response> {
    const respond = (value:unknown,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
    try {
      if (this.stopping) return respond({error:'The host is stopping.'},503);
      const match = /^\/v1\/integrations\/(plugins|mcp|ssh)\/(read|detail|mutate)$/.exec(url.pathname);
      if (!match || request.method !== 'POST') return respond({error:'Not found'},404);
      if(match[2]==='detail'&&match[1]==='plugins')return respond({error:'Not found'},404);
      const input = await readIntegrationBody(request); keys(input,match[2] === 'read' ? ['target'] : match[2]==='detail'?['target','request']:['target','mutation']);
      let target:WorkspaceTarget | undefined;
      try { target = input.target === undefined ? undefined : parseWorkspaceTarget(input.target); }
      catch { throw new InvalidRequest('Select an existing project or session.'); }
      const cwd = await this.options.resolveCwd(target);
      if (this.stopping) return respond({error:'The host is stopping.'},503);
      const {runtime} = this.options;
      if (match[1] === 'ssh') {
        if (!runtime.getSshHosts || !runtime.getSshHostDetail || !runtime.mutateSshHost) return respond({error:'This host does not support SSH configuration. Update its host service.'},501);
        if (match[2] === 'read') return respond(await runtime.getSshHosts(cwd));
        if (match[2] === 'detail') return respond(await runtime.getSshHostDetail(cwd, parseSshDetailRequest(input.request)));
        const mutation = parseSshMutation(input.mutation);
        if (mutation.operation === 'add' && mutation.scope === 'project' && !target) throw new InvalidRequest('Project SSH hosts require an existing project or session.');
        const result = await runtime.mutateSshHost(cwd, mutation);
        this.options.changed(target);
        return respond(result);
      }
      if (match[2] === 'read') return respond(await (match[1] === 'plugins' ? runtime.getPlugins(cwd) : runtime.getMcpServers(cwd)));
      if(match[2]==='detail')return respond(await runtime.getMcpServerDetail(cwd,parseMcpDetailRequest(input.request)));
      let result: unknown;
      if (match[1] === 'plugins') result = await runtime.mutatePlugin(cwd,parsePluginMutation(input.mutation));
      else {
        const mutation = parseMcpMutation(input.mutation);
        if (mutation.operation === 'add' && mutation.scope === 'project' && !target) throw new InvalidRequest('Project servers require an existing project or session.');
        result = await runtime.mutateMcpServer(cwd,mutation);
      }
      this.options.changed(target);
      return respond(result);
    } catch (error) {
      // Native validators can include configuration values in exceptions. Only
      // our fixed request diagnostics may cross this boundary.
      return respond({error:error instanceof InvalidRequest ? error.message : 'Native integration configuration could not be read or saved. Reload and inspect the current configuration before trying again.'},400);
    }
  }
  async dispose(): Promise<void> { this.stopping = true; await Promise.allSettled([...this.pending]); }
}
