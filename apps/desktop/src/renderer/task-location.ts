import type { TaskLocationMoveReceipt, TaskLocationMoveTarget, TaskLocationSnapshot } from "../../../../packages/shared/src/task-location";

export type { TaskLocationKind, TaskLocationAvailability, TaskLocationDestination, TaskLocationMoveStatus, TaskLocationMoveStep, TaskLocationOperation, TaskLocationMoveReceipt, TaskLocationMoveTarget, TaskLocationSnapshot } from "../../../../packages/shared/src/task-location";

/** The renderer sends only the exact host snapshot revision and a host-proven branch. */
export interface TaskLocationActions {
  move(snapshot: TaskLocationSnapshot, target: TaskLocationMoveTarget, operationId: string): Promise<TaskLocationMoveReceipt>;
  resume(snapshot: TaskLocationSnapshot, operationId: string): Promise<TaskLocationMoveReceipt>;
}

export const sameTaskLocationOwner = (a: TaskLocationSnapshot, b: TaskLocationSnapshot) =>
  a.hostId === b.hostId && a.sessionId === b.sessionId;
