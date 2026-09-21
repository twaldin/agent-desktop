export const GOAL_COMPOSER_CAPABILITY = { version: 1, commandVersion: 24 } as const;

/** Unsent intent. Objective text remains in the ordinary composer document. */
export interface GoalComposerDraft { tokenBudget: string }
/** Validated intent carried by the original session.prompt admission. */
export interface GoalPromptIntent { objective: string; tokenBudget?: number }

export function parseGoalComposerDraft(value: unknown): GoalComposerDraft | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Goal composer intent.");
  const draft = value as Record<string, unknown>;
  if (Object.keys(draft).some(key => key !== "tokenBudget") || typeof draft.tokenBudget !== "string") throw new Error("Invalid Goal budget draft.");
  return { tokenBudget: draft.tokenBudget };
}
export function sameGoalComposerDraft(left: GoalComposerDraft | null | undefined, right: GoalComposerDraft | null | undefined): boolean {
  return left === right || Boolean(left && right && left.tokenBudget === right.tokenBudget);
}
export function parseGoalPromptIntent(value: unknown): GoalPromptIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native Goal prompt intent.");
  const goal = value as Record<string, unknown>;
  if (Object.keys(goal).some(key => key !== "objective" && key !== "tokenBudget") || typeof goal.objective !== "string" || !goal.objective.trim()) throw new Error("Enter a Goal objective before sending.");
  if (goal.tokenBudget !== undefined && (!Number.isSafeInteger(goal.tokenBudget) || (goal.tokenBudget as number) <= 0)) throw new Error("Goal token budget must be a positive integer, or empty for no budget.");
  return { objective: goal.objective.trim(), ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget as number }) };
}
export function goalPromptFromDraft(draft: { text: string; goal?: GoalComposerDraft | null }): GoalPromptIntent | undefined {
  if (!draft.goal) return undefined;
  const budget = draft.goal.tokenBudget.trim();
  if (budget && !/^\d+$/.test(budget)) throw new Error("Goal token budget must be a positive integer, or empty for no budget.");
  if (draft.text.trimStart().startsWith("/")) throw new Error("Clear the Goal intent before sending another slash command. The objective and attachments were retained.");
  return parseGoalPromptIntent({ objective: draft.text, ...(budget ? { tokenBudget: Number(budget) } : {}) });
}

/** Revalidate at each worker boundary before reserving or mutating native state. */
export function goalPromptForAdmission(text: string, options: {
  goal?: unknown; commandId?: unknown; commandVersion?: unknown;
  treeTicket?: unknown; forceTool?: unknown; forceRecovery?: unknown;
}): GoalPromptIntent | undefined {
  if (options.goal === undefined) return undefined;
  const goal = parseGoalPromptIntent(options.goal);
  if (options.commandVersion !== 24 || typeof options.commandId !== "string" || !options.commandId.trim()
    || options.treeTicket !== undefined || options.forceTool !== undefined || options.forceRecovery !== undefined
    || goal.objective !== text.trim() || text.trimStart().startsWith("/"))
    throw new Error("Goal creation requires its original version 24 ordinary prompt and command identity.");
  return goal;
}
