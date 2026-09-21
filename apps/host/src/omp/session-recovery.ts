import type { AgentSession, AgentSessionEvent, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { NativePromptDispatchResult } from "./prompt";

export class NativeSessionRecovery {
  constructor(
    private readonly session: AgentSession,
    private readonly manager: SessionManager,
    private readonly assertOwner: () => void,
    private readonly onFresh: (result: { previousSessionId: string; sessionId: string; closedProviderSessions: number }) => void = () => {},
  ) {}

  async dispatch(command: "retry" | "fresh", args: string, signal: AbortSignal): Promise<NativePromptDispatchResult> {
    this.assertOwner();
    if (args !== "") throw new Error(`Usage: /${command}`);
    if (command === "fresh") return this.#fresh();
    return this.#retry(signal);
  }

  async #fresh(): Promise<NativePromptDispatchResult> {
    const localSessionFile = this.manager.getSessionFile();
    const result = this.session.freshSession();
    if (!result) throw new Error("Wait for the current response to finish or abort it before refreshing provider state.");
    this.assertOwner();
    if (this.manager.getSessionFile() !== localSessionFile)
      throw Object.assign(new Error("Native provider state changed but the original transcript identity could not be verified."), { code: "OUTCOME_UNKNOWN" });
    this.onFresh(result);
    const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
    const output = `Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`;
    const commandEntryId = this.manager.appendCustomEntry("agent-desktop.command-output", {
      command: "fresh", output, previousProviderSessionId: result.previousSessionId, providerSessionId: result.sessionId,
      closedProviderSessions: result.closedProviderSessions,
    });
    return { agentInvoked: false, handledCommand: "fresh", commandEntryId, output };
  }

  async #retry(signal: AbortSignal): Promise<NativePromptDispatchResult> {
    let started = false, settled = false;
    const turn = Promise.withResolvers<boolean>();
    const finish = (value: boolean) => { if (!settled) { settled = true; stop(); signal.removeEventListener("abort", aborted); turn.resolve(value); } };
    const observe = (event: AgentSessionEvent) => {
      if (event.type === "agent_start") started = true;
      if (started && event.type === "agent_end") finish(true);
    };
    const stop = this.session.subscribe(observe);
    const aborted = () => finish(false);
    signal.addEventListener("abort", aborted, { once: true });
    let didRetry = false;
    try { didRetry = await this.session.retry(); }
    catch (error) { stop(); signal.removeEventListener("abort", aborted); throw error; }
    if (!didRetry) {
      stop(); signal.removeEventListener("abort", aborted);
      throw new Error("Nothing to retry.");
    }
    const output = "Retrying the last failed turn.";
    const commandEntryId = this.manager.appendCustomEntry("agent-desktop.command-output", { command: "retry", output });
    await this.manager.flush();
    return { agentInvoked: true, handledCommand: "retry", commandEntryId, output, turnCompletion: turn.promise };
  }
}
