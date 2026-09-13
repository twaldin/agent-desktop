import { OmpPromptAdmissionError, type OmpPromptRun } from "./prompt";

/** Native prompt can execute an optional /custom command without appending a
 * user entry. Once entered, no user receipt means unknown effects, not safe
 * replay permission. The caller marks entry inside its atomic recovery guard. */
export function wrapForceToolRecoveryOutcome(
  run: OmpPromptRun,
  hasEnteredNativePrompt: () => boolean,
): OmpPromptRun {
  const accepted = run.accepted.then(receipt => {
    if (receipt?.kind === "user-message" || !hasEnteredNativePrompt()) return receipt;
    throw new OmpPromptAdmissionError(new Error("The recovered native prompt returned without a user-message receipt; command effects may already have occurred."));
  }, error => {
    if (!hasEnteredNativePrompt()) throw error;
    throw new OmpPromptAdmissionError(error);
  });
  // The host awaits admission before observing completion. Attach handlers now
  // without changing either returned promise or coupling their outcomes.
  void accepted.catch(() => {});
  void run.completion.catch(() => {});
  return { accepted, completion: run.completion, get forceToolReceipt() { return run.forceToolReceipt; } };
}
