import type { Database } from "bun:sqlite";
import { parseBrowserCreateRequest, parseBrowserCreationTicket, parseDraftBrowserCreationReceipt as receiptFor,
  type BrowserCreateRequest, type DraftBrowserReceiptIdentity, type DraftBrowserCreationReceipt, type DraftBrowserCreationObservation } from "@agent-desktop/shared";
export type { DraftBrowserCreationReceipt, DraftBrowserCreationObservation } from "@agent-desktop/shared";
import { BrowserCreationInputMismatch, browserCreationRequestHash } from "./browser-creation-records";
import type { DraftBrowserOwnerRecords } from "./browser-draft-owner-records";

export interface DraftBrowserCreationRecord {
  version: 1;
  ownerKind: "draft";
  hostId: string;
  ownerId: string;
  requestId: string;
  requestHash: string;
  controlEpoch: string;
  createdAt: number;
  state: "pending" | "settled";
  receipt?: DraftBrowserCreationReceipt;
}
const prefix = "draft-browser-creation.v1:";
const validOwner = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id);


/** Companion to schema19 draft owners. Claim/finish acknowledge storage only, never native acquisition or liveness. */
export class DraftBrowserCreationRecords {
  constructor(private readonly db: Database, private readonly hostId: string, private readonly owners: DraftBrowserOwnerRecords, private readonly now = Date.now) {}
  private identity(ownerId: string, requestId: string): DraftBrowserReceiptIdentity {
    if (!validOwner(ownerId)) throw new Error("Invalid draft browser owner ID");
    return { protocolVersion: 1, ownerKind: "draft", hostId: this.hostId, ownerId, requestId };
  }
  private key(ownerId: string, requestId: string) { return prefix + JSON.stringify([ownerId, requestId]); }
  private read(ownerId: string, requestId: string): DraftBrowserCreationRecord | undefined {
    const base = this.identity(ownerId, requestId);
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM metadata WHERE key = ?").get(this.key(ownerId, requestId));
    if (!row) return;
    if (Buffer.byteLength(row.data) > 32768) throw new Error("Draft browser creation record exceeds its limit");
    const saved = JSON.parse(row.data) as DraftBrowserCreationRecord;
    if (!saved || saved.version !== 1 || saved.ownerKind !== "draft" || saved.hostId !== this.hostId || saved.ownerId !== ownerId || saved.requestId !== requestId
      || !/^[a-f0-9]{64}$/.test(saved.requestHash) || !Number.isSafeInteger(saved.createdAt) || saved.createdAt <= 0
      || saved.state !== "pending" && saved.state !== "settled" || (saved.state === "settled") !== (saved.receipt !== undefined)) throw new Error("Invalid draft browser creation record");
    parseBrowserCreationTicket({ controlEpoch: saved.controlEpoch, observedAt: saved.createdAt });
    if (!this.owners.get(ownerId)) throw new Error("Draft browser creation record lost its owner");
    return { version: 1, ownerKind: "draft", hostId: this.hostId, ownerId, requestId, requestHash: saved.requestHash,
      controlEpoch: saved.controlEpoch, createdAt: saved.createdAt, state: saved.state,
      ...(saved.receipt === undefined ? {} : { receipt: receiptFor(saved.receipt, base) }) };
  }
  private write(record: DraftBrowserCreationRecord) {
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 32768) throw new Error("Draft browser creation record exceeds its limit");
    this.db.query("INSERT INTO metadata(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(this.key(record.ownerId, record.requestId), data);
  }
  get(ownerId: string, request: BrowserCreateRequest): DraftBrowserCreationRecord | undefined {
    const input = parseBrowserCreateRequest(request), saved = this.read(ownerId, input.requestId);
    if (saved && saved.requestHash !== browserCreationRequestHash(input)) throw new BrowserCreationInputMismatch("Draft browser creation ID already has different input");
    return saved;
  }
  claim(ownerId: string, request: BrowserCreateRequest): { fresh: boolean; record: DraftBrowserCreationRecord } {
    const input = parseBrowserCreateRequest(request);
    return this.db.transaction(() => {
      const prior = this.get(ownerId, input);
      if (prior) return { fresh: false, record: prior };
      const owner = this.owners.get(ownerId);
      if (!owner || owner.retiredAt !== undefined) throw new Error("Draft browser owner is missing or retired");
      const createdAt = this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error("Invalid draft browser admission time");
      const record: DraftBrowserCreationRecord = { version: 1, ownerKind: "draft", hostId: this.hostId, ownerId,
        requestId: input.requestId, requestHash: browserCreationRequestHash(input), controlEpoch: input.controlEpoch, createdAt, state: "pending" };
      this.write(record); return { fresh: true, record };
    }).immediate();
  }
  finish(ownerId: string, request: BrowserCreateRequest, receipt: DraftBrowserCreationReceipt): DraftBrowserCreationRecord {
    const input = parseBrowserCreateRequest(request);
    return this.db.transaction(() => {
      const prior = this.get(ownerId, input);
      if (!prior) throw new Error("Cannot finish an unclaimed draft browser creation");
      const projected = receiptFor(receipt, this.identity(ownerId, input.requestId));
      if (prior.receipt) {
        if (JSON.stringify(prior.receipt) !== JSON.stringify(projected)) throw new Error("Draft browser creation already settled differently");
        return prior;
      }
      const record: DraftBrowserCreationRecord = { ...prior, state: "settled", receipt: projected };
      this.write(record); return record;
    }).immediate();
  }
  observe(ownerId: string, request: BrowserCreateRequest, currentEpoch: string): DraftBrowserCreationObservation {
    parseBrowserCreationTicket({ controlEpoch: currentEpoch, observedAt: 1 });
    const input = parseBrowserCreateRequest(request), record = this.get(ownerId, input), base = this.identity(ownerId, input.requestId);
    if (!record) return { ...base, status: "unavailable" };
    if (record.receipt) return { ...base, status: "settled", receipt: record.receipt };
    if (record.controlEpoch === currentEpoch) return { ...base, status: "pending" };
    return { ...base, status: "settled", receipt: { ...base, outcome: "unknown",
      message: "The draft browser host restarted before durable completion. Inspect existing targets; do not replay creation." } };
  }
}
