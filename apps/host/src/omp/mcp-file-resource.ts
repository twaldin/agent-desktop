import { watch } from "node:fs";
import path from "node:path";
import { WorkspaceService, WorkspaceError } from "../workspace/service";
import type { McpJson, NativeMcpAppSource } from "../../../../packages/shared/src/session-mcp-app";
export const MCP_VIEWER_MAX_BYTES = 1024 * 1024;
const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** One native session's original directory; resource URIs cannot grant another path. */
export class McpFileResources {
  readonly workspace: WorkspaceService;
  constructor(cwd: string) { this.workspace = new WorkspaceService(cwd, { maxTextBytes: MCP_VIEWER_MAX_BYTES }); }
  async watch(source: Extract<NativeMcpAppSource, { type: "file" }>, changed: () => void, signal: AbortSignal, assertCurrent: () => void): Promise<{ release(): Promise<void> }> {
    signal.throwIfAborted(); assertCurrent();
    // Validate this exact path with the same original-root read authority first.
    const original = await this.workspace.copyInfo(source.path); signal.throwIfAborted(); assertCurrent();
    const parent = path.dirname(original.absolutePath), name = path.basename(original.absolutePath);
    let closed = false, failure: unknown, last: string | undefined = original.revision, inspecting: Promise<void> | undefined;
    const report = () => { if (!closed && !signal.aborted) changed(); };
    const watcher = watch(parent, { encoding: "utf8" }, (_event, filename) => { if (filename === null || filename === name) report(); });
    const watchClosed = new Promise<void>(resolve => watcher.once("close", () => resolve()));
    watcher.on("error", error => { failure ??= error; report(); });
    // Parent rename/replacement need not emit another filename on the old watch.
    // A bounded metadata read detects it without reading the viewer's contents.
    const inspect = () => {
      if (closed) return Promise.resolve();
      if (inspecting) return inspecting;
      inspecting = Promise.resolve().then(async () => {
        try {
          const info = await this.workspace.copyInfo(source.path);
          if (last !== undefined && last !== info.revision) report(); last = info.revision;
        } catch { if (last !== "missing") report(); last = "missing"; }
      }).finally(() => { inspecting = undefined; });
      return inspecting;
    };
    const timer = setInterval(() => void inspect(), 1000); void inspect();
    let release: Promise<void> | undefined;
    const close = () => {
      if (release) return release;
      closed = true; clearInterval(timer); signal.removeEventListener("abort", abort);
      watcher.close();
      release = Promise.all([watchClosed, inspecting]).then(() => { if (failure !== undefined) throw failure; });
      void release.catch(() => {}); return release;
    };
    const abort = () => { void close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try { signal.throwIfAborted(); assertCurrent(); }
    catch (error) { await close(); throw error; }
    return { release: close };
  }
  async request(source: Extract<NativeMcpAppSource, { type: "file" }>, method: "resources/read" | "openai/resources/write", params: Record<string, McpJson>, signal: AbortSignal, assertCurrent: () => void): Promise<unknown> {
    const current = () => { signal.throwIfAborted(); assertCurrent(); };
    current();
    if (typeof params.uri !== "string" || !(params.uri === source.resourceUri || params.uri.startsWith(`${source.resourceUri}/`))) throw new Error("The resource does not belong to this file viewer.");
    if (method === "resources/read") {
      if (Object.keys(params).some(key => !["uri", "_meta"].includes(key))) throw new Error("Unsupported file resource read field.");
      const meta = params._meta === undefined ? undefined : asRecord(params._meta);
      if (params._meta !== undefined && !meta) throw new Error("Invalid resource metadata.");
      const resourceMeta = meta?.["openai/resource"] === undefined ? undefined : asRecord(meta["openai/resource"]);
      const representation = resourceMeta?.representation ?? "auto";
      if (meta?.["openai/resource"] !== undefined && !resourceMeta || resourceMeta && Object.keys(resourceMeta).some(key => key !== "representation")
        || !["auto", "text", "blob"].includes(String(representation))) throw new Error("Invalid file representation.");
      const file = await this.workspace.readBytes(source.path); current();
      let text: string | undefined;
      if (representation !== "blob") {
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes); }
        catch { if (representation === "text") throw new Error("This file is not valid UTF-8 text. Request its binary representation."); }
        if (representation === "auto" && file.bytes.includes(0)) text = undefined;
      }
      return { contents: [{ uri: params.uri, ...(text === undefined ? { blob: file.bytes.toString("base64"), mimeType: "application/octet-stream" } : { text, mimeType: "text/plain" }) }],
        _meta: { "openai/resource": { etag: file.revision, writable: file.writable } } };
    }
    if (Object.keys(params).some(key => !["uri", "text", "blob", "ifMatch", "_meta"].includes(key))
      || typeof params.ifMatch !== "string" || !/^[a-f0-9]{64}$/.test(params.ifMatch)
      || (typeof params.text === "string") === (typeof params.blob === "string")
      || params.text !== undefined && typeof params.text !== "string" || params.blob !== undefined && typeof params.blob !== "string") throw new Error("A file save requires text or binary data and its exact revision.");
    let bytes: Buffer;
    if (typeof params.blob === "string") {
      if (params.blob.length > Math.ceil(MCP_VIEWER_MAX_BYTES / 3) * 4) return { outcome: "too-large", maxBytes: MCP_VIEWER_MAX_BYTES };
      bytes = Buffer.from(params.blob, "base64");
      if (bytes.toString("base64") !== params.blob) throw new Error("Invalid file binary encoding.");
    } else bytes = Buffer.from(params.text as string, "utf8");
    if (bytes.length > MCP_VIEWER_MAX_BYTES) return { outcome: "too-large", maxBytes: MCP_VIEWER_MAX_BYTES };
    try { return await this.workspace.writeBytes(source.path, bytes, params.ifMatch, current); }
    catch (error) { if (error instanceof WorkspaceError && error.code === "FILE_TOO_LARGE") return { outcome: "too-large", maxBytes: MCP_VIEWER_MAX_BYTES }; throw error; }
  }
}
