import { parsePlanDecisionReceipt, type PlanDecisionReceipt } from "../../../../packages/shared/src/session-plan";

/** Internal worker result. A native replacement is catalogued only after the
 * original worker has exited. Execution phase IDs are never renderer prompts. */
export interface OmpPlanDecisionPreparation {
  receipt: PlanDecisionReceipt;
  execution?: { phaseId: string };
  transition?: { nativeSessionId: string; sessionFile: string };
}

export function parsePlanDecisionPreparation(value: unknown, commandId: string): OmpPlanDecisionPreparation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native Plan decision result.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["receipt", "execution", "transition"].includes(key))) throw new Error("Invalid native Plan decision result fields.");
  const receipt = parsePlanDecisionReceipt(v.receipt, commandId);
  const result: OmpPlanDecisionPreparation = { receipt };
  const field = (input: unknown, keys: string[]) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid native Plan handoff.");
    const object = input as Record<string, unknown>;
    if (Object.keys(object).length !== keys.length || keys.some(key => typeof object[key] !== "string" || !object[key]
      || (object[key] as string).includes("\0") || new TextEncoder().encode(object[key] as string).length > 16384)) throw new Error("Invalid native Plan handoff fields.");
    return object as Record<string, string>;
  };
  if (v.execution !== undefined) {
    const e = field(v.execution, ["phaseId"]);
    if (receipt.outcome !== "applied" || receipt.execution !== "not-entered" || !["approve", "refine"].includes(receipt.action))
      throw new Error("Native Plan execution contradicts its decision receipt.");
    result.execution = { phaseId: e.phaseId! };
  }
  if (v.transition !== undefined) {
    const t = field(v.transition, ["nativeSessionId", "sessionFile"]);
    if (receipt.transition === "unchanged" || receipt.destinationSessionId !== t.nativeSessionId)
      throw new Error("Native Plan replacement contradicts its decision receipt.");
    result.transition = { nativeSessionId: t.nativeSessionId!, sessionFile: t.sessionFile! };
  } else if (receipt.transition === "new-session") throw new Error("Native Plan replacement omitted its actual path.");
  return result;
}
