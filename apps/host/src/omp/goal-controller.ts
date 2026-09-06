import type { AgentSession, AgentSessionEvent, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { OmpPromptAdmissionError } from "./prompt";

export type GoalContinuationBlockedReason =
  | "disabled" | "inactive" | "completed" | "suppressed-no-tools"
  | "admission-pending" | "prompt-running" | "post-prompt-work" | "native-async-work"
  | "interaction-pending" | "tool-running" | "mutation-pending" | "interrupt-pending"
  | "queued-input" | "native-mode" | "disposed";

export type GoalContinuationEligibility =
  | { eligible: true; goalId: string; observedUpdatedAt: number }
  | { eligible: false; reason: GoalContinuationBlockedReason };

export interface GoalContinuationAcceptance { goalId: string; entryId: string }
export interface GoalContinuationCompletion { goalId: string; hadToolCalls: boolean; suppressedNext: boolean }
export interface OmpGoalContinuationRun {
  accepted: Promise<GoalContinuationAcceptance>;
  completion: Promise<GoalContinuationCompletion>;
}

interface BusyState {
  disposed: boolean;
  admissionPending: boolean;
  promptInFlight: boolean;
  mutationPending: boolean;
  interruptsInFlight: number;
  interactionsPending: boolean;
}

/** Headless counterpart to InteractiveMode's native goal lifecycle controller. */
export class NativeGoalController {
  #activeTools = new Set<string>();
  #continuation: { goalId: string; hadToolCalls: boolean } | undefined;
  #suppressedGoalId: string | undefined;
  #finalization: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: AgentSession,
    private readonly manager: SessionManager,
    private readonly busy: () => BusyState,
    private readonly restoreTools: () => Promise<void>,
  ) {}

  async refreshUsage(): Promise<void> {
    await this.session.goalRuntime.flushUsage("suppressed");
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === "agent_start") {
      if (this.#continuation) this.#continuation.hadToolCalls = false;
      return;
    }
    if (event.type === "tool_execution_start") {
      this.#activeTools.add(event.toolCallId);
      if (this.#continuation) this.#continuation.hadToolCalls = true;
      else this.#suppressedGoalId = undefined;
      return;
    }
    if (event.type === "tool_execution_end") {
      this.#activeTools.delete(event.toolCallId);
      return;
    }
    if (event.type !== "agent_end") return;
    if (this.#continuation) {
      this.#suppressedGoalId = this.#continuation.hadToolCalls ? undefined : this.#continuation.goalId;
    }
    if (this.session.getGoalModeState()?.mode === "exiting") {
      this.#finalization = this.#finalization.then(() => this.finalizeCompletedGoal(), () => this.finalizeCompletedGoal());
      void this.#finalization.catch(() => {});
    }
    this.#activeTools.clear();
  }

  resetSuppression(): void { this.#suppressedGoalId = undefined; }
  hasActiveToolExecution(): boolean { return this.#activeTools.size > 0; }

  eligibility(): GoalContinuationEligibility {
    const busy = this.busy();
    if (busy.disposed) return { eligible: false, reason: "disposed" };
    if (!this.session.settings.get("goal.enabled") || !this.session.settings.get("goal.continuationModes").includes("interactive")) {
      return { eligible: false, reason: "disabled" };
    }
    const state = this.session.getGoalModeState();
    if (state?.mode === "exiting" || state?.goal.status === "complete") return { eligible: false, reason: "completed" };
    if (!state?.enabled || state.goal.status !== "active") return { eligible: false, reason: "inactive" };
    if (this.session.getPlanModeState()?.enabled || this.session.getVibeModeState()?.enabled) return { eligible: false, reason: "native-mode" };
    if (this.#suppressedGoalId === state.goal.id) return { eligible: false, reason: "suppressed-no-tools" };
    if (busy.interruptsInFlight) return { eligible: false, reason: "interrupt-pending" };
    if (busy.mutationPending) return { eligible: false, reason: "mutation-pending" };
    if (busy.admissionPending) return { eligible: false, reason: "admission-pending" };
    if (busy.promptInFlight || this.session.isStreaming) return { eligible: false, reason: "prompt-running" };
    if (this.session.queuedMessageCount > 0) return { eligible: false, reason: "queued-input" };
    if (this.#activeTools.size) return { eligible: false, reason: "tool-running" };
    if (busy.interactionsPending) return { eligible: false, reason: "interaction-pending" };
    if (this.session.hasPostPromptWork) return { eligible: false, reason: "post-prompt-work" };
    if (this.session.hasPendingAsyncWork()) return { eligible: false, reason: "native-async-work" };
    return { eligible: true, goalId: state.goal.id, observedUpdatedAt: state.goal.updatedAt };
  }

  begin(expectedGoalId: string, dispatch: (prompt: string) => Promise<boolean>): OmpGoalContinuationRun {
    const eligible = this.eligibility();
    if (!eligible.eligible || eligible.goalId !== expectedGoalId) {
      const error = new Error(!eligible.eligible ? `Native goal continuation is not eligible: ${eligible.reason}.` : "The native goal changed.");
      error.name = "GoalContinuationRejected";
      throw error;
    }
    const prompt = this.session.goalRuntime.buildContinuationPrompt();
    if (!prompt) {
      const error = new Error("The native goal has no continuation prompt.");
      error.name = "GoalContinuationRejected";
      throw error;
    }
    const receipt = Promise.withResolvers<GoalContinuationAcceptance>();
    const previous = this.manager.onEntryAppended;
    let observed = false;
    const listener: NonNullable<SessionManager["onEntryAppended"]> = entry => {
      previous?.(entry);
      if (observed || entry.type !== "custom_message" || entry.customType !== "goal-continuation") return;
      observed = true;
      void this.manager.flush().then(() => receipt.resolve({ goalId: expectedGoalId, entryId: entry.id }), receipt.reject);
    };
    this.manager.onEntryAppended = listener;
    this.#continuation = { goalId: expectedGoalId, hadToolCalls: false };
    const completion = (async (): Promise<GoalContinuationCompletion> => {
      try {
        const dispatched = await dispatch(prompt);
        await this.manager.flush();
        if (!observed || !dispatched) throw new OmpPromptAdmissionError();
        await this.#finalization;
        const hadToolCalls = this.#continuation?.hadToolCalls ?? false;
        return { goalId: expectedGoalId, hadToolCalls, suppressedNext: !hadToolCalls };
      } catch (error) {
        if (!observed) receipt.reject(error);
        throw error;
      } finally {
        if (this.manager.onEntryAppended === listener) this.manager.onEntryAppended = previous;
        this.#continuation = undefined;
      }
    })();
    void receipt.promise.catch(() => {});
    void completion.catch(() => {});
    return { accepted: receipt.promise, completion };
  }

  async settleFinalization(): Promise<void> { await this.#finalization; }

  async finalizeCompletedGoal(): Promise<void> {
    const state = this.session.getGoalModeState();
    if (state?.mode !== "exiting" || state.goal.status !== "complete") return;
    await this.restoreTools();
    await this.manager.appendEntriesAtomically(() => {
      this.manager.appendModeChange("none");
      this.manager.appendCustomEntry("goal-completed", {
        objective: state.goal.objective,
        tokensUsed: state.goal.tokensUsed,
        tokenBudget: state.goal.tokenBudget,
        timeUsedSeconds: state.goal.timeUsedSeconds,
      });
    });
    this.session.setGoalModeState(undefined);
  }
}
