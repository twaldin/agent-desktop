import type { DockPresentations } from "./dock-presentations";
import { isCurrentDockPresentation } from "./dock-presentations";
import type { MainChatTarget } from "./main-task-targets";
import { sameMainTask } from "./main-task-targets";
import { captureBrowserReplacement, replaceBrowserWorkspaceDestination, type BrowserReplacementOrigin, type BrowserReplacementDestination } from "./browser-workspace-replacement";
import type { TerminalPreparation } from "./use-workbench-dock";
import type { DockTab } from "./dock-state";

export interface BrowserWorkspaceActionContext {
  presentations: DockPresentations;
  owner?: MainChatTarget;
  enabled: boolean;
  connected: boolean;
}
export type BrowserWorkspaceActionState =
  | { status: "idle" | "preparing" }
  /** Prepared is not published: the dock owner must still admit and commit replacement. */
  | { status: "ready"; tab: DockTab }
  | { status: "error"; message: string }
  | { status: "unknown"; message: string }
  | { status: "cancelled"; creationMayHaveRun: boolean; tab?: DockTab };

/** One deliberate action attempt for one exact launcher. The committed owner
 * calls observe on route/availability/presentation changes, including temporary
 * loss. Read-time validation alone cannot detect an away-and-back transition. */
export class BrowserWorkspaceActionController {
  private readonly cancellation = new AbortController();
  private started = false;
  private live = true;
  private invalidated = false;
  state: BrowserWorkspaceActionState = { status: "idle" };
  constructor(readonly origin: BrowserReplacementOrigin,
    private readonly current: () => BrowserWorkspaceActionContext,
    private readonly prepare: (signal: AbortSignal) => Promise<TerminalPreparation>,
    private readonly changed: () => void) {}

  private eligible(): boolean {
    const context = this.current();
    if (!context.enabled || !context.connected || !context.owner || !sameMainTask(context.owner, this.origin.owner)
      || !isCurrentDockPresentation(context.presentations, this.origin.presentation)) return false;
    const source = captureBrowserReplacement(context.presentations, this.origin.presentation.tabId, context.owner);
    return source?.state === this.origin.state && source.title === this.origin.title;
  }
  private set(state: BrowserWorkspaceActionState) {
    this.state = state;
    if (this.live) this.changed();
  }
  /** Must be driven by committed transitions, not abandoned render values. */
  observe() { if (!this.invalidated && !this.eligible()) this.cancel(); }
  cancel() {
    if (this.invalidated) return;
    this.invalidated = true;
    this.cancellation.abort();
    // A sent preparation settles before we know whether a native create ran.
    if (this.state.status !== "preparing" && this.state.status !== "unknown") {
      const tab = this.state.status === "ready" ? this.state.tab : undefined;
      this.set({ status: "cancelled", creationMayHaveRun: Boolean(tab), ...(tab ? { tab } : {}) });
    }
  }
  dispose() { this.live = false; this.cancel(); }

  async start(): Promise<void> {
    if (this.started || !this.live || this.invalidated) return;
    this.observe();
    if (this.invalidated) return;
    this.started = true;
    this.set({ status: "preparing" });
    // changed() may synchronously close or cancel the original presentation.
    this.observe();
    if (this.invalidated || !this.live) {
      this.set({ status: "cancelled", creationMayHaveRun: false });
      return;
    }
    let result: TerminalPreparation;
    try { result = await this.prepare(this.cancellation.signal); }
    catch (cause) {
      // An unclassified throw supplies no proof that creation was not submitted.
      result = { status: "error", outcome: "unknown", message: cause instanceof Error ? cause.message : String(cause) };
    }
    this.observe();
    if (this.invalidated || !this.live) {
      const tab = result.status === "ready" ? result.tab : result.status === "cancelled" ? result.tab : undefined;
      const creationMayHaveRun = result.status === "ready" || result.status === "error" && result.outcome === "unknown"
        || result.status === "cancelled" && result.creationMayHaveRun;
      this.set({ status: "cancelled", creationMayHaveRun, ...(tab ? { tab } : {}) });
      return;
    }
    if (result.status === "ready") {
      const context = this.current();
      // Validate the candidate through the same admission function used by the
      // dock, without publishing this projected value or performing focus.
      if (!replaceBrowserWorkspaceDestination(context.presentations, this.origin, { kind: "opened", tab: result.tab }, context.owner, "candidate-validation")) {
        this.set({ status: "unknown", message: "The action returned an unavailable destination. Its result was not attached." });
      } else this.set({ status: "ready", tab: result.tab });
    } else if (result.status === "error") {
      this.set({ status: result.outcome === "unknown" ? "unknown" : "error", message: result.message });
    } else if (result.status === "busy") {
      this.set({ status: "error", message: "Another action is opening this workspace. Wait for it to finish before selecting again." });
    } else {
      this.invalidated = true;
      this.cancellation.abort();
      this.set(result);
    }
  }

  /** An intent for the latest dock admission, never evidence of a UI commit.
   * Calling this repeatedly does not repeat acquisition. The dock revalidates
   * source/destination again inside its functional update. */
  replacement(): { origin: BrowserReplacementOrigin; destination: BrowserReplacementDestination } | undefined {
    this.observe();
    if (!this.live || this.invalidated || this.state.status !== "ready") return;
    return { origin: this.origin, destination: { kind: "opened", tab: this.state.tab } };
  }
}
