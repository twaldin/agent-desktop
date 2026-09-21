import type { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { parseGoalPromptIntent, type GoalPromptIntent } from "../../../../packages/shared/src/goal-composer";

/** Owner-side fences supplied by startPrompt's existing idle admission reservation. */
export interface NativeGoalPromptPorts {
  /** Throws once the original prompt admission has retired, aborted, or lost its session. */
  assertCurrent(): void;
  /** Activate the native goal tool over the captured prior roster, exactly as
   * mutateGoal("create") does, and record `previousTools` as the owner's goal
   * restoration roster so pause/drop/complete still restore the original tools. */
  activateTools(previousTools: readonly string[]): Promise<void>;
  /** NativeGoalController.resetSuppression, called only after durable success. */
  resetSuppression(): void;
}

/** Stage at which a failure after the attempted mutation surfaced. `prompt`
 * means the goal was verifiably created and durable; only the ordinary user
 * prompt that followed could not be verified. */
export type NativeGoalPromptStep = "create" | "tools" | "durable" | "prompt";

/** Nothing native changed. The submission may be corrected and resent as a new command. */
export class NativeGoalPromptRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalPromptRejected";
  }
}

/** A goal mutation may have landed. Never replay the original command. */
export class NativeGoalPromptAdmissionError extends Error {
  readonly code = "OUTCOME_UNKNOWN";
  constructor(
    readonly step: NativeGoalPromptStep,
    readonly objective: string,
    readonly sessionFile: string | undefined,
    readonly goalId: string | undefined,
    cause: unknown,
  ) {
    super(NativeGoalPromptAdmissionError.describe(step, objective, sessionFile, goalId, cause), { cause });
    this.name = "NativeGoalPromptAdmissionError";
  }
  static describe(step: NativeGoalPromptStep, objective: string, sessionFile: string | undefined, goalId: string | undefined, cause: unknown): string {
    const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : "";
    const evidence = sessionFile ? ` Inspect the session's Goal panel and the native history ${sessionFile} for a mode_change "goal" entry` : " Inspect the session's Goal panel";
    const summary = step === "create"
      ? "Native Goal creation could not be verified after it was attempted."
      : step === "tools"
        ? `The native Goal ${goalId ?? ""} was created but activating its goal tool could not be verified.`
        : step === "durable"
          ? `The native Goal ${goalId ?? ""} is active in memory but its history persistence could not be certified.`
          : `The native Goal ${goalId ?? ""} was created and durably recorded, but its original user prompt could not be verified as dispatched.`;
    const guidance = step === "prompt"
      ? " and its following user message; the goal stays active, so continue it with an ordinary prompt only if the user entry is missing."
      : "; pause or drop that goal before starting another one.";
    return `${summary} Retain the original submission identity and do not resend it.${evidence} carrying the objective ${JSON.stringify(objective.length > 200 ? `${objective.slice(0, 200)}…` : objective)}${guidance}${detail}`;
  }
}

type Phase = "created" | "prepared" | "initializing" | "initialized" | "failed";

/**
 * Per-submission admission of a goal-bearing plain prompt. It mirrors OMP's
 * InteractiveMode #enterGoalMode ordering (prior tools captured, then
 * goalRuntime.createGoal, then goal tool activation, then the objective is
 * prompted as the ordinary user turn) inside the desktop host's existing
 * native prompt reservation, so the first provider call already carries the
 * durable goal-mode context. There is no provider call, retry or rollback here.
 */
export class NativeGoalPromptAdmission {
  #phase: Phase = "created";
  #intent?: GoalPromptIntent;
  #origin?: { sessionId: string; sessionFile: string | undefined; cwd: string };
  #previousTools?: readonly string[];
  #attempted = false;
  #step: NativeGoalPromptStep = "create";
  #goalId?: string;

  constructor(
    private readonly session: AgentSession,
    private readonly manager: SessionManager,
    private readonly rawIntent: unknown,
    private readonly ports: NativeGoalPromptPorts,
  ) {}

  /** Validated intent; available once prepare() succeeded. */
  get intent(): GoalPromptIntent | undefined { return this.#intent; }
  /** True from the instant before native createGoal; any later failure is OUTCOME_UNKNOWN. */
  get attempted(): boolean { return this.#attempted; }
  get initialized(): boolean { return this.#phase === "initialized"; }
  get goalId(): string | undefined { return this.#goalId; }
  /** Roster captured immediately before createGoal; the owner's restoration roster after activation. */
  get previousTools(): readonly string[] | undefined { return this.#previousTools; }

  /**
   * Synchronous validation before any ordinary preflight. Throws
   * GoalPromptRejected; nothing native has changed. `text` is the submitted
   * composer text: only a plain (non-slash, non-skill) prompt whose trimmed
   * text is the objective can carry a goal.
   */
  prepare(text: string): void {
    if (this.#phase !== "created") throw new Error("Goal prompt admission was already prepared; construct a new one per submission.");
    let intent: GoalPromptIntent;
    try { intent = parseGoalPromptIntent(this.rawIntent); }
    catch (error) { throw new NativeGoalPromptRejectedError(error instanceof Error ? error.message : "Invalid native Goal prompt intent."); }
    if (text.trimStart().startsWith("/")) throw new NativeGoalPromptRejectedError("Clear the Goal intent before sending a slash command or skill. The objective and attachments were retained.");
    if (text.trim() !== intent.objective) throw new NativeGoalPromptRejectedError("The Goal objective must be the submitted prompt text. Refresh the composer before sending.");
    this.#assertCreatable();
    this.#origin = { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, cwd: this.manager.getCwd() };
    this.#intent = intent;
    this.#phase = "prepared";
  }

  /**
   * Call inside the same native prompt reservation, after auth/extension/model/
   * attachment preflight and immediately before the ordinary dispatch. Resolves
   * with the goal created, its tool active and the history durably certified.
   * Rejects with GoalPromptRejected before any mutation, or with
   * NativeGoalPromptAdmissionError (OUTCOME_UNKNOWN) after createGoal began.
   */
  async initialize(): Promise<void> {
    if (this.#phase !== "prepared") {
      throw this.failure(new Error(this.#phase === "created"
        ? "Goal prompt admission must be prepared before initialization."
        : "Native Goal initialization was already attempted for this submission; do not replay it."));
    }
    this.#phase = "initializing";
    const intent = this.#intent!;
    try {
      this.#assertOwner();
      // Extension startup or a concurrent native mode change can occur between
      // prepare and this reservation; recheck against the live session.
      this.#assertCreatable();
      let previousTools: string[];
      try { previousTools = this.session.getEnabledToolNames().filter(name => name !== "goal"); }
      catch { throw new NativeGoalPromptRejectedError("The native tool presentation is unavailable. Refresh before starting a goal."); }
      this.#previousTools = previousTools;
      this.#assertOwner();
      // No await between the final owner check and the native mutation.
      this.#attempted = true;
      this.#step = "create";
      const state = await this.session.goalRuntime.createGoal({ objective: intent.objective, ...(intent.tokenBudget === undefined ? {} : { tokenBudget: intent.tokenBudget }) });
      this.#goalId = state.goal.id;
      this.#step = "tools";
      this.#assertOwner();
      await this.ports.activateTools(previousTools);
      this.#step = "durable";
      this.#assertOwner();
      // The mode_change entry is appended lazily like any other entry: force the
      // file onto disk before the first user turn, then certify the write.
      await this.manager.ensureOnDisk();
      await this.manager.flush();
      this.#assertOwner();
      const live = this.session.getGoalModeState();
      if (!live?.enabled || live.goal.id !== state.goal.id || live.goal.status !== "active") throw new Error("The native goal changed before its prompt could be dispatched.");
      this.ports.resetSuppression();
      this.#step = "prompt";
      this.#phase = "initialized";
    } catch (error) {
      this.#phase = "failed";
      throw this.failure(error);
    }
  }

  /** Wrap an admission failure. Before any attempted mutation the error passes
   * through unchanged; afterwards it becomes OUTCOME_UNKNOWN with inspection
   * guidance. Idempotent, so owner catch blocks may call it on initialize() errors. */
  failure(error: unknown): unknown {
    if (!this.#attempted || error instanceof NativeGoalPromptAdmissionError) return error;
    return new NativeGoalPromptAdmissionError(this.#step, this.#intent?.objective ?? "", this.#origin?.sessionFile ?? this.session.sessionFile, this.#goalId, error);
  }

  #assertOwner(): void {
    this.ports.assertCurrent();
    const origin = this.#origin!;
    if (this.session.sessionId !== origin.sessionId || this.session.sessionFile !== origin.sessionFile || this.manager.getCwd() !== origin.cwd)
      throw new Error("The original native session identity retired before its Goal prompt could be admitted.");
  }

  #assertCreatable(): void {
    if (!this.session.settings.get("goal.enabled")) throw new NativeGoalPromptRejectedError("Goals are disabled in this session's native settings. Clear the Goal intent to send the text as an ordinary prompt.");
    const context = this.manager.buildSessionContext();
    if (context.mode === "plan" || context.mode === "plan_paused" || this.session.getPlanModeState()?.enabled || this.session.getVibeModeState()?.enabled)
      throw new NativeGoalPromptRejectedError("Exit the session's current native mode before starting a goal. The objective and attachments were retained.");
    // Native createGoal permits a fresh goal over a dropped or completed one.
    // A completing goal still owns tool restoration until the host finalizes
    // it; the durable mode must agree so a hidden goal is never overwritten.
    const state = this.session.getGoalModeState();
    if (state && (state.mode === "exiting" || (state.goal.status !== "dropped" && state.goal.status !== "complete")))
      throw new NativeGoalPromptRejectedError(state.mode === "exiting"
        ? "The session's completed native goal is still finalizing. Wait for it to settle before starting another goal."
        : "This session already has a native goal. Manage it from the Goal panel; a new objective cannot replace it implicitly.");
    if (context.mode === "goal" || context.mode === "goal_paused")
      throw new NativeGoalPromptRejectedError("This session's history still carries a native goal. Reopen the session so it can be reconciled before starting another goal.");
  }
}
