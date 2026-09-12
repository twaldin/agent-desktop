import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { parseBrowserCreateRequest, parseBrowserCreationTicket, parseNativeBrowserTabMetadata,
  type BrowserCreateObservation, type BrowserCreateReceipt, type BrowserCreateRequest } from "@agent-desktop/shared";

export class BrowserCreationInputMismatch extends Error {}

const prefix = "browser-creation.v1:";
export interface BrowserCreationRecord {
  version: 1;
  hostId: string;
  sessionId: string;
  requestId: string;
  requestHash: string;
  controlEpoch: string;
  createdAt: number;
  state: "pending" | "settled";
  receipt?: BrowserCreateReceipt;
}
const validSession = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0");
export function browserCreationRequestHash(request: BrowserCreateRequest): string {
  return createHash("sha256").update(JSON.stringify(parseBrowserCreateRequest(request))).digest("hex");
}

function receiptFor(value: unknown, hostId: string, sessionId: string, requestId: string): BrowserCreateReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid persisted browser receipt.");
  const r = value as BrowserCreateReceipt;
  if (r.protocolVersion !== 1 || r.hostId !== hostId || r.sessionId !== sessionId || r.requestId !== requestId) throw new Error("Browser receipt owner does not match its admission.");
  const base = { protocolVersion: 1 as const, hostId, sessionId, requestId };
  if (r.outcome === "rejected" || r.outcome === "unknown") {
    if (typeof r.message !== "string" || !r.message || r.message.length > 4096
      || r.workerPid !== undefined && (!Number.isSafeInteger(r.workerPid) || r.workerPid <= 0)) throw new Error("Invalid persisted browser outcome.");
    return { ...base, outcome: r.outcome, message: r.message, ...(r.workerPid === undefined ? {} : { workerPid: r.workerPid }) };
  }
  if (r.outcome !== "completed" || !Number.isSafeInteger(r.workerPid) || r.workerPid <= 0) throw new Error("Invalid persisted browser completion.");
  const tab = parseNativeBrowserTabMetadata(r.tab);
  const disposition = tab.kindTag === "headless" ? "created-page" : tab.kindTag === "cmux" ? "created-surface" : "adopted-existing-target";
  if (tab.name !== `desktop-${requestId}` || tab.state !== "alive" || r.targetDisposition !== disposition) throw new Error("Persisted browser target does not match its admission.");
  return { ...base, outcome: "completed", workerPid: r.workerPid, tab, targetDisposition: disposition };
}

/** Owns only its metadata namespace. Native acquisition remains outside SQLite;
 * callers must await a successful claim before dispatch and never replay prior IDs. */
export class BrowserCreationRecords {
  constructor(private db: Database, private hostId: string, private requireSchema: () => void, private now = Date.now) {}
  private key(sessionId: string, requestId: string) { return prefix + JSON.stringify([sessionId, requestId]); }
  private load(sessionId: string, requestId: string): BrowserCreationRecord | undefined {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM metadata WHERE key = ?").get(this.key(sessionId, requestId));
    if (!row) return;
    if (Buffer.byteLength(row.data) > 32768) throw new Error("Browser admission record exceeds its limit.");
    const r = JSON.parse(row.data) as BrowserCreationRecord;
    if (!r || r.version !== 1 || r.hostId !== this.hostId || r.sessionId !== sessionId || r.requestId !== requestId
      || !/^[a-f0-9]{64}$/.test(r.requestHash) || !Number.isSafeInteger(r.createdAt) || r.createdAt <= 0
      || (r.state !== "pending" && r.state !== "settled") || (r.state === "settled") !== (r.receipt !== undefined)) throw new Error("Invalid browser admission record.");
    parseBrowserCreationTicket({ controlEpoch: r.controlEpoch, observedAt: r.createdAt });
    return { version: 1, hostId: this.hostId, sessionId, requestId, requestHash: r.requestHash,
      controlEpoch: r.controlEpoch, createdAt: r.createdAt, state: r.state,
      ...(r.receipt === undefined ? {} : { receipt: receiptFor(r.receipt, this.hostId, sessionId, requestId) }) };
  }
  private write(record: BrowserCreationRecord) {
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 32768) throw new Error("Browser admission record exceeds its limit.");
    this.db.query("INSERT INTO metadata(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(this.key(record.sessionId, record.requestId), data);
  }
  get(sessionId: string, request: BrowserCreateRequest): BrowserCreationRecord | undefined {
    if (!validSession(sessionId)) throw new Error("Invalid browser session identity.");
    const input = parseBrowserCreateRequest(request), record = this.load(sessionId, input.requestId);
    if (record && record.requestHash !== browserCreationRequestHash(input)) throw new BrowserCreationInputMismatch("Browser creation identity already has different input.");
    return record;
  }
  claim(sessionId: string, request: BrowserCreateRequest): { fresh: boolean; record: BrowserCreationRecord } {
    const input = parseBrowserCreateRequest(request);
    return this.db.transaction(() => {
      const prior = this.get(sessionId, input);
      if (prior) return { fresh: false, record: prior };
      const createdAt = this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error("Invalid browser admission time.");
      this.requireSchema();
      const record: BrowserCreationRecord = { version: 1, hostId: this.hostId, sessionId, requestId: input.requestId,
        requestHash: browserCreationRequestHash(input), controlEpoch: input.controlEpoch, createdAt, state: "pending" };
      this.write(record);
      return { fresh: true, record };
    }).immediate();
  }
  finish(sessionId: string, request: BrowserCreateRequest, receipt: BrowserCreateReceipt): BrowserCreationRecord {
    const input = parseBrowserCreateRequest(request);
    return this.db.transaction(() => {
      const record = this.get(sessionId, input);
      if (!record) throw new Error("Cannot finish an unclaimed browser creation.");
      const projected = receiptFor(receipt, this.hostId, sessionId, input.requestId);
      if (record.receipt) {
        if (JSON.stringify(record.receipt) !== JSON.stringify(projected)) throw new Error("Browser creation receipt is already settled differently.");
        return record;
      }
      const next: BrowserCreationRecord = { ...record, state: "settled", receipt: projected };
      this.write(next); return next;
    }).immediate();
  }
  observe(sessionId: string, request: BrowserCreateRequest, currentEpoch: string): BrowserCreateObservation {
    parseBrowserCreationTicket({ controlEpoch: currentEpoch, observedAt: 1 });
    const input = parseBrowserCreateRequest(request), record = this.get(sessionId, input);
    const base = { protocolVersion: 1 as const, hostId: this.hostId, sessionId, requestId: input.requestId };
    if (!record) return { ...base, status: "unavailable" };
    if (record.receipt) return { ...base, status: "settled", receipt: record.receipt };
    if (record.controlEpoch === currentEpoch) return { ...base, status: "pending" };
    return { ...base, status: "settled", receipt: { ...base, outcome: "unknown",
      message: "The browser host restarted before a durable completion receipt. Inspect existing targets; do not replay creation." } };
  }
}
