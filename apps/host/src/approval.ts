import type { HostCommand, OmpApprovalMode } from "@agent-desktop/shared";

export function approvalMode(value: unknown): OmpApprovalMode {
  if (value !== "always-ask" && value !== "write" && value !== "yolo") throw new Error("Invalid native permission mode.");
  return value;
}

/** Presence, not truthiness: an unsupported client must never drop intent. */
export function hasApprovalIntent(command: unknown): boolean {
  if (!command || typeof command !== "object") return false;
  if (Object.hasOwn(command, "approvalMode")) return true;
  const value = command as { draft?: unknown };
  return !!value.draft && typeof value.draft === "object" && Object.hasOwn(value.draft, "approvalMode");
}

export function validateCommandApproval(command: HostCommand): void {
  if ("approvalMode" in command && command.approvalMode !== undefined) approvalMode(command.approvalMode);
  if (command.type === "draft.put" && command.draft.approvalMode !== undefined) approvalMode(command.draft.approvalMode);
}
