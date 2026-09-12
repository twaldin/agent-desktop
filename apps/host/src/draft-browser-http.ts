import { BROWSER_CREATE_MAX_AGE_MS, BROWSER_METADATA_OWNER_HEADER, parseBrowserCreateRequest, parseBrowserControlRequest, parseNativeBrowserFrame, parseNativeBrowserTabMetadata, validBrowserFrameTarget,
  type BrowserCreateRequest, type BrowserControlRequest, type BrowserFrameTarget, type BrowserMetadataAvailability, type NativeBrowserFrame } from "@agent-desktop/shared";
import { parseBrowserCloseRequest, type BrowserCloseRequest } from "../../../packages/shared/src/browser-close";
import { BrowserCloseInputMismatch } from "./browser-close-records";
import { BrowserCloseRequests } from "./browser-close-requests";
import { readBrowserCreateBody } from "./browser-create-http";
import { readBrowserControlBody } from "./browser-control-http";
import { BrowserControlRequests } from "./browser-control-requests";
import { BrowserCreationInputMismatch, browserCreationRequestHash } from "./browser-creation-records";
import type { DraftBrowserAdmissionRequest } from "./browser-draft-admission";
import type { DraftBrowserWorkers } from "./browser-draft-workers";
import type { DraftBrowserCreationReceipt } from "./draft-browser-creation-records";
import type { HostStore } from "./store";

/** Invoked only after the host's existing local-token or authorized-tailnet gate. */
export class DraftBrowserHttp {
  private readonly pending = new Map<string, { hash: string; result: Promise<DraftBrowserCreationReceipt> }>();
  private readonly active = new Set<Promise<Response>>();
  private readonly reads = new Map<string, Promise<BrowserMetadataAvailability | NativeBrowserFrame>>();
  private readonly controls: BrowserControlRequests;
  private readonly closes: BrowserCloseRequests;
  private closing?: Promise<void>;
  constructor(private readonly store: HostStore, private readonly workers: DraftBrowserWorkers,
    private readonly epoch: string, private readonly now = Date.now) {
    this.controls = new BrowserControlRequests(now);
    this.closes = new BrowserCloseRequests(store.browserCloses, store.host.id, epoch, now);
  }

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/draft-browser-owners\/([^/]+)\/(acquire|status|retire|create|open|creation-status|metadata|frame|control|close|close-status)$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [BROWSER_METADATA_OWNER_HEADER]: this.store.host.id };
    const error = (code: string, message: string, status = 400) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.store.host.id) return error("OWNER_MISMATCH", "The draft browser belongs to another host", 409);
    if (request.method !== "POST") return error("INVALID_REQUEST", "Use POST for this request", 405);
    let owner: DraftBrowserAdmissionRequest, creation: BrowserCreateRequest | undefined, target: BrowserFrameTarget | undefined, control: BrowserControlRequest | undefined, close: BrowserCloseRequest | undefined;
    const action = match[2]!;
    try {
      const ownerId = decodeURIComponent(match[1]!);
      const body = await (action === "control" ? readBrowserControlBody(request) : readBrowserCreateBody(request)) as {
        draftId: string; draftRevision: number; creation?: BrowserCreateRequest; target?: BrowserFrameTarget; control?: BrowserControlRequest; close?: BrowserCloseRequest };
      const creates = action === "create" || action === "open" || action === "creation-status";
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["draftId", "draftRevision", ...(creates ? ["creation"] : []), ...(action === "frame" ? ["target"] : []), ...(action === "control" ? ["control"] : []), ...(["close", "close-status"].includes(action) ? ["close"] : [])].includes(key))
        || ![ownerId, body.draftId].every(id => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id))
        || !Number.isSafeInteger(body.draftRevision) || body.draftRevision < 1) throw new Error("Invalid owner request");
      owner = { hostId: this.store.host.id, ownerId, draftId: body.draftId, draftRevision: body.draftRevision };
      if (creates) {
        creation = parseBrowserCreateRequest(body.creation);
        if (action !== "creation-status" && (action === "open") !== (creation.initialUrl !== undefined)) throw new Error("Operation/URL mismatch");
      }
      if (action === "frame") {
        if (!validBrowserFrameTarget(body.target) || Object.keys(body.target).some(key => !["workerPid", "name", "targetId"].includes(key))) throw new Error("Invalid frame target");
        target = { workerPid: body.target.workerPid, name: body.target.name, targetId: body.target.targetId };
      }
      if (action === "control") control = parseBrowserControlRequest(body.control);
      if (action === "close" || action === "close-status") close = parseBrowserCloseRequest(body.close);
    } catch { return error("INVALID_REQUEST", "Invalid draft browser request"); }
    if (this.closing) return error("HOST_STOPPING", "Draft browser requests are stopping", 503);
    const operation = (async () => {
      try {
        if (close) {
          // Inspect validates the saved draft/revision binding without creating a worker.
          this.workers.inspect(owner);
          const identity = { kind: "draft" as const, ownerId: owner.ownerId, draftId: owner.draftId, draftRevision: owner.draftRevision };
          const value = action === "close-status" ? this.closes.observe(identity, close) : await this.closes.execute(identity, close, {
            isCurrent: () => !this.closing && this.workers.inspect(owner).state === "ready",
            getExistingHandle: () => this.workers.getExisting(owner),
          });
          return Response.json(value, { headers });
        }
        if (control) {
          // Validate original request binding even before returning an earlier action receipt.
          this.workers.inspect(owner);
          const result = await this.controls.execute(owner.ownerId, control, {
            isCurrent: () => !this.closing && this.workers.inspect(owner).state === "ready",
            getExistingHandle: () => this.workers.getExisting(owner),
          });
          return Response.json({ ...result, hostId: owner.hostId, ownerKind: "draft", ownerId: owner.ownerId }, { headers });
        }
        if (action === "metadata" || action === "frame") return await this.observation(owner, target, headers);
        if (creation) return Response.json(await this.creation(owner, creation, action === "creation-status"), { headers });
        if (action === "acquire") await this.workers.acquire(owner);
        if (action === "retire") await this.workers.retire(owner);
        const status = this.workers.inspect(owner);
        return Response.json({ protocolVersion: 1, hostId: owner.hostId, ownerId: owner.ownerId, ...status,
          ticket: { controlEpoch: this.epoch, observedAt: this.now() } }, { headers });
      } catch (cause) {
        if (cause instanceof BrowserCloseInputMismatch) return error("BROWSER_CLOSE_INPUT_MISMATCH", "This close request has different input", 409);
        if (cause instanceof BrowserCreationInputMismatch) return error("BROWSER_CREATE_INPUT_MISMATCH", "This request ID has different input", 409);
        return error("DRAFT_BROWSER_UNAVAILABLE", cause instanceof Error ? cause.message : "Draft browser request unavailable", 503);
      }
    })();
    this.active.add(operation);
    try { return await operation; } finally { this.active.delete(operation); }
  }

  private async observation(owner: DraftBrowserAdmissionRequest, target: BrowserFrameTarget | undefined, headers: Record<string, string>): Promise<Response> {
    const error = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status, headers });
    const base = { protocolVersion: 1, ownerKind: "draft", hostId: owner.hostId, ownerId: owner.ownerId };
    try {
      const status = this.workers.inspect(owner), handle = await this.workers.getExisting(owner);
      if (this.closing) return error("HOST_STOPPING", "Draft browser requests are stopping", 503);
      if (!handle) return target ? error("STALE_TARGET", "The draft browser worker is unavailable", 409)
        : Response.json({ ...base, availability: status.state === "absent" ? "not-started" : "unavailable", reason: "No live draft browser worker" }, { headers });
      if (target && target.workerPid !== handle.workerPid) return error("STALE_TARGET", "The draft browser worker changed", 409);
      const key = JSON.stringify([owner.ownerId, handle.workerPid, target ? [target.name, target.targetId] : null]);
      let read = this.reads.get(key);
      if (!read) {
        if (this.reads.size >= 8) return error("BROWSER_READ_BUSY", "This host is reading other browser views; try again shortly", 429);
        read = Promise.resolve().then(async () => target ? parseNativeBrowserFrame(await handle.getBrowserFrame(target), target)
          : metadata(await handle.getBrowserMetadata(), handle.workerPid));
        this.reads.set(key, read);
        void read.finally(() => { if (this.reads.get(key) === read) this.reads.delete(key); }).catch(() => {});
      }
      const value = await read, current = await this.workers.getExisting(owner);
      if (this.closing || current !== handle) return error("STALE_TARGET", "The draft browser owner changed during the read", 409);
      return Response.json({ ...base, workerPid: handle.workerPid, controlEpoch: this.controls.epoch, ...value }, { headers });
    } catch { return error("DRAFT_BROWSER_READ_FAILED", "The draft browser could not be read; refresh its status", 503); }
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const deferred = Promise.withResolvers<void>();
    this.closing = deferred.promise;
    void Promise.allSettled([this.closes.dispose(), this.workers.dispose(), ...this.active]).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) deferred.reject(new AggregateError(errors, "Draft browser HTTP cleanup failed"));
      else deferred.resolve();
    });
    return this.closing;
  }

  private async creation(owner: DraftBrowserAdmissionRequest, input: BrowserCreateRequest, observation: boolean) {
    // Match original binding without acquisition even when handling historical receipts.
    this.workers.inspect(owner);
    const base = { protocolVersion: 1 as const, ownerKind: "draft" as const, hostId: owner.hostId, ownerId: owner.ownerId, requestId: input.requestId };
    const failure = (outcome: "unknown" | "rejected", message: string, workerPid?: number): DraftBrowserCreationReceipt =>
      ({ ...base, outcome, message, ...(workerPid === undefined ? {} : { workerPid }) });
    const interrupted = () => failure("unknown", "No durable completion is confirmed. Inspect existing targets; do not replay creation.");
    const records = this.store.draftBrowserCreations, key = JSON.stringify([owner.ownerId, input.requestId]), hash = browserCreationRequestHash(input);
    if (observation) {
      const saved = records.observe(owner.ownerId, input, this.epoch);
      return saved.status === "pending" && !this.pending.has(key) ? { ...base, status: "settled" as const, receipt: interrupted() } : saved;
    }
    const prior = records.get(owner.ownerId, input);
    if (prior) {
      const local = this.pending.get(key);
      return prior.receipt ?? (local?.hash === hash ? await local.result : interrupted());
    }
    const now = this.now();
    if (input.controlEpoch !== this.epoch || input.observedAt > now + 5000 || now - input.observedAt > BROWSER_CREATE_MAX_AGE_MS) return failure("rejected", "Refresh the draft browser ticket before creating a tab");
    if (this.pending.size >= 8) return failure("rejected", "This host is creating other browser tabs; try again later");
    const claimed = records.claim(owner.ownerId, input);
    if (!claimed.fresh) return claimed.record.receipt ?? interrupted();
    const result = Promise.resolve().then(async (): Promise<DraftBrowserCreationReceipt> => {
      let handle;
      try { handle = await this.workers.getExisting(owner); }
      catch { return failure("rejected", "The admitted draft browser worker is unavailable"); }
      if (!handle || this.closing) return failure("rejected", "The admitted draft browser worker is unavailable");
      try {
        const value = await handle.createBrowserTab(`desktop-${input.requestId}`, input.initialUrl);
        if (this.closing || await this.workers.getExisting(owner) !== handle) return interrupted();
        return { ...base, outcome: "completed", workerPid: handle.workerPid, tab: value.tab, targetDisposition: value.targetDisposition };
      } catch (cause) {
        return cause instanceof Error && cause.name === "BrowserTabCreateRejected"
          ? failure("rejected", "The native browser rejected this request", handle.workerPid)
          : failure("unknown", "Native browser creation may have run. Inspect status without replaying it.", handle.workerPid);
      }
    }).then(receipt => {
      try { return records.finish(owner.ownerId, input, receipt).receipt!; }
      catch { return interrupted(); }
    }, () => interrupted()).finally(() => { this.pending.delete(key); });
    this.pending.set(key, { hash, result });
    return result;
  }
}

/** Project native metadata before crossing the host boundary, including PID ownership. */
function metadata(value: BrowserMetadataAvailability, workerPid: number): BrowserMetadataAvailability {
  if (!value || typeof value !== "object") throw new Error("Invalid browser metadata");
  if (value.availability === "not-started" || value.availability === "unavailable") {
    if (typeof value.reason !== "string" || !value.reason.length || value.reason.length > 4096) throw new Error("Invalid browser availability");
    return { availability: value.availability, reason: value.reason };
  }
  if (value.availability !== "running" || value.workerPid !== workerPid || !Array.isArray(value.tabs) || value.tabs.length > 1000) throw new Error("Invalid browser metadata owner");
  const tabs = value.tabs.map(parseNativeBrowserTabMetadata);
  if (new Set(tabs.map(tab => tab.name)).size !== tabs.length) throw new Error("Duplicate browser tab identity");
  return { availability: "running", workerPid, tabs };
}
