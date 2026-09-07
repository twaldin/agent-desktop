import type { WorkspaceTarget } from '@agent-desktop/shared';
import type { Database } from 'bun:sqlite';
import type { NativePluginAcquisitionReceipt } from '../../../../packages/shared/src/plugin-acquisition';

const PREFIX = 'plugin-acquisition.v1:';
interface Record extends NativePluginAcquisitionReceipt { cwd: string; requestHash: string }
type Row = { data: string };
const publicReceipt = ({cwd: _cwd, requestHash: _hash, ...receipt}: Record): NativePluginAcquisitionReceipt => receipt;

/** Uses the existing host metadata table. Source URLs and action payloads are never stored. */
export class PluginAcquisitionRecords {
  constructor(private db: Database) {}

  private load(id: string): Record | undefined {
    const row = this.db.query<Row, [string]>('SELECT data FROM metadata WHERE key = ?').get(PREFIX + id);
    return row ? JSON.parse(row.data) as Record : undefined;
  }
  private write(record: Record): void {
    this.db.query('INSERT INTO metadata (key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data')
      .run(PREFIX + record.id, JSON.stringify(record));
  }
  list(cwd?: string): NativePluginAcquisitionReceipt[] {
    return this.db.query<Row, [string]>('SELECT data FROM metadata WHERE key LIKE ?').all(PREFIX + '%')
      .map(row => JSON.parse(row.data) as Record).filter(row => cwd === undefined || row.cwd === cwd)
      .sort((a,b) => b.createdAt - a.createdAt).map(publicReceipt);
  }
  get(cwd: string, id: string): NativePluginAcquisitionReceipt | undefined {
    const record = this.load(id);
    if (!record || record.cwd !== cwd) return undefined;
    return publicReceipt(record);
  }
  claim(cwd: string, id: string, requestHash: string, operation: Record['operation'], target?: WorkspaceTarget): { fresh: boolean; receipt: NativePluginAcquisitionReceipt } {
    return this.db.transaction(() => {
      const existing = this.load(id);
      if (existing) {
        if (existing.cwd !== cwd || existing.requestHash !== requestHash) throw new Error('This operation ID belongs to a different request.');
        return {fresh:false, receipt:publicReceipt(existing)};
      }
      const unsettled = this.db.query<Row, [string]>(`SELECT data FROM metadata WHERE key LIKE ? AND json_extract(data,'$.state') IN ('running','needs-review') LIMIT 1`).get(PREFIX + '%');
      if (unsettled) throw new Error('A plugin operation is running or needs review on this host.');
      const now = Date.now();
      const record: Record = {id,cwd,requestHash,operation,...(target?{target}:{}),state:'running',createdAt:now,updatedAt:now};
      this.write(record);
      return {fresh:true,receipt:publicReceipt(record)};
    }).immediate();
  }
  /** Fence a delayed request only if it has never been admitted. This cannot cancel native work. */
  closeRequest(cwd: string, id: string, operation: Record['operation'], target?: WorkspaceTarget): NativePluginAcquisitionReceipt {
    return this.db.transaction(() => {
      const existing = this.load(id);
      if (existing) {
        if (existing.cwd !== cwd || existing.operation !== operation) throw new Error('This operation belongs to another request.');
        return publicReceipt(existing);
      }
      const now = Date.now();
      const record: Record = {id,cwd,operation,...(target?{target}:{}),requestHash:'closed-before-admission',state:'reviewed',createdAt:now,updatedAt:now,
        message:'Request closed before native admission. No native operation ran.'};
      this.write(record); return publicReceipt(record);
    }).immediate();
  }
  finish(cwd: string, id: string, state: 'succeeded' | 'needs-review'): NativePluginAcquisitionReceipt {
    return this.db.transaction(() => {
      const record = this.load(id);
      if (!record || record.cwd !== cwd || record.state !== 'running') throw new Error('The plugin operation is no longer running.');
      record.state = state; record.updatedAt = Date.now();
      if (state === 'needs-review') record.message = 'The native operation did not finish with a confirmed result. Inspect the current configuration before another operation.';
      this.write(record); return publicReceipt(record);
    }).immediate();
  }
  review(cwd: string, id: string): NativePluginAcquisitionReceipt {
    return this.db.transaction(() => {
      const record = this.load(id);
      if (!record || record.cwd !== cwd || record.state !== 'needs-review') throw new Error('This plugin operation is not awaiting review.');
      record.state = 'reviewed'; record.updatedAt = Date.now();
      record.message = 'Configuration reviewed. The original operation was not replayed.';
      this.write(record); return publicReceipt(record);
    }).immediate();
  }
  /** Call only after acquiring the host lease. Native profile locks still fence any draining predecessor worker. */
  recoverInterrupted(): void {
    this.db.transaction(() => {
      const rows = this.db.query<Row, [string]>(`SELECT data FROM metadata WHERE key LIKE ? AND json_extract(data,'$.state') = 'running'`).all(PREFIX + '%');
      for (const row of rows) {
        const record = JSON.parse(row.data) as Record;
        record.state = 'needs-review'; record.updatedAt = Date.now();
        record.message = 'The host restarted before recording the native result. Inspect the configuration; this operation will not be replayed.';
        this.write(record);
      }
    }).immediate();
  }
}
