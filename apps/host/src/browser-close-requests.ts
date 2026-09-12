import { BROWSER_CREATE_MAX_AGE_MS } from "@agent-desktop/shared";
import { browserCloseIdentity, parseBrowserCloseOwner, parseBrowserCloseRequest, type BrowserCloseOwner,
  type BrowserCloseRequest, type BrowserCloseReceipt, type BrowserCloseObservation } from "../../../packages/shared/src/browser-close";
import type { BrowserFrameTarget } from "@agent-desktop/shared";
import { BrowserCloseRecords } from "./browser-close-records";

export interface BrowserCloseHandle {
  workerPid: number;
  workerFailure?: { message: string };
  closeBrowserTab(target: BrowserFrameTarget): Promise<BrowserFrameTarget & { ownerId: string; released: true }>;
}
interface CloseBinding {
  isCurrent(): boolean;
  getExistingHandle(): Promise<BrowserCloseHandle | undefined>;
}

/** Shared session/draft close admission. A missing worker is never acquired and an old request is never replayed. */
export class BrowserCloseRequests {
  private readonly pending = new Map<string, Promise<BrowserCloseReceipt>>();
  private closing?: Promise<void>;
  constructor(private readonly records: BrowserCloseRecords, private readonly hostId: string,
    private readonly epoch: string, private readonly now = Date.now) {}
  private key(owner: BrowserCloseOwner, request: BrowserCloseRequest) { return JSON.stringify([owner, request.requestId]); }
  observe(ownerValue: BrowserCloseOwner, requestValue: BrowserCloseRequest): BrowserCloseObservation {
    const owner = parseBrowserCloseOwner(ownerValue), request = parseBrowserCloseRequest(requestValue);
    const base = browserCloseIdentity(this.hostId, owner, request), prior = this.records.get(owner, request);
    if (!prior) return { ...base, status: "unavailable" };
    if (prior.receipt) return { ...base, status: "settled", receipt: prior.receipt };
    if (request.controlEpoch === this.epoch && this.pending.has(this.key(owner, request))) return { ...base, status: "pending" };
    return { ...base, status: "settled", receipt: this.records.unknown(owner, request) };
  }
  async execute(ownerValue: BrowserCloseOwner, requestValue: BrowserCloseRequest, binding: CloseBinding): Promise<BrowserCloseReceipt> {
    const owner = parseBrowserCloseOwner(ownerValue), request = parseBrowserCloseRequest(requestValue);
    const base = browserCloseIdentity(this.hostId, owner, request), key = this.key(owner, request);
    const rejected = (message: string): BrowserCloseReceipt => ({ ...base, outcome: "rejected", message });
    // Durable history precedes worker lookup, epoch expiry and any new admission.
    const prior = this.records.get(owner, request);
    if (prior) return prior.receipt ?? await (this.pending.get(key) ?? this.records.unknown(owner, request));
    if (this.closing) return rejected("The browser host is stopping.");
    const now = this.now();
    if (request.controlEpoch !== this.epoch || request.observedAt > now + 5000 || now - request.observedAt > BROWSER_CREATE_MAX_AGE_MS) return rejected("Refresh the browser owner before requesting close.");
    if (this.pending.size >= 8) return rejected("This host is closing other browser targets. Try again later.");
    // The transaction and promise registration precede all user callbacks and asynchronous work.
    const claimed = this.records.claim(owner, request);
    if (!claimed.fresh) return claimed.record.receipt ?? this.records.unknown(owner, request);
    const result = Promise.resolve().then(async (): Promise<BrowserCloseReceipt> => {
      let handle: BrowserCloseHandle | undefined;
      try {
        if (this.closing || !binding.isCurrent()) return rejected("The browser owner is no longer available.");
        handle = await binding.getExistingHandle();
        if (this.closing || !binding.isCurrent() || !handle || handle.workerFailure || handle.workerPid !== request.target.workerPid) return rejected("The original browser worker is unavailable.");
      } catch { return rejected("The original browser owner could not be resolved."); }
      try {
        const value = await handle.closeBrowserTab({ ...request.target });
        const current = binding.isCurrent() && !handle.workerFailure ? await binding.getExistingHandle() : undefined;
        if (!binding.isCurrent() || current !== handle || handle.workerFailure || value.ownerId !== (owner.kind === "session" ? owner.sessionId : owner.ownerId)
          || value.workerPid !== request.target.workerPid || value.name !== request.target.name || value.targetId !== request.target.targetId || value.released !== true) return this.records.unknown(owner, request);
        return { ...base, outcome: "completed", released: true };
      } catch (error) {
        return error instanceof Error && error.name === "BrowserActionRejected"
          ? rejected("The native browser rejected close before dispatch.") : this.records.unknown(owner, request);
      }
    }).then(receipt => this.records.finish(owner, request, receipt).receipt!);
    this.pending.set(key, result);
    void result.then(() => this.pending.delete(key), () => this.pending.delete(key));
    return result;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>(); this.closing = completion.promise;
    void Promise.allSettled([...this.pending.values()]).then(outcomes => {
      const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
      if (errors.length) completion.reject(new AggregateError(errors, "Browser close history could not finish."));
      else completion.resolve();
    });
    return this.closing;
  }
}
