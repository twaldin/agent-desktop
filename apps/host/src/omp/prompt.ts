import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { ImageAdmission, PromptAdmission } from "@agent-desktop/shared";

export type OmpPromptReceipt = PromptAdmission;
export class OmpPromptAdmissionError extends Error {
  readonly code = "OUTCOME_UNKNOWN";
  constructor(cause?: unknown) {
    super(`Native prompt admission could not be verified. Retain the original submission identity.${cause instanceof Error ? ` ${cause.message}` : ""}`, { cause });
    this.name = "OmpPromptAdmissionError";
  }
}
export interface NativePromptDispatchResult {
  agentInvoked: boolean;
  /** Set only by an executed native command handler that consumed the input. */
  handledCommand?: string;
  commandEntryId?: string;
  output?: string;
}
export interface OmpPromptRun {
  /** Flushed user entry or completed native command; null is unaccepted input. */
  accepted: Promise<OmpPromptReceipt | null>;
  /** Actual native turn completion. Its boolean is not an acceptance receipt. */
  completion: Promise<boolean>;
}

/** The caller must exclude other user submissions until this admission settles. */
export function beginNativePrompt(
  manager: Pick<SessionManager, "onEntryAppended" | "flush">,
  dispatch: () => Promise<NativePromptDispatchResult>,
  settlePersistence: () => Promise<void>,
  imageAdmission?: { matches(message: unknown): boolean; receipt(): ImageAdmission[]; readonly dispatched: boolean },
  skillAdmission?: { matchesEntry(entry: Parameters<NonNullable<SessionManager["onEntryAppended"]>>[0]): boolean; readonly name: string; readonly dispatched: boolean },
  selectedTextAdmission?: { readonly attempted: boolean; matches(message: unknown): boolean },
): OmpPromptRun {
  const receipt = Promise.withResolvers<OmpPromptReceipt | null>();
  let entryObserved = false;
  let commandHandled = false;
  const admissionFailure = (error: unknown) => imageAdmission?.dispatched || skillAdmission?.dispatched || selectedTextAdmission?.attempted || commandHandled ? new OmpPromptAdmissionError(error) : error;
  const previousEntryListener = manager.onEntryAppended;
  const entryListener: NonNullable<typeof manager.onEntryAppended> = entry => {
    previousEntryListener?.(entry);
    const skillEntry = skillAdmission?.matchesEntry(entry);
    if (entryObserved || (skillAdmission ? !skillEntry : entry.type !== "message" || entry.message.role !== "user"
      || (imageAdmission && !imageAdmission.matches(entry.message))
      || (selectedTextAdmission && !selectedTextAdmission.matches(entry.message)))) return;
    entryObserved = true;
    // message_end precedes persistence. onEntryAppended follows native append;
    // flush additionally checks asynchronous writes and latched disk failures.
    void manager.flush().then(() => {
      receipt.resolve(skillEntry ? { kind: "skill-message", entryId: entry.id, name: skillAdmission!.name }
        : { kind: "user-message", entryId: entry.id, ...(imageAdmission ? { images: imageAdmission.receipt() } : {}) });
    }).catch(error => receipt.reject(admissionFailure(error)));
  };
  manager.onEntryAppended = entryListener;
  const completion = (async () => {
    try {
      const result = await dispatch();
      commandHandled = result.handledCommand !== undefined;
      await settlePersistence();
      // Native local commands can persist title/custom/settings metadata without
      // a message event. Check the manager's disk tail before acknowledging them.
      await manager.flush();
      if (!entryObserved) {
        if (imageAdmission?.dispatched || skillAdmission?.dispatched || selectedTextAdmission?.attempted) receipt.reject(new OmpPromptAdmissionError());
        else receipt.resolve(result.handledCommand ? { kind: "native-command", command: result.handledCommand,
          ...(result.commandEntryId ? { entryId: result.commandEntryId } : {}), ...(result.output ? { output: result.output } : {}) } : null);
      }
      return result.agentInvoked;
    } catch (error) {
      if (!entryObserved) receipt.reject(admissionFailure(error));
      throw error;
    } finally {
      if (manager.onEntryAppended === entryListener) manager.onEntryAppended = previousEntryListener;
    }
  })();
  // The host awaits admission before attaching its completion observer. Both
  // original promises still reject to their caller; avoid an unhandled process
  // rejection during that short interval.
  void completion.catch(() => {});
  void receipt.promise.catch(() => {});
  return { accepted: receipt.promise, completion };
}
