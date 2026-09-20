import { ResetAccountAdmissions } from "./session-reset-admission";
import { randomUUID } from "node:crypto";
import type { HostStore } from "./store";
import type { WorkerSession } from "./omp-workers/runtime";
import type { NativeUsagePreparation } from "./omp/session-usage";
import type { SessionUsageResponse, UsageRefresh, UsageResetAnswer, UsageResetPrepare, UsageResetReceipt } from "../../../packages/shared/src/session-usage";

interface Intent {
  receipt: UsageResetReceipt; answerId?: string; generation?: string; native: NativeUsagePreparation; requestId: string;
  source: { id: string; file: string; cwd: string };
}
const intentKey = (id: string) => `usage-reset.v1:${id}`;
const latestKey = (id: string) => `usage-reset-latest.v1:${id}`;
const uncertain = (receipt: UsageResetReceipt) => receipt.state === "dispatching" || receipt.state === "unknown";

/** Durable one-call manual transactions. Worker tickets are never restored or recreated. */
export class SessionUsageService {
  readonly admissions: ResetAccountAdmissions;
  #owners = new Map<string, WorkerSession>();
  #active = new Set<string>();
  #snapshots = new Map<string, SessionUsageResponse["snapshot"]>();
  #reads = new Map<string, Promise<SessionUsageResponse>>();
  constructor(private options: {
    store: HostStore;
    admissions?: ResetAccountAdmissions;
    existing(id: string): Promise<WorkerSession | undefined>;
    open(id: string): Promise<WorkerSession>;
    ordered<T>(id: string, run: () => Promise<T>): Promise<T>;
    assertActive(): void;
    commandActive?(id: string): boolean;
  }) {
    options.admissions?.assertStore(options.store);
    this.admissions = options.admissions ?? new ResetAccountAdmissions(options.store);
  }
  #load(id: string) { return this.options.store.readMetadata<Intent>(intentKey(id)); }
  #save(intent: Intent) { this.options.store.writeMetadata(intentKey(intent.receipt.operationId), intent); }
  #latest(sessionId: string) {
    const id = this.options.store.readMetadata<string>(latestKey(sessionId)); return id ? this.#load(id) : undefined;
  }
  #receipt(intent: Intent): UsageResetReceipt {
    const receipt = structuredClone(intent.receipt);
    if (receipt.state === "prepared" && this.admissions.inspect(intent.native.accountKey)?.operationId === receipt.operationId) receipt.state = "unknown";
    if (receipt.state === "settled" && intent.answerId) {
      const command = this.options.store.getCommand(intent.answerId);
      if (command?.state !== "done" || !command.result?.ok) { receipt.state = "unknown"; delete receipt.outcome; }
    }
    if (receipt.state === "dispatching" && !this.#active.has(receipt.operationId)) receipt.state = "unknown";
    return receipt;
  }
  async read(sessionId: string, mode: UsageRefresh, commandId?: string): Promise<SessionUsageResponse> {
    const key = `${sessionId}:${mode}:${commandId ?? ""}`, current = this.#reads.get(key); if (current) return current;
    if (this.#reads.size >= 16) throw new Error("Too many provider usage requests.");
    const run = async (): Promise<SessionUsageResponse> => {
      this.options.assertActive();
      const owner = mode === "cached" ? undefined : await this.options.open(sessionId);
      let snapshot = owner ? await owner.readUsage(mode) : this.#snapshots.get(sessionId) ?? null;
      this.options.assertActive();
      if (owner && (await this.options.existing(sessionId) !== owner || owner.id !== sessionId || owner.workerFailure)) {
        if (mode !== "cached") throw new Error("Original provider usage worker changed.");
        snapshot = null;
      }
      if (mode !== "cached") { if (this.#snapshots.size >= 256) this.#snapshots.delete(this.#snapshots.keys().next().value!); this.#snapshots.set(sessionId, snapshot); }
      let latest = this.#latest(sessionId);
      let command: SessionUsageResponse["command"];
      if (commandId) {
        const entry = this.options.store.getCommand(commandId), request = entry?.command;
        if (!entry) command = { id: commandId, state: "absent" };
        else if (!request || !(request.type === "session.usage.reset.prepare" || request.type === "session.usage.reset.respond") || request.sessionId !== sessionId) command = { id: commandId, state: "unknown" };
        else {
          latest = this.#load(request.type === "session.usage.reset.prepare" ? commandId : request.operationId);
          command = { id: commandId, state: entry.state === "done" ? entry.result?.ok || entry.result?.error.code !== "OUTCOME_UNKNOWN" ? "done" : "unknown" : this.options.commandActive?.(commandId) ? "pending" : "unknown", ...(entry.result && !entry.result.ok ? { failed: true } : {}) };
        }
      }
      return { ...(command ? { command } : {}), version: 1, hostId: this.options.store.host.id, sessionId, snapshot, reset: latest ? this.#receipt(latest) : null };
    };
    // Cached/status viewing never opens a worker or waits behind an in-flight consume.
    const pending = mode === "cached" ? run() : this.options.ordered(sessionId, run);
    this.#reads.set(key, pending);
    try { return await pending; } finally { if (this.#reads.get(key) === pending) this.#reads.delete(key); }
  }
  async prepare(operationId: string, request: UsageResetPrepare): Promise<UsageResetReceipt> {
    const previous = this.#latest(request.sessionId);
    if (previous && (uncertain(this.#receipt(previous)) || previous.receipt.state === "prepared" && previous.receipt.confirmation.expiresAt > Date.now()))
      throw new Error("Inspect or cancel the original saved-reset confirmation before preparing another.");
    for (const [id] of this.#owners) { const intent = this.#load(id); if (!intent || intent.receipt.state !== "prepared" || intent.receipt.confirmation.expiresAt < Date.now()) this.#owners.delete(id); }
    if (this.#owners.size >= 64) throw new Error("Too many pending saved-reset confirmations.");
    const admissionRevision = this.admissions.revision();
    const owner = await this.options.existing(request.sessionId);
    if (!owner || owner.workerFailure) throw new Error("Refresh the original session's saved credits first.");
    const source = { id: owner.id, file: owner.sessionFile, cwd: owner.cwd };
    const native = await owner.prepareUsageReset(request);
    this.options.assertActive();
    if (await this.options.existing(request.sessionId) !== owner || owner.id !== source.id || owner.sessionFile !== source.file || owner.cwd !== source.cwd || owner.workerFailure || native.epoch !== request.epoch)
      throw new Error("Original saved-reset worker changed during preparation.");
    this.admissions.assertRevision(admissionRevision);
    const blocked = this.admissions.inspect(native.accountKey);
    if (blocked && blocked.state !== "settled")
      throw new Error("This account has an unresolved reset outcome. Inspect the original receipt; a replacement credit cannot be selected.");
    const receipt: UsageResetReceipt = { operationId, hostId: this.options.store.host.id, sessionId: request.sessionId,
      createdAt: Date.now(), state: "prepared", confirmation: native.confirmation };
    const intent: Intent = { receipt, native, source, requestId: randomUUID(), generation: blocked?.generation };
    this.#save(intent); this.options.store.writeMetadata(latestKey(request.sessionId), operationId); this.#owners.set(operationId, owner);
    return structuredClone(receipt);
  }
  async answer(commandId: string, request: UsageResetAnswer): Promise<UsageResetReceipt> {
    const intent = this.#load(request.operationId);
    if (!intent || intent.receipt.sessionId !== request.sessionId) throw new Error("Unknown reset confirmation for this session.");
    if (this.#receipt(intent).state !== "prepared") return this.#receipt(intent);
    if (!request.confirm) { intent.receipt.state = "cancelled"; this.#save(intent); this.#owners.delete(request.operationId); return this.#receipt(intent); }
    const reject = () => { intent.receipt.state = "rejected"; intent.receipt.outcome = "admission_rejected"; this.#save(intent); return this.#receipt(intent); };
    const owner = this.#owners.get(request.operationId);
    if (!owner || intent.receipt.confirmation.expiresAt <= Date.now()) return reject();
    // The account guard is durable BEFORE the dispatch marker. A crash between
    // these writes conservatively blocks another credit, even if none was sent.
    try { this.admissions.admit({ key: intent.native.accountKey, expectedGeneration: intent.generation, operationId: request.operationId, commandId }); }
    catch { return reject(); }
    intent.answerId = commandId; intent.receipt.dispatchedAt = Date.now(); intent.receipt.state = "dispatching"; this.#save(intent); this.#active.add(request.operationId);
    try {
      this.options.assertActive();
      if (await this.options.existing(request.sessionId) !== owner || owner.workerFailure || owner.id !== intent.source.id || owner.sessionFile !== intent.source.file || owner.cwd !== intent.source.cwd) {
        const result = reject(); this.admissions.settle(intent.native.accountKey, request.operationId, "settled"); return result;
      }
      // Native validates its private ticket and synchronous final admission.
      const result = await owner.redeemUsageReset(intent.native.ticket, intent.requestId);
      intent.receipt.state = result.state; intent.receipt.outcome = result.outcome;
      this.#save(intent);
      this.admissions.settle(intent.native.accountKey, request.operationId, result.state === "unknown" ? "unknown" : "settled");
      return structuredClone(intent.receipt);
    } catch {
      intent.receipt.state = "unknown"; delete intent.receipt.outcome;
      // If settlement fails, the original persisted dispatch marker still means unknown.
      try { this.admissions.settle(intent.native.accountKey, request.operationId, "unknown"); this.#save(intent); } catch { /* Retain the prior durable state. */ }
      return this.#receipt(intent);
    } finally { this.#active.delete(request.operationId); this.#owners.delete(request.operationId); }
  }
}
