import { BROWSER_METADATA_OWNER_HEADER } from "@agent-desktop/shared";
import { browserCloseIdentity, parseBrowserCloseOwner, parseBrowserCloseRequest, parseBrowserCloseReceipt, parseBrowserCloseObservation,
  type BrowserCloseOwner, type BrowserCloseRequest, type BrowserCloseReceipt, type BrowserCloseObservation } from "../../../../packages/shared/src/browser-close";
import { readBrowserJSON } from "./browser-frame-transport";
import { HostRequestError, type HostEndpoint } from "./host-transport";

/** One original endpoint/owner; no acquisition, retry, session fallback or renderer credentials. */
export class BrowserCloseTransport {
  private readonly endpoint: Readonly<HostEndpoint>;
  private readonly owner: BrowserCloseOwner;
  constructor(endpoint: HostEndpoint, owner: BrowserCloseOwner) {
    const origin = new URL(endpoint.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.href !== origin.origin + "/"
      || typeof endpoint.hostId !== "string" || !endpoint.hostId || endpoint.hostId.length > 200 || /[\u0000-\u001f\u007f]/.test(endpoint.hostId)) throw new Error("Choose the original browser owning host.");
    this.endpoint = Object.freeze({ hostId: endpoint.hostId, origin: origin.origin, ...(endpoint.token ? { token: endpoint.token } : {}) });
    this.owner = Object.freeze(parseBrowserCloseOwner(owner));
  }
  async close(request: BrowserCloseRequest): Promise<BrowserCloseReceipt> {
    const input = parseBrowserCloseRequest(request);
    return parseBrowserCloseReceipt(await this.post("close", input), this.endpoint.hostId, this.owner, input);
  }
  async status(request: BrowserCloseRequest): Promise<BrowserCloseObservation> {
    const input = parseBrowserCloseRequest(request);
    return parseBrowserCloseObservation(await this.post("close-status", input), this.endpoint.hostId, this.owner, input);
  }
  private async post(action: "close" | "close-status", input: BrowserCloseRequest): Promise<unknown> {
    const owner = this.owner;
    const path = owner.kind === "session" ? `/v1/sessions/${encodeURIComponent(owner.sessionId)}/browser-${action}`
      : `/v1/draft-browser-owners/${encodeURIComponent(owner.ownerId)}/${action}`;
    const body = owner.kind === "session" ? input : { draftId: owner.draftId, draftRevision: owner.draftRevision, close: input };
    const response = await fetch(this.endpoint.origin + path, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(action === "close" ? 60_000 : 20_000), body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", [BROWSER_METADATA_OWNER_HEADER]: this.endpoint.hostId,
        ...(this.endpoint.token ? { Authorization: `Bearer ${this.endpoint.token}` } : {}) },
    });
    if (response.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.endpoint.hostId) {
      await response.body?.cancel(); throw new Error("Browser close response belongs to another host; outcome is unconfirmed.");
    }
    const value = await readBrowserJSON(response, response.ok ? 32_768 : 16_384);
    if (!response.ok) {
      const detail = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
      const code = typeof detail.code === "string" && /^[A-Z0-9_]{1,100}$/.test(detail.code) ? detail.code : undefined;
      const message = typeof detail.message === "string" && detail.message.trim() && detail.message.length <= 4096 ? detail.message : undefined;
      // Only the host's explicit pre-admission envelope can be a definite rejection.
      if (action === "close" && message && ((code === "INVALID_REQUEST" && (response.status === 400 || response.status === 405))
        || (code === "OWNER_MISMATCH" && response.status === 409))) return { ...browserCloseIdentity(this.endpoint.hostId, owner, input), outcome: "rejected", message };
      throw new HostRequestError(`Browser close ${action === "close" ? "outcome is unconfirmed" : "history is unavailable"} (${response.status}); inspect the original request without replaying close.`, response.status, code);
    }
    return value;
  }
}
