/** Native Todos are branch state. Tickets bind edits to one loaded native owner;
 * command receipts live in the existing host journal, never a second Todo store. */
export const SESSION_TODOS_OWNER_HEADER = "X-Agent-Todos-Host-Id";
export const SESSION_TODOS_CAPABILITY = { version: 1, commandVersion: 22 } as const;
export const MAX_TODO_BYTES = 1024 * 1024;
export const MAX_TODO_COMMAND_CHARS = 65536;
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export interface TodoTask { content: string; status: TodoStatus; blocker?: string }
export interface TodoPhase { name: string; tasks: TodoTask[] }
export interface TodoTicket { nativeSessionId: string; epoch: string; revision: string }
export interface SessionTodos {
  ticket: TodoTicket;
  phases: TodoPhase[];
  /** Exact native phasesToMarkdown output, including its final newline. */
  markdown: string;
  nativeCommandAvailable: boolean;
  reconciliationRequired: boolean;
  busyReason?: string;
}
export type TodoMutation = { action: "command"; text: string } | { action: "edit"; markdown: string };
export interface TodoMutationRequest { sessionId: string; ticket: TodoTicket; mutation: TodoMutation }
export interface TodoMutationResult { commandId: string; state: SessionTodos; output: string; desktopAction?: "show" | "edit" | "expand" | "collapse" | "copy" }
export interface TodoJournalReceipt {
  commandId: string;
  state: "absent" | "pending" | "unknown" | "failed" | "succeeded";
  result?: TodoMutationResult;
  error?: string;
}
export interface SessionTodosResponse { hostId: string; sessionId: string; todos: SessionTodos | null; unavailable?: string; receipt?: TodoJournalReceipt }
const encoder = new TextEncoder();
function invalid(field: string): never { throw new Error(`Invalid native Todos ${field}.`); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(key);
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.length) || value.length > max || value.includes("\0")) return invalid("text");
  return value;
}
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid("boolean"); }
export function parseTodoCommandId(value: unknown): string {
  const id = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) invalid("command identity"); return id;
}
export function parseTodoTicket(value: unknown): TodoTicket {
  const v = record(value, ["nativeSessionId", "epoch", "revision"]);
  return { nativeSessionId: text(v.nativeSessionId), epoch: text(v.epoch), revision: text(v.revision) };
}
/** Refuse unsupported/oversized native state rather than silently truncating it. */
export function parseTodoPhases(value: unknown): TodoPhase[] {
  if (!Array.isArray(value) || value.length > 512) return invalid("phases");
  let tasks = 0, bytes = 0;
  const add = (v: string) => { bytes += encoder.encode(v).length; if (bytes > MAX_TODO_BYTES) invalid("state size"); return v; };
  return value.map(raw => {
    const phase = record(raw, ["name", "tasks"]);
    if (!Array.isArray(phase.tasks) || (tasks += phase.tasks.length) > 10000) return invalid("tasks");
    return { name: add(text(phase.name, MAX_TODO_BYTES, true)), tasks: phase.tasks.map(rawTask => {
      const task = record(rawTask, ["content", "status", "blocker"]);
      if (!["pending", "in_progress", "completed", "abandoned", "blocked"].includes(String(task.status))) invalid("status");
      return { content: add(text(task.content, MAX_TODO_BYTES, true)), status: task.status as TodoStatus,
        ...(task.blocker === undefined ? {} : { blocker: add(text(task.blocker, MAX_TODO_BYTES, true)) }) };
    }) };
  });
}
export function parseSessionTodos(value: unknown): SessionTodos {
  const v = record(value, ["ticket", "phases", "markdown", "nativeCommandAvailable", "reconciliationRequired", "busyReason"]);
  const markdown = text(v.markdown, MAX_TODO_BYTES * 2, true);
  if (encoder.encode(markdown).length > MAX_TODO_BYTES * 2) invalid("Markdown size");
  return { ticket: parseTodoTicket(v.ticket), phases: parseTodoPhases(v.phases), markdown,
    nativeCommandAvailable: bool(v.nativeCommandAvailable), reconciliationRequired: bool(v.reconciliationRequired),
    ...(v.busyReason === undefined ? {} : { busyReason: text(v.busyReason, 4096) }) };
}
export function parseTodoMutationRequest(value: unknown): TodoMutationRequest {
  const v = record(value, ["sessionId", "ticket", "mutation"]), mutation = record(v.mutation, ["action", "text", "markdown"]);
  let parsed: TodoMutation;
  if (mutation.action === "command") {
    if (mutation.markdown !== undefined) invalid("command fields");
    const command = text(mutation.text, MAX_TODO_COMMAND_CHARS);
    if (!/^\/todo(?:[\s:]|$)/.test(command)) invalid("command");
    parsed = { action: "command", text: command };
  } else if (mutation.action === "edit") {
    if (mutation.text !== undefined) invalid("edit fields");
    const markdown = text(mutation.markdown, MAX_TODO_BYTES, true);
    if (encoder.encode(markdown).length > MAX_TODO_BYTES) invalid("Markdown size");
    parsed = { action: "edit", markdown };
  } else return invalid("mutation");
  const sessionId = text(v.sessionId), ticket = parseTodoTicket(v.ticket);
  if (sessionId !== ticket.nativeSessionId) invalid("mutation owner");
  return { sessionId, ticket, mutation: parsed };
}
export function parseTodoMutationResult(value: unknown, commandId?: string): TodoMutationResult {
  const v = record(value, ["commandId", "state", "output", "desktopAction"]), id = parseTodoCommandId(v.commandId);
  if (commandId !== undefined && commandId !== id) invalid("result identity");
  if (v.desktopAction !== undefined && !["show", "edit", "expand", "collapse", "copy"].includes(String(v.desktopAction))) invalid("desktop action");
  return { commandId: id, state: parseSessionTodos(v.state), output: text(v.output, MAX_TODO_BYTES * 2, true),
    ...(v.desktopAction === undefined ? {} : { desktopAction: v.desktopAction as TodoMutationResult["desktopAction"] }) };
}
export function parseTodoJournalReceipt(value: unknown, commandId: string): TodoJournalReceipt {
  const v = record(value, ["commandId", "state", "result", "error"]);
  if (parseTodoCommandId(v.commandId) !== commandId || !["absent", "pending", "unknown", "failed", "succeeded"].includes(String(v.state))) invalid("receipt identity");
  if ((v.state === "succeeded") !== (v.result !== undefined)) invalid("receipt result");
  return { commandId, state: v.state as TodoJournalReceipt["state"],
    ...(v.result === undefined ? {} : { result: parseTodoMutationResult(v.result, commandId) }),
    ...(v.error === undefined ? {} : { error: text(v.error, 4096) }) };
}
export function parseSessionTodosResponse(value: unknown, hostId: string, sessionId: string, commandId?: string): SessionTodosResponse {
  const v = record(value, ["hostId", "sessionId", "todos", "unavailable", "receipt"]);
  if (v.hostId !== hostId || v.sessionId !== sessionId) invalid("response owner");
  const todos = v.todos === null ? null : parseSessionTodos(v.todos);
  if (todos && todos.ticket.nativeSessionId !== sessionId) invalid("native owner");
  if ((commandId !== undefined) !== (v.receipt !== undefined)) invalid("receipt presence");
  const receipt = commandId === undefined ? undefined : parseTodoJournalReceipt(v.receipt, commandId);
  if (receipt?.result && receipt.result.state.ticket.nativeSessionId !== sessionId) invalid("receipt owner");
  return { hostId, sessionId, todos, ...(v.unavailable === undefined ? {} : { unavailable: text(v.unavailable, 4096) }),
    ...(receipt === undefined ? {} : { receipt }) };
}
