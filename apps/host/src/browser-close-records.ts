import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { browserCloseIdentity, parseBrowserCloseOwner, parseBrowserCloseRequest, parseBrowserCloseReceipt,
  type BrowserCloseOwner, type BrowserCloseRequest, type BrowserCloseReceipt } from "../../../packages/shared/src/browser-close";

export class BrowserCloseInputMismatch extends Error {}
export interface BrowserCloseRecord {
  version: 1;
  hostId: string;
  owner: BrowserCloseOwner;
  request: BrowserCloseRequest;
  requestHash: string;
  createdAt: number;
  receipt?: BrowserCloseReceipt;
}
export function browserCloseRequestHash(owner: BrowserCloseOwner, request: BrowserCloseRequest): string {
  return createHash("sha256").update(JSON.stringify([parseBrowserCloseOwner(owner), parseBrowserCloseRequest(request)])).digest("hex");
}
/** Permanent request reservations. Reads never migrate or turn an interrupted close into another dispatch. */
export class BrowserCloseRecords {
  constructor(private readonly db: Database, private readonly hostId: string,
    private readonly admit: (owner: BrowserCloseOwner) => void, private readonly requireSchema: () => void, private readonly now = Date.now) {}
  private key(owner: BrowserCloseOwner, request: BrowserCloseRequest): string {
    return "browser-close.v1:" + JSON.stringify([owner.kind, owner.kind === "session" ? owner.sessionId : owner.ownerId, request.requestId]);
  }
  get(ownerValue: BrowserCloseOwner, requestValue: BrowserCloseRequest): BrowserCloseRecord | undefined {
    const owner = parseBrowserCloseOwner(ownerValue), request = parseBrowserCloseRequest(requestValue);
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM metadata WHERE key = ?").get(this.key(owner, request));
    if (!row) return;
    if (Buffer.byteLength(row.data) > 32768) throw new Error("Browser close record exceeds its limit.");
    const saved = JSON.parse(row.data) as BrowserCloseRecord;
    if (!saved || saved.version !== 1 || saved.hostId !== this.hostId || !Number.isSafeInteger(saved.createdAt) || saved.createdAt <= 0) throw new Error("Invalid browser close record.");
    const savedOwner = parseBrowserCloseOwner(saved.owner), savedRequest = parseBrowserCloseRequest(saved.request);
    if (this.key(savedOwner, savedRequest) !== this.key(owner, request) || saved.requestHash !== browserCloseRequestHash(savedOwner, savedRequest)) throw new Error("Invalid browser close record identity.");
    if (saved.requestHash !== browserCloseRequestHash(owner, request)) throw new BrowserCloseInputMismatch("Browser close request ID already has different input.");
    return { version: 1, hostId: this.hostId, owner: savedOwner, request: savedRequest, requestHash: saved.requestHash, createdAt: saved.createdAt,
      ...(saved.receipt === undefined ? {} : { receipt: parseBrowserCloseReceipt(saved.receipt, this.hostId, owner, request) }) };
  }
  private write(record: BrowserCloseRecord): void {
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 32768) throw new Error("Browser close record exceeds its limit.");
    this.db.query("INSERT INTO metadata(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(this.key(record.owner, record.request), data);
  }
  claim(ownerValue: BrowserCloseOwner, requestValue: BrowserCloseRequest): { fresh: boolean; record: BrowserCloseRecord } {
    const owner = parseBrowserCloseOwner(ownerValue), request = parseBrowserCloseRequest(requestValue);
    return this.db.transaction(() => {
      const prior = this.get(owner, request);
      if (prior) return { fresh: false, record: prior };
      this.admit(owner);
      const createdAt = this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error("Invalid browser close admission time.");
      this.requireSchema();
      const record: BrowserCloseRecord = { version: 1, hostId: this.hostId, owner, request, requestHash: browserCloseRequestHash(owner, request), createdAt };
      this.write(record);
      return { fresh: true, record };
    }).immediate();
  }
  finish(owner: BrowserCloseOwner, request: BrowserCloseRequest, receipt: BrowserCloseReceipt): BrowserCloseRecord {
    return this.db.transaction(() => {
      const record = this.get(owner, request);
      if (!record) throw new Error("Cannot finish an unclaimed browser close.");
      const projected = parseBrowserCloseReceipt(receipt, this.hostId, owner, request);
      if (record.receipt) {
        if (JSON.stringify(record.receipt) !== JSON.stringify(projected)) throw new Error("Browser close already settled differently.");
        return record;
      }
      const next = { ...record, receipt: projected }; this.write(next); return next;
    }).immediate();
  }
  unknown(owner: BrowserCloseOwner, request: BrowserCloseRequest): BrowserCloseReceipt {
    return { ...browserCloseIdentity(this.hostId, owner, request), outcome: "unknown",
      message: "Browser close has no confirmed durable completion. Inspect the original target; do not replay this request." };
  }
}
