export interface ActionError {
  message: string;
  force?: { hostId: string; sessionId: string; commandId: string };
}

export const actionError = (message: string, force?: ActionError["force"]): ActionError => ({
  message,
  ...(force ? { force } : {}),
});

export function clearRecoveredForceError(current: ActionError | null, force: NonNullable<ActionError["force"]>): ActionError | null {
  return current?.force?.hostId === force.hostId
    && current.force.sessionId === force.sessionId
    && current.force.commandId === force.commandId ? null : current;
}
