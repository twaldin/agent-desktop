import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import {
  isHiddenUserCompanion,
  isUserQueuedMessage,
  queueChipText,
} from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import type {
  NativeQueuedMessage,
  NativeQueuedMessageMutation,
  NativeQueuedMessageMutationReceipt,
  NativeQueuedMessagesSnapshot,
} from "../../../../packages/shared/src/queued-messages";
import type { NativeSteerAdmission } from "./steer";

type AgentMessage = Parameters<AgentSession["agent"]["steer"]>[0];

interface Unit {
  id: string;
  lane: NativeQueuedMessage["lane"];
  user: AgentMessage;
  messages: AgentMessage[];
}

export class NativeQueueConflictError extends Error {
  readonly code = "QUEUE_CHANGED";
  constructor(message = "The native queued messages changed. Reload them before trying again.") {
    super(message);
    this.name = "NativeQueueConflictError";
  }
}

const hiddenCompanion = (message: AgentMessage): boolean => isHiddenUserCompanion(message as never);
const userMessage = (message: AgentMessage): boolean => isUserQueuedMessage(message as never);
const chipText = (message: AgentMessage): string => queueChipText(message as never);

function imageCount(message: AgentMessage): number {
  if (!("content" in message) || typeof message.content === "string") return 0;
  return message.content.filter(part => part.type === "image").length;
}

/**
 * Owns identities and compare-and-swap mutations for one live native session.
 * OMP queue objects are in-memory, so these IDs intentionally do not survive a
 * worker restart. Hidden user companions move and disappear with their user row.
 */
export class NativeQueuedMessages {
  #ids = new WeakMap<object, string>();
  #nextId = 0;
  #revision = 0;
  #signature = "";
  #listeners = new Set<(snapshot: NativeQueuedMessagesSnapshot) => void>();
  #unsubscribeAdmission: () => void;
  #unsubscribeAgent: () => void;

  constructor(
    private readonly session: AgentSession,
    private readonly admission: NativeSteerAdmission,
    private readonly epoch: string = crypto.randomUUID(),
  ) {
    this.#unsubscribeAdmission = admission.subscribeQueue(() => this.#notifyIfChanged());
    this.#unsubscribeAgent = session.agent.subscribe(() => this.#notifyIfChanged());
  }

  subscribe(listener: (snapshot: NativeQueuedMessagesSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  close(): void {
    this.#unsubscribeAdmission();
    this.#unsubscribeAgent();
    this.#listeners.clear();
  }

  snapshot(): NativeQueuedMessagesSnapshot {
    const units = this.#units();
    const signature = [String(this.session.isStreaming),
      ...this.session.agent.peekSteeringQueue().map(message => `steer:${this.#id(message)}`),
      ...this.session.agent.peekFollowUpQueue().map(message => `follow-up:${this.#id(message)}`),
      ...units.map(unit => `${unit.id}:${this.admission.ownsQueuedMessage(unit.user)}`),
    ].join("\n");
    if (signature !== this.#signature) {
      this.#signature = signature;
      this.#revision++;
    }
    return {
      revision: this.#revision,
      streaming: this.session.isStreaming,
      messages: units.map((unit, position) => ({
        id: unit.id,
        lane: unit.lane,
        text: chipText(unit.user),
        imageCount: imageCount(unit.user),
        position,
        ownership: this.admission.ownsQueuedMessage(unit.user) ? "desktop-pending" : "native",
        // Replacing text on a pending desktop command would contradict that
        // command's durably journaled input. Editing needs a new receipt contract.
        editable: false,
        removable: true,
        promotable: unit.lane === "follow-up" && this.session.isStreaming,
      })),
    };
  }

  mutate(mutation: NativeQueuedMessageMutation): NativeQueuedMessageMutationReceipt {
    const before = this.snapshot();
    if (mutation.expectedRevision !== before.revision) throw new NativeQueueConflictError();
    const units = this.#units();
    const selected = "messageId" in mutation ? units.find(unit => unit.id === mutation.messageId) : undefined;
    if ("messageId" in mutation && !selected) throw new NativeQueueConflictError("That queued message is no longer available. Reload the queue.");

    if (mutation.type === "remove") {
      this.#remove(selected!);
      this.admission.settleRemovedQueuedMessage(selected!.user, "Queued input was removed before native delivery");
    } else if (mutation.type === "promote") {
      if (selected!.lane !== "follow-up" || !this.session.isStreaming)
        throw new NativeQueueConflictError("This follow-up cannot steer the current native turn.");
      const steering = this.session.agent.peekSteeringQueue();
      const followUp = this.session.agent.peekFollowUpQueue();
      this.session.agent.replaceQueues([...steering, ...selected!.messages], this.#without(followUp, selected!));
    } else {
      const currentIds = units.map(unit => unit.id);
      if (mutation.messageIds.length !== currentIds.length || new Set(mutation.messageIds).size !== currentIds.length
        || mutation.messageIds.some(id => !currentIds.includes(id))) throw new NativeQueueConflictError("The queued-message order is stale.");
      const byId = new Map(units.map(unit => [unit.id, unit]));
      const ordered = mutation.messageIds.map(id => byId.get(id)!);
      if (ordered.some((unit, index) => unit.lane !== units[index]!.lane))
        throw new NativeQueueConflictError("Reordering cannot change native steer and follow-up delivery lanes.");
      const steeringOrder = ordered.filter(unit => unit.lane === "steer");
      const followUpOrder = ordered.filter(unit => unit.lane === "follow-up");
      this.session.agent.replaceQueues(
        this.#reorderLane(this.session.agent.peekSteeringQueue(), units.filter(unit => unit.lane === "steer"), steeringOrder),
        this.#reorderLane(this.session.agent.peekFollowUpQueue(), units.filter(unit => unit.lane === "follow-up"), followUpOrder),
      );
    }
    const snapshot = this.snapshot();
    this.#emit(snapshot);
    return { type: "native-queued-messages", mutation: mutation.type,
      ...(selected ? { messageId: selected.id } : {}), snapshot };
  }

  #notifyIfChanged(): void {
    const revision = this.#revision;
    const snapshot = this.snapshot();
    if (snapshot.revision !== revision) this.#emit(snapshot);
  }

  #emit(snapshot: NativeQueuedMessagesSnapshot): void {
    for (const listener of this.#listeners) listener(snapshot);
  }

  #id(message: AgentMessage): string {
    const object = message as object;
    let id = this.#ids.get(object);
    if (!id) { id = `${this.epoch}:${++this.#nextId}`; this.#ids.set(object, id); }
    return id;
  }

  #units(): Unit[] {
    return [
      ...this.#laneUnits("steer", this.session.agent.peekSteeringQueue()),
      ...this.#laneUnits("follow-up", this.session.agent.peekFollowUpQueue()),
    ];
  }

  #laneUnits(lane: Unit["lane"], queue: readonly AgentMessage[]): Unit[] {
    const units: Unit[] = [];
    let companions: AgentMessage[] = [];
    for (const message of queue) {
      if (hiddenCompanion(message)) { companions.push(message); continue; }
      if (userMessage(message)) {
        units.push({ id: this.#id(message), lane, user: message, messages: [...companions, message] });
      }
      companions = [];
    }
    return units;
  }

  #remove(unit: Unit): void {
    const steering = this.session.agent.peekSteeringQueue();
    const followUp = this.session.agent.peekFollowUpQueue();
    this.session.agent.replaceQueues(
      unit.lane === "steer" ? this.#without(steering, unit) : steering.slice(),
      unit.lane === "follow-up" ? this.#without(followUp, unit) : followUp.slice(),
    );
  }

  #without(queue: readonly AgentMessage[], unit: Unit): AgentMessage[] {
    const removed = new Set(unit.messages);
    return queue.filter(message => !removed.has(message));
  }

  #reorderLane(queue: readonly AgentMessage[], current: Unit[], ordered: Unit[]): AgentMessage[] {
    if (current.length < 2) return queue.slice();
    const starts = new Map<AgentMessage, Unit>();
    for (const unit of current) starts.set(unit.messages[0]!, unit);
    const members = new Set(current.flatMap(unit => unit.messages));
    const replacement = ordered[Symbol.iterator]();
    const result: AgentMessage[] = [];
    for (const message of queue) {
      if (starts.has(message)) result.push(...replacement.next().value!.messages);
      if (!members.has(message)) result.push(message);
    }
    return result;
  }
}
