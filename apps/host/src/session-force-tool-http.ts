import {
  SESSION_FORCE_TOOL_OWNER_HEADER, parseForceToolCommandId, parseForceToolJournalReceipt,
  parseForceToolReceipt, parseForceToolResponse, parseForceToolState,
  type ForceToolJournalReceipt, type ForceToolResponse, type ForceToolState,
} from "../../../packages/shared/src/force-tool";
import type { CommandRecord } from "./store";

/** Projects only the existing command journal. A historical arm never supplies
 * live state and never creates or restores a native directive. */
export function projectForceToolJournalReceipt(
  entry: CommandRecord | undefined, sessionId: string, commandId: string, active: boolean,
): ForceToolJournalReceipt {
  parseForceToolCommandId(commandId);
  if (!entry || entry.id !== commandId || entry.command?.type !== "session.prompt" || entry.command.sessionId !== sessionId)
    return { commandId, state: "absent" };
  if (entry.state === "pending") return { commandId, state: active ? "pending" : "unknown" };
  const result = entry.result;
  if (!result || result.commandId !== commandId) return { commandId, state: "unknown" };
  const state = result.ok ? "succeeded" : result.error.code === "OUTCOME_UNKNOWN" ? "unknown" : "failed";
  const raw = "forceToolReceipt" in result ? result.forceToolReceipt : undefined;
  try {
    return parseForceToolJournalReceipt({ commandId, state, ...(raw === undefined ? {} : { forceToolReceipt: parseForceToolReceipt(raw, commandId) }) }, commandId);
  } catch {
    // Corrupt persisted evidence cannot be reclassified as absent or success.
    return { commandId, state: "unknown" };
  }
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const READ_TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();
async function bounded<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Force state read timed out")), READ_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

/** Mount behind the host's existing bearer authorization check, like SessionMcpHttp.
 * The only runtime capability supplied here is an existing-handle read. */
export class SessionForceToolHttp {
  constructor(private readonly options: {
    hostId: string;
    receipt: (sessionId: string, commandId: string) => ForceToolJournalReceipt;
    sessionExists: (id: string) => boolean;
    existing: (id: string) => Promise<{ getForceToolState(): Promise<ForceToolState> } | undefined>;
  }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/force-tool$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [SESSION_FORCE_TOOL_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_FORCE_TOOL_OWNER_HEADER) !== this.options.hostId)
      return fail(409, "OWNER_MISMATCH", "The force-tool session owner no longer matches this endpoint.");
    if (request.method !== "GET") return fail(405, "INVALID_FORCE_TOOL_REQUEST", "Use GET for native force-tool state.");
    let sessionId: string, commandId: string | undefined;
    try {
      if (url.search.length > 4096 || match[1]!.length > 600) throw new Error("Oversized target");
      sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || encoder.encode(sessionId).byteLength > 200 || sessionId.includes("\0")) throw new Error("Invalid session");
      if ([...url.searchParams.keys()].some(key => key !== "commandId") || url.searchParams.getAll("commandId").length > 1) throw new Error("Invalid query");
      const raw = url.searchParams.get("commandId");
      commandId = raw === null ? undefined : parseForceToolCommandId(raw);
    } catch { return fail(400, "INVALID_FORCE_TOOL_REQUEST", "Invalid force-tool state or receipt request."); }
    if (!this.options.sessionExists(sessionId)) return fail(409, "STALE_TARGET", "The selected force-tool session no longer exists on this host.");
    let receipt: ForceToolJournalReceipt | undefined;
    if (commandId !== undefined) {
      try { receipt = parseForceToolJournalReceipt(this.options.receipt(sessionId, commandId), commandId); }
      catch { receipt = { commandId, state: "unknown" }; }
    }
    let value: ForceToolState | null = null;
    let unavailable = "This session has no loaded native runtime. Historical force receipts do not restore its volatile queue.";
    try {
      value = await bounded(async () => {
        const handle = await this.options.existing(sessionId);
        return handle ? parseForceToolState(await handle.getForceToolState()) : null;
      });
    } catch { unavailable = "Native force-tool state could not be read. Refresh after its worker reconnects; do not rearm the original command."; }
    // Recheck the host's session lifetime after the asynchronous worker boundary.
    if (!this.options.sessionExists(sessionId)) return fail(409, "STALE_TARGET", "The selected force-tool session no longer exists on this host.");
    const response = (): ForceToolResponse => parseForceToolResponse({ protocolVersion: 1, hostId: this.options.hostId, sessionId, value,
      ...(value === null ? { unavailable } : {}), ...(receipt === undefined ? {} : { receipt }) }, this.options.hostId, sessionId, commandId);
    let body = JSON.stringify(response());
    if (encoder.encode(body).byteLength > MAX_RESPONSE_BYTES) {
      value = null;
      unavailable = "Native force-tool state exceeds the bounded read limit. The live queue was not changed.";
      body = JSON.stringify(response());
    }
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  }
}
