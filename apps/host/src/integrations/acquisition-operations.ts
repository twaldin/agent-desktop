import type { WorkspaceTarget } from '@agent-desktop/shared';
import { createHash } from 'node:crypto';
import type { NativeMarketplaceCatalog, NativePluginAcquisition, NativePluginAcquisitionRequest, NativePluginAcquisitionReceipt } from '../../../../packages/shared/src/plugin-acquisition';
import { PluginAcquisitionRecords } from './acquisition-records';

interface Runtime {
  read(cwd: string): Promise<NativeMarketplaceCatalog>;
  mutate(cwd: string, revision: string, action: NativePluginAcquisition): Promise<NativeMarketplaceCatalog>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)]));
  return value;
}

/** A host-owned install outlives its HTTP request. No request timeout cancels or replays native work. */
export class PluginAcquisitionOperations {
  private pending = new Map<string, Promise<void>>();
  private stopping = false;
  private completionErrors: unknown[] = [];
  constructor(private records: PluginAcquisitionRecords, private runtime: Runtime, private changed: (cwd: string) => void = () => {}) {}

  start(cwd: string, request: NativePluginAcquisitionRequest, target?: WorkspaceTarget): NativePluginAcquisitionReceipt {
    if (this.stopping) throw new Error('The host is stopping.');
    const hash = createHash('sha256').update(JSON.stringify(canonical({cwd,target,...request}))).digest('hex');
    const claim = this.records.claim(cwd, request.id, hash, request.action.operation,target);
    if (!claim.fresh) return claim.receipt;
    const work = Promise.resolve().then(async () => {
      let state: 'succeeded' | 'needs-review' = 'succeeded';
      try { await this.runtime.mutate(cwd,request.expectedRevision,request.action); }
      catch { state = 'needs-review'; }
      this.records.finish(cwd,request.id,state);
      this.changed(cwd);
    });
    this.pending.set(request.id,work);
    void work.catch(error => { this.completionErrors.push(error); }).finally(() => this.pending.delete(request.id));
    return claim.receipt;
  }
  list(cwd?: string): NativePluginAcquisitionReceipt[] { return this.records.list(cwd); }
  get(cwd: string, id: string): NativePluginAcquisitionReceipt | undefined { return this.records.get(cwd,id); }

  closeRequest(cwd: string, id: string, operation: NativePluginAcquisition['operation'], target?: WorkspaceTarget): NativePluginAcquisitionReceipt {
    if (this.stopping) throw new Error('The host is stopping.');
    const receipt = this.records.closeRequest(cwd,id,operation,target); this.changed(cwd); return receipt;
  }

  async review(cwd: string, id: string, expectedRevision: string): Promise<NativePluginAcquisitionReceipt> {
    if (this.stopping) throw new Error('The host is stopping.');
    if (this.pending.has(id)) throw new Error('The native operation has not settled.');
    // read() takes the same native profile locks as mutation: a draining old worker must settle first.
    const current = await this.runtime.read(cwd);
    if (current.revision !== expectedRevision) throw new Error('Plugin configuration changed. Reload before confirming review.');
    const receipt = this.records.review(cwd,id);
    this.changed(cwd); return receipt;
  }
  async dispose(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.pending.values()]);
    if (this.completionErrors.length) throw new AggregateError(this.completionErrors,'Plugin operation receipts could not be recorded.');
  }
}
