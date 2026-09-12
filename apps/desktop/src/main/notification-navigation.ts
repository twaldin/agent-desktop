import { parseNotificationNavigationRequest, type NotificationNavigationRequest, type NotificationNavigationTarget } from "@agent-desktop/shared";

export interface NotificationNavigationRenderer {
  id: number;
  send(request: NotificationNavigationRequest): void;
}

/** One main-process owner for notification click routing. A renderer may only
 * acknowledge the request assigned to its current document. Renderer loss
 * retains the target for another ready document; a newer click supersedes it. */
export class NotificationNavigation {
  private readonly renderers = new Map<number, NotificationNavigationRenderer>();
  private pending?: NotificationNavigationRequest;
  private assigned?: number;
  private preferred?: number;

  open(target: NotificationNavigationTarget, preferred?: number): NotificationNavigationRequest {
    const request = parseNotificationNavigationRequest({ id: crypto.randomUUID(), target });
    this.pending = request;
    this.assigned = undefined;
    this.preferred = preferred;
    this.dispatch();
    return request;
  }

  ready(renderer: NotificationNavigationRenderer): void {
    if (!Number.isSafeInteger(renderer.id) || renderer.id < 0) throw new Error("Invalid notification renderer.");
    this.renderers.set(renderer.id, renderer);
    this.dispatch();
  }

  unready(id: number): void {
    this.renderers.delete(id);
    if (this.assigned === id) {
      this.assigned = undefined;
      this.dispatch();
    }
  }

  acknowledge(rendererId: number, requestId: string): boolean {
    if (rendererId !== this.assigned || requestId !== this.pending?.id) return false;
    this.pending = undefined;
    this.assigned = undefined;
    this.preferred = undefined;
    return true;
  }

  current(): NotificationNavigationRequest | undefined {
    return this.pending ? structuredClone(this.pending) : undefined;
  }

  private dispatch(): void {
    if (!this.pending || this.assigned !== undefined) return;
    const renderer = this.preferred === undefined ? undefined : this.renderers.get(this.preferred);
    const recipient = renderer ?? this.renderers.values().next().value as NotificationNavigationRenderer | undefined;
    if (!recipient) return;
    this.assigned = recipient.id;
    try { recipient.send(structuredClone(this.pending)); }
    catch {
      this.renderers.delete(recipient.id);
      this.assigned = undefined;
      this.dispatch();
    }
  }
}
