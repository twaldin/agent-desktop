import { AsyncLocalStorage } from "node:async_hooks";
import { AgentBusyError, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

export interface NativePlanMessageAdmission {
  kind: "native-plan-message" | "native-plan-command";
  entryId: string;
}

export interface OmpPlanExecutionRun {
  /** Exact message append, or completed native local command, durably flushed. */
  accepted: Promise<NativePlanMessageAdmission | null>;
  /** The direct native turn or queued native follow-up, including its drain. */
  completion: Promise<void>;
  /** Interrupt native work, then join the same completion. */
  abort(): Promise<void>;
}

export class NativePlanMessageAdmissionError extends Error {
  readonly code = "OUTCOME_UNKNOWN";
  constructor(cause?: unknown) {
    super("Native Plan message admission could not be verified.", { cause });
    this.name = "NativePlanMessageAdmissionError";
  }
}

type Attribution = "approval" | "refinement";
type NativeAgentPrompt = AgentSession["agent"]["prompt"];
type NativeAgentQueue = AgentSession["agent"]["followUp"];

interface Pending {
  attribution: Attribution;
  assertCurrent?: () => void;
  accepted: ReturnType<typeof Promise.withResolvers<NativePlanMessageAdmission | null>>;
  message?: AgentMessage;
  entryId?: string;
  flush?: Promise<void>;
  dispatchSettled: boolean;
  settled: boolean;
}

/**
 * Attributes an internal Plan execution to the exact AgentMessage created by
 * OMP's public session prompt/follow-up APIs. Approval stays a native synthetic
 * developer message; refinement stays a native user message. No text,
 * timestamp, or reconstructed-message matching participates in acceptance.
 */
export class NativePlanExecutionAdmission {
  #scope = new AsyncLocalStorage<Pending>();
  #active?: { pending: Pending; completion: Promise<void> };
  #closed = false;
  #originalPrompt: NativeAgentPrompt;
  #wrappedPrompt: NativeAgentPrompt;
  #originalFollowUp: NativeAgentQueue;
  #wrappedFollowUp: NativeAgentQueue;
  #previousEntryListener: SessionManager["onEntryAppended"];
  #entryListener: NonNullable<SessionManager["onEntryAppended"]>;

  constructor(private readonly session: AgentSession, private readonly manager: SessionManager) {
    const agent = session.agent;
    this.#originalPrompt = agent.prompt;
    this.#originalFollowUp = agent.followUp;
    this.#wrappedPrompt = ((...args: unknown[]) => {
      const pending = this.#scope.getStore();
      if (pending) {
        pending.assertCurrent?.();
        const input = args[0];
        const messages = Array.isArray(input) ? input : typeof input === "object" && input !== null ? [input] : [];
        const candidates = messages.filter(message => this.#matches(message, pending.attribution));
        if (candidates.length !== 1) throw new Error("Native Plan prompt did not produce one attributable message.");
        this.#capture(pending, candidates[0] as AgentMessage);
      }
      return (this.#originalPrompt as (...values: unknown[]) => Promise<void>).apply(agent, args);
    }) as NativeAgentPrompt;
    this.#wrappedFollowUp = ((message: AgentMessage) => {
      const pending = this.#scope.getStore();
      if (pending) {
        pending.assertCurrent?.();
        if (!this.#matches(message, pending.attribution))
          throw new Error("Native Plan follow-up did not preserve its native attribution.");
        this.#capture(pending, message);
      }
      return this.#originalFollowUp.call(agent, message);
    }) as NativeAgentQueue;
    agent.prompt = this.#wrappedPrompt;
    agent.followUp = this.#wrappedFollowUp;

    this.#previousEntryListener = manager.onEntryAppended;
    this.#entryListener = entry => {
      this.#previousEntryListener?.(entry);
      const active = this.#active?.pending;
      if (!active || active.settled || entry.type !== "message" || entry.message !== active.message) return;
      if (active.entryId !== undefined) {
        active.accepted.reject(new NativePlanMessageAdmissionError(new Error("Native Plan message was appended more than once.")));
        active.settled = true;
        return;
      }
      active.entryId = entry.id;
      active.flush = manager.flush().then(() => {
        active.assertCurrent?.();
        if (active.settled) return;
        active.settled = true;
        active.accepted.resolve({ kind: "native-plan-message", entryId: entry.id });
      }).catch(error => {
        if (active.settled) return;
        active.settled = true;
        active.accepted.reject(new NativePlanMessageAdmissionError(error));
      });
    };
    manager.onEntryAppended = this.#entryListener;
  }

  get busy(): boolean { return this.#active !== undefined; }

  start(input: { prompt: string; attribution: Attribution; assertCurrent?: () => void }): OmpPlanExecutionRun {
    if (this.#closed) throw new Error("Native Plan execution admission is closed.");
    if (this.#active) throw new AgentBusyError("A native Plan execution admission is already active.");
    const pending: Pending = { attribution: input.attribution, assertCurrent: input.assertCurrent,
      accepted: Promise.withResolvers(), dispatchSettled: false, settled: false };
    void pending.accepted.promise.catch(() => {});
    const completion = this.#dispatch(pending, input.prompt).finally(() => {
      if (this.#active?.pending === pending) this.#active = undefined;
    });
    void completion.catch(() => {});
    this.#active = { pending, completion };
    return { accepted: pending.accepted.promise, completion, abort: async () => {
      await this.session.abort();
      await completion;
    } };
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    const errors: unknown[] = [];
    if (active) {
      try { await this.session.abort(); } catch (error) { errors.push(error); }
      try { await active.completion; } catch (error) { errors.push(error); }
    }
    const agent = this.session.agent;
    if (agent.prompt === this.#wrappedPrompt) agent.prompt = this.#originalPrompt;
    if (agent.followUp === this.#wrappedFollowUp) agent.followUp = this.#originalFollowUp;
    if (this.manager.onEntryAppended === this.#entryListener) this.manager.onEntryAppended = this.#previousEntryListener;
    this.#scope.disable();
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Native Plan execution admission disposal failed.");
  }

  async #dispatch(pending: Pending, text: string): Promise<void> {
    let queued = this.session.isStreaming;
    let localCommandHandled = false;
    try {
      if (queued) await this.#enqueue(pending, text);
      else {
        try { localCommandHandled = await this.#scope.run(pending, () => this.#prompt(pending.attribution, text)) === false; }
        catch (error) {
          if (!(error instanceof AgentBusyError) || pending.entryId !== undefined) throw error;
          this.#resetCaptured(pending);
          queued = true;
          await this.#enqueue(pending, text);
        }
      }
      pending.dispatchSettled = true;
      if (!pending.message) {
        if (localCommandHandled) {
          // OMP's false result means an extension/custom command consumed the
          // input. It is completed work, not a removed message safe to retry.
          pending.assertCurrent?.();
          const entryId = this.manager.appendCustomEntry("agent-desktop-plan-local-command", {
            version: 1, attribution: pending.attribution, command: text, nativeSessionId: this.session.sessionId,
          });
          await this.manager.flush(); pending.assertCurrent?.();
          pending.settled = true;
          pending.accepted.resolve({ kind: "native-plan-command", entryId });
          return;
        }
        throw new NativePlanMessageAdmissionError(new Error("Native Plan dispatch completed without an attributable message or local-command result."));
      }
      if (!queued) await this.#settleDirectCapture(pending);
      if (queued) await this.#settleQueuedCapture(pending);
      else await pending.accepted.promise;
    } catch (error) {
      pending.dispatchSettled = true;
      const failures: unknown[] = [error];
      if (pending.message && !pending.settled) {
        // Both drains must settle even when one fails. In particular, an owner
        // assertion thrown after flush cannot leave accepted pending forever.
        const drains = await Promise.allSettled([
          Promise.resolve().then(() => this.session.settleInFlightMessagePersistence()),
          pending.flush,
        ]);
        for (const drain of drains) if (drain.status === "rejected") failures.push(drain.reason);
      }
      const failure = failures.length === 1 ? error : new AggregateError(failures, "Native Plan dispatch and persistence failed.");
      if (!pending.settled) {
        pending.settled = true;
        // A command can act before producing a message, then throw. Absence of
        // an entry is not evidence that replaying that command is safe.
        pending.accepted.reject(new NativePlanMessageAdmissionError(failure));
      }
      throw failure;
    }
  }

  async #prompt(attribution: Attribution, text: string): Promise<boolean> {
    const pending = this.#scope.getStore(), runner = this.session.extensionRunner;
    const commandErrors: Error[] = [];
    // Native prompt catches local command errors and reports them on this
    // runner before returning false. Preserve that actual failure signal;
    // false by itself cannot establish a successful local command.
    const unsubscribe = runner?.onError(error => {
      if (this.#scope.getStore() === pending && error.event === "command") commandErrors.push(new Error(error.error));
    });
    try {
      const result = await (attribution === "approval" ? this.session.prompt(text, { synthetic: true }) : this.session.prompt(text));
      if (commandErrors.length) throw new AggregateError(commandErrors, "Native Plan local command failed.");
      if (result === false && (!runner || this.session.extensionRunner !== runner))
        throw new NativePlanMessageAdmissionError(new Error("The original native command error channel was unavailable."));
      return result;
    } finally { unsubscribe?.(); }
  }

  #enqueue(pending: Pending, text: string): Promise<void> {
    return this.#scope.run(pending, () => pending.attribution === "approval"
      ? this.session.followUp(text, undefined, { synthetic: true })
      : this.session.followUp(text));
  }

  async #settleDirectCapture(pending: Pending): Promise<void> {
    await this.session.settleInFlightMessagePersistence();
    await pending.flush;
    if (pending.settled) return;
    pending.settled = true;
    pending.accepted.reject(new NativePlanMessageAdmissionError(new Error("Native Plan prompt completed without a durable attributable entry.")));
  }

  async #settleQueuedCapture(pending: Pending): Promise<void> {
    while (!pending.settled) {
      await Promise.race([pending.accepted.promise.then(() => {}), this.session.waitForIdle()]);
      if (pending.settled) break;
      await this.session.settleInFlightMessagePersistence();
      await pending.flush;
      if (pending.settled) break;
      const message = pending.message!;
      const queued = this.session.agent.peekSteeringQueue().includes(message)
        || this.session.agent.peekFollowUpQueue().includes(message);
      if (!queued && !this.session.isStreaming && !this.session.hasPostPromptWork) {
        pending.settled = true;
        pending.accepted.resolve(null);
        break;
      }
      // A still-queued message has no completed admission to claim. Poll only
      // for native queue/turn state changes; elapsed time is never acceptance.
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await pending.accepted.promise;
    await this.session.waitForIdle();
  }

  #capture(pending: Pending, message: AgentMessage): void {
    if (pending.message && pending.message !== message)
      throw new Error("Native Plan execution produced multiple attributable messages.");
    pending.message = message;
  }

  #resetCaptured(pending: Pending): void {
    if (pending.entryId !== undefined) throw new NativePlanMessageAdmissionError(new Error("A recorded native Plan prompt cannot fall back to follow-up."));
    pending.message = undefined;
    pending.flush = undefined;
  }

  #matches(message: unknown, attribution: Attribution): boolean {
    if (!message || typeof message !== "object") return false;
    const value = message as { role?: unknown; synthetic?: unknown; attribution?: unknown };
    return attribution === "approval"
      ? value.role === "developer" && value.synthetic === true && value.attribution === "agent"
      : value.role === "user" && value.synthetic !== true && value.attribution === "user";
  }
}
