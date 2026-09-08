import type { Draft, HostCommand } from "@agent-desktop/shared";
export function hasWholeFileIntent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  return Object.hasOwn(command, "wholeFileAttachments") || command.type === "draft.put"
    && !!command.draft && typeof command.draft === "object" && Object.hasOwn(command.draft, "wholeFileAttachments");
}
export function requiresWholeFileProtocol(command: HostCommand, getDraft: (id: string) => Draft | undefined): boolean {
  if (hasWholeFileIntent(command)) return true;
  const id = command.type === "draft.put" ? command.draft.id : "draft" in command ? command.draft?.id : undefined;
  return id !== undefined && getDraft(id)?.wholeFileAttachments !== undefined;
}
