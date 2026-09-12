import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { parsePullRequestWriteRequest, parsePullRequestWriteReceipt, pullRequestWriteIdentity,
  type PullRequestWriteRequest, type PullRequestWriteReceipt } from "../../../packages/shared/src/pull-request-write";

interface SubmissionRecord {
  version: 1;
  hostId: string;
  request: PullRequestWriteRequest;
  hash: string;
  createdAt: number;
  receipt?: PullRequestWriteReceipt;
}
const hash = (request: PullRequestWriteRequest) => createHash("sha256").update(pullRequestWriteIdentity(request)).digest("hex");

/** Permanent request reservations. An interrupted GitHub call must never be automatically reposted. */
export class PullRequestWriteRecords {
  constructor(private readonly db: Database, private readonly hostId: string, private readonly requireSchema: () => void) {}
  private key(request: PullRequestWriteRequest) { return `pull-request-write.v1:${request.requestId}`; }
  get(value: PullRequestWriteRequest): SubmissionRecord | undefined {
    const request = parsePullRequestWriteRequest(value);
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM metadata WHERE key = ?").get(this.key(request));
    if (!row) return;
    if (Buffer.byteLength(row.data) > 140_000) throw new Error("Saved pull request submission exceeds its limit.");
    const record = JSON.parse(row.data) as SubmissionRecord;
    if (!record || record.version !== 1 || record.hostId !== this.hostId ||
      !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0) throw new Error("Invalid saved pull request submission.");
    const saved = parsePullRequestWriteRequest(record.request);
    if (this.key(saved) !== this.key(request) || record.hash !== hash(saved)) throw new Error("Invalid saved submission identity.");
    if (record.hash !== hash(request)) throw new Error("This submission ID already belongs to different input.");
    return { version: 1, hostId: this.hostId, request: saved, hash: record.hash, createdAt: record.createdAt,
      ...(record.receipt === undefined ? {} : { receipt: parsePullRequestWriteReceipt(record.receipt, this.hostId, saved) }) };
  }
  private write(record: SubmissionRecord) {
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 140_000) throw new Error("Pull request submission exceeds its storage limit.");
    this.db.query("INSERT INTO metadata(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(this.key(record.request), data);
  }
  claim(value: PullRequestWriteRequest): { fresh: boolean; record: SubmissionRecord } {
    const request = parsePullRequestWriteRequest(value);
    return this.db.transaction(() => {
      const prior = this.get(request);
      if (prior) return { fresh: false, record: prior };
      this.requireSchema();
      const record: SubmissionRecord = { version: 1, hostId: this.hostId, request, hash: hash(request), createdAt: Date.now() };
      this.write(record);
      return { fresh: true, record };
    }).immediate();
  }
  finish(request: PullRequestWriteRequest, value: PullRequestWriteReceipt): PullRequestWriteReceipt {
    const receipt = parsePullRequestWriteReceipt(value, this.hostId, request);
    if (receipt.outcome === "pending") throw new Error("A pending submission cannot be finished.");
    return this.db.transaction(() => {
      const record = this.get(request);
      if (!record) throw new Error("The submission was not durably reserved.");
      if (record.receipt) {
        if (JSON.stringify(record.receipt) !== JSON.stringify(receipt)) throw new Error("The submission already finished differently.");
        return record.receipt;
      }
      this.write({ ...record, receipt });
      return receipt;
    }).immediate();
  }
  unresolved(request: PullRequestWriteRequest, pending: boolean): PullRequestWriteReceipt {
    return { hostId: this.hostId, request: parsePullRequestWriteRequest(request), outcome: pending ? "pending" : "unknown",
      message: pending ? "GitHub submission is still running." : "This submission has no confirmed result. Inspect the original pull request before starting another attempt.", url: null };
  }
}
