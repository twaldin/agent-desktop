import { parseNotificationNavigationRequest, type NotificationNavigationRequest, type NotificationNavigationTarget } from "@agent-desktop/shared";
import type { WindowViewState } from "../window-state";
import type { WindowSaveObserver } from "./window-view-state";

type Pending = { request: NotificationNavigationRequest; appeared: boolean; resolve(): void; reject(error: Error): void; cleanup(): void };
const routeMatches = (view: WindowViewState | undefined, target: NotificationNavigationTarget) =>
  view?.route.hostId === target.hostId && view.route.sessionId === target.sessionId
  && !view.settingsOpen && !view.pluginDirectoryOpen && !view.pullRequestsOpen && !view.automationsOpen;

/** Observes the real App commit and synchronous WindowStateStore acknowledgement.
 * It never supplies another host/session and never considers a transient route
 * change enough to clear a main-process notification click. */
export class NotificationNavigationCheckpoint implements WindowSaveObserver {
  private committedView?: WindowViewState;
  private savedView?: WindowViewState;
  private pending?: Pending;
  private live = true;

  committed(view: WindowViewState): void {
    if (!this.live) return;
    this.committedView = structuredClone(view);
    this.savedView = undefined;
    const pending = this.pending;
    if (!pending) return;
    if (routeMatches(view, pending.request.target)) pending.appeared = true;
    else if (pending.appeared) this.finish(new Error("The notification conversation changed before it was saved."));
    this.resolveIfSaved();
  }

  saved(view: WindowViewState): void {
    if (!this.live) return;
    this.savedView = structuredClone(view);
    const pending = this.pending;
    if (pending?.appeared && !routeMatches(view, pending.request.target)) {
      this.finish(new Error("The saved window did not retain the notification conversation."));
      return;
    }
    this.resolveIfSaved();
  }

  failed(message: string): void {
    this.savedView = undefined;
    this.finish(new Error(message));
  }

  wait(request: NotificationNavigationRequest, signal: AbortSignal): Promise<void> {
    const parsed = parseNotificationNavigationRequest(request);
    if (!this.live || this.pending) return Promise.reject(new Error("Notification navigation is unavailable or already active."));
    return new Promise((resolve, reject) => {
      const abort = () => this.finish(new Error("Notification navigation was cancelled."));
      this.pending = { request: parsed, appeared: routeMatches(this.committedView, parsed.target), resolve, reject,
        cleanup: () => signal.removeEventListener("abort", abort) };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else this.resolveIfSaved();
    });
  }

  dispose(): void {
    this.live = false;
    this.committedView = undefined;
    this.savedView = undefined;
    this.finish(new Error("The window closed before notification navigation was saved."));
  }

  private resolveIfSaved(): void {
    const pending = this.pending;
    if (pending?.appeared && routeMatches(this.committedView, pending.request.target) && routeMatches(this.savedView, pending.request.target)) this.finish();
  }

  private finish(error?: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.cleanup();
    if (error) pending.reject(error); else pending.resolve();
  }
}
