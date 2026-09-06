import type { LocalEnvironmentWorkerEnvironment } from "../local-environments/environment";
import type { NativeTerminalAction, NativeTerminalInputRequest, NativeTerminalInvalidation, NativeTerminalQuery } from "../../../../packages/shared/src/terminals";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace";
import { TerminalError } from "./error";
import { validateNativeInput } from "./native-input";
import { TmuxTerminalManager } from "./native-manager";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalid = (message: string): never => { throw new TerminalError("INVALID_NATIVE_TERMINAL_REQUEST", message); };
function object(value: unknown, fields: readonly string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) return invalid("Unknown or malformed native terminal request fields."); return value as Record<string, unknown>; }
function id(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) return invalid("A native terminal, attachment or catalog UUID is required."); return value; }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return invalid("Invalid native terminal sequence or dimensions."); return value as number; }
function target(value: unknown): WorkspaceTarget { const item = object(value, ["projectId", "sessionId"]); if (Object.keys(item).length !== 1) return invalid("Select one catalog project or session."); return "projectId" in item ? { projectId: id(item.projectId) } : { sessionId: id(item.sessionId) }; }
export function parseNativeTerminalQuery(value: unknown): NativeTerminalQuery {
  const item = object(value, ["type", "target", "terminalId", "attachmentId", "afterSequence"]);
  if (item.type === "list") { object(item, ["type", "target"]); return { type: "list", ...(item.target === undefined ? {} : { target: target(item.target) }) }; }
  if (item.type === "history") { object(item, ["type", "terminalId"]); return { type: "history", terminalId: id(item.terminalId) }; }
  if (item.type === "replay") { object(item, ["type", "attachmentId", "afterSequence"]); return { type: "replay", attachmentId: id(item.attachmentId), afterSequence: integer(item.afterSequence) }; }
  return invalid("Unknown native terminal query.");
}
export function parseNativeTerminalAction(value: unknown): NativeTerminalAction {
  const item = object(value, ["type", "options", "terminalId", "viewerId", "attachmentId", "afterSequence", "geometryRevision", "cols", "rows", "outputSequence", "ordinal", "data", "focused"]);
  if (item.type === "create") { object(item, ["type", "options"]); const options = object(item.options, ["target", "cols", "rows"]); return { type: "create", options: { target: target(options.target), ...(options.cols === undefined ? {} : { cols: integer(options.cols, 1, 65535) }), ...(options.rows === undefined ? {} : { rows: integer(options.rows, 1, 65535) }) } }; }
  if (item.type === "attach") { object(item, ["type", "terminalId", "viewerId"]); return { type: "attach", terminalId: id(item.terminalId), viewerId: id(item.viewerId) }; }
  if (item.type === "detach") { object(item, ["type", "attachmentId"]); return { type: "detach", attachmentId: id(item.attachmentId) }; }
  if (item.type === "focus") { object(item, ["type", "attachmentId", "focused"]); if (typeof item.focused !== "boolean") return invalid("Native attachment focus must be a boolean."); return { type: "focus", attachmentId: id(item.attachmentId), focused: item.focused }; }
  if (item.type === "heartbeat") { object(item, ["type", "attachmentId", "afterSequence", "geometryRevision"]); return { type: "heartbeat", attachmentId: id(item.attachmentId), afterSequence: integer(item.afterSequence), geometryRevision: integer(item.geometryRevision, 1) }; }
  if (item.type === "resize") { object(item, ["type", "terminalId", "attachmentId", "geometryRevision", "cols", "rows"]); return { type: "resize", terminalId: id(item.terminalId), attachmentId: id(item.attachmentId), geometryRevision: integer(item.geometryRevision, 1), cols: integer(item.cols, 1, 65535), rows: integer(item.rows, 1, 65535) }; }
  if (item.type === "reply") { object(item, ["type", "attachmentId", "outputSequence", "ordinal", "data"]); if (typeof item.data !== "string" || Buffer.byteLength(item.data) > 4096) return invalid("A native parser reply exceeds its bound."); return { type: "reply", attachmentId: id(item.attachmentId), outputSequence: integer(item.outputSequence, 1), ordinal: integer(item.ordinal, 1, 2048), data: item.data }; }
  if (item.type === "close" || item.type === "forget") { object(item, ["type", "terminalId"]); return { type: item.type, terminalId: id(item.terminalId) }; }
  return invalid("Unknown native terminal action.");
}
export function parseNativeTerminalInput(value: unknown): NativeTerminalInputRequest {
  const item = object(value, ["terminalId", "attachmentId", "inputEpoch", "geometryRevision", "clientId", "sequence", "input"]);
  validateNativeInput(item.input as NativeTerminalInputRequest["input"]);
  return { terminalId: id(item.terminalId), attachmentId: id(item.attachmentId), inputEpoch: id(item.inputEpoch), geometryRevision: integer(item.geometryRevision, 1), clientId: id(item.clientId), sequence: integer(item.sequence, 1), input: item.input as NativeTerminalInputRequest["input"] };
}
async function body(request: Request): Promise<unknown> {
  if (!request.body) return invalid("A native terminal request body is required.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of request.body) { bytes += chunk.byteLength; if (bytes > 512 * 1024) throw new TerminalError("TERMINAL_REQUEST_TOO_LARGE", "The native terminal request exceeds its bound."); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return invalid("Native terminal requests require valid UTF-8 JSON."); }
}
/** The existing local bearer/Tailscale boundary MUST authenticate before calling this adapter. */
export class TmuxTerminalsHttp {
  private readonly unsubscribe: () => void;
  private readonly pending = new Map<string, Extract<NativeTerminalInvalidation, { type: "output" }>>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly options: { manager: TmuxTerminalManager; resolveTarget: (target: WorkspaceTarget) => string;
    /** Host-private setup exports; never accepted from terminal request bodies. */
    environmentForTarget?: (target: WorkspaceTarget) => LocalEnvironmentWorkerEnvironment | undefined; invalidate: (event: NativeTerminalInvalidation) => void }) {
    this.unsubscribe = options.manager.subscribe(event => {
      if (event.type === "output") { this.pending.set(event.attachmentId, event); if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; for (const value of this.pending.values()) this.notify(value); this.pending.clear(); }, 40); }
      else { if (event.type === "detached") this.pending.delete(event.attachmentId); this.notify(event); }
    });
  }
  private notify(event: NativeTerminalInvalidation): void { try { this.options.invalidate(event); } catch { console.error("Native terminal invalidation delivery failed; attached clients can resync."); } }
  dispose(): void { this.disposed = true; this.unsubscribe(); clearTimeout(this.timer); this.pending.clear(); }
  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!["/v2/terminals/capabilities", "/v2/terminals/query", "/v2/terminals/action", "/v2/terminals/input"].includes(path)) return null;
    if (this.disposed) return Response.json({ error: { code: "TERMINALS_STOPPING", message: "Native terminal routes are stopping." } }, { status: 503 });
    const method = path.endsWith("/capabilities") ? "GET" : "POST";
    if (request.method !== method) return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: `Use ${method} for this native terminal endpoint.` } }, { status: 405, headers: { Allow: method } });
    try {
      if (path.endsWith("/capabilities")) return Response.json(this.options.manager.capabilities());
      const value = await body(request);
      if (path.endsWith("/input")) return Response.json(await this.options.manager.input(parseNativeTerminalInput(value)));
      if (path.endsWith("/query")) {
        const query = parseNativeTerminalQuery(value);
        if (query.type === "list") return Response.json({ type: "list", terminals: this.options.manager.list(query.target) });
        if (query.type === "history") return Response.json({ type: "history", history: await this.options.manager.history(query.terminalId) });
        return Response.json({ type: "replay", replay: this.options.manager.replay(query.attachmentId, query.afterSequence) });
      }
      const action = parseNativeTerminalAction(value);
      if (action.type === "create") return Response.json({ terminal: await this.options.manager.create({ ...action.options, cwd: this.options.resolveTarget(action.options.target) }, this.options.environmentForTarget?.(action.options.target)) });
      if (action.type === "attach") return Response.json({ attachment: await this.options.manager.attach(action.terminalId, action.viewerId), terminal: this.options.manager.get(action.terminalId) });
      if (action.type === "detach") { await this.options.manager.detach(action.attachmentId); return Response.json({}); }
      if (action.type === "focus") { this.options.manager.focus(action.attachmentId, action.focused); return Response.json({ accepted: true }); }
      if (action.type === "heartbeat") return Response.json({ attachment: this.options.manager.heartbeat(action.attachmentId, action.afterSequence, action.geometryRevision) });
      if (action.type === "reply") return Response.json({ accepted: this.options.manager.reply(action.attachmentId, action.outputSequence, action.ordinal, action.data) });
      if (action.type === "resize") return Response.json({ terminal: await this.options.manager.resize(action.terminalId, action.attachmentId, action.geometryRevision, action.cols, action.rows) });
      if (action.type === "close") return Response.json({ terminal: await this.options.manager.close(action.terminalId) });
      await this.options.manager.forget(action.terminalId); return Response.json({});
    } catch (error) {
      const code = error instanceof TerminalError ? error.code : "NATIVE_TERMINAL_REQUEST_FAILED";
      const status = code === "TERMINAL_NOT_FOUND" ? 404 : code === "TERMINAL_REQUEST_TOO_LARGE" ? 413 : code.startsWith("INVALID_") ? 400 : 409;
      return Response.json({ error: { code, message: error instanceof Error ? error.message : "The native terminal request failed." } }, { status });
    }
  }
}
