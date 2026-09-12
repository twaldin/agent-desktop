import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { parseTerminalCreationRequest, parseTerminalCreationReceipt, type TerminalCreationRequest, type TerminalCreationReceipt, type TerminalCreationObservation } from "../../../../packages/shared/src/terminal-creation";
export { parseTerminalCreationRequest, type TerminalCreationRequest, type TerminalCreationReceipt, type TerminalCreationObservation } from "../../../../packages/shared/src/terminal-creation";

const prefix = "terminal-creation.v1:";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface TerminalCreationRecord {
  version: 1;
  hostId: string;
  request: TerminalCreationRequest;
  requestHash: string;
  terminalId: string;
  createdAt: number;
  state: "pending" | "settled";
  receipt?: TerminalCreationReceipt;
}
export class TerminalCreationInputMismatch extends Error {}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) throw new Error("Invalid terminal creation fields.");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("Terminal creation requires a UUID identity.");
  return value;
}

function requestHash(request: TerminalCreationRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
/** Durable admission only. A fresh claim reserves an identity; it does not prove
 * a shell was created. Native dispatch and receipt authenticity belong to the
 * consuming host route. Observation never releases or repairs a prior claim. */
export class TerminalCreationRecords {
  constructor(private db: Database, private hostId: string, private requireSchema: () => void) { id(hostId); }
  private key(requestId: string): string { return prefix + requestId; }
  private load(requestId: string): TerminalCreationRecord | undefined {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM metadata WHERE key = ?").get(this.key(requestId));
    if (!row) return;
    if (Buffer.byteLength(row.data) > 16384) throw new Error("Terminal creation record exceeds its bound.");
    const r = object(JSON.parse(row.data), ["version", "hostId", "request", "requestHash", "terminalId", "createdAt", "state", "receipt"]);
    const request = parseTerminalCreationRequest(r.request), terminalId = id(r.terminalId);
    if (r.version !== 1 || r.hostId !== this.hostId || request.requestId !== requestId
      || r.requestHash !== requestHash(request) || !Number.isSafeInteger(r.createdAt) || (r.createdAt as number) <= 0
      || (r.state !== "pending" && r.state !== "settled") || (r.state === "settled") !== (r.receipt !== undefined))
      throw new Error("Invalid terminal creation record.");
    return { version: 1, hostId: this.hostId, request, requestHash: r.requestHash as string, terminalId,
      createdAt: r.createdAt as number, state: r.state,
      ...(r.receipt === undefined ? {} : { receipt: parseTerminalCreationReceipt(r.receipt, terminalId) }) };
  }
  private write(record: TerminalCreationRecord): void {
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 16384) throw new Error("Terminal creation record exceeds its bound.");
    this.db.query("INSERT INTO metadata(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(this.key(record.request.requestId), data);
  }
  get(request: TerminalCreationRequest): TerminalCreationRecord | undefined {
    const input = parseTerminalCreationRequest(request), record = this.load(input.requestId);
    if (record && record.requestHash !== requestHash(input))
      throw new TerminalCreationInputMismatch("Terminal creation identity already has different input.");
    return record;
  }
  claim(request: TerminalCreationRequest): { fresh: boolean; record: TerminalCreationRecord } {
    const input = parseTerminalCreationRequest(request);
    return this.db.transaction(() => {
      const prior = this.get(input);
      if (prior) return { fresh: false, record: prior };
      this.requireSchema();
      const record: TerminalCreationRecord = { version: 1, hostId: this.hostId, request: input,
        requestHash: requestHash(input), terminalId: randomUUID(), createdAt: Date.now(), state: "pending" };
      this.write(record);
      return { fresh: true, record };
    }).immediate();
  }
  finish(request: TerminalCreationRequest, receipt: TerminalCreationReceipt): TerminalCreationRecord {
    return this.db.transaction(() => {
      const record = this.get(request);
      if (!record) throw new Error("Cannot settle an unclaimed terminal creation.");
      const checked = parseTerminalCreationReceipt(receipt, record.terminalId);
      if (record.receipt) {
        if (JSON.stringify(record.receipt) !== JSON.stringify(checked)) throw new Error("Terminal creation is already settled differently.");
        return record;
      }
      const settled: TerminalCreationRecord = { ...record, state: "settled", receipt: checked };
      this.write(settled);
      return settled;
    }).immediate();
  }
  observe(request: TerminalCreationRequest, currentEpoch: string): TerminalCreationObservation {
    id(currentEpoch);
    const record = this.get(request);
    if (!record) return { status: "unavailable" };
    if (record.receipt) return { status: "settled", receipt: record.receipt };
    if (record.request.controlEpoch === currentEpoch) return { status: "pending", terminalId: record.terminalId };
    return { status: "settled", receipt: { outcome: "unknown", terminalId: record.terminalId,
      message: "The terminal host restarted before a durable completion receipt. Inspect the reserved terminal; do not replay creation." } };
  }
}
