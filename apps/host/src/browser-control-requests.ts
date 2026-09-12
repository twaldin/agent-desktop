import { createHash } from "node:crypto";
import { BROWSER_CONTROL_MAX_AGE_MS, parseBrowserDocumentContext, type BrowserControlRequest, type BrowserControlReceipt } from "@agent-desktop/shared";

export interface BrowserControlHandle {
  workerPid: number; workerFailure?: { message: string };
  controlBrowser(request: BrowserControlRequest): Promise<{ name: string; targetId: string; context: unknown; url: string; title: string }>;
}
export type BrowserControlResult = Omit<BrowserControlReceipt, "hostId" | "sessionId">;
interface ControlOwner {
  isCurrent(): boolean;
  getExistingHandle(): Promise<BrowserControlHandle | undefined>;
}

/** Parsed requests only. Epoch and ephemeral receipt table share one lifetime;
 * HTTP boundaries add their actual session or draft owner envelope. */
export class BrowserControlRequests {
  readonly epoch = crypto.randomUUID();
  private receipts = new Map<string, { hash: string; createdAt: number; settled: boolean; result: Promise<BrowserControlResult> }>();
  constructor(private readonly now = Date.now) {}
  async execute(ownerId: string, input: BrowserControlRequest, owner: ControlOwner,
    afterCompletedNavigation?: (ownerId:string,input:BrowserControlRequest)=>Promise<void>): Promise<BrowserControlResult> {
    const receipt = (outcome: BrowserControlResult['outcome'], message?: string): BrowserControlResult => ({ protocolVersion: 1, requestId: input.requestId,
      workerPid: input.target.workerPid, name: input.target.name, targetId: input.target.targetId, outcome, ...(message ? { message } : {}) });
    if (input.controlEpoch !== this.epoch) return receipt('rejected', 'The browser control owner restarted. Refresh before sending another action.');
    const now = this.now();
    for (const [key, value] of this.receipts) if (value.settled && now - value.createdAt > BROWSER_CONTROL_MAX_AGE_MS * 2) this.receipts.delete(key);
    const key = JSON.stringify([ownerId, input.requestId]), hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = this.receipts.get(key);
    if (prior) return prior.hash === hash ? await prior.result : receipt('rejected', 'This browser action identity was already used for different input.');
    if (input.capturedAt > now + 5000 || now - input.capturedAt > BROWSER_CONTROL_MAX_AGE_MS) return receipt('rejected', 'The browser preview is too old. Refresh before interacting.');
    if (this.receipts.size >= 4096) return receipt('rejected', 'This host is handling too many browser actions. Wait before trying a new action.');
    // Reserve the identity before the first asynchronous lookup; concurrent retry
    // requests must observe the same promise even while resolving the worker.
    const result = Promise.resolve().then(async (): Promise<BrowserControlResult> => {
      if (!owner.isCurrent()) return receipt('rejected', 'The browser owner is no longer available.');
      let handle: BrowserControlHandle | undefined;
      try { handle = await owner.getExistingHandle(); } catch { return receipt('rejected', 'The browser worker is unavailable.'); }
      if (!owner.isCurrent() || !handle || handle.workerFailure || handle.workerPid !== input.target.workerPid) return receipt('rejected', 'The browser worker changed. Refresh before interacting.');
      try {
        const value = await handle.controlBrowser(input);
        const current = owner.isCurrent() && !handle.workerFailure ? await owner.getExistingHandle() : undefined;
        if (!owner.isCurrent() || handle.workerFailure || current !== handle) return receipt('unknown', 'The browser worker changed during the action. Inspect the page before acting again.');
        if (value.name !== input.target.name || value.targetId !== input.target.targetId) throw new Error('Browser result identity changed.');
        // Returned text remains untrusted page data and is bounded before IPC.
        if (typeof value.url !== 'string' || value.url.length > 8192 || typeof value.title !== 'string' || value.title.length > 1024) throw new Error('Invalid browser action result.');
        if (input.action.type === "navigate") await afterCompletedNavigation?.(ownerId,input).catch(()=>{});
        return { ...receipt('completed'), context: parseBrowserDocumentContext(value.context), url: value.url, title: value.title };
      } catch (error) {
        return error instanceof Error && error.name === 'BrowserActionRejected'
          ? receipt('rejected', 'The page changed or its native browser is busy. Refresh and try again.')
          : receipt('unknown', 'The action may have reached the page. Refresh and inspect it before acting again.');
      }
    });
    const record = { hash, createdAt: now, settled: false, result }; this.receipts.set(key, record);
    void result.finally(() => { record.settled = true; }).catch(() => {});
    return result;
  }
}
