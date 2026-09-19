import { randomUUID } from "node:crypto";
import type { HostStore } from "./store";

export interface ResetAccountAdmission {
  generation: string; operationId: string; state: "dispatching" | "settled" | "unknown";
  /** Manual transactions settle through the existing command journal. */
  commandId?: string;
}
const GLOBAL = "reset-admission.v1:revision";
const keyFor = (key: string) => { if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid native reset account key."); return `reset-admission.v1:account:${key}`; };

/** One host-local collision authority for manual and future native policy owners.
 * It does not coordinate another host, TUI or independently running broker client. */
export class ResetAccountAdmissions {
  constructor(private store: HostStore) {}
  revision(): string { return this.store.readMetadata<string>(GLOBAL) ?? "initial"; }
  inspect(key: string): ResetAccountAdmission | undefined {
    const record = this.store.readMetadata<ResetAccountAdmission>(keyFor(key));
    if (!record) return;
    if (record.state === "settled" && record.commandId) {
      const command = this.store.getCommand(record.commandId);
      if (command?.state !== "done" || !command.result?.ok) return { ...record, state: "unknown" };
    }
    return record;
  }
  /** Capture revision before asynchronous preparation, then assert it afterward. */
  assertRevision(revision: string): void { if (revision !== this.revision()) throw new Error("A native reset was admitted during preparation. Prepare fresh evidence."); }
  admit(input: { key: string; expectedGeneration?: string; operationId: string; commandId?: string }): ResetAccountAdmission {
    const existing = this.inspect(input.key);
    if (existing?.generation !== input.expectedGeneration || existing && existing.state !== "settled") throw new Error("The account has changed or has an unresolved reset admission.");
    const record: ResetAccountAdmission = { generation: randomUUID(), operationId: input.operationId, state: "dispatching", ...(input.commandId ? { commandId: input.commandId } : {}) };
    // Invalidation first: failure before the account write sends nothing and
    // only conservatively invalidates preparations for other accounts.
    this.store.writeMetadata(GLOBAL, randomUUID());
    this.store.writeMetadata(keyFor(input.key), record);
    return record;
  }
  settle(key: string, operationId: string, state: "settled" | "unknown"): void {
    const record = this.store.readMetadata<ResetAccountAdmission>(keyFor(key));
    if (!record || record.operationId !== operationId) throw new Error("Reset admission does not belong to this operation.");
    if (record.state === "unknown" && state !== "unknown") throw new Error("Unknown reset admission cannot be upgraded or replayed.");
    this.store.writeMetadata(keyFor(key), { ...record, state });
  }
}
