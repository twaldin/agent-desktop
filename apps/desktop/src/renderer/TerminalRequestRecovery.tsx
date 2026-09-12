import type { TerminalWindowIntent } from "../terminal-window-intent";
import type { TerminalPreparation } from "./use-workbench-dock";

/** The callback performs an explicit observation of the saved request. This
 * surface never offers Retry or asks the terminal catalogue to infer a result. */
export function TerminalRequestRecovery({ intent, state, running, checking, enabled, onCheck, detached = false }: {
  intent: TerminalWindowIntent; state?: TerminalPreparation; running: boolean; checking: boolean; enabled: boolean; onCheck(button: HTMLButtonElement): void;
  detached?: boolean;
}) {
  const message = state?.status === "error" ? state.message : state?.status === "cancelled"
    ? "Opening was interrupted. The original terminal request is retained."
    : "The original terminal request is retained until its result is attached and saved.";
  return <div className="browser-status" role="status" data-terminal-request-id={intent.request.requestId}>
    <span>{running ? checking ? "Checking terminal…" : "Opening terminal…" : message}</span>{" "}
    <button type="button" disabled={!enabled || running} onClick={event => { if (enabled && !running) onCheck(event.currentTarget); }}>{detached ? "Check result in Terminal" : "Check result"}</button>
  </div>;
}
