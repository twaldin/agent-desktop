import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { DesktopBridge, TaskLocationMoveReceipt, TaskLocationMoveTarget, TaskLocationSnapshot } from "@agent-desktop/shared";
import type { TaskLocationActions } from "./task-location";

type Owner = { hostId: string; sessionId: string };
export class TaskLocationRequestFence {
  #generation = 0; #request = 0;
  reset() { return ++this.#generation; }
  request(generation: number) { return { generation, request: ++this.#request }; }
  accepts(token: { generation: number; request: number }, connected: boolean) { return connected && token.generation === this.#generation && token.request === this.#request; }
  isCurrent(generation: number, connected: boolean) { return connected && generation === this.#generation; }
  current() { return this.#generation; }
}

export type TaskLocationView =
  | { state: "loading" | "unavailable"; reason?: string }
  | { snapshot: TaskLocationSnapshot; actions: TaskLocationActions };

const ownerKey = (owner: Owner) => `${owner.hostId}:${owner.sessionId}`;
const owns = (owner: Owner, snapshot: TaskLocationSnapshot) => snapshot.hostId === owner.hostId && snapshot.sessionId === owner.sessionId;

function receipt(result: Awaited<ReturnType<DesktopBridge["command"]>>): TaskLocationMoveReceipt {
  if (!result.ok) throw new Error(result.error.message);
  const value = result.value;
  if (!value || !("type" in value) || value.type !== "session.location.move" || !("operation" in value)) throw new Error("The host did not return the task location operation.");
  return value as TaskLocationMoveReceipt;
}

/** Keeps the task-location snapshot attached to the selected session's original host. */
export function useTaskLocation(bridge: DesktopBridge, hostId: string, sessionId: string | undefined, connected: boolean): TaskLocationView | undefined {
  const owner = useMemo(() => sessionId ? { hostId, sessionId } : undefined, [hostId, sessionId]);
  const key = owner ? ownerKey(owner) : undefined;
  const currentOwner = useRef<Owner | undefined>(undefined);
  currentOwner.current = owner;
  const [view, setView] = useState<TaskLocationView>({ state: "loading" });
  const connectedRef = useRef(connected); connectedRef.current = connected;
  const fence = useRef(new TaskLocationRequestFence());
  const refresh = useCallback(async (expected: Owner, expectedGeneration = fence.current.current()) => {
    if (!bridge.getTaskLocation) throw new Error("Update this desktop to inspect this task location.");
    const token = fence.current.request(expectedGeneration);
    try {
      const snapshot = await bridge.getTaskLocation(expected.sessionId, expected.hostId);
      if (!fence.current.accepts(token, connectedRef.current) || !currentOwner.current || ownerKey(currentOwner.current) !== ownerKey(expected) || !owns(expected, snapshot)) return;
      setView(previous => "snapshot" in previous && previous.snapshot.revision === snapshot.revision ? previous : { snapshot, actions: createTaskLocationActions(bridge, currentOwner, expected, refresh, () => fence.current.isCurrent(expectedGeneration, connectedRef.current) && currentOwner.current !== undefined && ownerKey(currentOwner.current) === ownerKey(expected)) });
    } catch (cause) {
      if (fence.current.accepts(token, connectedRef.current) && currentOwner.current && ownerKey(currentOwner.current) === ownerKey(expected)) setView({ state: "unavailable", reason: cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    }
  }, [bridge]);

  useEffect(() => {
    if (!owner) return;
    const expectedGeneration = fence.current.reset();
    setView({ state: "loading" });
    if (!connected) { setView({ state: "unavailable", reason: "Reconnect to the owning host." }); return; }
    void refresh(owner, expectedGeneration).catch(() => {});
    return () => { fence.current.reset(); };
  }, [key, connected, owner, refresh]);

  useEffect(() => bridge.subscribe(event => {
    if (!owner || event.type !== "task-location" || event.hostId !== owner.hostId || event.sessionId !== owner.sessionId || !connected) return;
    const expectedGeneration = fence.current.current(); void refresh(owner, expectedGeneration).catch(() => {});
  }), [bridge, key, connected, owner, refresh]);

  return owner ? view : undefined;
}

export function createTaskLocationActions(bridge: DesktopBridge, currentOwner: MutableRefObject<Owner | undefined>, owner: Owner, refresh: (owner: Owner) => Promise<void>, valid: () => boolean): TaskLocationActions {
  const submit = async (snapshot: TaskLocationSnapshot, operationId: string, command: { type: "session.location.move"; target: TaskLocationMoveTarget } | { type: "session.location.resume"; operationId: string }) => {
    if (!valid() || !currentOwner.current || ownerKey(currentOwner.current) !== ownerKey(owner) || !owns(owner, snapshot)) throw new Error("This task changed before its location request could be sent.");
    const commandResult = await bridge.command({ id: operationId, command: command.type === "session.location.move"
      ? { type: command.type, sessionId: owner.sessionId, expectedRevision: snapshot.revision, target: command.target }
      : { type: command.type, sessionId: owner.sessionId, operationId: command.operationId, expectedRevision: snapshot.revision } }, owner.hostId);
    if (commandResult.commandId !== operationId) throw new Error("The host returned a different task location command receipt.");
    const result = receipt(commandResult), expectedOperationId = command.type === "session.location.move" ? operationId : command.operationId;
    if (result.operation.id !== expectedOperationId) throw new Error("The host returned a different task location operation.");
    if (!valid() || !currentOwner.current || ownerKey(currentOwner.current) !== ownerKey(owner) || result.operation.hostId !== owner.hostId || result.operation.sessionId !== owner.sessionId) throw new Error("The task changed while its location request was in flight.");
    await refresh(owner);
    return result;
  };
  return { move: (snapshot, target, operationId) => submit(snapshot, operationId, { type: "session.location.move", target }), resume: (snapshot, operationId) => submit(snapshot, crypto.randomUUID(), { type: "session.location.resume", operationId }) };
}
