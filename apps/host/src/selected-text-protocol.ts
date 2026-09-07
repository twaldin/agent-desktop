import type { Draft, HostCommand } from "@agent-desktop/shared";

/** Check raw input before an older endpoint can normalize away snapshot fields. */
export function hasSelectedTextIntent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  return Object.hasOwn(command, "selectedTextAttachments") || command.type === "draft.put"
    && !!command.draft && typeof command.draft === "object" && Object.hasOwn(command.draft, "selectedTextAttachments");
}

/** Recheck saved state after prior queued writes, including draft-consuming commands. */
export function requiresSelectedTextProtocol(command: HostCommand, getDraft: (id: string) => Draft | undefined): boolean {
  if (hasSelectedTextIntent(command)) return true;
  const id = command.type === "draft.put" ? command.draft.id
    : "draft" in command ? command.draft?.id : undefined;
  return id !== undefined && getDraft(id)?.selectedTextAttachments !== undefined;
}
