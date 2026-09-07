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
