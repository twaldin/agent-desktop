/** Live state belongs to one native session manager generation, not to the
 * saved user/project configuration catalog. */
export interface NativeSessionMcpServer {
  name: string;
  status: 'connected' | 'connecting' | 'disconnected';
  source: string;
  tools: string[];
  resourceCount: number | null;
  promptCount: number | null;
  error?: string;
}
export interface NativeSessionMcpSnapshot {
  epoch: string;
  revision: number;
  available: boolean;
  reason?: string;
  servers: NativeSessionMcpServer[];
}
export interface NativeSessionMcpReload {
  epoch: string;
  expectedRevision: number;
}
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
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error('Invalid native MCP text.');
  return value;
};
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid native MCP revision or count.');
  return value;
};
export function parseNativeSessionMcpReload(value: unknown): NativeSessionMcpReload {
  const input = record(value);
  if (Object.keys(input).some(key => !['epoch','expectedRevision'].includes(key))) throw new Error('Unsupported MCP reload field.');
  return {epoch:text(input.epoch,200),expectedRevision:integer(input.expectedRevision)};
}
export function parseNativeSessionMcpSnapshot(value: unknown): NativeSessionMcpSnapshot {
  const input = record(value);
  if (typeof input.available !== 'boolean' || !Array.isArray(input.servers) || input.servers.length > 4096) throw new Error('Invalid native MCP catalog.');
  const servers = input.servers.map(raw => {
    const server = record(raw);
    if (!['connected','connecting','disconnected'].includes(String(server.status)) || !Array.isArray(server.tools) || server.tools.length > 16384) throw new Error('Invalid native MCP server.');
    return {name:text(server.name),status:server.status as NativeSessionMcpServer['status'],source:text(server.source),tools:server.tools.map(name=>text(name)),resourceCount:server.resourceCount === null ? null : integer(server.resourceCount),promptCount:server.promptCount === null ? null : integer(server.promptCount),...(server.error === undefined ? {} : {error:text(server.error,4096)})};
  });
  if (new Set(servers.map(server=>server.name)).size !== servers.length) throw new Error('Duplicate native MCP server.');
  return {epoch:text(input.epoch,200),revision:integer(input.revision),available:input.available,servers,...(input.reason === undefined ? {} : {reason:text(input.reason,4096)})};
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
