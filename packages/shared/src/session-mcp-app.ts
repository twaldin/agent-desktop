/** A UI resource and all of its operations belong to the selected live native
 * MCP session generation. A displayed title is never an admission identity. */
export interface NativeMcpAppSelection {
  epoch: string;
  expectedRevision: number;
  serverName: string;
  toolName: string;
  resourceUri: string;
}
export interface NativeMcpAppDescriptor {
  toolName: string;
  title: string;
  resourceUri: string;
  icon?: { light: string; dark: string };
}
export type McpJson = null | boolean | number | string | McpJson[] | { [key: string]: McpJson };
export type NativeMcpAppSource = { type: "artifact"; entryId: string } | { type: "file"; path: string; resourceUri: string };
export interface NativeMcpFileViewer extends NativeMcpAppDescriptor { extensions: string[] }
export type NativeMcpAppRequest =
  | { type: "open"; channelId: string; selection: NativeMcpAppSelection; source?: NativeMcpAppSource }
  | { type: "events"; channelId: string; after: number }
  | { type: "request"; channelId: string; requestId: string; method: "tools/call" | "resources/read" | "resources/subscribe" | "resources/unsubscribe" | "openai/resources/write" | "resources/list" | "resources/templates/list"; params: Record<string, McpJson> }
  | { type: "close"; channelId: string };
export interface NativeMcpAppResource {
  uri: string;
  mimeType: string;
  html: string;
  /** Validated declarative resource policy; the renderer never treats it as HTML. */
  csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
}
export type NativeMcpAppResponse =
  | { type: "events"; channelId: string; sequence: number; uris: string[] }
  | { type: "opened"; channelId: string; resource: NativeMcpAppResource; initialResult?: Record<string, McpJson>; initialArguments?: Record<string, McpJson> }
  | { type: "result"; channelId: string; requestId: string; value: Record<string, McpJson> }
  | { type: "closed"; channelId: string; operationErrors?: number };

const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP app object.");
  return value as Record<string, unknown>;
};
const text = (value: unknown, maximum = 1024): string => {
  if (typeof value !== "string" || !value || value.includes("\0") || encoder.encode(value).byteLength > maximum) throw new Error("Invalid MCP app identity.");
  return value;
};
const id = (value: unknown): string => {
  const result = text(value, 200);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error("Invalid MCP app operation identity.");
  return result;
};
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported MCP app field.");
};
export function cloneMcpJson(value: unknown, maximum = 2 * 1024 * 1024): McpJson {
  let remaining = maximum;
  const visit = (entry: unknown, depth: number): McpJson => {
    if (depth > 32 || --remaining < 0) throw new Error("MCP app value exceeds its bound.");
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (typeof entry === "string") { remaining -= encoder.encode(entry).byteLength; if (remaining < 0) throw new Error("MCP app value exceeds its bound."); return entry; }
    if (Array.isArray(entry)) {
      const result: McpJson[] = [];
      for (let index = 0; index < entry.length; index++) result.push(visit(entry[index], depth + 1));
      return result;
    }
    const input = record(entry), result: Record<string, McpJson> = Object.create(null);
    for (const [key, item] of Object.entries(input)) { remaining -= encoder.encode(key).byteLength; result[key] = visit(item, depth + 1); }
    return result;
  };
  const result = visit(value, 0);
  if (encoder.encode(JSON.stringify(result)).byteLength > maximum) throw new Error("MCP app value exceeds its bound.");
  return result;
}
export function parseNativeMcpAppSelection(value: unknown): NativeMcpAppSelection {
  const input = record(value);
  keys(input, ["epoch", "expectedRevision", "serverName", "toolName", "resourceUri"]);
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) throw new Error("Invalid MCP app revision.");
  const resourceUri = text(input.resourceUri, 16_384);
  if (!resourceUri.startsWith("ui://")) throw new Error("MCP app resource must use ui://.");
  return { epoch: text(input.epoch, 200), expectedRevision: input.expectedRevision as number, serverName: text(input.serverName), toolName: text(input.toolName), resourceUri };
}
export function parseNativeMcpAppDescriptor(value: unknown): NativeMcpAppDescriptor {
  const input = record(value);
  keys(input, ["toolName", "title", "resourceUri", "icon"]);
  const resourceUri = text(input.resourceUri, 16_384);
  if (!resourceUri.startsWith("ui://")) throw new Error("Invalid MCP app resource URI.");
  let icon: NativeMcpAppDescriptor["icon"];
  if (input.icon !== undefined) {
    const raw = record(input.icon); keys(raw, ["light", "dark"]);
    const source = (value: unknown) => { const url = text(value, 32_768); if (!url.startsWith("https://") && !url.startsWith("data:image/")) throw new Error("Invalid MCP app icon source."); return url; };
    icon = { light: source(raw.light), dark: source(raw.dark) };
  }
  return { toolName: text(input.toolName), title: text(input.title), resourceUri, ...(icon ? { icon } : {}) };
}
export function parseNativeMcpFileViewer(value: unknown): NativeMcpFileViewer {
  const input = record(value), { extensions, ...descriptor } = input;
  if (!Array.isArray(extensions) || !extensions.length || extensions.length > 128) throw new Error("Invalid file viewer extensions.");
  const parsed: string[] = [];
  for (let index = 0; index < extensions.length; index++) parsed.push(text(extensions[index], 256).trim());
  if (parsed.some(extension => !extension)) throw new Error("Invalid file viewer extension.");
  return { ...parseNativeMcpAppDescriptor(descriptor), extensions: parsed };
}
/** Longest normalized suffix wins; declaration order breaks ties. */
export function mcpViewerExtension(path: string, extensions: string[]): string | undefined {
  const name = path.split("/").at(-1)!.toLowerCase();
  let selected: string | undefined;
  for (const extension of extensions) {
    const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
    if (normalized && name.endsWith(`.${normalized}`) && normalized.length > (selected?.length ?? 0)) selected = normalized;
  }
  return selected;
}
export function parseNativeMcpAppRequest(value: unknown): NativeMcpAppRequest {
  const input = record(value), channelId = id(input.channelId);
  if (input.type === "open") { keys(input, ["type", "channelId", "selection", "source"]); return { type: "open", channelId, selection: parseNativeMcpAppSelection(input.selection), ...(input.source === undefined ? {} : { source: parseNativeMcpAppSource(input.source) }) }; }
  if (input.type === "close") { keys(input, ["type", "channelId"]); return { type: "close", channelId }; }
  if (input.type === "events") { keys(input, ["type", "channelId", "after"]); if (!Number.isSafeInteger(input.after) || Number(input.after) < 0) throw new Error("Invalid MCP app event cursor."); return { type: "events", channelId, after: Number(input.after) }; }
  keys(input, ["type", "channelId", "requestId", "method", "params"]);
  if (input.type !== "request" || !["tools/call", "resources/read", "resources/subscribe", "resources/unsubscribe", "openai/resources/write", "resources/list", "resources/templates/list"].includes(String(input.method))) throw new Error("Unsupported MCP app operation.");
  return { type: "request", channelId, requestId: id(input.requestId), method: input.method as Extract<NativeMcpAppRequest, { type: "request" }>["method"], params: record(cloneMcpJson(record(input.params), input.method === "openai/resources/write" ? 2 * 1024 * 1024 : 32_768)) as Record<string, McpJson> };
}
export function parseNativeMcpAppSource(value: unknown): NativeMcpAppSource {
  const input = record(value);
  if (input.type === "artifact") { keys(input, ["type", "entryId"]); return { type: "artifact", entryId: id(input.entryId) }; }
  if (input.type === "file") {
    keys(input, ["type", "path", "resourceUri"]);
    const path = text(input.path, 16_384), resourceUri = text(input.resourceUri, 256);
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some(segment => !segment || segment === "." || segment === "..")
      || !/^codex-resource:\/\/[a-zA-Z0-9-]{1,200}$/.test(resourceUri)) throw new Error("Invalid original viewer file.");
    return { type: "file", path, resourceUri };
  }
  throw new Error("Unsupported MCP app source.");
}
export function parseNativeMcpAppResource(value: unknown): NativeMcpAppResource {
  const input = record(value); keys(input, ["uri", "mimeType", "html", "csp"]);
  if (typeof input.html !== "string" || encoder.encode(input.html).byteLength > 2 * 1024 * 1024) throw new Error("MCP app HTML exceeds its bound.");
  const uri = text(input.uri, 16_384), mimeType = text(input.mimeType);
  if (!uri.startsWith("ui://") || !["text/html;profile=mcp-app"].includes(mimeType)) throw new Error("Unsupported MCP app resource.");
  let csp: NativeMcpAppResource["csp"];
  if (input.csp !== undefined) {
    const raw = record(input.csp); keys(raw, ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]); csp = {};
    for (const name of Object.keys(raw) as Array<keyof NonNullable<NativeMcpAppResource["csp"]>>) {
      const entries = raw[name]; if (!Array.isArray(entries) || entries.length > 64) throw new Error("Invalid MCP app resource policy.");
      const domains: string[] = [];
      for (let index = 0; index < entries.length; index++) {
        const domain = text(entries[index], 2048);
        if (!/^(?:https?|wss?):\/\/(?:\*\.)?[a-zA-Z0-9.-]+(?::[0-9]+)?\/?$/.test(domain)) throw new Error("Invalid MCP app resource domain.");
        domains.push(domain);
      }
      csp[name] = domains;
    }
  }
  return { uri, mimeType, html: input.html, ...(csp ? { csp } : {}) };
}
export function parseNativeMcpAppResponse(value: unknown, request: NativeMcpAppRequest): NativeMcpAppResponse {
  const input = record(value);
  if (input.channelId !== request.channelId) throw new Error("MCP app response owner changed.");
  if (request.type === "events" && input.type === "events") {
    keys(input, ["type", "channelId", "sequence", "uris"]);
    if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < request.after || !Array.isArray(input.uris) || input.uris.length > 128) throw new Error("Invalid MCP resource update batch.");
    const uris: string[] = []; for (let index = 0; index < input.uris.length; index++) uris.push(text(input.uris[index], 16_384));
    if (uris.length && Number(input.sequence) === request.after) throw new Error("MCP resource update did not advance its cursor.");
    if (new Set(uris).size !== uris.length) throw new Error("Duplicate MCP resource update.");
    return { type: "events", channelId: request.channelId, sequence: Number(input.sequence), uris };
  }
  if (request.type === "open" && input.type === "opened") {
    keys(input, ["type", "channelId", "resource", "initialResult", "initialArguments"]);
    const resource = parseNativeMcpAppResource(input.resource);
    if (resource.uri !== request.selection.resourceUri) throw new Error("MCP app resource identity changed.");
    if (request.source?.type === "artifact" && input.initialResult === undefined) throw new Error("The saved app result is unavailable. Its tool cannot be replayed.");
    if (request.source?.type === "file" && (input.initialArguments === undefined || input.initialResult !== undefined)) throw new Error("Invalid original file viewer input.");
    if (!request.source && (input.initialResult !== undefined || input.initialArguments !== undefined)) throw new Error("Unexpected saved MCP result.");
    return { type: "opened", channelId: request.channelId, resource,
      ...(input.initialResult === undefined ? {} : { initialResult: record(cloneMcpJson(input.initialResult)) as Record<string, McpJson> }),
      ...(input.initialArguments === undefined ? {} : { initialArguments: record(cloneMcpJson(input.initialArguments, 32_768)) as Record<string, McpJson> }),
    };
  }
  if (request.type === "close" && input.type === "closed") { keys(input, ["type", "channelId", "operationErrors"]);
    if (input.operationErrors !== undefined && (!Number.isSafeInteger(input.operationErrors) || Number(input.operationErrors) < 1 || Number(input.operationErrors) > 1024)) throw new Error("Invalid MCP app cleanup outcome.");
    return { type: "closed", channelId: request.channelId, ...(input.operationErrors === undefined ? {} : { operationErrors: Number(input.operationErrors) }) }; }
  if (request.type === "request" && input.type === "result" && input.requestId === request.requestId) { keys(input, ["type", "channelId", "requestId", "value"]); return { type: "result", channelId: request.channelId, requestId: request.requestId, value: record(cloneMcpJson(record(input.value))) as Record<string, McpJson> }; }
  throw new Error("MCP app response does not match the operation.");
}
