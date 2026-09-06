import type { Draft, HostCommand } from "@agent-desktop/shared";

export function hasEnvironmentIntent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  return command.type === 'session.environment.cancel' || command.type === 'session.environment.resume' || Object.hasOwn(command, "environment") || command.type === "draft.put" && !!command.draft
    && typeof command.draft === "object" && Object.hasOwn(command.draft, "environment");
}

export function requiresEnvironmentProtocol(command: HostCommand, getDraft: (id: string) => Draft | undefined): boolean {
  if (hasEnvironmentIntent(command)) return true;
  const id = command.type === "draft.put" ? command.draft.id
    : command.type === "session.create" || command.type === "session.prompt" || command.type === "session.steer" ? command.draft?.id : undefined;
  return id !== undefined && getDraft(id)?.environment !== undefined;
}
