import type { Database } from "bun:sqlite";
import { isAbsolute, resolve } from "node:path";

/** Internal host input, after selecting the owning draft and directory. Not a client path capability. */
export interface DraftBrowserOwnerInput {
  id: string;
  draftId: string;
  draftRevision: number;
  projectId: string | null;
  cwd: string;
}
export interface DraftBrowserOwnerRecord extends DraftBrowserOwnerInput {
  version: 1;
  kind: "draft";
  hostId: string;
  createdAt: number;
  /** Durable retirement intent, not an acknowledgement that native cleanup completed. */
  retiredAt?: number;
}
const prefix = "draft-browser-owner.v1:";
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
function parseInput(value: DraftBrowserOwnerInput): DraftBrowserOwnerInput {
  if (!value || !identity(value.id) || !identity(value.draftId) || value.projectId !== null && !identity(value.projectId)
    || !Number.isSafeInteger(value.draftRevision) || value.draftRevision < 1 || typeof value.cwd !== "string" || value.cwd.length > 8192
    || value.cwd.includes("\0") || !isAbsolute(value.cwd) || resolve(value.cwd) !== value.cwd) throw new Error("Invalid draft browser owner binding");
  return { id: value.id, draftId: value.draftId, draftRevision: value.draftRevision, projectId: value.projectId, cwd: value.cwd };
}
function sameInput(a: DraftBrowserOwnerInput, b: DraftBrowserOwnerInput): boolean {
  return a.id === b.id && a.draftId === b.draftId && a.draftRevision === b.draftRevision && a.projectId === b.projectId && a.cwd === b.cwd;
}

/** Durable identity/history only. No worker acquisition or inferred session identity. */
export class DraftBrowserOwnerRecords {
  constructor(private db: Database, private hostId: string, private validateNewBinding: (input: DraftBrowserOwnerInput) => void,
    private requireSchema: () => void, private now = Date.now) {}

  get(id: string): DraftBrowserOwnerRecord | undefined {
    if (!identity(id)) throw new Error("Invalid draft browser owner identity");
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM metadata WHERE key = ?").get(prefix + id);
    if (!row) return undefined;
    if (Buffer.byteLength(row.data) > 16_384) throw new Error("Draft browser owner record exceeds its limit");
    const saved = JSON.parse(row.data) as DraftBrowserOwnerRecord;
    const input = parseInput(saved);
    if (saved.version !== 1 || saved.kind !== "draft" || saved.id !== id || saved.hostId !== this.hostId
      || !Number.isSafeInteger(saved.createdAt) || saved.createdAt <= 0
      || saved.retiredAt !== undefined && (!Number.isSafeInteger(saved.retiredAt) || saved.retiredAt < saved.createdAt)) throw new Error("Invalid draft browser owner record");
    return { ...input, version: 1, kind: "draft", hostId: this.hostId, createdAt: saved.createdAt,
      ...(saved.retiredAt === undefined ? {} : { retiredAt: saved.retiredAt }) };
  }

  claim(value: DraftBrowserOwnerInput): { fresh: boolean; record: DraftBrowserOwnerRecord } {
    const input = parseInput(value);
    return this.db.transaction(() => {
      const prior = this.get(input.id);
      if (prior) {
        if (!sameInput(prior, input)) throw new Error("Draft browser owner identity already has different input");
        return { fresh: false, record: prior };
      }
      // Runs in the same immediate transaction as the first durable claim.
      this.validateNewBinding(input);
      const createdAt = this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error("Invalid draft browser owner time");
      this.requireSchema();
      const record: DraftBrowserOwnerRecord = { ...input, version: 1, kind: "draft", hostId: this.hostId, createdAt };
      this.db.query("INSERT INTO metadata(key,data) VALUES (?,?)").run(prefix + input.id, JSON.stringify(record));
      return { fresh: true, record };
    }).immediate();
  }

  retire(id: string): DraftBrowserOwnerRecord | undefined {
    return this.db.transaction(() => {
      const prior = this.get(id);
      if (!prior || prior.retiredAt !== undefined) return prior;
      const now = this.now();
      if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid draft browser owner retirement time");
      const record = { ...prior, retiredAt: Math.max(now, prior.createdAt) };
      this.db.query("UPDATE metadata SET data = ? WHERE key = ?").run(JSON.stringify(record), prefix + id);
      return record;
    }).immediate();
  }
}
