import { parseHtmlPreviewRequest, type HtmlPreviewLease, type HtmlPreviewRequest } from '../../../../packages/shared/src/html-preview';
import type { HostEndpoint } from './host-transport';
type Held = { sessionId: string; hostId: string; endpoint: HostEndpoint; lease: HtmlPreviewLease; release?: Promise<void> };
/** A document retains the exact host endpoint which created each preview. */
export class HtmlPreviewDocument {
  #retired = false;
  #leases = new Map<string, Held>();
  #pending = new Set<Promise<unknown>>();
  #cleanupErrors: unknown[] = [];
  #disposal?: Promise<void>;
  constructor(private readonly options: { current(): boolean; connect(hostId: string): Promise<HostEndpoint>; request(endpoint: HostEndpoint, sessionId: string, input: HtmlPreviewRequest | { leaseId: string }): Promise<HtmlPreviewLease | undefined> }) {}
  current() { return !this.#retired && this.options.current(); }
  dispatch(sessionId: string, input: HtmlPreviewRequest | { leaseId: string }, hostId: string): Promise<HtmlPreviewLease | undefined> {
    if (!this.current()) return Promise.reject(new Error('The original preview document retired.'));
    const run = this.#dispatch(sessionId, input, hostId); this.#pending.add(run);
    void run.then(() => this.#pending.delete(run), () => this.#pending.delete(run)); return run;
  }
  async #dispatch(sessionId: string, input: HtmlPreviewRequest | { leaseId: string }, hostId: string): Promise<HtmlPreviewLease | undefined> {
    if (!input || typeof input !== 'object') throw new Error('Invalid preview request.');
    if (!('output' in input)) {
      const held = this.#leases.get(input.leaseId);
      if (!held || held.sessionId !== sessionId || held.hostId !== hostId) throw new Error('The preview belongs to a different document or task.');
      await this.#release(held); return;
    }
    const request = parseHtmlPreviewRequest(input), endpoint = await this.options.connect(hostId);
    if (!this.current() || endpoint.hostId !== hostId) throw new Error('The original preview host changed.');
    const lease = await this.options.request(endpoint, sessionId, request);
    if (!lease) throw new Error('The original worker did not return a preview lease.');
    const held = { sessionId, hostId, endpoint, lease }; this.#leases.set(lease.leaseId, held);
    if (!this.current()) { await this.#release(held); throw new Error('The original preview document retired.'); }
    return { ...lease };
  }
  #release(held: Held): Promise<void> {
    return held.release ??= this.options.request(held.endpoint, held.sessionId, { leaseId: held.lease.leaseId }).then(() => { this.#leases.delete(held.lease.leaseId); }, error => { this.#cleanupErrors.push(error); throw error; });
  }
  retire(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#retired = true;
    return this.#disposal = (async () => {
      await Promise.allSettled([...this.#leases.values()].map(held => this.#release(held)));
      await Promise.allSettled([...this.#pending]);
      if (this.#cleanupErrors.length) throw new AggregateError(this.#cleanupErrors, 'Some original HTML preview releases were not confirmed.');
    })();
  }
}
