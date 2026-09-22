import type { GoalComposerDraft } from "@agent-desktop/shared";
import { goalBudgetIssue } from "./goal-composer";

export interface ActionError {
  message: string;
  force?: { hostId: string; sessionId: string; commandId: string };
  goalBudget?: { hostId: string; draftId: string };
}

export const actionError = (message: string, force?: ActionError["force"]): ActionError => ({
  message,
  ...(force ? { force } : {}),
});

export function clearRecoveredForceError(current: ActionError | null, force: NonNullable<ActionError["force"]>): ActionError | null {
  return current?.force?.hostId === force.hostId
    && current.force.sessionId === force.sessionId
    && current.force.commandId === force.commandId ? null : current;
}

export function clearRecoveredGoalBudgetError(current: ActionError | null, owner: NonNullable<ActionError["goalBudget"]>, goal: GoalComposerDraft | null): ActionError | null {
  return current?.goalBudget?.hostId === owner.hostId
    && current.goalBudget.draftId === owner.draftId
    && (!goal || !goalBudgetIssue(goal.tokenBudget)) ? null : current;
}
