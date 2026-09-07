export type InteractionMethod = "select" | "confirm" | "input" | "editor";
export type InteractionAction = "left" | "right" | "externalEditor" | "timeoutReset";
export interface OmpInteraction {
  id: string;
  sessionId: string;
  method: InteractionMethod;
  /** Set only when a native approval hook explicitly owns this interaction. */
  notificationKind?: "question" | "permission";
  title: string;
  message?: string;
  options?: Array<{ label: string; description?: string }>;
  placeholder?: string;
  prefill?: string;
  promptStyle?: boolean;
  createdAt: number;
  expiresAt?: number;
  initialIndex?: number;
  outline?: boolean;
  helpText?: string;
  selectionMarker?: "radio" | "checkbox";
  checkedIndices?: number[];
  markableCount?: number;
  actions: InteractionAction[];
}
export type OmpInteractionResponse = { value: string | boolean } | { cancel: true } | { action: InteractionAction };
export type InteractionEndReason = "answered" | "navigated" | "cancelled" | "timeout" | "aborted" | "disconnected" | "disposed";
export type OmpBridgeEvent =
  | { type: "extension_interaction_requested"; interaction: OmpInteraction }
  | { type: "extension_interaction_resolved"; sessionId: string; id: string; reason: InteractionEndReason }
  | { type: "extension_notification"; sessionId: string; message: string; level: "info" | "warning" | "error" }
  | { type: "extension_ui_unsupported"; sessionId: string; surface: string; message: string };
