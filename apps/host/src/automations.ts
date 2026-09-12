import type { Automation, AutomationInput, AutomationMutation, AutomationMutationResult, AutomationRun,
  AutomationsQuery, AutomationsSnapshot, AutomationInputDestination } from "../../../packages/shared/src/automations";
import type { CommandEnvelope, CommandResult, HostCommand, SessionSummary } from "../../../packages/shared/src/protocol";
import { AutomationConflictError, AutomationRecords, AutomationRequestConflictError } from "./automation-records";
import { nextAutomationRun, parseAutomationSchedule } from "./automation-schedule";

const TICK_MS = 30_000;
const MAX_CONCURRENT_RUNS = 3;

export class AutomationHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface AutomationSessionState {
  session: SessionSummary | undefined;
  busy: boolean;
  hasDraft: boolean;
  hasInteraction: boolean;
}

export interface AutomationServiceOptions {
  records: AutomationRecords;
  dispatch(envelope: CommandEnvelope, commandVersion?: 15): Promise<CommandResult>;
  /** Resolves only after the exact accepted prompt reaches a native terminal outcome. */
  waitForPrompt(commandId: string): Promise<"completed" | "failed" | "stopped" | "unknown">;
  sessionState(sessionId: string): Promise<AutomationSessionState>;
  validateDestination?(destination: AutomationInputDestination): void | Promise<void>;
  changed(): void;
  notify?(run: AutomationRun): void;
  now?: () => number;
  tickMs?: number;
}

const commandFailure = (result: CommandResult): Error & { code?: string } =>
  Object.assign(new Error(result.ok ? "Automation command unexpectedly succeeded." : result.error.message),
    result.ok ? {} : { code: result.error.code });
const unknown = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN";

/** Host-owned scheduler and mutation boundary. Native work is admitted only
 * through the existing durable command journal; scheduled runs never replay an
 * unknown create or prompt command under a new identity. */
export class AutomationService {
  private readonly now: () => number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickCall: Promise<void> | undefined;
  private schedulerError: unknown;
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly activeMutations = new Set<Promise<unknown>>();
  private readonly activeSessions = new Set<string>();
  private stopping = false;

  constructor(private readonly options: AutomationServiceOptions) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? TICK_MS;
  }

  snapshot(query?: AutomationsQuery): AutomationsSnapshot { return this.options.records.snapshot(query); }

  start(): void {
    if (this.timer || this.stopping) return;
    void this.tick().catch(error => { this.schedulerError ??= error; });
    this.timer = setInterval(() => void this.tick().catch(error => { this.schedulerError ??= error; }), this.tickMs);
    this.timer.unref?.();
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const outcomes = await Promise.allSettled([...(this.tickCall ? [this.tickCall] : []), ...this.activeRuns.values(), ...this.activeMutations]);
    const errors = [...(this.schedulerError === undefined ? [] : [this.schedulerError]), ...outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
    if (errors.length) throw new AggregateError(errors, "Automation operations did not finish cleanly.");
  }

  async mutate(mutation: AutomationMutation): Promise<AutomationMutationResult> {
    if (this.stopping) throw new AutomationHttpError(503, "The host is stopping. Reconnect before changing automations.");
    const call = this.mutateInner(mutation); this.activeMutations.add(call);
    try { return await call; } finally { this.activeMutations.delete(call); }
  }

  private async mutateInner(mutation: AutomationMutation): Promise<AutomationMutationResult> {
    let request;
    try { request = this.options.records.claim(mutation); }
    catch (error) { throw this.httpError(error); }
    if (request.state === "done") return this.result(mutation.requestId, request.task,
      request.run ? this.options.records.getRun(request.run.id) ?? request.run : null);
    try {
      if (mutation.type === "history") {
        const done = this.options.records.history(mutation); this.options.changed();
        return this.result(mutation.requestId, done.task, done.run);
      }
      if (mutation.type === "delete") {
        const done = this.options.records.delete(mutation as AutomationMutation & { type: "delete" }); this.options.changed();
        return this.result(mutation.requestId, done.task, done.run);
      }
      if (mutation.type === "save") {
        const current = this.options.records.get(mutation.id);
        const previousStart = current?.rrule.match(/^DTSTART[^\r\n]*$/mi)?.[0];
        const recurrence = previousStart && !/^DTSTART(?:;|:)/mi.test(mutation.input.rrule)
          ? `${previousStart}\n${mutation.input.rrule.trim()}` : mutation.input.rrule;
        const schedule = parseAutomationSchedule(recurrence, this.now());
        const input = { ...await this.resolveDestination(mutation), rrule: schedule.source };
        const next = input.status === "active"
          ? current?.status === "active" && current.rrule === input.rrule ? current.nextRunAt : this.next(mutation.id, input, this.now())
          : null;
        if (input.status === "active" && next === null) throw new Error("The active automation recurrence has no future occurrence.");
        const done = this.options.records.save(mutation, input, next); this.options.changed();
        return this.result(mutation.requestId, done.task, done.run);
      }
      const task = this.options.records.get(mutation.id);
      if (!task || task.revision !== mutation.expectedRevision) throw new AutomationConflictError("The automation changed. Reload it before running.");
      const done = this.options.records.reserveManual(mutation as AutomationMutation & { type: "run" }, task.status === "active" ? this.next(task.id, task, this.now()) : null);
      this.options.changed();
      if (done.run) this.launch(done.run, true);
      return this.result(mutation.requestId, done.task, done.run);
    } catch (error) { throw this.httpError(error); }
  }

  private async resolveDestination(mutation: Extract<AutomationMutation, { type: "save" }>): Promise<AutomationInput & { destination: Automation["destination"] }> {
    const input = mutation.input;
    await this.options.validateDestination?.(input.destination);
    if (input.destination.kind !== "heartbeat-new") {
      if (input.destination.kind === "heartbeat") await this.requireHeartbeatOwner(input.destination.sessionId);
      return input as AutomationInput & { destination: Automation["destination"] };
    }
    const command: HostCommand = { type: "session.create", projectId: input.destination.projectId,
      ...(input.destination.model ? { model: input.destination.model } : {}),
      ...(input.destination.approvalMode ? { approvalMode: input.destination.approvalMode } : {}),
      ...(input.destination.execution.type === "worktree" ? { worktree: input.destination.execution.startingState } : {}),
      ...(input.destination.environment === null ? {} : { environment: input.destination.environment }) };
    const result = await this.options.dispatch({ id: `automation:${mutation.requestId}:heartbeat:create`, command }, 15);
    if (!result.ok) throw commandFailure(result);
    const session = result.value;
    if (!session || !("id" in session) || typeof session.id !== "string") throw Object.assign(new Error("The original conversation receipt was incomplete."), { code: "OUTCOME_UNKNOWN" });
    return { ...input, destination: { kind: "heartbeat", sessionId: session.id } };
  }

  private async requireHeartbeatOwner(sessionId: string): Promise<AutomationSessionState> {
    const state = await this.options.sessionState(sessionId);
    if (!state.session || state.session.archived) throw new Error("The original conversation is unavailable on this host.");
    return state;
  }

  private next(id: string, input: Pick<AutomationInput, "rrule" | "destination">, after: number): number | null {
    return nextAutomationRun(input.rrule, after, { id, heartbeat: input.destination.kind === "heartbeat", jitterSalt: this.options.records.jitterSalt() });
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.tickCall) return;
    this.tickCall = (async () => {
      const available = Math.max(0, MAX_CONCURRENT_RUNS - this.activeRuns.size);
      if (!available) return;
      const runs = this.options.records.reserveDue(this.now(), available, (task, now) => this.next(task.id, task, now));
      if (runs.length) this.options.changed();
      for (const run of runs) this.launch(run, false);
    })().finally(() => { this.tickCall = undefined; });
    await this.tickCall;
  }

  private launch(run: AutomationRun, manual: boolean): void {
    if (this.activeRuns.has(run.id)) return;
    if (this.activeRuns.size >= MAX_CONCURRENT_RUNS) {
      this.finish(run.id, manual ? "failed" : "skipped", "The automation concurrency limit is busy. Try again after another run finishes.");
      return;
    }
    const heartbeatSession = run.destination.kind === "heartbeat" ? run.destination.sessionId : undefined;
    if (heartbeatSession && this.activeSessions.has(heartbeatSession)) {
      this.finish(run.id, manual ? "failed" : "skipped", "Another automation is already using the original conversation.");
      return;
    }
    if (heartbeatSession) this.activeSessions.add(heartbeatSession);
    const call = this.executeRun(run, manual).finally(() => { this.activeRuns.delete(run.id); });
    this.activeRuns.set(run.id, call);
  }

  private async executeRun(run: AutomationRun, manual: boolean): Promise<void> {
    let current = run;
    try {
      let sessionId = run.sessionId;
      if (run.destination.kind === "cron") {
        await this.options.validateDestination?.(run.destination);
        current = this.options.records.advanceRun(run.id, "running"); this.options.changed();
        const create: HostCommand = { type: "session.create", projectId: run.destination.projectId,
          model: run.destination.model, ...(run.destination.approvalMode ? { approvalMode: run.destination.approvalMode } : {}),
          ...(run.destination.execution.type === "worktree" ? { worktree: run.destination.execution.startingState } : {}),
          ...(run.destination.environment === null ? {} : { environment: run.destination.environment }) };
        const created = await this.options.dispatch({ id: run.createCommandId, command: create }, 15);
        if (!created.ok) throw commandFailure(created);
        if (!created.value || !("id" in created.value) || typeof created.value.id !== "string")
          throw Object.assign(new Error("The created conversation receipt was incomplete."), { code: "OUTCOME_UNKNOWN" });
        sessionId = created.value.id;
        current = this.options.records.advanceRun(run.id, "running", { sessionId }); this.options.changed();
      } else {
        const state = await this.requireHeartbeatOwner(run.destination.sessionId);
        if (state.busy || state.hasDraft || state.hasInteraction) {
          if (!manual) { this.finish(run.id, "skipped", "The original conversation was busy or waiting for input."); return; }
          throw new Error("The original conversation is busy or has unsent work. Finish it before running this automation.");
        }
        sessionId = run.destination.sessionId;
        current = this.options.records.advanceRun(run.id, "running"); this.options.changed();
      }
      if (!sessionId) throw new Error("The automation has no conversation destination.");
      const prompt: HostCommand = { type: "session.prompt", sessionId, text: run.prompt,
        ...(run.destination.kind === "cron" && run.destination.model ? { model: run.destination.model } : {}),
        ...(run.destination.kind === "cron" && run.destination.thinkingLevel ? { thinkingLevel: run.destination.thinkingLevel } : {}),
        ...(run.destination.kind === "cron" && run.destination.approvalMode ? { approvalMode: run.destination.approvalMode } : {}) };
      const accepted = await this.options.dispatch({ id: run.promptCommandId, command: prompt }, 15);
      if (!accepted.ok) throw commandFailure(accepted);
      const outcome = await this.options.waitForPrompt(run.promptCommandId);
      if (outcome === "unknown") throw Object.assign(new Error("The prompt outcome could not be verified."), { code: "OUTCOME_UNKNOWN" });
      this.finish(run.id, outcome === "completed" ? "completed" : "failed", outcome === "completed" ? undefined : `Conversation ${outcome}.`);
    } catch (error) {
      this.finish(run.id, unknown(error) ? "unknown" : "failed", error);
    } finally {
      if (current.sessionId) this.activeSessions.delete(current.sessionId);
    }
  }

  private finish(id: string, status: "completed" | "failed" | "unknown" | "skipped", error?: unknown): void {
    const run = this.options.records.advanceRun(id, status, error === undefined ? {} : { error });
    this.options.changed();
    if (run.notificationPolicy === "all" || status === "failed" || status === "unknown") this.options.notify?.(run);
  }

  private result(requestId: string, task: Automation | null, run: AutomationRun | null): AutomationMutationResult {
    return { hostId: this.options.records.hostId, requestId, task, run, snapshot: this.options.records.snapshot() };
  }
  private httpError(error: unknown): Error {
    if (error instanceof AutomationRequestConflictError || error instanceof AutomationConflictError) return new AutomationHttpError(409, error.message);
    if (error instanceof AutomationHttpError) return error;
    return error instanceof Error ? error : new Error(String(error));
  }
}
