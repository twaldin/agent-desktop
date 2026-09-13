import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { ParsedSlashCommand, SlashCommandSpec } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
  parseForceToolPromptFields, parseForceToolReceipt,
  type ForceToolGuard, type ForceToolReceipt, type ForceToolRecovery,
} from "../../../../packages/shared/src/force-tool";
import type { NativeForceToolAdmissionPort } from "./force-tool";
import type { NativePromptDispatchResult, OmpPromptRun } from "./prompt";

/** Preserve both native handler branches, including void and Promise<void>. */
export type NativeForceHandlerReturn = ReturnType<NonNullable<SlashCommandSpec["handle"]>>;

/** Root revalidates the same raw native winner before each synchronous call.
 * This never spans an await and is never supplied to standalone recovery. */
export type NativeForceInvocationScope = <T>(operation: () => T) => T;

export interface ForceToolPromptOptions {
  commandId?: string;
  commandVersion?: number;
  forceTool?: ForceToolGuard;
  forceRecovery?: ForceToolRecovery;
}
export interface ForceToolPromptRun extends OmpPromptRun {
  readonly forceToolReceipt?: ForceToolReceipt;
}
export class ForceToolAdmissionError extends Error {
  constructor(message: string, readonly code: "FORCE_TOOL_NOT_ARMED" | "FORCE_TOOL_PROTOCOL_REQUIRED" | "OUTCOME_UNKNOWN" | "FORCE_TOOL_PROMPT_NOT_RECORDED" | "FORCE_TOOL_POST_ENTRY_FAILED",
    readonly forceToolReceipt?: ForceToolReceipt, cause?: unknown) {
    super(message, { cause });
    this.name = "ForceToolAdmissionError";
  }
}
/** Bounded typed evidence only. Never mine an error's text for an arm. */
export function forceToolReceiptFromError(error: unknown, commandId?: string): ForceToolReceipt | undefined {
  if (!error || typeof error !== "object" || !("forceToolReceipt" in error) || error.forceToolReceipt === undefined) return;
  return parseForceToolReceipt(error.forceToolReceipt, commandId);
}

/** A per-submission observer, not a runnable queue or an arm/send client API.
 * Construct after startPrompt owns its existing idle admission reservation. */
export class NativeForceToolAdmission {
  readonly options: ForceToolPromptOptions;
  #receipt?: ForceToolReceipt;
  #attempted = false;
  #entryId?: string;
  #historyFlushed = false;
  #promptDispatched = false;
  constructor(
    private readonly controller: NativeForceToolAdmissionPort,
    private readonly session: Pick<AgentSession, "sessionManager" | "prompt">,
    options: ForceToolPromptOptions,
    private readonly assertAdmissionOwner: () => void,
  ) {
    this.options = { ...options, ...parseForceToolPromptFields(options) };
  }
  get forceToolReceipt(): ForceToolReceipt | undefined { return this.#receipt && { ...this.#receipt }; }

  /** Called only from dispatchNativePrompt's already resolved native builtin
   * branch, after extension/custom precedence and attachment exclusions. */
  async dispatch(
    parsed: ParsedSlashCommand,
    builtin: SlashCommandSpec,
    invokeOriginalNativeHandler: () => NativeForceHandlerReturn,
    output: () => string,
    withResolvedNativeInvocation: NativeForceInvocationScope = operation => operation(),
  ): Promise<NativePromptDispatchResult> {
    if (this.#attempted) throw new Error("The original force handler was already attempted; do not rearm it.");
    this.#attempted = true;
    // This is a projection of the ORIGINAL parsed native arguments for queue
    // correlation only. The original handler still owns usage, parsing the
    // returned prompt, the setter, helper and [named, none] sequence.
    const space = parsed.args.indexOf(" ");
    const toolName = space === -1 ? parsed.args : parsed.args.slice(0, space);
    const promptRequested = space !== -1 && parsed.args.slice(space + 1).trim().length > 0;
    // A refusal before any native mutation still has an operation receipt.
    // Bare native usage has no requested tool: preserve "", never a placeholder.
    if (this.options.commandId) {
      const state = this.controller.getState();
      this.#receipt = parseForceToolReceipt({ commandId: this.options.commandId, epoch: state.epoch, toolName,
        arm: "not-armed", prompt: promptRequested ? "not-recorded" : "not-requested" }, this.options.commandId);
    }
    try {
      this.assertAdmissionOwner();
      if (builtin.name !== "force" || lookupBuiltinSlashCommand(parsed.name) !== builtin || !builtin.handle)
        throw new Error("The original native force command no longer owns this invocation.");
      if (this.options.forceRecovery) throw new Error("Force recovery must enter an ordinary prompt, not another arm.");
      if ((this.options.commandVersion ?? 0) < 18 || !this.options.commandId)
        throw new ForceToolAdmissionError("Native force requires command protocol 18 and its original submission identity.", "FORCE_TOOL_PROTOCOL_REQUIRED");
      const capture = withResolvedNativeInvocation(() => this.controller.captureArm({ commandId: this.options.commandId!, toolName, promptRequested,
        ...(this.options.forceTool === undefined ? {} : { guard: this.options.forceTool }) }, invokeOriginalNativeHandler));
      // Observe the original promise even if snapshot/receipt validation fails.
      // Never leave a false no-arm receipt after an unrepresentable mutation.
      void Promise.resolve(capture.result).catch(() => {});
      if (capture.receipt) {
        try { this.#receipt = parseForceToolReceipt(capture.receipt, this.options.commandId); }
        catch (error) {
          this.#receipt = undefined;
          throw new ForceToolAdmissionError("Native force mutation evidence could not be validated; retain the original command identity.", "OUTCOME_UNKNOWN", undefined, error);
        }
      }
      const armedState = this.#receipt?.arm === "armed" ? withResolvedNativeInvocation(() => this.controller.getState()) : undefined;
      let result: Awaited<NativeForceHandlerReturn>;
      try { result = await capture.result; }
      catch (error) { throw this.failure(error, true); }
      if (!this.#receipt || this.#receipt.arm === "not-armed")
        throw new ForceToolAdmissionError(output().slice(0, 4096) || "The native force handler did not arm a directive.", "FORCE_TOOL_NOT_ARMED", this.#receipt);
      if (this.#receipt.arm !== "armed") throw this.failure(new Error("Native queue correlation was ambiguous; inspect the original command without replaying it."), true);
      this.assertAdmissionOwner();
      const commandEntryId = this.session.sessionManager.appendCustomEntry("agent-desktop.force-tool", { forceToolReceipt: this.#receipt });
      try { await this.session.sessionManager.flush(); this.#historyFlushed = true; }
      catch (error) { throw this.failure(error, true); }
      if (result && "prompt" in result) {
        // Ownership fences are rechecked after native output and history I/O.
        this.assertAdmissionOwner();
        // Keep the post-arm policy ticket across both awaits. Registry/model/
        // dialect changes must not send the remaining prompt under a new policy.
        withResolvedNativeInvocation(() => this.controller.assertRecovery({ epoch: armedState!.epoch, expectedRevision: armedState!.revision, directiveId: this.#receipt!.directiveId! }));
        this.#promptDispatched = true;
        this.#receipt = { ...this.#receipt, prompt: "unknown" };
        return { agentInvoked: await this.session.prompt(result.prompt) };
      }
      return { agentInvoked: false, handledCommand: "force", commandEntryId, output: output() };
    } catch (error) {
      try {
        const nativeReceipt = forceToolReceiptFromError(error, this.options.commandId);
        if (nativeReceipt) this.#receipt = nativeReceipt;
      } catch (cause) {
        this.#receipt = undefined;
        throw new ForceToolAdmissionError("Native force mutation evidence could not be validated; retain the original command identity.", "OUTCOME_UNKNOWN", undefined, cause);
      }
      throw this.failure(error, !this.#historyFlushed);
    }
  }

  /** beginNativePrompt calls these at its actual append/flush boundaries. */
  observeUserEntry(entryId: string): void {
    if (!this.#receipt || !this.#promptDispatched) return;
    if (this.#entryId !== undefined && this.#entryId !== entryId) throw this.failure(new Error("Multiple user entries cannot identify the force prompt."), true);
    this.#entryId = entryId;
    this.#receipt = parseForceToolReceipt({ ...this.#receipt, prompt: "unknown", promptEntryId: entryId }, this.options.commandId);
  }
  observeFlushedUserEntry(entryId: string): void {
    if (!this.#receipt || !this.#promptDispatched) return;
    if (this.#entryId !== entryId) throw this.failure(new Error("Force prompt flush did not match its observed user entry."), true);
    this.#receipt = parseForceToolReceipt({ ...this.#receipt, prompt: "recorded", promptEntryId: entryId }, this.options.commandId);
  }
  failure(error: unknown, unknown = false): unknown {
    if (!this.#receipt) return error;
    if (this.#receipt.arm === "not-armed") return new ForceToolAdmissionError(
      error instanceof Error ? error.message : "The native force handler did not arm a directive.",
      error instanceof ForceToolAdmissionError && error.code === "FORCE_TOOL_PROTOCOL_REQUIRED" ? error.code : "FORCE_TOOL_NOT_ARMED",
      this.forceToolReceipt, error);
    if (this.#receipt.prompt !== "recorded" && this.#receipt.prompt !== "not-requested") {
      // Repeated observations by dispatch, beginNativePrompt and wrapRun cannot
      // turn uncertainty into proof of no entry. Only a positive flush can.
      this.#receipt = { ...this.#receipt, prompt: unknown || this.#receipt.prompt === "unknown" || this.#promptDispatched
        || this.#entryId !== undefined || this.#receipt.arm === "unknown"
        || (error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN") ? "unknown" : "not-recorded" };
    }
    const uncertain = unknown || this.#receipt.arm === "unknown" || this.#receipt.prompt === "unknown"
      || (error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN");
    return new ForceToolAdmissionError(uncertain
      ? "Native force outcome could not be fully verified. Retain the original command identity; do not rearm it."
      : this.#receipt.prompt === "recorded" ? "The native force prompt was recorded before the later operation failed."
      : "The native force remains armed but its optional prompt was not recorded. Retain the original draft.",
    uncertain ? "OUTCOME_UNKNOWN" : this.#receipt.prompt === "recorded" ? "FORCE_TOOL_POST_ENTRY_FAILED" : "FORCE_TOOL_PROMPT_NOT_RECORDED", this.forceToolReceipt, error);
  }
  /** Preserve independent admission/completion. An error after a flushed user
   * entry cannot revoke the already accepted prompt or manufacture a replay. */
  wrapRun(run: OmpPromptRun): ForceToolPromptRun {
    const observer = this;
    const accepted = run.accepted.then(value => {
      if (observer.#receipt && observer.#promptDispatched && (!value || value.kind !== "user-message"))
        throw observer.failure(new Error("The returned force prompt did not record a user entry."));
      if (value?.kind === "user-message" && observer.#receipt && observer.#receipt.prompt !== "recorded")
        throw observer.failure(new Error("Force prompt persistence was not observed."), true);
      return value;
    }, error => { throw observer.failure(error); });
    const completion = run.completion.catch(error => { throw observer.failure(error); });
    void accepted.catch(() => {});
    void completion.catch(() => {});
    return { accepted, completion, get forceToolReceipt() { return observer.forceToolReceipt; } };
  }
}

/** Call from INSIDE the same existing idle/queue reservation as ordinary prompt
 * entry, after all asynchronous preparation. There is deliberately no await
 * between the final assertion and entering the original native prompt. */
export function assertForceToolRecoveryAndEnter<T>(
  controller: NativeForceToolAdmissionPort, recovery: ForceToolRecovery,
  assertAdmissionOwner: () => void, enterOriginalPrompt: () => T,
): T {
  const parsed = parseForceToolPromptFields({ forceRecovery: recovery }).forceRecovery!;
  assertAdmissionOwner();
  controller.assertRecovery(parsed);
  return enterOriginalPrompt();
}
