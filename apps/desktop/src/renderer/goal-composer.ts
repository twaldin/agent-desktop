/** Native OMP 18.1.10 `/goal` management verbs. Anything else after `/goal` is an objective. */
const GOAL_VERBS = ["set", "show", "pause", "resume", "drop", "budget"] as const;
export type GoalVerb = typeof GOAL_VERBS[number];
export type GoalComposerCommand =
  /** `/goal` or `/goal objective`: the flag activates and only the prefix leaves the text. */
  | { kind: "activate"; text: string }
  /** `/goal set|show|pause|resume|drop|budget …`: existing-goal management, never an objective. */
  | { kind: "manage"; verb: GoalVerb; rest: string };

export function goalComposerCommand(text: string): GoalComposerCommand | undefined {
  const input = text.trimStart();
  if (!/^\/goal(?=$| )/.test(input)) return undefined;
  const rest = input.slice(5).trimStart();
  const verb = /^(\S+)/.exec(rest)?.[1]?.toLowerCase();
  if (verb && (GOAL_VERBS as readonly string[]).includes(verb)) return { kind: "manage", verb: verb as GoalVerb, rest: rest.slice(verb.length).trim() };
  return { kind: "activate", text: rest };
}

/** Mirrors the shared send-time budget rule so the chip can warn before the prompt is refused. */
export function goalBudgetIssue(tokenBudget: string): string | undefined {
  const budget = tokenBudget.trim();
  if (!budget) return undefined;
  return /^\d+$/.test(budget) && Number.isSafeInteger(Number(budget)) && Number(budget) > 0 ? undefined : "Goal token budget must be a positive integer, or empty for no budget.";
}
