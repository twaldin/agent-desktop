export type HostNotificationKind = "completion" | "question" | "permission";
export type HostNotificationState = "open" | "resolved";

/** Bounded desktop notice: session title plus fixed status text. No transcript, answer, tool arguments, or error details are copied. A session title can itself be derived from its initial prompt. */
export interface HostNotification {
  id: string;
  sessionId: string;
  kind: HostNotificationKind;
  state: HostNotificationState;
  createdAt: number;
  title: string;
  body: string;
}

export interface NotificationNavigationTarget {
  hostId: string;
  sessionId: string;
}

/** Main-owned notification click retained until one renderer durably saves the
 * exact conversation route. The opaque id acknowledges this click only. */
export interface NotificationNavigationRequest {
  id: string;
  target: NotificationNavigationTarget;
}

function navigationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)
    && !["__proto__", "constructor", "prototype"].includes(value);
}

export function parseNotificationNavigationRequest(value: unknown): NotificationNavigationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid notification navigation request.");
  const item = value as Record<string, unknown>, target = item.target;
  if (Object.keys(item).some(key => key !== "id" && key !== "target") || !navigationId(item.id)
    || !target || typeof target !== "object" || Array.isArray(target)) throw new Error("Invalid notification navigation request.");
  const owner = target as Record<string, unknown>;
  if (Object.keys(owner).some(key => key !== "hostId" && key !== "sessionId")
    || !navigationId(owner.hostId) || !navigationId(owner.sessionId)) throw new Error("Invalid notification navigation request.");
  return { id: item.id, target: { hostId: owner.hostId, sessionId: owner.sessionId } };
}
