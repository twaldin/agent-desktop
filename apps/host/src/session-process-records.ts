import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { assertSessionProcessesResultMatches, parseSessionProcessReceipt, parseSessionProcessesRequest,
  type SessionProcessMutation, type SessionProcessReceipt } from "../../../packages/shared/src/session-processes";

export class ProcessInputMismatch extends Error {}
interface ProcessRecord { version: 1; hostId: string; runnerId: string; createdAt: number; requestHash: string; receipt: SessionProcessReceipt }
function mutation(value: unknown): SessionProcessMutation {
  const parsed = parseSessionProcessesRequest(value);
  if (parsed.action !== "stop" && parsed.action !== "restart" && parsed.action !== "input") throw new Error("Expected a native process mutation.");
  return parsed;
}
function hash(request: SessionProcessMutation): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
/** Permanent operation IDs, scoped to the original host/session. The journal
 * stores only a digest of input text, never the submitted stdin itself. A new
 * host instance projects an unfinished receipt as unknown without dispatching
 * or rewriting it; original receipt lookup remains available after retirement. */
export class SessionProcessRecords {
  readonly #runnerId = randomUUID();
  constructor(private readonly db: Database, private readonly hostId: string,
    private readonly admit: (request: SessionProcessMutation) => void,
    private readonly requireSchema: () => void, private readonly now = Date.now) {}
  #key(sessionId: string, operationId: string): string {
    // Reuse the public validators without accepting an unbounded arbitrary key.
    parseSessionProcessesRequest({ action: "receipt", operationId });
    if (!sessionId || sessionId.length > 200 || /[\u0000-\u001f\u007f]/.test(sessionId)) throw new Error("Invalid process receipt session.");
    return "session-process.v1:" + JSON.stringify([sessionId, operationId]);
  }
  #read(sessionId: string, operationId: string): ProcessRecord | undefined {
    const key = this.#key(sessionId, operationId);
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM metadata WHERE key = ?").get(key);
    if (!row) return;
    if (Buffer.byteLength(row.data) > 32768) throw new Error("Native process receipt exceeds its limit.");
    const raw = JSON.parse(row.data) as ProcessRecord;
    if (!raw || raw.version !== 1 || raw.hostId !== this.hostId || typeof raw.runnerId !== "string" || !raw.runnerId.length
      || !Number.isSafeInteger(raw.createdAt) || raw.createdAt <= 0 || !/^[a-f0-9]{64}$/.test(raw.requestHash)) throw new Error("Invalid native process record.");
    const receipt = parseSessionProcessReceipt(raw.receipt);
    if (this.#key(receipt.owner.nativeSessionId, receipt.operationId) !== key) throw new Error("Native process receipt identity mismatch.");
    return { version: 1, hostId: this.hostId, runnerId: raw.runnerId, createdAt: raw.createdAt, requestHash: raw.requestHash, receipt };
  }
  #project(record: ProcessRecord): SessionProcessReceipt {
    return record.receipt.status === "pending" && record.runnerId !== this.#runnerId
      ? { ...record.receipt, status: "unknown" } : record.receipt;
  }
  get(sessionId: string, operationId: string): SessionProcessReceipt | undefined {
    const record = this.#read(sessionId, operationId);
    return record && this.#project(record);
  }
  #write(record: ProcessRecord): void {
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 32768) throw new Error("Native process receipt exceeds its limit.");
    this.db.query("INSERT INTO metadata(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(this.#key(record.receipt.owner.nativeSessionId, record.receipt.operationId), data);
  }
  claim(raw: SessionProcessMutation): { fresh: boolean; receipt: SessionProcessReceipt } {
    const request = mutation(raw), requestHash = hash(request);
    return this.db.transaction(() => {
      const prior = this.#read(request.owner.nativeSessionId, request.operationId);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ProcessInputMismatch("This process operation ID already has different input.");
        return { fresh: false, receipt: this.#project(prior) };
      }
      this.admit(request);
      const createdAt = this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error("Invalid process admission time.");
      this.requireSchema();
      const receipt: SessionProcessReceipt = { operationId: request.operationId, action: request.action, owner: request.owner, target: request.target, status: "pending" };
      this.#write({ version: 1, hostId: this.hostId, runnerId: this.#runnerId, createdAt, requestHash, receipt });
      return { fresh: true, receipt };
    }).immediate();
  }
  finish(raw: SessionProcessMutation, outcome: SessionProcessReceipt): SessionProcessReceipt {
    const request = mutation(raw), receipt = parseSessionProcessReceipt(outcome);
    assertSessionProcessesResultMatches(request, { action: "mutation", receipt });
    if (receipt.status === "pending") throw new Error("Cannot finish a process operation as pending.");
    return this.db.transaction(() => {
      const record = this.#read(request.owner.nativeSessionId, request.operationId);
      if (!record || record.requestHash !== hash(request)) throw new ProcessInputMismatch("Cannot finish an unclaimed or different process operation.");
      if (record.receipt.status !== "pending") {
        if (JSON.stringify(record.receipt) !== JSON.stringify(receipt)) throw new Error("This process operation already settled differently.");
        return record.receipt;
      }
      if (record.runnerId !== this.#runnerId) throw new Error("The original process dispatcher no longer owns this receipt.");
      this.#write({ ...record, receipt });
      return receipt;
    }).immediate();
  }
}
