import type { OmpInteractionResponse } from "@agent-desktop/shared";

export function parseInteractionAnswer(input: unknown): { interactionId: string; response: OmpInteractionResponse } {
  if (!input || typeof input !== "object") throw new Error("Invalid interaction answer.");
  const answer = input as Record<string, unknown>;
  if (typeof answer.interactionId !== "string" || !answer.interactionId || answer.interactionId.length > 200) throw new Error("Invalid interaction ID.");
  const response = answer.response as Record<string, unknown> | undefined;
  if (!response || typeof response !== "object" || Object.keys(response).length !== 1) throw new Error("Invalid interaction response.");
  let parsed: OmpInteractionResponse;
  if (response.cancel === true) parsed = { cancel: true };
  else if (typeof response.value === "boolean" || (typeof response.value === "string" && response.value.length <= 1024 * 1024)) parsed = { value: response.value };
  else if (response.action === "left" || response.action === "right" || response.action === "externalEditor" || response.action === "timeoutReset") parsed = { action: response.action };
  else throw new Error("Invalid interaction response.");
  return { interactionId: answer.interactionId, response: parsed };
}
