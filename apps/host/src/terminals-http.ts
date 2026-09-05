import { createHash } from "node:crypto";
import type { TerminalControlAction, TerminalInputReceipt, TerminalInputRequest, TerminalInvalidation, TerminalQuery, TerminalViewerLease } from "../../../packages/shared/src/terminals";
import type { WorkspaceTarget } from "../../../packages/shared/src/workspace";
import { TerminalManager, TerminalError } from "./terminals";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalid = (message: string): never => { throw new TerminalError("INVALID_TERMINAL_REQUEST", message); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid("Unknown or malformed terminal request fields.");
  return value as Record<string, unknown>;
}
function id(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) return invalid("A terminal or catalog UUID is required."); return value; }
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return invalid("Invalid terminal sequence or dimensions.");
  return value as number;
}
function target(value: unknown): WorkspaceTarget {
  const item = object(value, ["projectId", "sessionId"]);
  if (Object.keys(item).length !== 1) return invalid("Select one catalog project or session.");
  return "projectId" in item ? { projectId: id(item.projectId) } : { sessionId: id(item.sessionId) };
}
export function parseTerminalQuery(value: unknown): TerminalQuery {
  const item = object(value, ["type", "target", "terminalId", "afterSequence"]);
  if (item.type === "list") { object(item, ["type", "target"]); return { type: "list", ...(item.target === undefined ? {} : { target: target(item.target) }) }; }
  if (item.type === "replay") { object(item, ["type", "terminalId", "afterSequence"]); return { type: "replay", terminalId: id(item.terminalId), afterSequence: item.afterSequence === undefined ? 0 : integer(item.afterSequence, 0, Number.MAX_SAFE_INTEGER) }; }
  return invalid("Unknown terminal query.");
}
export function parseTerminalAction(value: unknown): TerminalControlAction {
  const item = object(value, ["type", "options", "terminalId", "cols", "rows", "viewerId", "afterSequence", "leaseId", "release"]);
  if (item.type === "create") {
    object(item, ["type", "options", "viewerId"]); const options = object(item.options, ["target", "cols", "rows"]);
    return { type: "create", ...(item.viewerId === undefined ? {} : { viewerId: id(item.viewerId) }), options: { target: target(options.target), ...(options.cols === undefined ? {} : { cols: integer(options.cols, 1, 65535) }), ...(options.rows === undefined ? {} : { rows: integer(options.rows, 1, 65535) }) } };
  }
  if (item.type === "resize") { object(item, ["type", "terminalId", "cols", "rows"]); return { type: "resize", terminalId: id(item.terminalId), cols: integer(item.cols, 1, 65535), rows: integer(item.rows, 1, 65535) }; }
  if (item.type === "viewer") {
    object(item, ["type", "terminalId", "viewerId", "afterSequence", "leaseId", "release"]);
    if (item.release !== undefined && typeof item.release !== "boolean") return invalid("Viewer release must be a boolean.");
    return { type: "viewer", terminalId: id(item.terminalId), viewerId: id(item.viewerId), afterSequence: integer(item.afterSequence, 0, Number.MAX_SAFE_INTEGER), ...(item.leaseId === undefined ? {} : { leaseId: id(item.leaseId) }), ...(item.release === undefined ? {} : { release: item.release }) };
  }
  if (item.type === "close" || item.type === "forget") { object(item, ["type", "terminalId"]); return { type: item.type, terminalId: id(item.terminalId) }; }
  return invalid("Unknown terminal action. Input uses the ephemeral input endpoint.");
}
export function parseTerminalInput(value: unknown): TerminalInputRequest {
  const item = object(value, ["terminalId", "clientId", "sequence", "data", "encoding", "reply"]);
  if (typeof item.data !== "string" || (item.encoding !== undefined && item.encoding !== "utf8" && item.encoding !== "base64")) return invalid("Terminal input requires text or base64 bytes.");
  if (item.encoding === "base64" && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data) || Buffer.from(item.data, "base64").toString("base64") !== item.data)) return invalid("Terminal byte input must use canonical base64.");
  if (Buffer.byteLength(item.data, item.encoding === "base64" ? "base64" : "utf8") > 65_536) return invalid("Terminal input must contain at most 64 KiB.");
  const reply = item.reply === undefined ? undefined : object(item.reply, ["leaseId", "outputSequence", "ordinal"]);
  return { terminalId: id(item.terminalId), clientId: id(item.clientId), sequence: integer(item.sequence, 1, Number.MAX_SAFE_INTEGER), data: item.data, ...(item.encoding ? { encoding: item.encoding } : {}), ...(reply ? { reply: { leaseId: id(reply.leaseId), outputSequence: integer(reply.outputSequence, 1, Number.MAX_SAFE_INTEGER), ordinal: integer(reply.ordinal, 1, 2048) } } : {}) };
}
async function json(request: Request): Promise<unknown> {
  if (!request.body) return invalid("A terminal request body is required.");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 512 * 1024) { await reader.cancel(); throw new TerminalError("TERMINAL_REQUEST_TOO_LARGE", "The terminal request body exceeds its limit."); } chunks.push(next.value); }
    try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { return invalid("Terminal requests require valid UTF-8 JSON."); }
  } finally { reader.releaseLock(); }
}
interface InputStream { terminalId: string; lastSequence: number; receipts: Map<number, { hash: string; accepted: boolean }> }
interface ViewerState { lease: TerminalViewerLease; replies: Map<string, string> }

/** Authentication happens in the owning server before this adapter is called. */
export class TerminalsHttp {
  private readonly streams = new Map<string, InputStream>();
  private readonly pending = new Map<string, number>();
  private readonly viewers = new Map<string, ViewerState>();
  private readonly unsubscribe: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: {
    manager: TerminalManager;
    /** Resolve and check removal reservations synchronously, immediately before native create admission. */
    resolveTarget: (target: WorkspaceTarget) => string;
    invalidate: (event: TerminalInvalidation) => void;
    viewerLeaseMs?: number;
  }) {
    this.unsubscribe = options.manager.subscribe(event => {
      if (event.type === "output") {
        this.pending.set(event.terminalId, event.chunk.sequence);
        if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; for (const [terminalId, lastSequence] of this.pending) this.notify({ type: "output", terminalId, lastSequence }); this.pending.clear(); }, 40);
      } else {
        if (event.type === "removed") { this.viewers.delete(event.terminalId); this.pending.delete(event.terminalId); for (const [key, stream] of this.streams) if (stream.terminalId === event.terminalId) this.streams.delete(key); }
        this.notify(event);
      }
    });
  }
  private notify(event: TerminalInvalidation): void {
    try { this.options.invalidate(event); }
    catch { console.error("Terminal invalidation delivery failed; clients can recover by replay."); }
  }
  dispose(): void { this.disposed = true; this.unsubscribe(); if (this.timer) clearTimeout(this.timer); this.pending.clear(); this.streams.clear(); this.viewers.clear(); }

  viewer(terminalId: string, viewerId: string, afterSequence: number, leaseId?: string, release = false): TerminalViewerLease {
    const replay = this.options.manager.replay(terminalId, afterSequence); const now = Date.now(); const duration = this.options.viewerLeaseMs ?? 6000;
    let state = this.viewers.get(terminalId);
    const continuing = state?.lease.viewerId === viewerId && state.lease.leaseId === leaseId && state.lease.expiresAt > now;
    if (!state) {
      // The first attachment renders existing history silently. Output after registration is live.
      state = { lease: { leaseId: crypto.randomUUID(), viewerId, expiresAt: now + duration, startSequence: replay.lastSequence, completedSequence: replay.lastSequence }, replies: new Map() };
      this.viewers.set(terminalId, state);
    } else if (!release && state.lease.expiresAt <= now) {
      state.lease = { ...state.lease, leaseId: crypto.randomUUID(), viewerId, expiresAt: now + duration };
    }
    if (continuing) {
      state.lease.completedSequence = Math.max(state.lease.completedSequence, afterSequence);
      state.lease.expiresAt = release ? 0 : now + duration;
      for (const key of state.replies.keys()) if (Number(key.split(":")[0]) <= state.lease.completedSequence) state.replies.delete(key);
    }
    return structuredClone(state.lease);
  }

  input(input: TerminalInputRequest): TerminalInputReceipt {
    this.options.manager.get(input.terminalId); // An old UUID can never create a replacement shell.
    const key = `${input.terminalId}:${input.clientId}`;
    let stream = this.streams.get(key);
    if (!stream) {
      if (this.streams.size >= 1024) throw new TerminalError("TERMINAL_INPUT_STREAM_LIMIT", "Too many terminal input streams; close and forget an old terminal.");
      stream = { terminalId: input.terminalId, lastSequence: 0, receipts: new Map() };
    }
    const hash = createHash("sha256").update(JSON.stringify({ data: input.data, encoding: input.encoding ?? "utf8", reply: input.reply })).digest("hex");
    if (input.sequence <= stream.lastSequence) {
      const previous = stream.receipts.get(input.sequence);
      if (previous?.hash === hash) return { sequence: input.sequence, duplicate: true, accepted: previous.accepted };
      throw new TerminalError(previous ? "TERMINAL_INPUT_REUSED" : "TERMINAL_INPUT_RECEIPT_EXPIRED", "This input sequence was already used. It will not be sent again.");
    }
    if (input.sequence !== stream.lastSequence + 1) throw new TerminalError("TERMINAL_INPUT_OUT_OF_ORDER", "Terminal input arrived out of order and was not sent.");
    let accepted = true;
    const payload = input.encoding === "base64" ? Buffer.from(input.data, "base64") : input.data;
    if (input.reply) {
      const state = this.viewers.get(input.terminalId); const reply = input.reply;
      accepted = !!state && state.lease.leaseId === reply.leaseId && state.lease.expiresAt > Date.now() && reply.outputSequence > Math.max(state.lease.startSequence, state.lease.completedSequence);
      if (accepted && state) {
        const replay = this.options.manager.replay(input.terminalId); const key = `${reply.outputSequence}:${reply.ordinal}`;
        if (reply.outputSequence > replay.lastSequence || reply.outputSequence < replay.firstSequence) throw new TerminalError("TERMINAL_REPLY_CURSOR_LOST", "The terminal query is no longer in retained output.");
        const replyHash = createHash("sha256").update(payload).digest("hex"); const previous = state.replies.get(key);
        if (!previous) {
          if (state.replies.size >= 2048) throw new TerminalError("TERMINAL_REPLY_LIMIT", "Too many unacknowledged terminal replies.");
          this.options.manager.write(input.terminalId, payload); state.replies.set(key, replyHash);
        }
        // A takeover may calculate a different screen position; the first accepted answer is authoritative.
      }
    } else this.options.manager.write(input.terminalId, payload);
    stream.lastSequence = input.sequence; stream.receipts.set(input.sequence, { hash, accepted });
    while (stream.receipts.size > 128) stream.receipts.delete(stream.receipts.keys().next().value!);
    this.streams.set(key, stream);
    return { sequence: input.sequence, duplicate: false, accepted };
  }

  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!["/v1/terminals/query", "/v1/terminals/action", "/v1/terminals/input"].includes(path)) return null;
    if (this.disposed) return Response.json({ error: { code: "TERMINALS_STOPPING", message: "Terminal routes are stopping." } }, { status: 503 });
    if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST for terminal requests." } }, { status: 405, headers: { Allow: "POST" } });
    try {
      const body = await json(request);
      if (path === "/v1/terminals/query") {
        const query = parseTerminalQuery(body);
        return Response.json(query.type === "list" ? { type: query.type, terminals: this.options.manager.list(query.target) } : { type: query.type, replay: this.options.manager.replay(query.terminalId, query.afterSequence) });
      }
      if (path === "/v1/terminals/input") return Response.json(this.input(parseTerminalInput(body)));
      const action = parseTerminalAction(body);
      if (action.type === "create") {
        const terminal = await this.options.manager.create({ ...action.options, cwd: this.options.resolveTarget(action.options.target) });
        if (action.viewerId) this.viewers.set(terminal.id, { lease: { leaseId: crypto.randomUUID(), viewerId: action.viewerId, expiresAt: Date.now() + (this.options.viewerLeaseMs ?? 6000), startSequence: 0, completedSequence: 0 }, replies: new Map() });
        return Response.json({ terminal, ...(action.viewerId ? { viewer: this.viewers.get(terminal.id)!.lease } : {}) });
      }
      if (action.type === "resize") return Response.json({ terminal: this.options.manager.resize(action.terminalId, action.cols, action.rows) });
      if (action.type === "viewer") return Response.json({ viewer: this.viewer(action.terminalId, action.viewerId, action.afterSequence, action.leaseId, action.release) });
      if (action.type === "close") return Response.json({ terminal: await this.options.manager.close(action.terminalId) });
      this.options.manager.forget(action.terminalId); return Response.json({});
    } catch (error) {
      const code = error instanceof TerminalError ? error.code : "TERMINAL_REQUEST_FAILED";
      const status = code === "TERMINAL_NOT_FOUND" || code === "WORKSPACE_NOT_FOUND" ? 404 : code === "TERMINAL_REQUEST_TOO_LARGE" ? 413 : code.startsWith("INVALID_") ? 400 : 409;
      return Response.json({ error: { code, message: error instanceof Error ? error.message : "The terminal request failed." } }, { status });
    }
  }
}
