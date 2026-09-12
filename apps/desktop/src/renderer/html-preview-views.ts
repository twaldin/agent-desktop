import type { HtmlPreviewAdmission } from "../../../../packages/shared/src/html-preview";
import type { DesktopBridge } from '@agent-desktop/shared';
import { parseHtmlPreviewLease, parseHtmlPreviewRequest, type HtmlPreviewOutput, type HtmlPreviewLease } from '../../../../packages/shared/src/html-preview';
type Held = { lease: HtmlPreviewLease; bridge: DesktopBridge; hostId: string; sessionId: string; tabId?: string; pending: boolean; current(): boolean; release?: Promise<void> };
/** Original-output leases live with their browser presentation, not the URL string. */
export class HtmlPreviewViews {
  #live = true;
  #generation = 0;
  #held = new Set<Held>();
  #tabs = new Set<string>();
  constructor(private readonly report: (message: string) => void) {}
  start() { this.#live = true; }
  observe(tabIds: readonly string[]) {
    this.#tabs = new Set(tabIds);
    for (const held of this.#held) if (!held.current() || !held.pending && (!held.tabId || !this.#tabs.has(held.tabId))) void this.#release(held).catch(() => {});
  }
  async open(options: { bridge: DesktopBridge; hostId: string; sessionId: string; epoch: string; output: HtmlPreviewOutput; admitted(): boolean; retained(): boolean;
    queue(url: string, current: () => boolean, preview: HtmlPreviewAdmission): { tabId: string; queued: Promise<boolean> } | undefined }) {
    if (!this.#live || !options.admitted()) throw new Error('The original saved HTML is no longer selected.');
    if (!options.bridge.openHtmlPreview || !options.bridge.releaseHtmlPreview) throw new Error('Update the desktop and owning host to preview saved HTML.');
    const startedAt = Date.now(), generation = this.#generation, current = () => this.#live && this.#generation === generation && options.retained();
    const request = parseHtmlPreviewRequest({ epoch: options.epoch, output: options.output });
    const lease = parseHtmlPreviewLease(await options.bridge.openHtmlPreview(options.sessionId, request, options.hostId), request);
    const held: Held = { lease, bridge: options.bridge, hostId: options.hostId, sessionId: options.sessionId, pending: true, current };
    this.#held.add(held);
    if (!current() || !options.admitted()) { await this.#release(held); throw new Error('The original HTML selection changed during preparation.'); }
    try {
      const queued = options.queue(lease.url, current, { workerPid: lease.workerPid, expiresAt: startedAt + lease.validForMs });
      if (!queued) { await this.#release(held); return; }
      held.tabId = queued.tabId;
      const accepted = await queued.queued; held.pending = false;
      if (!accepted || !current() || !this.#tabs.has(held.tabId)) await this.#release(held);
    } catch (error) {
      try { await this.#release(held); } catch (cleanup) {
        if (cleanup !== error) throw new AggregateError([error, cleanup], 'HTML preview opening and release both failed.');
      }
      throw error;
    }
  }
  #release(held: Held): Promise<void> {
    return held.release ??= held.bridge.releaseHtmlPreview!(held.sessionId, held.lease.leaseId, held.hostId).then(() => { this.#held.delete(held); }, error => { this.report(error instanceof Error ? error.message : 'The original HTML preview release was not confirmed.'); throw error; });
  }
  dispose() { this.#live = false; this.#generation++; for (const held of this.#held) void this.#release(held).catch(() => {}); }
}
