import { parseNativeMcpAppDescriptor, parseNativeMcpFileViewer, type NativeMcpFileViewer, type NativeMcpAppDescriptor } from "./session-mcp-app";
/** Live state belongs to one native session manager generation, not to the
 * saved user/project configuration catalog. */
export interface NativeSessionMcpServer {
  name: string;
  status: 'connected' | 'connecting' | 'disconnected';
  source: string;
  /** Whether native OAuth authorization is applicable to this server. */
  canAuthorize?: boolean;
  tools: string[];
  apps?: NativeMcpAppDescriptor[];
  fileViewers?: NativeMcpFileViewer[];
  resourceCount: number | null;
  promptCount: number | null;
  resources?: Array<{uri:string;name:string;description?:string;mimeType?:string}> | null;
  resourceTemplates?: Array<{uriTemplate:string;name:string;description?:string;mimeType?:string}> | null;
  prompts?: Array<{name:string;description?:string;arguments?:Array<{name:string;description?:string;required:boolean}>}> | null;
  notifications?: {enabled:boolean;toolsListChanged:boolean;resourcesListChanged:boolean;promptsListChanged:boolean;resourceSubscribe:boolean;subscriptions:string[]} | null;
  error?: string;
}
export interface NativeSessionMcpSnapshot {
  epoch: string;
  revision: number;
  available: boolean;
  canReconnect?: boolean;
  canReadResources?: boolean;
  canOpenApps?: boolean;
  reason?: string;
  servers: NativeSessionMcpServer[];
}
export interface NativeSessionMcpReload {
  epoch: string;
  expectedRevision: number;
}
export interface NativeSessionMcpReconnect extends NativeSessionMcpReload { serverName: string }
export interface NativeSessionMcpReceipt { commandId: string; state: "pending" | "succeeded" | "failed" | "unknown" | "absent"; message?: string }
export interface NativeSessionMcpResponse {
  protocolVersion: 1;
  hostId: string;
  sessionId: string;
  value: NativeSessionMcpSnapshot | null;
  unavailable?: string;
  receipt?: NativeSessionMcpReceipt;
}
export const SESSION_MCP_OWNER_HEADER = 'X-Agent-Host-Id';
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native MCP state.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 1024): string => {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).byteLength > max || value.includes('\0')) throw new Error('Invalid native MCP text.');
  return value;
};
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid native MCP revision or count.');
  return value;
};
const optionalText = (value: unknown, max: number): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > max || value.includes('\0')) throw new Error('Invalid native MCP text.');
  return value;
};
const exactKeys = (input: Record<string, unknown>, keys: readonly string[], message: string): void => {
  if (Object.keys(input).some(key => !keys.includes(key))) throw new Error(message);
};
const optionalArray = <T>(value: unknown, limit: number, parse: (entry: unknown) => T): T[] | null | undefined => {
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid native MCP metadata list.');
  return value.map(parse);
};
export function parseNativeSessionMcpReload(value: unknown): NativeSessionMcpReload {
  const input = record(value);
  if (Object.keys(input).some(key => !['epoch','expectedRevision'].includes(key))) throw new Error('Unsupported MCP reload field.');
  return {epoch:text(input.epoch,200),expectedRevision:integer(input.expectedRevision)};
}
export function parseNativeSessionMcpReconnect(value: unknown): NativeSessionMcpReconnect {
  const input = record(value);
  exactKeys(input, ['epoch','expectedRevision','serverName'], 'Unsupported MCP reconnect field.');
  return { ...parseNativeSessionMcpReload({ epoch: input.epoch, expectedRevision: input.expectedRevision }), serverName: text(input.serverName) };
}
export function parseNativeSessionMcpSnapshot(value: unknown): NativeSessionMcpSnapshot {
  const input = record(value);
  exactKeys(input,['epoch','revision','available','canReconnect','canReadResources','canOpenApps','reason','servers'],'Unsupported native MCP catalog field.');
  if (input.canOpenApps !== undefined && typeof input.canOpenApps !== 'boolean') throw new Error('Invalid native MCP app capability.');
  if (input.canReadResources !== undefined && typeof input.canReadResources !== 'boolean') throw new Error('Invalid native MCP resource capability.');
  if (input.canReconnect !== undefined && typeof input.canReconnect !== 'boolean') throw new Error('Invalid native MCP reconnect capability.');
  if (typeof input.available !== 'boolean' || !Array.isArray(input.servers) || input.servers.length > 4096) throw new Error('Invalid native MCP catalog.');
  const servers = input.servers.map(raw => {
    const server = record(raw);
    exactKeys(server,['name','status','source','canAuthorize','tools','apps','fileViewers','resourceCount','promptCount','resources','resourceTemplates','prompts','notifications','error'],'Unsupported native MCP server field.');
    if (server.canAuthorize !== undefined && typeof server.canAuthorize !== 'boolean') throw new Error('Invalid native MCP authorization capability.');
    if (!['connected','connecting','disconnected'].includes(String(server.status)) || !Array.isArray(server.tools) || server.tools.length > 16384) throw new Error('Invalid native MCP server.');
    let apps: NativeMcpAppDescriptor[] | undefined;
    if (server.apps !== undefined) {
      if (!Array.isArray(server.apps) || server.apps.length > 4096) throw new Error('Invalid native MCP app catalogue.');
      apps = [];
      for (let index = 0; index < server.apps.length; index++) apps.push(parseNativeMcpAppDescriptor(server.apps[index]));
      if (new Set(apps.map(app => app.toolName)).size !== apps.length) throw new Error('Duplicate native MCP app.');
    }
    let fileViewers: NativeMcpFileViewer[] | undefined;
    if (server.fileViewers !== undefined) {
      if (!Array.isArray(server.fileViewers) || server.fileViewers.length > 4096) throw new Error('Invalid native file viewer catalogue.');
      fileViewers = [];
      for (let index = 0; index < server.fileViewers.length; index++) fileViewers.push(parseNativeMcpFileViewer(server.fileViewers[index]));
      if (new Set(fileViewers.map(viewer => viewer.toolName)).size !== fileViewers.length) throw new Error('Duplicate native file viewer.');
    }
    const resources = optionalArray(server.resources,4096,rawResource=>{const resource=record(rawResource);exactKeys(resource,['uri','name','description','mimeType'],'Unsupported native MCP resource field.');return {uri:text(resource.uri,16384),name:text(resource.name),...(resource.description===undefined?{}:{description:optionalText(resource.description,4096)!}),...(resource.mimeType===undefined?{}:{mimeType:optionalText(resource.mimeType,1024)!})};});
    const resourceTemplates = optionalArray(server.resourceTemplates,4096,rawTemplate=>{const template=record(rawTemplate);exactKeys(template,['uriTemplate','name','description','mimeType'],'Unsupported native MCP resource template field.');return {uriTemplate:text(template.uriTemplate,16384),name:text(template.name),...(template.description===undefined?{}:{description:optionalText(template.description,4096)!}),...(template.mimeType===undefined?{}:{mimeType:optionalText(template.mimeType,1024)!})};});
    const prompts = optionalArray(server.prompts,4096,rawPrompt=>{const prompt=record(rawPrompt);exactKeys(prompt,['name','description','arguments'],'Unsupported native MCP prompt field.');const args=optionalArray(prompt.arguments,256,rawArgument=>{const argument=record(rawArgument);exactKeys(argument,['name','description','required'],'Unsupported native MCP prompt argument field.');if(typeof argument.required!=='boolean')throw new Error('Invalid native MCP prompt argument.');return {name:text(argument.name),...(argument.description===undefined?{}:{description:optionalText(argument.description,4096)!}),required:argument.required};});if(args===null)throw new Error('Invalid native MCP prompt arguments.');return {name:text(prompt.name),...(prompt.description===undefined?{}:{description:optionalText(prompt.description,4096)!}),...(args===undefined?{}:{arguments:args})};});
    let notifications: NativeSessionMcpServer['notifications'];
    if(server.notifications===null) notifications=null;
    else if(server.notifications!==undefined){const rawNotifications=record(server.notifications);exactKeys(rawNotifications,['enabled','toolsListChanged','resourcesListChanged','promptsListChanged','resourceSubscribe','subscriptions'],'Unsupported native MCP notification field.');if(typeof rawNotifications.enabled!=='boolean'||typeof rawNotifications.toolsListChanged!=='boolean'||typeof rawNotifications.resourcesListChanged!=='boolean'||typeof rawNotifications.promptsListChanged!=='boolean'||typeof rawNotifications.resourceSubscribe!=='boolean'||!Array.isArray(rawNotifications.subscriptions)||rawNotifications.subscriptions.length>4096)throw new Error('Invalid native MCP notification state.');notifications={enabled:rawNotifications.enabled,toolsListChanged:rawNotifications.toolsListChanged,resourcesListChanged:rawNotifications.resourcesListChanged,promptsListChanged:rawNotifications.promptsListChanged,resourceSubscribe:rawNotifications.resourceSubscribe,subscriptions:rawNotifications.subscriptions.map(uri=>text(uri,16384))};}
    return {name:text(server.name),status:server.status as NativeSessionMcpServer['status'],source:text(server.source),...(server.canAuthorize === undefined ? {} : {canAuthorize:server.canAuthorize}),tools:server.tools.map(name=>text(name)),...(apps === undefined ? {} : {apps}),...(fileViewers === undefined ? {} : {fileViewers}),resourceCount:server.resourceCount === null ? null : integer(server.resourceCount),promptCount:server.promptCount === null ? null : integer(server.promptCount),...(resources===undefined?{}:{resources}),...(resourceTemplates===undefined?{}:{resourceTemplates}),...(prompts===undefined?{}:{prompts}),...(notifications===undefined?{}:{notifications}),...(server.error === undefined ? {} : {error:text(server.error,4096)})};
  });
  if (new Set(servers.map(server=>server.name)).size !== servers.length) throw new Error('Duplicate native MCP server.');
  const parsed = {...(input.canReadResources === undefined ? {} : {canReadResources:input.canReadResources}),...(input.canOpenApps === undefined ? {} : {canOpenApps:input.canOpenApps}),epoch:text(input.epoch,200),revision:integer(input.revision),available:input.available,...(input.canReconnect === undefined ? {} : {canReconnect:input.canReconnect}),servers,...(input.reason === undefined ? {} : {reason:text(input.reason,4096)})};
  if(new TextEncoder().encode(JSON.stringify(parsed)).byteLength>2*1024*1024)throw new Error('Native MCP catalog exceeds its 2 MiB response limit.');
  return parsed;
}
export function parseNativeSessionMcpResponse(value: unknown, hostId: string, sessionId: string, commandId?: string): NativeSessionMcpResponse {
  const input = record(value);
  if (input.protocolVersion !== 1 || input.hostId !== hostId || input.sessionId !== sessionId) throw new Error('Native MCP response owner does not match the selected session.');
  let receipt: NativeSessionMcpReceipt | undefined;
  if (input.receipt !== undefined) {
    const raw = record(input.receipt);
    if (!commandId || raw.commandId !== commandId || !['pending','succeeded','failed','unknown','absent'].includes(String(raw.state))) throw new Error('MCP receipt owner does not match the requested command.');
    receipt = {commandId,state:raw.state as NativeSessionMcpReceipt['state'],...(raw.message === undefined ? {} : {message:text(raw.message,4096)})};
  }
  if (commandId && !receipt) throw new Error('Missing native MCP command receipt.');
  return {protocolVersion:1,hostId,sessionId,...(receipt ? {receipt} : {}),value:input.value === null ? null : parseNativeSessionMcpSnapshot(input.value),...(input.unavailable === undefined ? {} : {unavailable:text(input.unavailable,4096)})};
}
