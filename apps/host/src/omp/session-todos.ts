import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import type { AgentSession, AgentSessionEvent, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { commitUserTodoEdit, findLatestTodoStateEntry, markdownToPhases, phasesToMarkdown, type UserTodoEdit } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { planTodoExport, planTodoImport, planTodoMutation, TODO_HELP_TEXT, type TodoCommandPlan } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/todo";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand, parseSubcommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { MAX_TODO_BYTES, parseTodoCommandId, parseTodoMutationRequest, parseTodoPhases,
  type SessionTodos, type TodoMutationRequest, type TodoMutationResult, type TodoPhase, type TodoTicket } from "@agent-desktop/shared";

/** `TODOS_REJECTED`: nothing native changed. `OUTCOME_UNKNOWN`: a commit may have
 * landed but its durability/owner could not be confirmed; never replay it. */
export class NativeTodosError extends Error {
  constructor(readonly code: "TODOS_REJECTED" | "OUTCOME_UNKNOWN", message: string, options?: ErrorOptions) {
    super(message, options); this.name = "NativeTodosError";
  }
}
const rejected = (message: string, cause?: unknown) => new NativeTodosError("TODOS_REJECTED", message, cause === undefined ? undefined : { cause });

export interface NativeSessionTodosPorts {
  /** Existing runtime admission/lifetime fence, required at every awaited boundary. */
  assertOwner(): void;
  /** Runtime work (prompt, admission, other native mutations) that refuses a todo edit right now. */
  getBusyReason(): string | undefined;
  /** Branch todo state or reconciliation state changed; clients should refresh. */
  onChanged(): void;
}
export interface NativeTodoInvocation {
  readonly args: string;
  /** Worker-local capability; never deserialize this from a client. */
  assertCurrent(): void;
}
/** Literal native extension/custom token precedence precedes the `/todo` builtin. */
export function resolveNativeTodoInvocation(session: AgentSession, text: string): NativeTodoInvocation | undefined {
  const parsed = parseSlashCommand(text);
  const builtin = parsed && lookupBuiltinSlashCommand(parsed.name);
  if (!parsed || !builtin || builtin.name !== "todo") return;
  const space = text.indexOf(" "), token = space < 0 ? text.slice(1) : text.slice(1, space);
  const nativeId = session.sessionId, file = session.sessionFile;
  const owns = () => session.sessionId === nativeId && session.sessionFile === file
    && !session.extensionRunner?.getCommand(token) && !session.customCommands.some(item => item.command.name === token)
    && lookupBuiltinSlashCommand(parsed.name) === builtin;
  if (!owns()) return;
  return { args: parsed.args, assertCurrent() { if (!owns()) throw rejected("The original native /todo command no longer owns this input."); } };
}

/** One loaded native session's todo list. The current branch is the only truth:
 * an empty latest state is authoritative and never falls back to live memory.
 * Reads never append; every user change goes through the native shared commit. */
export class NativeSessionTodos {
  readonly #identity: { nativeSessionId: string; sessionFile: string; providerSessionId: string };
  #epoch = randomUUID();
  #busy = false;
  #active?: Promise<void>;
  #reconciliationRequired = false;
  constructor(private readonly session: AgentSession, private readonly manager: SessionManager, private readonly ports: NativeSessionTodosPorts) {
    if (!session.sessionFile || session.sessionManager !== manager) throw rejected("A persisted owning native session is required.");
    this.#identity = { nativeSessionId: manager.getSessionId(), providerSessionId: session.sessionId, sessionFile: session.sessionFile };
    this.#assert();
  }
  prepareExternalEditor(ticket: TodoTicket): { content: string; extension: string; trimTrailingNewline: boolean } {
    this.#assert();
    const current = this.read(); this.#checkTicket(ticket, current);
    if (current.reconciliationRequired || current.busyReason) throw rejected("The original Todos are unavailable for editing.");
    // Exact pinned TodoCommandController #editInExternalEditor initial document.
    const content = current.phases.length ? current.markdown : "# Todos\n- [ ] (replace this with your tasks)\n";
    if (Buffer.byteLength(content) > MAX_TODO_BYTES) throw rejected("The native Todo editor content exceeds its bound.");
    return { content, extension: ".todo.md", trimTrailingNewline: true };
  }
  get busy(): boolean { return this.#busy; }
  /** Resolves once any in-flight mutation has settled; never throws. */
  async settle(): Promise<void> { while (this.#active) await this.#active.catch(() => {}); }
  #assert(invocation?: NativeTodoInvocation) {
    this.ports.assertOwner();
    if (this.session.sessionId !== this.#identity.providerSessionId || this.session.sessionFile !== this.#identity.sessionFile
      || this.manager.getSessionId() !== this.#identity.nativeSessionId || this.manager.getSessionFile() !== this.#identity.sessionFile)
      throw rejected("The original native Todos owner has retired.");
    invocation?.assertCurrent();
  }
  rebindProviderSession(): void {
    this.ports.assertOwner();
    if (this.manager.getSessionId() !== this.#identity.nativeSessionId || this.manager.getSessionFile() !== this.#identity.sessionFile) throw rejected("The original native Todos owner has retired.");
    this.#identity.providerSessionId = this.session.sessionId; this.#epoch = randomUUID();
  }
  #busyReason(includeOwnBusy = true): string | undefined {
    return this.ports.getBusyReason() ?? (includeOwnBusy && this.#busy ? "A native Todos change is still settling."
      : this.session.isCompacting || this.session.isAborting ? "Wait for native maintenance to settle." : undefined);
  }
  /** Side-effect free: only the branch is inspected. A malformed or oversized
   * latest todo entry rejects instead of silently showing an older state. */
  read(): SessionTodos { return this.#snapshot(); }
  #snapshot(includeOwnBusy = true): SessionTodos {
    this.#assert();
    const branch = this.manager.getBranch();
    const latest = findLatestTodoStateEntry(branch, true);
    let phases: TodoPhase[];
    try { phases = parseTodoPhases(latest ? latest.phases : []); }
    catch (cause) {
      throw rejected(`The latest native todo entry ${latest!.entry.id} is not readable: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
    }
    const revision = createHash("sha256").update(branch.at(-1)?.id ?? "").update("\0")
      .update(latest?.entry.id ?? "").update("\0").update(JSON.stringify(phases)).digest("hex");
    const busyReason = this.#busyReason(includeOwnBusy);
    return { ticket: { nativeSessionId: this.#identity.nativeSessionId, epoch: this.#epoch, revision }, phases, markdown: phasesToMarkdown(phases),
      nativeCommandAvailable: !!resolveNativeTodoInvocation(this.session, "/todo"), reconciliationRequired: this.#reconciliationRequired,
      ...(busyReason ? { busyReason } : {}) };
  }
  /** Native todo tool results change the branch; the persisted entry lands at message_end. */
  observeEvent(event: AgentSessionEvent): void {
    if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "todo" && !event.message.isError) this.ports.onChanged();
  }
  #checkTicket(ticket: TodoTicket, current: SessionTodos) {
    if (ticket.nativeSessionId !== current.ticket.nativeSessionId || ticket.epoch !== current.ticket.epoch)
      throw rejected("The Todos ticket belongs to another native owner. Refresh before editing.");
    if (ticket.revision !== current.ticket.revision) throw rejected("The native todo list changed. Refresh before editing.");
  }
  /** Validation, owner, busy, and revision guards all run before the busy
   * reservation and any side effect. Every failure is coded: uncoded errors
   * can only arise before the native commit, so they are rejections. */
  mutate(commandId: string, raw: TodoMutationRequest): Promise<TodoMutationResult> {
    const coded = (error: unknown) => error instanceof NativeTodosError ? error : rejected(error instanceof Error ? error.message : String(error), error);
    try {
      const id = parseTodoCommandId(commandId), request = parseTodoMutationRequest(raw);
      this.#assert();
      if (this.#reconciliationRequired) throw new NativeTodosError("OUTCOME_UNKNOWN", "Native Todos require owner reconciliation after an uncertain commit.");
      const busy = this.#busyReason(); if (busy) throw rejected(busy);
      if (request.sessionId !== this.#identity.nativeSessionId) throw rejected("The Todos request names another native session.");
      const current = this.read(); this.#checkTicket(request.ticket, current);
      this.#busy = true;
      const settled = Promise.withResolvers<void>(); this.#active = settled.promise;
      return this.#run(id, request, current).catch(error => { throw coded(error); }).finally(() => {
        this.#busy = false; settled.resolve(); if (this.#active === settled.promise) this.#active = undefined;
      });
    } catch (error) { return Promise.reject(coded(error)); }
  }
  async #run(commandId: string, request: TodoMutationRequest, current: SessionTodos): Promise<TodoMutationResult> {
    const result = (output: string, state: SessionTodos, desktopAction?: TodoMutationResult["desktopAction"]): TodoMutationResult =>
      ({ commandId, state, output, ...(desktopAction ? { desktopAction } : {}) });
    if (request.mutation.action === "edit") {
      const { phases, errors } = markdownToPhases(request.mutation.markdown);
      if (errors.length > 0) throw rejected(`Could not parse Markdown:\n  ${errors.join("\n  ")}`);
      const state = await this.#commit({ phases, action: "/todo edit" }, current);
      const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
      return result(`Todos updated from editor: ${phases.length} phase(s), ${taskCount} task(s).`, state);
    }
    const invocation = resolveNativeTodoInvocation(this.session, request.mutation.text);
    if (!invocation) throw rejected("An extension or custom command owns /todo in this session.");
    const phases = current.phases, trimmed = invocation.args.trim();
    if (!trimmed) return result(phases.length === 0 ? "No todos. Use /todo append <task> to start one." : current.markdown.trimEnd(), current, "show");
    const { verb, rest } = parseSubcommand(trimmed);
    switch (verb) {
      case "expand": case "collapse": return result(current.markdown, current, verb);
      case "edit": return result(current.markdown, current, "edit");
      case "copy":
        if (phases.length === 0) throw rejected("No todos to copy.");
        return result(current.markdown, current, "copy");
      case "help": case "?": return result(TODO_HELP_TEXT, current);
      case "export": {
        if (!phases.length) return result("No todos to export.", current);
        try {
          const plan = await planTodoExport(rest, phases, this.manager.getCwd(), { display: this.#display(rest) });
          if (plan.failed) throw new Error(plan.message);
          this.#assert(invocation);
          if (this.ports.getBusyReason() || this.read().ticket.revision !== current.ticket.revision)
            throw new Error("Native Todos changed while the export was being written.");
          return result(plan.message, this.#snapshot(false));
        } catch (cause) {
          this.#unknown(cause, "The native Todo export may have been written but could not be confirmed.");
        }
      }
      case "import": {
        const plan = await planTodoImport(rest, this.manager.getCwd(), { display: this.#display(rest), read: target => this.#readBounded(target) });
        this.#assert(invocation);
        return result(plan.message, await this.#commitPlan(plan, current, invocation));
      }
      case "append": case "start": case "done": case "drop": case "rm": {
        const plan = planTodoMutation(verb, rest, phases);
        return result(plan.message, await this.#commitPlan(plan, current, invocation));
      }
      default: throw rejected(`Unknown /todo subcommand "${verb}".\n${TODO_HELP_TEXT}`);
    }
  }
  /** Operator text never carries an owner-host absolute path: cwd-relative inside the workspace, else the typed argument. */
  #display(rest: string) {
    return (target: string) => {
      const relative = path.relative(this.manager.getCwd(), target);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : rest.trim() || "TODO.md";
    };
  }
  /** Bounded before allocation: the file is sized through its own descriptor and refused above the contract limit. */
  async #readBounded(target: string): Promise<string> {
    const handle = await open(target, "r");
    try {
      const { size } = await handle.stat();
      if (size > MAX_TODO_BYTES) throw new Error(`${target} is ${size} bytes; the todo import limit is ${MAX_TODO_BYTES} bytes.`);
      const buffer = Buffer.allocUnsafe(size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break; offset += bytesRead;
      }
      if (offset > size) throw new Error(`${target} grew while it was being read.`);
      return buffer.toString("utf8", 0, offset);
    } finally { await handle.close(); }
  }
  #unknown(cause: unknown, message: string): never {
    this.#reconciliationRequired = true;
    const failure = new NativeTodosError("OUTCOME_UNKNOWN", `${message} ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    try { this.ports.onChanged(); } finally { throw failure; }
  }
  async #commitPlan(plan: TodoCommandPlan, current: SessionTodos, invocation: NativeTodoInvocation): Promise<SessionTodos> {
    if (plan.failed) throw rejected(plan.message);
    if (!plan.edit) throw rejected(plan.message);
    return this.#commit(plan.edit, current, invocation);
  }
  /** Re-guards after any asynchronous preparation, then performs the one native
   * commit. A failure after the commit started is latched as unknown: the entry
   * may already be on the branch, so it is never replayed. */
  async #commit(edit: UserTodoEdit, current: SessionTodos, invocation?: NativeTodoInvocation): Promise<SessionTodos> {
    this.#assert(invocation);
    const busy = this.ports.getBusyReason(); if (busy) throw rejected(busy);
    if (this.read().ticket.revision !== current.ticket.revision) throw rejected("The native todo list changed. Refresh before editing.");
    try { parseTodoPhases(edit.phases); }
    catch (cause) { throw rejected(`The resulting todo list is not storable: ${cause instanceof Error ? cause.message : String(cause)}`, cause); }
    try {
      commitUserTodoEdit({ session: this.session, sessionManager: this.manager }, edit);
      await this.manager.ensureOnDisk(); this.#assert(invocation);
      await this.manager.flush(); this.#assert(invocation);
      this.ports.onChanged();
      return this.#snapshot(false);
    } catch (cause) {
      this.#unknown(cause, "The native todo change may not be durable.");
    }
  }
}
