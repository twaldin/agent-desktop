import { SESSION_TODOS_OWNER_HEADER, parseTodoCommandId, parseTodoJournalReceipt, parseTodoMutationRequest,
  parseTodoMutationResult, parseSessionTodosResponse, type SessionTodos, type TodoJournalReceipt,
  type TodoMutationRequest, type TodoMutationResult } from "../../../packages/shared/src/session-todos";
import type { CommandRecord } from "./store";

export interface SessionTodosOwner {
  getTodos(): Promise<SessionTodos>;
  mutateTodos(commandId: string, request: TodoMutationRequest): Promise<TodoMutationResult>;
}
interface Owners {
  sessionExists(id: string): boolean;
  existing(id: string): Promise<SessionTodosOwner | undefined>;
}
const unknown = () => Object.assign(new Error("The original Todos outcome could not be confirmed. Inspect the original command; it was not replayed."), { code: "OUTCOME_UNKNOWN" });
const rejected = (message: string) => Object.assign(new Error(message), { code: "TODOS_REJECTED" });

/** Uses the already-loaded worker only. The server's durable command journal
 * serializes/deduplicates calls; this boundary must never reopen or replay one. */
export async function mutateSessionTodos(owners: Owners, commandId: string, raw: TodoMutationRequest): Promise<TodoMutationResult> {
  let request: TodoMutationRequest;
  try { parseTodoCommandId(commandId); request = parseTodoMutationRequest(raw); }
  catch { throw rejected("Invalid native Todos mutation. Nothing was dispatched."); }
  if (!owners.sessionExists(request.sessionId)) throw rejected("The original Todos session no longer exists.");
  const owner = await owners.existing(request.sessionId);
  if (!owner || !owners.sessionExists(request.sessionId) || await owners.existing(request.sessionId) !== owner)
    throw rejected("The original Todos worker is unavailable. Open and inspect the original session.");
  let result: TodoMutationResult;
  try { result = parseTodoMutationResult(await owner.mutateTodos(commandId, request), commandId); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "TODOS_REJECTED") throw error;
    throw unknown();
  }
  if (!owners.sessionExists(request.sessionId) || await owners.existing(request.sessionId) !== owner
    || result.state.ticket.nativeSessionId !== request.ticket.nativeSessionId || result.state.ticket.epoch !== request.ticket.epoch)
    throw unknown();
  return result;
}

/** Orphaned pending journal records are unknown, never implicit retries. */
export function projectTodoJournalReceipt(entry: CommandRecord | undefined, sessionId: string, commandId: string, active: boolean): TodoJournalReceipt {
  parseTodoCommandId(commandId);
  const command = entry?.command;
  if (!entry || entry.id !== commandId || command?.type !== "session.todos.mutate" || command.sessionId !== sessionId)
    return { commandId, state: "absent" };
  if (entry.state === "pending") return { commandId, state: active ? "pending" : "unknown" };
  const result = entry.result;
  if (!result || result.commandId !== commandId) return { commandId, state: "unknown" };
  if (!result.ok) return { commandId, state: result.error.code === "TODOS_REJECTED" ? "failed" : "unknown", error: result.error.message.slice(0, 4096) };
  if (!result.value || !("type" in result.value) || result.value.type !== "session.todos.mutate") return { commandId, state: "unknown" };
  try {
    const value = parseTodoMutationResult(result.value.result, commandId);
    if (value.state.ticket.nativeSessionId !== sessionId || value.state.ticket.epoch !== command.ticket.epoch) return { commandId, state: "unknown" };
    return { commandId, state: "succeeded", result: value };
  } catch { return { commandId, state: "unknown" }; }
}

/** Mounted after host authentication. Reading creates neither workers nor history. */
export class SessionTodosHttp {
  constructor(private readonly options: Owners & { hostId: string; receipt(sessionId: string, commandId: string): TodoJournalReceipt }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/todos$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [SESSION_TODOS_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_TODOS_OWNER_HEADER) !== this.options.hostId)
      return fail(409, "OWNER_MISMATCH", "The Todos owner does not match this host.");
    if (request.method !== "GET") return fail(405, "INVALID_TODOS_REQUEST", "Use GET to inspect native Todos.");
    let sessionId: string, commandId: string | undefined;
    try {
      if (match[1]!.length > 600 || url.search.length > 4096) throw new Error("Invalid target");
      sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.includes("\0") || new TextEncoder().encode(sessionId).length > 200) throw new Error("Invalid target");
      if ([...url.searchParams.keys()].some(key => key !== "commandId") || url.searchParams.getAll("commandId").length > 1) throw new Error("Invalid query");
      const raw = url.searchParams.get("commandId");
      commandId = raw === null ? undefined : parseTodoCommandId(raw);
    } catch { return fail(400, "INVALID_TODOS_REQUEST", "Invalid native Todos target or receipt identity."); }
    if (!this.options.sessionExists(sessionId)) return fail(409, "STALE_TARGET", "The original Todos session no longer exists.");
    let receipt: TodoJournalReceipt | undefined;
    if (commandId !== undefined) {
      try { receipt = parseTodoJournalReceipt(this.options.receipt(sessionId, commandId), commandId); }
      catch { receipt = { commandId, state: "unknown" }; }
    }
    let todos: SessionTodos | null = null;
    let unavailable = "This session has no loaded Todos owner. Open the original session to inspect it.";
    try {
      const owner = await this.options.existing(sessionId);
      const raw = owner ? await owner.getTodos() : null;
      if (owner && await this.options.existing(sessionId) !== owner) throw new Error("Owner changed");
      todos = parseSessionTodosResponse({ hostId: this.options.hostId, sessionId, todos: raw }, this.options.hostId, sessionId).todos;
    } catch { unavailable = "The original native Todos could not be read. Refresh to inspect; no mutation was replayed."; }
    if (!this.options.sessionExists(sessionId)) return fail(409, "STALE_TARGET", "The original Todos session retired during inspection.");
    const serialize = () => JSON.stringify(parseSessionTodosResponse({ hostId: this.options.hostId, sessionId, todos,
      ...(todos === null ? { unavailable } : {}), ...(receipt ? { receipt } : {}) }, this.options.hostId, sessionId, commandId));
    let body = serialize();
    if (new TextEncoder().encode(body).length > 16 * 1024 * 1024) {
      todos = null; unavailable = "The complete native Todos exceed the transport limit. Native state is unchanged.";
      if (commandId !== undefined) receipt = { commandId, state: "unknown" };
      body = serialize();
    }
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  }
}
