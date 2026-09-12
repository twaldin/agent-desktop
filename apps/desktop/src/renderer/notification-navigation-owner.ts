import type { DesktopBridge, NotificationNavigationRequest, NotificationNavigationTarget } from "@agent-desktop/shared";
import type { WindowViewState } from "../window-state";
import { NotificationNavigationCheckpoint } from "./notification-navigation";
import type { WindowSaveObserver } from "./window-view-state";

export type NotificationNavigate = (target: NotificationNavigationTarget) => void;

/** One renderer-document owner. New clicks cancel older work, and unmount cannot
 * acknowledge a target that this document did not durably save. */
export class NotificationNavigationOwner implements WindowSaveObserver {
  private readonly checkpoint = new NotificationNavigationCheckpoint();
  private unsubscribe?: () => void;
  private operation?: AbortController;
  private navigate?: NotificationNavigate;
  error?: string;

  constructor(private readonly bridge: Pick<DesktopBridge, "subscribeNotificationNavigation" | "acknowledgeNotificationNavigation">, private readonly changed: () => void = () => {}) {}

  setNavigate(navigate: NotificationNavigate): void { this.navigate = navigate; }

  start(): void {
    if (this.unsubscribe || !this.bridge.subscribeNotificationNavigation) return;
    this.unsubscribe = this.bridge.subscribeNotificationNavigation(request => { void this.open(request); });
  }

  private async open(request: NotificationNavigationRequest): Promise<void> {
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    this.error = undefined;
    this.changed();
    try {
      const navigate = this.navigate;
      if (!navigate) throw new Error("Notification navigation is not ready in this window.");
      const waiting = this.checkpoint.wait(request, operation.signal);
      navigate(request.target);
      await waiting;
      if (this.operation !== operation || operation.signal.aborted) return;
      this.bridge.acknowledgeNotificationNavigation?.(request.id);
    } catch (cause) {
      if (!operation.signal.aborted) this.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (this.operation === operation) this.operation = undefined;
      this.changed();
    }
  }

  committed(view: WindowViewState): void { this.checkpoint.committed(view); }
  saved(view: WindowViewState): void { this.checkpoint.saved(view); }
  failed(message: string): void { this.checkpoint.failed(message); }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.navigate = undefined;
    this.operation?.abort();
    this.operation = undefined;
    this.checkpoint.dispose();
  }
}
