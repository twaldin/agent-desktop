import type { DesktopBridge, OmpInteraction, OmpInteractionResponse } from "../../../../packages/shared/src/protocol";
export type InteractionBridge = Pick<DesktopBridge, "getInteractions" | "respondInteraction" | "subscribe">;

/** Pending native requests only; answers and request payloads never enter persistent caches. */
export class InteractionsState {
  requests: OmpInteraction[] = [];
  loading = false;
  loadError?: string;
  responseError?: string;
  responding = new Set<string>();
  private pending?: Promise<void>;
  private again = false;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  constructor(private bridge: InteractionBridge, readonly hostId: string, readonly sessionId: string, private localHostId?: string) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  start() {
    this.unsubscribe ??= this.bridge.subscribe(event => {
      if (event.type === "interactions" && event.sessionId === this.sessionId && (event.hostId ?? this.localHostId) === this.hostId) void this.refresh();
    });
  }
  stop() { this.unsubscribe?.(); this.unsubscribe = undefined; }
  dismissResponseError() { this.responseError = undefined; this.changed(); }
  refresh(): Promise<void> {
    if (this.pending) { this.again = true; return this.pending; }
    this.pending = this.load().finally(() => { this.pending = undefined; if (this.again) { this.again = false; void this.refresh(); } });
    return this.pending;
  }
  private async load() {
    this.loading = true; this.changed();
    try {
      if (!this.bridge.getInteractions) throw new Error("Pending interactions require the current desktop bridge. Restart the app after updating.");
      const requests = await this.bridge.getInteractions(this.sessionId, this.hostId);
      if (requests.some(request => request.sessionId !== this.sessionId)) throw new Error("The host returned a pending request for another session.");
      this.requests = requests; this.loadError = undefined;
    } catch (cause) { this.loadError = message(cause); }
    finally { this.loading = false; this.changed(); }
  }
  async respond(id: string, response: OmpInteractionResponse): Promise<void> {
    if (this.responding.has(id)) return;
    const request = this.requests.find(request => request.id === id);
    if (!request) { this.responseError = "This request is no longer in the pending list. Refresh its status."; this.changed(); await this.refresh(); return; }
    const invalid = validateResponse(request, response);
    if (invalid) { this.responseError = invalid; this.changed(); return; }
    this.responding.add(id); this.responseError = undefined; this.changed();
    try {
      if (!this.bridge.respondInteraction) throw new Error("Interaction responses require the current desktop bridge.");
      await this.bridge.respondInteraction(this.sessionId, id, response, this.hostId);
    } catch (cause) { this.responseError = message(cause); }
    finally { this.responding.delete(id); this.changed(); await this.refresh(); }
  }
}
export function validateResponse(request: OmpInteraction, response: OmpInteractionResponse): string | undefined {
  if ("cancel" in response) return response.cancel === true ? undefined : "Invalid cancellation.";
  if ("action" in response) return request.actions.includes(response.action) ? undefined : "The host did not advertise this action.";
  if (request.method === "confirm") return typeof response.value === "boolean" ? undefined : "A confirmation requires an explicit yes or no.";
  if (typeof response.value !== "string") return "This request requires text.";
  if (request.method === "select" && !request.options?.some(option => option.label === response.value)) return "Choose one of the host’s supplied options.";
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
