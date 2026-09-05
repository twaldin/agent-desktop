import type { Draft, HostCommand } from "@agent-desktop/shared";

/** Inspect before normalization so an older endpoint cannot discard unknown image fields. */
export function hasAttachmentIntent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  if (Object.hasOwn(command, "attachments")) return true;
  return command.type === "draft.put" && !!command.draft && typeof command.draft === "object"
    && Object.hasOwn(command.draft, "attachments");
}

/** Recheck at execution after earlier queued commands have committed. Receipted retries skip execution. */
export function requiresAttachmentProtocol(command: HostCommand, getDraft: (id: string) => Draft | undefined): boolean {
  if (hasAttachmentIntent(command)) return true;
  const draftId = command.type === "draft.put" ? command.draft.id
    : command.type === "session.prompt" || command.type === "session.steer" ? command.draft?.id : undefined;
  return draftId !== undefined && getDraft(draftId)?.attachments !== undefined;
}
