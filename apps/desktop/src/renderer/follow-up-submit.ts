import type { FollowUpDelivery } from "@agent-desktop/shared";

export interface FollowUpEnterKey {
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  keyCode: number;
  isComposing: boolean;
}

/** Resolve the pinned normal/opposite active-turn shortcut without dispatching. */
export function followUpDeliveryForEnter(event: FollowUpEnterKey, sendBehavior: "enter" | "mod-enter",
  selected: FollowUpDelivery): FollowUpDelivery | null {
  if (event.key !== "Enter" || event.altKey || event.isComposing || event.keyCode === 229) return null;
  const modified = event.metaKey || event.ctrlKey;
  const inverse = sendBehavior === "enter" ? modified && !event.shiftKey : modified && event.shiftKey;
  const normal = sendBehavior === "enter" ? !modified && !event.shiftKey : modified && !event.shiftKey;
  if (!normal && !inverse) return null;
  return inverse ? selected === "follow-up" ? "steer" : "follow-up" : selected;
}
