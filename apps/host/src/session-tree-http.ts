import { SESSION_TREE_OWNER_HEADER, parseTreeCommandId, parseTreeJournalReceipt, parseTreeMutationRequest,
  parseTreeMutationResult, parseSessionTreeResponse, type SessionTree, type TreeJournalReceipt,
  type TreeMutationRequest, type TreeMutationResult } from "../../../packages/shared/src/session-tree";
import type { CommandRecord } from "./store";

export interface SessionTreeOwner {
  getTree(): Promise<SessionTree>;
  mutateTree(commandId: string, request: TreeMutationRequest): Promise<TreeMutationResult>;
}
interface Owners {
  sessionExists(id: string): boolean;
  existing(id: string): Promise<SessionTreeOwner | undefined>;
}
const unknown = () => Object.assign(new Error("The original Tree outcome could not be confirmed. Inspect the original command; it was not replayed."), { code: "OUTCOME_UNKNOWN" });
const rejected = (message: string) => Object.assign(new Error(message), { code: "TREE_REJECTED" });

/** Uses the already-loaded worker only. The server's durable command journal
 * serializes/deduplicates calls; this boundary must never reopen or replay one. */
export async function mutateSessionTree(owners: Owners, commandId: string, raw: TreeMutationRequest): Promise<TreeMutationResult> {
  let request: TreeMutationRequest;
  try { parseTreeCommandId(commandId); request = parseTreeMutationRequest(raw); }
  catch { throw rejected("Invalid native Tree mutation. Nothing was dispatched."); }
  if (!owners.sessionExists(request.sessionId)) throw rejected("The original Tree session no longer exists.");
  const owner = await owners.existing(request.sessionId);
  if (!owner || !owners.sessionExists(request.sessionId) || await owners.existing(request.sessionId) !== owner)
    throw rejected("The original Tree worker is unavailable. Open and inspect the original session.");
  let result: TreeMutationResult;
  try { result = parseTreeMutationResult(await owner.mutateTree(commandId, request), commandId); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "TREE_REJECTED") throw error;
    throw unknown();
  }
  if (!owners.sessionExists(request.sessionId) || await owners.existing(request.sessionId) !== owner
    || result.state.ticket.nativeSessionId !== request.ticket.nativeSessionId || result.state.ticket.epoch !== request.ticket.epoch)
    throw unknown();
  return result;
}

/** Orphaned pending journal records are unknown, never implicit retries. */
export function projectTreeJournalReceipt(entry: CommandRecord | undefined, sessionId: string, commandId: string, active: boolean): TreeJournalReceipt {
  parseTreeCommandId(commandId);
  const command = entry?.command;
  if (entry?.id === commandId && command?.type === "session.prompt" && command.treeTicket && command.sessionId === sessionId) {
    if (entry.state === "pending") return { commandId, state: active ? "pending" : "unknown" };
    const result = entry.result;
    if (!result || result.commandId !== commandId) return { commandId, state: "unknown" };
    if (!result.ok) return { commandId, state: result.error.code === "OUTCOME_UNKNOWN" ? "unknown" : "failed", error: result.error.message.slice(0, 4096) };
    const admission = result.admission;
    return admission ? { commandId, state: "succeeded", submission: { kind: admission.kind, ...(admission.entryId ? { entryId: admission.entryId } : {}) } } : { commandId, state: "unknown" };
  }
  if (!entry || entry.id !== commandId || command?.type !== "session.tree.mutate" || command.sessionId !== sessionId)
    return { commandId, state: "absent" };
  if (entry.state === "pending") return { commandId, state: active ? "pending" : "unknown" };
  const result = entry.result;
  if (!result || result.commandId !== commandId) return { commandId, state: "unknown" };
  if (!result.ok) return { commandId, state: result.error.code === "TREE_REJECTED" ? "failed" : "unknown", error: result.error.message.slice(0, 4096) };
  if (!result.value || !("type" in result.value) || result.value.type !== "session.tree.mutate") return { commandId, state: "unknown" };
  try {
    const value = parseTreeMutationResult(result.value.result, commandId);
    if (value.state.ticket.nativeSessionId !== sessionId || value.state.ticket.epoch !== command.ticket.epoch) return { commandId, state: "unknown" };
    return { commandId, state: "succeeded", result: value };
  } catch { return { commandId, state: "unknown" }; }
}

/** Mounted after host authentication. Reading creates neither workers nor history. */
export class SessionTreeHttp {
  constructor(private readonly options: Owners & { hostId: string; receipt(sessionId: string, commandId: string): TreeJournalReceipt }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/tree$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [SESSION_TREE_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_TREE_OWNER_HEADER) !== this.options.hostId)
      return fail(409, "OWNER_MISMATCH", "The Tree owner does not match this host.");
    if (request.method !== "GET") return fail(405, "INVALID_TREE_REQUEST", "Use GET to inspect native Tree.");
    let sessionId: string, commandId: string | undefined;
    try {
      if (match[1]!.length > 600 || url.search.length > 4096) throw new Error("Invalid target");
      sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.includes("\0") || new TextEncoder().encode(sessionId).length > 200) throw new Error("Invalid target");
      if ([...url.searchParams.keys()].some(key => key !== "commandId") || url.searchParams.getAll("commandId").length > 1) throw new Error("Invalid query");
      const raw = url.searchParams.get("commandId");
      commandId = raw === null ? undefined : parseTreeCommandId(raw);
    } catch { return fail(400, "INVALID_TREE_REQUEST", "Invalid native Tree target or receipt identity."); }
    if (!this.options.sessionExists(sessionId)) return fail(409, "STALE_TARGET", "The original Tree session no longer exists.");
    let receipt: TreeJournalReceipt | undefined;
    if (commandId !== undefined) {
      try { receipt = parseTreeJournalReceipt(this.options.receipt(sessionId, commandId), commandId); }
      catch { receipt = { commandId, state: "unknown" }; }
    }
    let tree: SessionTree | null = null;
    let unavailable = "This session has no loaded Tree owner. Open the original session to inspect it.";
    try {
      const owner = await this.options.existing(sessionId);
      const raw = owner ? await owner.getTree() : null;
      if (owner && await this.options.existing(sessionId) !== owner) throw new Error("Owner changed");
      tree = parseSessionTreeResponse({ hostId: this.options.hostId, sessionId, tree: raw }, this.options.hostId, sessionId).tree;
    } catch { unavailable = "The original native Tree could not be read. Refresh to inspect; no mutation was replayed."; }
    if (!this.options.sessionExists(sessionId)) return fail(409, "STALE_TARGET", "The original Tree session retired during inspection.");
    const serialize = () => JSON.stringify(parseSessionTreeResponse({ hostId: this.options.hostId, sessionId, tree,
      ...(tree === null ? { unavailable } : {}), ...(receipt ? { receipt } : {}) }, this.options.hostId, sessionId, commandId));
    let body = serialize();
    if (new TextEncoder().encode(body).length > 16 * 1024 * 1024) {
      tree = null; unavailable = "The complete native Tree exceed the transport limit. Native state is unchanged.";
      if (commandId !== undefined) receipt = { commandId, state: "unknown" };
      body = serialize();
    }
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  }
}
