import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  PLAN_EXTERNAL_EDITOR_PAGE_SIZE, parsePlanExternalEditorCursor, parsePlanExternalEditorObservation, parsePlanExternalEditorRequest,
  type PlanExternalEditorObservation, type PlanExternalEditorRequest,
} from "../../../packages/shared/src/plan-external-editor";

type EditorResult = NonNullable<PlanExternalEditorObservation["result"]>;
interface EditorRecord {
  version: 1;
  hostId: string;
  request: PlanExternalEditorRequest;
  requestHash: string;
  terminalId: string;
  createdAt: number;
  launched: boolean;
  processSettled?: boolean;
  result?: EditorResult;
}
const hash = (request: PlanExternalEditorRequest) => createHash("sha256").update(JSON.stringify(request)).digest("hex");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RECORD_BYTES = 1024 * 1024;

export class PlanEditorInputMismatch extends Error {}

/** The durable claim owns one terminal identity before any editor dispatch.
 * A prior epoch can be inspected, but can never authorize a replacement run. */
export class PlanExternalEditorRecords {
  constructor(private readonly db: Database, private readonly hostId: string,
    private readonly requireSchema: () => void) {}

  private key(requestId: string): string {
    if (!UUID.test(requestId)) throw new Error("Invalid Plan editor request identity.");
    return `plan-external-editor:v1:${requestId}`;
  }

  private load(requestId: string): EditorRecord | undefined {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM metadata WHERE key = ?").get(this.key(requestId));
    if (!row) return;
    if (Buffer.byteLength(row.data) > MAX_RECORD_BYTES) throw new Error("Plan editor record exceeds its bound.");
    const value: unknown = JSON.parse(row.data);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Plan editor record.");
    const r = value as Record<string, unknown>;
    if (Object.keys(r).some(key => !["version", "hostId", "request", "requestHash", "terminalId", "createdAt", "launched", "processSettled", "result"].includes(key)))
      throw new Error("Invalid Plan editor record fields.");
    const request = parsePlanExternalEditorRequest(r.request);
    if (r.version !== 1 || r.hostId !== this.hostId || request.requestId !== requestId || r.requestHash !== hash(request)
      || typeof r.terminalId !== "string" || !UUID.test(r.terminalId) || typeof r.launched !== "boolean"
      || r.processSettled !== undefined && typeof r.processSettled !== "boolean"
      || !Number.isSafeInteger(r.createdAt) || (r.createdAt as number) <= 0)
      throw new Error("Invalid Plan editor record identity.");
    const projection = parsePlanExternalEditorObservation({ protocolVersion: 1, hostId: this.hostId, request,
      state: r.result === undefined ? "pending" : "settled",
      ...(r.launched ? { terminalId: r.terminalId } : {}), ...(r.result === undefined ? {} : { result: r.result }) }, this.hostId, request);
    return { version: 1, hostId: this.hostId, request, requestHash: r.requestHash as string,
      terminalId: r.terminalId, createdAt: r.createdAt as number, launched: r.launched,
      ...(r.processSettled === undefined ? {} : { processSettled: r.processSettled as boolean }),
      ...(projection.result === undefined ? {} : { result: projection.result }) };
  }

  private write(record: EditorRecord): void {
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new Error("Plan editor record exceeds its bound.");
    this.db.query("INSERT INTO metadata(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(this.key(record.request.requestId), data);
  }

  get(raw: PlanExternalEditorRequest): EditorRecord | undefined {
    const request = parsePlanExternalEditorRequest(raw), record = this.load(request.requestId);
    if (record && record.requestHash !== hash(request))
      throw new PlanEditorInputMismatch("This Plan editor request already owns different input.");
    return record;
  }

  list(sessionId: string, cursor?: string): { items: PlanExternalEditorRequest[]; nextCursor?: string } {
    if (!sessionId || sessionId.includes("\0") || new TextEncoder().encode(sessionId).byteLength > 200)
      throw new Error("Invalid Plan editor session identity.");
    const boundary = cursor === undefined ? undefined : this.load(parsePlanExternalEditorCursor(cursor));
    if (cursor !== undefined && (!boundary || boundary.request.sessionId !== sessionId))
      throw new Error("The Plan editor cursor does not belong to this session.");
    const prefix = "plan-external-editor:v1:";
    const rows = boundary
      ? this.db.query<{ key: string }, [string, string, number, number, string, number]>(`SELECT key FROM metadata
          WHERE key LIKE ? AND json_extract(data, '$.request.sessionId') = ?
            AND (json_extract(data, '$.createdAt') < ?
              OR (json_extract(data, '$.createdAt') = ? AND json_extract(data, '$.request.requestId') < ?))
          ORDER BY json_extract(data, '$.createdAt') DESC, json_extract(data, '$.request.requestId') DESC LIMIT ?`)
        .all(`${prefix}%`, sessionId, boundary.createdAt, boundary.createdAt, boundary.request.requestId, PLAN_EXTERNAL_EDITOR_PAGE_SIZE + 1)
      : this.db.query<{ key: string }, [string, string, number]>(`SELECT key FROM metadata
          WHERE key LIKE ? AND json_extract(data, '$.request.sessionId') = ?
          ORDER BY json_extract(data, '$.createdAt') DESC, json_extract(data, '$.request.requestId') DESC LIMIT ?`)
        .all(`${prefix}%`, sessionId, PLAN_EXTERNAL_EDITOR_PAGE_SIZE + 1);
    const records = rows.map(row => this.load(row.key.slice(prefix.length))!);
    const page = records.slice(0, PLAN_EXTERNAL_EDITOR_PAGE_SIZE);
    return { items: page.map(record => record.request), ...(records.length > PLAN_EXTERNAL_EDITOR_PAGE_SIZE
      ? { nextCursor: page.at(-1)!.request.requestId } : {}) };
  }

  claim(raw: PlanExternalEditorRequest): { fresh: boolean; record: EditorRecord } {
    const request = parsePlanExternalEditorRequest(raw);
    return this.db.transaction(() => {
      const prior = this.get(request);
      if (prior) return { fresh: false, record: prior };
      this.requireSchema();
      const record: EditorRecord = { version: 1, hostId: this.hostId, request, requestHash: hash(request),
        terminalId: randomUUID(), createdAt: Date.now(), launched: false };
      this.write(record);
      return { fresh: true, record };
    }).immediate();
  }

  /** Persist before calling native creation. This records possible dispatch,
   * not proof that a pane exists or the configured program has started. */
  markDispatched(request: PlanExternalEditorRequest): void {
    this.db.transaction(() => {
      const record = this.get(request);
      if (!record || record.result) throw new Error("The Plan editor claim is not pending.");
      if (!record.launched) this.write({ ...record, launched: true });
    }).immediate();
  }

  /** Retain possible processes across host epochs until exact terminal settlement. */
  unsettledProcesses(): EditorRecord[] {
    const rows = this.db.query<{ key: string }, []>("SELECT key FROM metadata WHERE key LIKE 'plan-external-editor:v1:%'").all();
    return rows.map(row => this.load(row.key.slice("plan-external-editor:v1:".length))!)
      .filter(record => record.launched && !record.processSettled);
  }

  markProcessSettled(request: PlanExternalEditorRequest): void {
    this.db.transaction(() => {
      const record = this.get(request);
      if (!record?.launched) throw new Error("The Plan editor process was not dispatched.");
      if (!record.processSettled) this.write({ ...record, processSettled: true });
    }).immediate();
  }

  finish(request: PlanExternalEditorRequest, result: EditorResult): void {
    this.db.transaction(() => {
      const record = this.get(request);
      if (!record) throw new Error("Cannot finish an unclaimed Plan editor.");
      const checked = parsePlanExternalEditorObservation({ protocolVersion: 1, hostId: this.hostId, request,
        state: "settled", ...(record.launched ? { terminalId: record.terminalId } : {}), result }, this.hostId, request).result!;
      if (record.result) {
        if (JSON.stringify(record.result) !== JSON.stringify(checked)) throw new Error("The Plan editor outcome is already settled differently.");
        return;
      }
      this.write({ ...record, result: checked });
    }).immediate();
  }

  observe(raw: PlanExternalEditorRequest, currentEpoch: string): PlanExternalEditorObservation {
    if (!UUID.test(currentEpoch)) throw new Error("Invalid Plan editor host epoch.");
    const request = parsePlanExternalEditorRequest(raw), record = this.get(request);
    const base = { protocolVersion: 1 as const, hostId: this.hostId, request };
    if (!record) return { ...base, state: "absent" };
    const terminal = record.launched ? { terminalId: record.terminalId } : {};
    if (record.result) return { ...base, ...terminal, state: "settled", result: record.result };
    if (request.controlEpoch === currentEpoch) return { ...base, ...terminal, state: "pending" };
    return { ...base, ...terminal, state: "settled", result: { outcome: "unknown",
      message: "The owning host restarted before saving this editor result. Inspect the original terminal and Plan; this request will not run again." } };
  }
}
