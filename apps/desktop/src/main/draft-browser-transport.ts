import { BROWSER_FRAME_MAX_BYTES, BROWSER_METADATA_OWNER_HEADER, parseBrowserCreateRequest, parseBrowserCreationTicket,
  parseBrowserControlRequest, parseBrowserHistoryRequest, parseBrowserHistoryResult, parseDraftBrowserOwnerReference, parseBrowserDocumentContext, parseDraftBrowserCreationReceipt, parseNativeBrowserFrame, parseNativeBrowserTabMetadata, validBrowserFrameTarget,
  type BrowserCreateRequest, type BrowserControlRequest, type BrowserFrameTarget, type BrowserHistoryRequest, type BrowserHistoryResult, type DraftBrowserCreationReceipt, type DraftBrowserCreationObservation,
  type DraftBrowserOwnerReference, type DraftBrowserOwnerSnapshot, type DraftBrowserMetadataSnapshot, type DraftBrowserFrameSnapshot, type DraftBrowserControlReceipt } from "@agent-desktop/shared";
import { readBrowserJSON } from "./browser-frame-transport";
import { HostRequestError, type HostEndpoint } from "./host-transport";

const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);
const pid = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid draft browser response; outcome is unconfirmed.");
  return v as Record<string, unknown>;
};

/** Main-process only. Capture the original endpoint/binding; submit once with no
 * session fallback, implicit acquisition, retry or reconstruction of old input. */
export class DraftBrowserTransport {
  private readonly endpoint: Readonly<HostEndpoint>;
  private readonly reference: Readonly<DraftBrowserOwnerReference>;
  constructor(endpoint: HostEndpoint, reference: DraftBrowserOwnerReference) {
    const origin = new URL(endpoint.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.href !== origin.origin + "/"
      || !id(endpoint.hostId)) throw new Error("Select the original draft browser owner and host.");
    this.endpoint = Object.freeze({ hostId: endpoint.hostId, origin: origin.origin, ...(endpoint.token ? { token: endpoint.token } : {}) });
    this.reference = Object.freeze(parseDraftBrowserOwnerReference(reference));
  }

  async owner(action: "acquire" | "status" | "retire"): Promise<DraftBrowserOwnerSnapshot> {
    if (!["acquire", "status", "retire"].includes(action)) throw new Error("Invalid draft browser owner operation.");
    const value = await this.post(action, {}, 65_536, action === "status" ? 20_000 : 60_000);
    const { state, workerPid, error } = value;
    if (!["absent", "starting", "ready", "unavailable", "retired"].includes(String(state))
      || workerPid !== undefined && !pid(workerPid) || error !== undefined && !text(error, 4096)) throw new Error("Invalid draft browser owner status.");
    if (state === "absent") {
      if (value.record !== undefined || workerPid !== undefined) throw new Error("Absent draft browser returned an owner.");
    } else {
      const record = object(value.record);
      if (record.version !== 1 || record.kind !== "draft" || record.hostId !== this.endpoint.hostId || record.id !== this.reference.ownerId
        || record.draftId !== this.reference.draftId || record.draftRevision !== this.reference.draftRevision || !pid(record.createdAt)
        || record.retiredAt !== undefined && (!pid(record.retiredAt) || record.retiredAt < record.createdAt)
        || (state === "retired") !== (record.retiredAt !== undefined) || state === "ready" && (workerPid === undefined || error !== undefined)) throw new Error("Draft browser status changed its original binding.");
    }
    // Filesystem details in the host's internal record are not client path capabilities.
    return { protocolVersion: 1, hostId: this.endpoint.hostId, ownerId: this.reference.ownerId, state: state as DraftBrowserOwnerSnapshot["state"],
      ...(workerPid === undefined ? {} : { workerPid: workerPid as number }), ...(error === undefined ? {} : { error: error as string }), ticket: parseBrowserCreationTicket(value.ticket) };
  }

  async create(request: BrowserCreateRequest): Promise<DraftBrowserCreationReceipt> {
    const input = parseBrowserCreateRequest(request);
    const value = await this.post(input.initialUrl === undefined ? "create" : "open", { creation: input }, 32_768, 60_000);
    return parseDraftBrowserCreationReceipt(value, { ...this.identity(), requestId: input.requestId });
  }

  async creationStatus(request: BrowserCreateRequest): Promise<DraftBrowserCreationObservation> {
    const input = parseBrowserCreateRequest(request), value = await this.post("creation-status", { creation: input }, 32_768);
    this.requireDraft(value);
    if (value.requestId !== input.requestId) throw new Error("Draft browser observation changed request identity.");
    const base = { ...this.identity(), requestId: input.requestId };
    if (value.status === "settled") return { ...base, status: "settled", receipt: parseDraftBrowserCreationReceipt(value.receipt, base) };
    if (value.status !== "pending" && value.status !== "unavailable" || value.receipt !== undefined) throw new Error("Invalid draft browser observation status.");
    return { ...base, status: value.status };
  }

  async metadata(): Promise<DraftBrowserMetadataSnapshot> {
    // Includes worst-case JSON escaping of all bounded fields in1000 native tabs.
    const value = await this.post("metadata", {}, 64 * 1024 * 1024); this.requireDraft(value);
    const epoch = value.controlEpoch === undefined ? {} : { controlEpoch: this.controlEpoch(value) };
    if (value.workerPid !== undefined && !pid(value.workerPid)) throw new Error("Invalid draft browser worker identity.");
    if (value.availability === "not-started" || value.availability === "unavailable") {
      if (!text(value.reason, 4096) || !value.reason) throw new Error("Invalid browser availability.");
      return { ...this.identity(), ...epoch, availability: value.availability, reason: value.reason };
    }
    if (value.availability !== "running" || !pid(value.workerPid) || !Array.isArray(value.tabs) || value.tabs.length > 1000) throw new Error("Invalid draft browser metadata.");
    const tabs = value.tabs.map(parseNativeBrowserTabMetadata);
    if (new Set(tabs.map(tab => tab.name)).size !== tabs.length) throw new Error("Duplicate draft browser tab identity.");
    return { ...this.identity(), availability: "running", workerPid: value.workerPid, tabs, controlEpoch: this.controlEpoch(value) };
  }

  async history(request: BrowserHistoryRequest): Promise<BrowserHistoryResult> {
    const input=parseBrowserHistoryRequest(request),value=await this.post("history",{history:input},2*1024*1024);
    return parseBrowserHistoryResult(value,this.endpoint.hostId,{kind:"draft",id:this.reference.ownerId},input);
  }

  async frame(target: BrowserFrameTarget): Promise<DraftBrowserFrameSnapshot> {
    if (!validBrowserFrameTarget(target)) throw new Error("Select an exact draft browser target.");
    const input = { workerPid: target.workerPid, name: target.name, targetId: target.targetId };
    const value = await this.post("frame", { target: input }, Math.ceil(BROWSER_FRAME_MAX_BYTES / 3) * 4 + 32_768); this.requireDraft(value);
    if (value.workerPid !== input.workerPid) throw new Error("Draft browser frame changed its worker.");
    return { ...this.identity(), workerPid: input.workerPid, controlEpoch: this.controlEpoch(value), ...parseNativeBrowserFrame(value, input) };
  }

  async control(request: BrowserControlRequest): Promise<DraftBrowserControlReceipt> {
    const input = parseBrowserControlRequest(request), value = await this.post("control", { control: input }, 32_768); this.requireDraft(value);
    if (value.requestId !== input.requestId || value.workerPid !== input.target.workerPid || value.name !== input.target.name || value.targetId !== input.target.targetId
      || !["completed", "rejected", "unknown"].includes(String(value.outcome)) || value.message !== undefined && !text(value.message, 4096)) throw new Error("Draft browser action is unconfirmed; inspect the page before acting again.");
    const base: DraftBrowserControlReceipt = { ...this.identity(), requestId: input.requestId, workerPid: input.target.workerPid, name: input.target.name, targetId: input.target.targetId,
      outcome: value.outcome as DraftBrowserControlReceipt["outcome"], ...(value.message ? { message: value.message as string } : {}) };
    if (value.outcome !== "completed") return base;
    if (!text(value.url, 8192) || !text(value.title, 1024)) throw new Error("Invalid draft browser action result; outcome is unconfirmed.");
    return { ...base, context: parseBrowserDocumentContext(value.context), url: value.url, title: value.title };
  }

  private identity() { return { protocolVersion: 1 as const, ownerKind: "draft" as const, hostId: this.endpoint.hostId, ownerId: this.reference.ownerId }; }
  private requireDraft(value: Record<string, unknown>) { if (value.ownerKind !== "draft") throw new Error("Browser response is not owned by this draft."); }
  private controlEpoch(value: Record<string, unknown>) { return parseBrowserCreationTicket({ controlEpoch: value.controlEpoch, observedAt: 1 }).controlEpoch; }
  private async post(action: string, extra: Record<string, unknown>, limit: number, timeout = 20_000): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.endpoint.origin}/v1/draft-browser-owners/${encodeURIComponent(this.reference.ownerId)}/${action}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeout),
      headers: { "Content-Type": "application/json", [BROWSER_METADATA_OWNER_HEADER]: this.endpoint.hostId, ...(this.endpoint.token ? { Authorization: `Bearer ${this.endpoint.token}` } : {}) },
      body: JSON.stringify({ draftId: this.reference.draftId, draftRevision: this.reference.draftRevision, ...extra }),
    });
    if (response.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.endpoint.hostId) { await response.body?.cancel(); throw new Error("Draft browser response belongs to another host; outcome is unconfirmed."); }
    const value = object(await readBrowserJSON(response, response.ok ? limit : 16_384));
    if (!response.ok) {
      const error = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
      throw new HostRequestError(`Draft browser request failed (${response.status}); outcome is unconfirmed. Inspect status without replaying the action.`, response.status,
        typeof error.code === "string" && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : undefined);
    }
    if (value.protocolVersion !== 1 || value.hostId !== this.endpoint.hostId || value.ownerId !== this.reference.ownerId || value.sessionId !== undefined) throw new Error("Draft browser response changed its owner/protocol; outcome is unconfirmed.");
    return value;
  }
}
