import type { TodoMutationRequest, TodoMutationResult, TodoPhase, TodoTask, TodoTicket } from "../../../../packages/shared/src/session-todos";
import { TodosNotSubmitted, type SessionTodosOwner, type SessionTodosView } from "./use-session-todos";

export interface SessionTodosPanelInput extends SessionTodosView { connected: boolean }
export interface SessionTodosPanelPorts {
  mutate(owner: SessionTodosOwner, request: TodoMutationRequest): Promise<TodoMutationResult>;
  /** Reconcile the original command; never reissue a mutation to recover. */
  refresh(owner: SessionTodosOwner): Promise<void>;
  copy?(text: string): Promise<void>;
}
export interface TodoSelection { phase: string; task: string }
/** Authored against one exact native ticket; native changes never overwrite the text. */
export interface TodoEditDraft { ticket: TodoTicket; base: string; text: string }
interface Local {
  selection?: TodoSelection; edit?: TodoEditDraft; appendPhase: string; appendText: string; path: string;
  form?: "append" | "export" | "import"; pending?: string; error?: string; errorContext?: string; refreshing: boolean;
}
export interface SessionTodosPanelView extends SessionTodosPanelInput {
  local: Readonly<Local>; selected?: { phase: TodoPhase; task: TodoTask }; conflict: boolean; dirty: boolean;
  blockedReason?: string; commandReason?: string; canCopy: boolean; counts: { tasks: number; completed: number; inProgress: number };
}
export const todoStatusLabels: Record<TodoTask["status"], string> = {
  pending: "Pending", in_progress: "In progress", completed: "Completed", abandoned: "Abandoned", blocked: "Blocked",
};
/** Native tokenizer grammar: `"` groups a token and `\` escapes the next character. */
const quoteNativeToken = (value: string) => `"${value.replace(/[\\"]/g, match => `\\${match}`)}"`;
const sameTicket = (a: TodoTicket, b: TodoTicket) => a.nativeSessionId === b.nativeSessionId && a.epoch === b.epoch && a.revision === b.revision;

/** Local selection, drafts and in-flight UI operations only. Native tickets and
 * durable command outcomes remain supplied by the owning bridge. */
export class SessionTodosModel {
  #input: SessionTodosPanelInput; #ports: SessionTodosPanelPorts; #locals = new Map<string, Local>();
  #listeners = new Set<() => void>(); #view!: SessionTodosPanelView;
  constructor(input: SessionTodosPanelInput, ports: SessionTodosPanelPorts) { this.#input = input; this.#ports = ports; this.#reconcile(); this.#publish(); }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = () => this.#view;
  /** Called by the React layout effect, never by a speculative render. */
  configure(input: SessionTodosPanelInput, ports: SessionTodosPanelPorts) { this.#input = input; this.#ports = ports; this.#reconcile(); this.#publish(); }
  #local() {
    const key = JSON.stringify([this.#input.owner.hostId, this.#input.owner.sessionId]);
    let local = this.#locals.get(key);
    if (!local) { local = { appendPhase: "", appendText: "", path: "", refreshing: false }; this.#locals.set(key, local); }
    return local;
  }
  /** A clean draft follows native changes; an authored one keeps its original ticket.
   * Local admission messages are superseded once the owner state itself moves on. */
  #reconcile() {
    const local = this.#local(), edit = local.edit, input = this.#input, value = input.value;
    if (edit && value && edit.text === edit.base && !sameTicket(edit.ticket, value.ticket))
      local.edit = { ticket: { ...value.ticket }, base: value.markdown, text: value.markdown };
    const context = JSON.stringify([input.error, input.uncertain, input.receipt?.state, value?.ticket.revision]);
    if (local.errorContext !== context) { if (local.errorContext !== undefined) local.error = undefined; local.errorContext = context; }
  }
  #publish() {
    const input = this.#input, local = this.#local(), value = input.value, edit = local.edit;
    let selected: SessionTodosPanelView["selected"];
    if (value && local.selection) {
      const phase = value.phases.find(candidate => candidate.name === local.selection!.phase);
      const task = phase?.tasks.find(candidate => candidate.content === local.selection!.task);
      if (phase && task) selected = { phase, task };
    }
    const blockedReason = !input.connected ? "Offline · reconnect before changing todos."
      : input.unavailable ? input.unavailable
      : input.uncertain ? "The original Todos command is not confirmed. Check status before another change."
      : input.pending || local.pending ? "A Todos change is in progress."
      : !input.fresh ? "Todos are stale. Refresh before changing them."
      : !value ? "Native Todos are unavailable for this conversation."
      : value.reconciliationRequired ? "The native Todos need reconciliation. Check status; do not repeat the change."
      : value.busyReason;
    const counts = { tasks: 0, completed: 0, inProgress: 0 };
    for (const phase of value?.phases ?? []) for (const task of phase.tasks) {
      counts.tasks++; if (task.status === "completed") counts.completed++; else if (task.status === "in_progress") counts.inProgress++;
    }
    this.#view = { ...input, local: { ...local }, selected, conflict: !!edit && !!value && !sameTicket(edit.ticket, value.ticket),
      dirty: !!edit && edit.text !== edit.base, blockedReason,
      commandReason: blockedReason ?? (value && !value.nativeCommandAvailable ? "Native /todo is unavailable in this session. Edit the Markdown instead." : undefined),
      canCopy: !!this.#ports.copy && !!value, counts };
    for (const listener of this.#listeners) listener();
  }
  select(selection: TodoSelection | undefined) {
    const local = this.#local();
    local.selection = selection && local.selection?.phase === selection.phase && local.selection.task === selection.task ? undefined : selection;
    this.#publish();
  }
  openForm(form: Local["form"]) { const local = this.#local(); local.form = local.form === form ? undefined : form; local.error = undefined; this.#publish(); }
  setAppend(patch: { phase?: string; text?: string }) { const local = this.#local(); local.appendPhase = patch.phase ?? local.appendPhase; local.appendText = patch.text ?? local.appendText; this.#publish(); }
  setPath(path: string) { const local = this.#local(); local.path = path; this.#publish(); }
  setEditing(editing: boolean) {
    const local = this.#local(), value = this.#input.value;
    if (!editing) { if (local.edit && local.edit.text === local.edit.base) local.edit = undefined; }
    else if (!local.edit && value) local.edit = { ticket: { ...value.ticket }, base: value.markdown, text: value.markdown };
    this.#publish();
  }
  setText(text: string) { const local = this.#local(); if (local.edit) { local.edit.text = text; this.#publish(); } }
  discardEdits() { const local = this.#local(); if (!local.pending) { local.edit = undefined; local.error = undefined; this.#publish(); } }
  /** Native command text only; fuzzy matching stays in OMP. */
  async command(text: string) {
    const local = this.#local();
    if (this.#view.commandReason) { local.error = this.#view.commandReason; this.#publish(); return; }
    return this.#submit(local, { action: "command", text }, this.#input.value!.ticket);
  }
  taskAction(verb: "start" | "done" | "drop" | "rm", task: TodoTask) {
    // Native `start` re-tokenizes its argument; the other verbs match the raw text exactly.
    return this.command(`/todo ${verb} ${verb === "start" ? quoteNativeToken(task.content) : task.content}`);
  }
  append() {
    const local = this.#local(), text = local.appendText.trim();
    if (!text) { local.error = "Enter the task to append."; this.#publish(); return; }
    const phase = local.appendPhase.trim();
    return this.command(`/todo append ${phase ? `${quoteNativeToken(phase)} ` : ""}${quoteNativeToken(text)}`);
  }
  transfer(direction: "export" | "import") {
    const path = this.#local().path.trim();
    return this.command(`/todo ${direction}${path ? ` ${path}` : ""}`);
  }
  /** `rebase` re-targets authored text at the latest native ticket after an explicit choice. */
  async saveEdits(rebase = false) {
    const local = this.#local(), edit = local.edit, value = this.#input.value;
    if (!edit || !value) return;
    if (this.#view.blockedReason) { local.error = this.#view.blockedReason; this.#publish(); return; }
    if (!rebase && !sameTicket(edit.ticket, value.ticket)) {
      local.error = "The native Todos changed while you were editing. Save over the latest state or discard your edits."; this.#publish(); return;
    }
    const result = await this.#submit(local, { action: "edit", markdown: edit.text }, rebase ? value.ticket : edit.ticket);
    if (result && local.edit === edit) { local.edit = undefined; this.#publish(); }
  }
  async #submit(local: Local, mutation: TodoMutationRequest["mutation"], ticket: TodoTicket): Promise<TodoMutationResult | undefined> {
    if (local.pending) return;
    const owner = { ...this.#input.owner }, ports = this.#ports;
    const request: TodoMutationRequest = { sessionId: owner.sessionId, ticket: { ...ticket }, mutation };
    local.pending = mutation.action === "command" ? mutation.text : "edit"; local.error = undefined; this.#publish();
    try {
      const result = await ports.mutate(owner, request);
      if (mutation.action === "command" && local.form) { local.form = undefined; local.appendText = ""; }
      return result;
    } catch (cause) {
      // Refusals keep the authored text and selection; unknown outcomes are reported by the owner state.
      if (cause instanceof TodosNotSubmitted) local.error = cause.message;
    } finally { local.pending = undefined; this.#reconcile(); this.#publish(); }
  }
  async refresh() {
    const local = this.#local();
    if (!this.#input.connected || local.refreshing || local.pending) return;
    const owner = { ...this.#input.owner }, ports = this.#ports;
    local.refreshing = true; this.#publish();
    try { await ports.refresh(owner); }
    catch (cause) { local.error = cause instanceof Error ? cause.message : String(cause); }
    finally { local.refreshing = false; this.#reconcile(); this.#publish(); }
  }
  /** Exact native Markdown, final newline included. */
  async copy() {
    const local = this.#local(), value = this.#input.value;
    if (!value || local.pending) return;
    local.pending = "copy"; local.error = undefined; this.#publish();
    try { if (!this.#ports.copy) throw new Error("Copy is unavailable in this desktop context."); await this.#ports.copy(value.markdown); }
    catch (cause) { local.error = cause instanceof Error ? cause.message : String(cause); }
    finally { local.pending = undefined; this.#publish(); }
  }
}
