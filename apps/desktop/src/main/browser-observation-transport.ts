import { BROWSER_METADATA_OWNER_HEADER, type BrowserFrameTarget } from "@agent-desktop/shared";
import { parseBrowserObservationOwner, parseBrowserObservationTarget, parseBrowserTargetObservation,
  type BrowserObservationOwner, type BrowserTargetObservation } from "../../../../packages/shared/src/browser-observation";
import { readBrowserJSON } from "./browser-frame-transport";
import { HostRequestError, type HostEndpoint } from "./host-transport";

/** Read the captured original endpoint once. Errors never manufacture absence. */
export class BrowserObservationTransport {
  private readonly endpoint: Readonly<HostEndpoint>;
  private readonly owner: BrowserObservationOwner;
  constructor(endpoint: HostEndpoint, owner: BrowserObservationOwner) {
    const origin = new URL(endpoint.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.href !== origin.origin + "/"
      || typeof endpoint.hostId !== "string" || !endpoint.hostId || endpoint.hostId.length > 200 || /[\u0000-\u001f\u007f]/.test(endpoint.hostId)) throw new Error("Choose the original browser owning host.");
    this.endpoint = Object.freeze({ hostId: endpoint.hostId, origin: origin.origin, ...(endpoint.token ? { token: endpoint.token } : {}) });
    this.owner = Object.freeze(parseBrowserObservationOwner(owner));
  }
  async inspect(target: BrowserFrameTarget): Promise<BrowserTargetObservation> {
    const input = parseBrowserObservationTarget(target), owner = this.owner;
    const path = owner.kind === "session" ? `/v1/sessions/${encodeURIComponent(owner.sessionId)}/browser-target-observation?` + new URLSearchParams({ workerPid: String(input.workerPid), name: input.name, targetId: input.targetId })
      : `/v1/draft-browser-owners/${encodeURIComponent(owner.ownerId)}/target-observation`;
    const response = await fetch(this.endpoint.origin + path, {
      method: owner.kind === "session" ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      ...(owner.kind === "draft" ? { body: JSON.stringify({ draftId: owner.draftId, draftRevision: owner.draftRevision, target: input }) } : {}),
      headers: { "Content-Type": "application/json", [BROWSER_METADATA_OWNER_HEADER]: this.endpoint.hostId,
        ...(this.endpoint.token ? { Authorization: `Bearer ${this.endpoint.token}` } : {}) },
    });
    if (response.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.endpoint.hostId) {
      await response.body?.cancel(); throw new Error("Browser observation response belongs to another host.");
    }
    const value = await readBrowserJSON(response, response.ok ? 32_768 : 16_384);
    if (!response.ok) {
      const detail = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
      const code = typeof detail.code === "string" && /^[A-Z0-9_]{1,100}$/.test(detail.code) ? detail.code : undefined;
      throw new HostRequestError(`The original browser target observation is unavailable (${response.status}).`, response.status, code);
    }
    return parseBrowserTargetObservation(value, this.endpoint.hostId, owner, input);
  }
}
