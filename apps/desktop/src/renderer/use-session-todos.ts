import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { DesktopBridge, DesktopEvent } from "../../../../packages/shared/src/protocol";
import { parseSessionTodosResponse, parseTodoCommandId, parseTodoMutationRequest, parseTodoMutationResult, SESSION_TODOS_CAPABILITY,
  type SessionTodos, type TodoJournalReceipt, type TodoMutationRequest, type TodoMutationResult } from "../../../../packages/shared/src/session-todos";

/** Proven no-effect refusal: local admission or an explicit host rejection code. */
export class TodosNotSubmitted extends Error {}
export interface SessionTodosOwner { hostId: string; sessionId: string }
export interface SessionTodosPorts {
  bridge: Pick<DesktopBridge, "getSessionTodos" | "command" | "subscribe">;
  storage?: { read(key: string): string | null; write(key: string, value: string): void; remove(key: string): void };
}
export interface SessionTodosView {
  owner: SessionTodosOwner; value: SessionTodos | null; fresh: boolean; loading: boolean; pending: boolean; uncertain: boolean;
  /** Outcome of the latest change: refusal or unconfirmed-command guidance. */
  error?: string;
  /** Latest failed read; cleared by the next successful read. */
  readError?: string;
  unavailable?: string;
  /** Retained original command awaiting journal inspection. Never resent. */
  original?: { commandId: string; request: TodoMutationRequest };
  receipt?: TodoJournalReceipt;
  /** Exact native output of the latest confirmed change. */
  output?: string;
}
type TodosEnvelope = { id: string; commandVersion: typeof SESSION_TODOS_CAPABILITY.commandVersion; command: { type: "session.todos.mutate" } & TodoMutationRequest };
const refusedCodes: Record<string, true> = { TODOS_REJECTED: true, TODOS_PROTOCOL_UNSUPPORTED: true };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const receiptGuidance: Record<Exclude<TodoJournalReceipt["state"], "succeeded" | "failed">, string> = {
  pending: "The original Todos command is still pending on the owning host. Check status without repeating it.",
  unknown: "The original Todos command outcome is unknown. Check status; do not repeat it.",
  absent: "The owning host has no record of the original Todos command. Check status; do not repeat it.",
};

/** Owns the desktop read/admission lifetime, not native Todos state. Every write
 * goes through the existing deduplicated host command path. Reads never replay. */
export class SessionTodosState {
  #ports?: SessionTodosPorts; #enabled = false; #generation = 0; #reading = false; #again = false; #readToken = 0;
  #listeners = new Set<() => void>(); #view: SessionTodosView;
  #original?: TodosEnvelope; #restored = false;
  constructor(readonly owner: SessionTodosOwner) {
    this.#view = { owner, value: null, fresh: false, loading: false, pending: false, uncertain: false };
  }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = () => this.#view;
  #set(patch: Partial<SessionTodosView>) { this.#view = { ...this.#view, ...patch }; this.#listeners.forEach(listener => listener()); }
  #storageKey() { return `agent-desktop:todos-command:v1:${JSON.stringify(this.owner)}`; }
  #remember(envelope?: TodosEnvelope) {
    const storage = this.#ports?.storage;
    if (storage) { if (envelope) storage.write(this.#storageKey(), JSON.stringify(envelope)); else storage.remove(this.#storageKey()); }
    this.#original = envelope;
    if (!envelope) { this.#set({ original: undefined }); return; }
    const { type: _type, ...request } = envelope.command;
    this.#set({ original: { commandId: envelope.id, request } });
  }
  configure(ports: SessionTodosPorts, enabled: boolean, unavailable?: string) {
    this.#ports = ports;
    if (!this.#restored) {
      this.#restored = true;
      const text = ports.storage?.read(this.#storageKey());
      if (text) {
        try {
          const raw: unknown = JSON.parse(text);
          if (!raw || typeof raw !== "object" || !("id" in raw) || !("commandVersion" in raw) || raw.commandVersion !== SESSION_TODOS_CAPABILITY.commandVersion
            || !("command" in raw) || !raw.command || typeof raw.command !== "object" || !("type" in raw.command) || raw.command.type !== "session.todos.mutate"
            || Object.keys(raw).some(key => !["id", "commandVersion", "command"].includes(key))) throw new Error("Stored Todos command is invalid.");
          const id = parseTodoCommandId(raw.id), { type: _type, ...fields } = raw.command;
          const request = parseTodoMutationRequest(fields);
          if (request.sessionId !== this.owner.sessionId) throw new Error("Stored Todos command belongs to another owner.");
          this.#original = { id, commandVersion: SESSION_TODOS_CAPABILITY.commandVersion, command: { type: "session.todos.mutate", ...request } };
          this.#set({ original: { commandId: id, request }, uncertain: true, error: "Check the original Todos command status before making another change." });
        } catch (cause) {
          // An unreadable record cannot be inspected; discarding it never resends anything.
          ports.storage?.remove(this.#storageKey());
          this.#set({ error: `A saved Todos recovery record could not be read and was discarded: ${message(cause)} Review the current Todos before changing them.` });
        }
      }
    }
    if (this.#enabled !== enabled) { this.#generation++; this.#reading = false; this.#again = false; }
    this.#enabled = enabled;
    this.#set({ unavailable, ...(!enabled ? { fresh: false, loading: false } : {}) });
  }
  disconnect() { this.#enabled = false; this.#generation++; this.#reading = false; this.#again = false; this.#set({ fresh: false, loading: false }); }
  #assert(owner = this.owner) {
    if (!this.#enabled || owner.hostId !== this.owner.hostId || owner.sessionId !== this.owner.sessionId)
      throw new TodosNotSubmitted("Open the connected owning conversation before changing its Todos.");
  }
  refresh = async () => {
    this.#assert();
    if (this.#reading) { this.#again = true; return; }
    const ports = this.#ports!, generation = this.#generation, token = ++this.#readToken, original = this.#original;
    const live = () => this.#enabled && generation === this.#generation && token === this.#readToken;
    this.#reading = true; this.#set({ loading: true, fresh: false });
    try {
      if (!ports.bridge.getSessionTodos) throw new Error("Update the desktop to read native Todos.");
      const response = parseSessionTodosResponse(await ports.bridge.getSessionTodos(this.owner.sessionId, this.owner.hostId, original?.id), this.owner.hostId, this.owner.sessionId, original?.id);
      if (!live()) return;
      let patch: Partial<SessionTodosView> = {};
      const receipt = response.receipt;
      if (original && receipt) {
        if (receipt.state === "succeeded") {
          const result = receipt.result!;
          if (result.state.ticket.nativeSessionId !== this.owner.sessionId || result.state.ticket.epoch !== original.command.ticket.epoch)
            throw new Error("The journal result belongs to another native owner.");
          // The desktop performs advertised structured actions itself; only plain outputs are shown.
          this.#remember(); patch = { uncertain: false, receipt, output: result.desktopAction ? undefined : result.output, error: undefined };
        } else if (receipt.state === "failed") {
          this.#remember();
          patch = { uncertain: false, receipt, error: `The owning host refused the original Todos command before any change${receipt.error ? `: ${receipt.error}` : "."}` };
        } else patch = { uncertain: true, receipt, error: receiptGuidance[receipt.state] };
      }
      this.#set({ ...patch, value: response.todos, unavailable: response.unavailable, fresh: true, readError: undefined });
    } catch (cause) { if (live()) this.#set({ fresh: false, readError: message(cause) }); }
    finally {
      if (generation === this.#generation && token === this.#readToken) {
        this.#reading = false; this.#set({ loading: false });
        if (this.#again && this.#enabled) { this.#again = false; void this.refresh(); }
      }
    }
  };
  #invalidateRead() { this.#readToken++; this.#reading = false; this.#again = false; this.#set({ loading: false, fresh: false }); }
  /** The request ticket must be the exact loaded revision; the host rejects any
   * stale ticket, and a refusal only refreshes. Nothing is ever resent. */
  async mutate(owner: SessionTodosOwner, raw: TodoMutationRequest): Promise<TodoMutationResult> {
    this.#assert(owner);
    let request: TodoMutationRequest;
    try { request = parseTodoMutationRequest(raw); } catch (cause) { throw new TodosNotSubmitted(message(cause)); }
    if (request.sessionId !== owner.sessionId) throw new TodosNotSubmitted("The Todos request belongs to another conversation.");
    const view = this.#view;
    if (!view.fresh || view.pending || view.uncertain || !view.value) throw new TodosNotSubmitted("Refresh the current Todos before changing them.");
    if (view.value.reconciliationRequired) throw new TodosNotSubmitted("The native Todos need reconciliation. Check status; do not repeat the change.");
    const current = view.value.ticket, ticket = request.ticket;
    if (ticket.epoch !== current.epoch || ticket.nativeSessionId !== current.nativeSessionId || ticket.revision !== current.revision)
      throw new TodosNotSubmitted("The native Todos changed. Review the latest state before applying this change.");
    const ports = this.#ports!, generation = this.#generation;
    const envelope: TodosEnvelope = { id: crypto.randomUUID(), commandVersion: SESSION_TODOS_CAPABILITY.commandVersion, command: { type: "session.todos.mutate", ...request } };
    try { this.#remember(envelope); } catch (cause) { throw new TodosNotSubmitted(`The Todos recovery record could not be saved: ${message(cause)}`); }
    this.#invalidateRead(); this.#set({ pending: true, error: undefined, receipt: undefined, output: undefined });
    try {
      const result = await ports.bridge.command(envelope, owner.hostId);
      if (result.commandId !== envelope.id) throw new Error("The Todos response belongs to another command.");
      if (!result.ok) {
        if (refusedCodes[result.error.code]) {
          this.#remember(); this.#set({ uncertain: false, error: result.error.message });
          if (this.#enabled && generation === this.#generation) void this.refresh().catch(() => {});
          throw new TodosNotSubmitted(result.error.message);
        }
        throw new Error(result.error.message);
      }
      if (!result.value || !("type" in result.value) || result.value.type !== "session.todos.mutate") throw new Error("The original Todos outcome was not returned.");
      const outcome = parseTodoMutationResult(result.value.result, envelope.id);
      if (outcome.state.ticket.nativeSessionId !== owner.sessionId || outcome.state.ticket.epoch !== request.ticket.epoch)
        throw new Error("The Todos result belongs to another native owner.");
      this.#remember(); this.#invalidateRead();
      this.#set({ value: outcome.state, output: outcome.desktopAction ? undefined : outcome.output, uncertain: false, fresh: this.#enabled && generation === this.#generation });
      return outcome;
    } catch (cause) {
      if (!(cause instanceof TodosNotSubmitted)) this.#set({ error: message(cause), uncertain: true, fresh: false });
      throw cause;
    } finally { this.#set({ pending: false }); }
  }
}

export function todosEventMatches(event: DesktopEvent, owner: SessionTodosOwner, localHostId?: string) {
  if ((event.hostId ?? localHostId) !== owner.hostId) return false;
  if (event.type === "state") return true;
  if (event.type === "settings") return event.sessionId === owner.sessionId;
  if (event.type !== "runtime" || event.sessionId !== owner.sessionId) return false;
  const native = event.event;
  if (!native || typeof native !== "object" || !("type" in native) || typeof native.type !== "string") return false;
  if (native.type === "tool_execution_end") return "toolName" in native && native.toolName === "todo";
  return ["todos_changed", "agent_end", "turn_end", "session_start"].includes(native.type);
}

export function useSessionTodos(owner: SessionTodosOwner, ports: SessionTodosPorts,
  options: { connected: boolean; supported: boolean; active: boolean; localHostId?: string }) {
  const states = useMemo(() => new Map<string, SessionTodosState>(), []);
  const state = useMemo(() => {
    const key = JSON.stringify(owner); let value = states.get(key);
    if (!value) { value = new SessionTodosState(owner); states.set(key, value); } return value;
  }, [states, owner.hostId, owner.sessionId]);
  const enabled = !!owner.sessionId && options.connected && options.supported && options.active;
  useLayoutEffect(() => { state.configure(ports, enabled, !owner.sessionId ? "Open a conversation to see its native Todos."
    : !options.supported ? "Update the owning host and desktop to use native Todos." : undefined); }, [state, ports, enabled, options.supported]);
  useLayoutEffect(() => () => state.disconnect(), [state]);
  useEffect(() => { if (enabled) void state.refresh(); }, [state, enabled]);
  useEffect(() => {
    if (!enabled) return;
    return ports.bridge.subscribe(event => {
      if ((event.hostId ?? options.localHostId) === owner.hostId && event.type === "connection") {
        if (!event.connected) state.disconnect();
        else { state.configure(ports, true); void state.refresh().catch(() => {}); }
      }
      else if (todosEventMatches(event, owner, options.localHostId)) void state.refresh().catch(() => {});
    });
  }, [state, ports.bridge, enabled, options.localHostId]);
  const view = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  return { state, view };
}
