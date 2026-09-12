import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { sameMessageContent, sessionMessagePersistenceKey } from "@oh-my-pi/pi-coding-agent/session/turn-persistence";
import { isHiddenUserCompanion } from "@oh-my-pi/pi-coding-agent/session/queued-messages";

export type OmpSteerReceipt =
  | { kind: "user-message"; entryId: string }
  | { kind: "not-recorded"; reason: string }
  | { kind: "outcome-unknown"; reason: string };
type NativeMessage = Parameters<AgentSession["agent"]["steer"]>[0];
interface Pending {
  result: ReturnType<typeof Promise.withResolvers<OmpSteerReceipt>>;
  message?: NativeMessage;
  dispatched: boolean;
  cancelled?: string;
  flushing?: Promise<void>;
  checking?: Promise<void>;
  settled: boolean;
}

/**
 * Pinned OMP 18.1.10 returns from steer before its queue is consumed. Associate
 * this adapter's async submission with the exact object passed to public
 * agent.steer, then require that object's native append and flush. No text or
 * timestamp matching is used for admission, and native message fields stay intact.
 * This wraps only the owned instance; it never patches the installed package.
 */
export class NativeSteerAdmission {
  #scope = new AsyncLocalStorage<Pending>();
  #pending = new Set<Pending>();
  #messages = new Map<NativeMessage, Pending>();
  #original: AgentSession["agent"]["steer"];
  #wrapped: AgentSession["agent"]["steer"];
  #originalFollowUp: AgentSession["agent"]["followUp"];
  #wrappedFollowUp: AgentSession["agent"]["followUp"];
  #previous: SessionManager["onEntryAppended"];
  #observer: NonNullable<SessionManager["onEntryAppended"]>;
  #unsubscribe: () => void;
  #timer?: ReturnType<typeof setInterval>;
  #queueListeners = new Set<() => void>();
  #closed = false;

  constructor(private session: AgentSession, private manager: SessionManager) {
    const agent = session.agent;
    this.#original = agent.steer;
    this.#originalFollowUp = agent.followUp;
    const capture = (message: NativeMessage, enqueue: (message: NativeMessage) => void) => {
      const pending = this.#scope.getStore();
      if (!pending) return enqueue(message);
      if (pending.cancelled || this.#closed) throw new Error(pending.cancelled ?? "OMP steer admission is closed");
      if (pending.message || message.role !== "user") throw new Error("Native steer did not produce one attributable user message");
      // Native persistence deduplicates by key + content. Reject a collision
      // before enqueue rather than borrow another entry's identity or alter a
      // native timestamp. This comparison is only a preflight rejection guard.
      const key = sessionMessagePersistenceKey(message);
      const existing = [...agent.state.messages, ...agent.peekSteeringQueue(), ...agent.peekFollowUpQueue(),
        ...manager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : [])];
      if (key && existing.some(item => sessionMessagePersistenceKey(item) === key && sameMessageContent(item, message))) {
        throw new Error("Native steer identity collides with an existing message; submit again after this rejection");
      }
      pending.message = message;
      this.#messages.set(message, pending);
      enqueue(message);
      for (const listener of this.#queueListeners) listener();
    };
    this.#wrapped = message => capture(message, value => this.#original.call(agent, value));
    this.#wrappedFollowUp = message => capture(message, value => this.#originalFollowUp.call(agent, value));
    agent.steer = this.#wrapped;
    agent.followUp = this.#wrappedFollowUp;
    this.#previous = manager.onEntryAppended;
    this.#observer = entry => {
      this.#previous?.(entry);
      if (entry.type !== "message") return;
      const pending = this.#messages.get(entry.message);
      if (!pending || pending.flushing) return;
      pending.flushing = manager.flush().then(
        () => this.#finish(pending, { kind: "user-message", entryId: entry.id }),
        error => this.#finish(pending, { kind: "outcome-unknown", reason: `Native steer storage could not be verified: ${String(error)}` }),
      );
    };
    manager.onEntryAppended = this.#observer;
    // Raw agent events retain original objects; display events may contain
    // deobfuscation copies. OMP installs its persistence slot before this listener.
    this.#unsubscribe = agent.subscribe(event => {
      if (event.type !== "message_end") return;
      const pending = this.#messages.get(event.message);
      if (pending) void this.#check(pending, "Native steer was delivered but its durable entry could not be verified");
    });
  }

  async submit(text: string): Promise<OmpSteerReceipt> {
    return this.#submit(() => this.session.steer(text));
  }

  /** Queue an ordinary user follow-up and verify its exact native entry. */
  async submitFollowUp(text: string): Promise<OmpSteerReceipt> {
    return this.#submit(() => this.session.followUp(text, undefined, { expandPromptTemplates: false }));
  }

  ownsQueuedMessage(message: NativeMessage): boolean {
    return this.#messages.has(message);
  }

  subscribeQueue(listener: () => void): () => void {
    this.#queueListeners.add(listener);
    return () => { this.#queueListeners.delete(listener); };
  }

  /** Settle an owned admission after a queue controller removed its exact object. */
  settleRemovedQueuedMessage(message: NativeMessage, reason: string): boolean {
    const pending = this.#messages.get(message);
    if (!pending || pending.settled) return false;
    pending.cancelled = reason;
    this.#finish(pending, { kind: "not-recorded", reason });
    return true;
  }

  async #submit(dispatch: () => Promise<void>): Promise<OmpSteerReceipt> {
    if (this.#closed) return { kind: "not-recorded", reason: "OMP steer admission is closed" };
    const pending: Pending = { result: Promise.withResolvers<OmpSteerReceipt>(), dispatched: false, settled: false };
    this.#pending.add(pending);
    this.#timer ??= setInterval(() => {
      if (this.session.isStreaming || this.session.hasPostPromptWork) return;
      for (const item of this.#pending) {
        if (item.dispatched && !item.cancelled) void this.#check(item, "Native turn settled without recording this steer", true);
      }
    }, 25);
    this.#timer.unref();
    try {
      await this.#scope.run(pending, dispatch);
      pending.dispatched = true;
      if (!pending.message) this.#finish(pending, { kind: "not-recorded", reason: "Native steer did not enqueue a user message" });
    } catch (error) {
      pending.dispatched = true;
      if (!pending.message || this.#removeQueued(pending)) this.#finish(pending, { kind: "not-recorded", reason: String(error) });
      else await this.#check(pending, `Native steer failed after leaving its queue: ${String(error)}`);
    }
    return pending.result.promise;
  }

  /** Synchronous removal precedes abort/dispose, preventing native auto-resume. */
  cancelQueued(reason: string): void {
    for (const pending of this.#pending) {
      pending.cancelled = reason;
      if (!pending.message || this.#removeQueued(pending)) this.#finish(pending, { kind: "not-recorded", reason });
    }
  }

  /** Call after native abort/dispose has settled its in-flight event handlers. */
  async settleCancelled(reason: string): Promise<void> {
    await Promise.all([...this.#pending].map(pending => this.#check(pending, reason)));
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    if (this.session.agent.steer === this.#wrapped) this.session.agent.steer = this.#original;
    if (this.session.agent.followUp === this.#wrappedFollowUp) this.session.agent.followUp = this.#originalFollowUp;
    if (this.manager.onEntryAppended === this.#observer) this.manager.onEntryAppended = this.#previous;
    if (this.#timer) clearInterval(this.#timer);
    for (const pending of this.#pending) this.#finish(pending, { kind: "outcome-unknown", reason: "Native steer admission closed without a verified receipt" });
    this.#scope.disable();
    this.#queueListeners.clear();
  }

  #removeQueued(pending: Pending): boolean {
    if (!pending.message) return false;
    const steering = this.session.agent.peekSteeringQueue();
    const followUp = this.session.agent.peekFollowUpQueue();
    if (!steering.includes(pending.message) && !followUp.includes(pending.message)) return false;
    const remove = (queue: readonly NativeMessage[]) => {
      const index = queue.indexOf(pending.message!);
      if (index < 0) return queue.slice();
      let start = index;
      while (start > 0 && isHiddenUserCompanion(queue[start - 1] as never)) start--;
      return [...queue.slice(0, start), ...queue.slice(index + 1)];
    };
    this.session.agent.replaceQueues(remove(steering), remove(followUp));
    for (const listener of this.#queueListeners) listener();
    return true;
  }

  #check(pending: Pending, reason: string, removeIfQueued = false): Promise<void> {
    if (pending.settled) return Promise.resolve();
    if (pending.checking) return pending.checking;
    pending.checking = (async () => {
      try {
        await this.session.settleInFlightMessagePersistence();
        await pending.flushing;
        if (pending.settled) return;
        if (removeIfQueued && this.#removeQueued(pending)) this.#finish(pending, { kind: "not-recorded", reason });
        else this.#finish(pending, { kind: "outcome-unknown", reason });
      } catch (error) {
        this.#finish(pending, { kind: "outcome-unknown", reason: `${reason}: ${String(error)}` });
      }
    })();
    return pending.checking;
  }

  #finish(pending: Pending, receipt: OmpSteerReceipt): void {
    if (pending.settled) return;
    pending.settled = true;
    this.#pending.delete(pending);
    if (pending.message) this.#messages.delete(pending.message);
    if (!this.#pending.size && this.#timer) { clearInterval(this.#timer); this.#timer = undefined; }
    pending.result.resolve(receipt);
  }
}
