import { parseNativeBtwSnapshot, type NativeBtwSnapshot, type NativeBtwStart } from "@agent-desktop/shared";

type Stored = NativeBtwSnapshot | null;
type Session = { id: string; archived: boolean; status: string };
type Handle = { workerFailure?: unknown; getBtw(): Promise<Stored>; startBtw(input: NativeBtwStart): Promise<NativeBtwSnapshot>; cancelBtw(runId: string): Promise<Stored> };
const unknown = (message: string) => Object.assign(new Error(message), { code: "OUTCOME_UNKNOWN" as const });

/** Last observation is durable; native execution remains ephemeral and is never
 * recreated by GET or a recovered pending command. All updates share one lane. */
export class BtwService {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly options: { session(id: string): Session | undefined; read(id: string): Stored; write(id: string, value: Stored): void; getHandle(id: string): Promise<Handle>; getExistingHandle(id: string): Promise<Handle | undefined> }) {}
  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; }); this.locks.set(id, current); await previous.catch(() => {});
    try { return await operation(); } finally { release(); if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  private session(id: string, writable = false) {
    const session = this.options.session(id);
    if (!session || session.id !== id) throw new Error("The selected conversation does not exist on this host.");
    if (writable && session.archived) throw new Error("Archived conversations cannot start a side question.");
    return session;
  }
  private save(id: string, value: Stored) {
    if (value && value.sessionId !== id) throw new Error("The native side question belongs to another session.");
    const parsed = value && parseNativeBtwSnapshot(value);
    if (JSON.stringify(this.options.read(id)) !== JSON.stringify(parsed)) this.options.write(id, parsed);
    return parsed;
  }
  private lost(id: string, stored: Stored) {
    return stored?.status === "running" ? this.save(id, { ...stored, status: "failed", error: "The native side-question worker was lost. Its outcome is unknown and it will not be replayed.", updatedAt: Math.max(Date.now(), stored.updatedAt) }) : stored;
  }
  async snapshot(id: string): Promise<Stored> { return this.locked(id, async () => {
    this.session(id);
    const stored = this.options.read(id), handle = await this.options.getExistingHandle(id);
    if (!handle || handle.workerFailure) return this.lost(id, stored);
    let live: Stored;
    try { live = await handle.getBtw(); }
    catch (error) { if (handle.workerFailure || await this.options.getExistingHandle(id) !== handle) return this.lost(id, stored); throw error; }
    this.session(id);
    if (await this.options.getExistingHandle(id) !== handle || handle.workerFailure) return this.lost(id, stored);
    if (!live || stored && live.runId !== stored.runId) return this.lost(id, stored);
    return this.save(id, live);
  }); }
  async start(id: string, input: NativeBtwStart): Promise<NativeBtwSnapshot> { return this.locked(id, async () => {
    this.session(id, true);
    if (typeof input.runId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.runId) || typeof input.question !== "string" || !input.question.trim() || Buffer.byteLength(input.question) > 32 * 1024) throw new Error("The side question is invalid or exceeds 32 KiB.");
    const runId = input.runId, question = input.question.trim(), previous = this.options.read(id);
    if (previous?.runId === runId) {
      if (previous.question !== question) throw new Error("This side-question identity belongs to different input.");
      return previous;
    }
    const handle = await this.options.getHandle(id);
    this.session(id, true);
    if (handle.workerFailure || await this.options.getExistingHandle(id) !== handle) throw new Error("The native side-question worker changed before admission.");
    const now = Date.now(), intent: NativeBtwSnapshot = { runId, sessionId: id, question, status: "running", answer: "", startedAt: now, updatedAt: now };
    this.save(id, intent); // Failure here cannot have dispatched a side request.
    try {
      const result = await handle.startBtw({ runId, question });
      if (result.sessionId !== id || result.runId !== runId || await this.options.getExistingHandle(id) !== handle || handle.workerFailure) throw new Error("The native side-question owner changed during admission.");
      this.session(id);
      return this.save(id, result)!;
    } catch {
      // Keep the intent even if recording this qualification fails. GET can still
      // inspect the exact native run; the durable command ID cannot be replayed.
      try { this.save(id, { ...intent, status: "failed", error: "Native side-question admission is unconfirmed. Refresh to inspect the original run; it will not be replayed.", updatedAt: Date.now() }); } catch { /* Original intent is already durable. */ }
      throw unknown("Native side-question admission is unconfirmed. Refresh to inspect the original run.");
    }
  }); }
  async cancel(id: string, runId: string): Promise<Stored> { return this.locked(id, async () => {
    this.session(id);
    if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(runId)) throw new Error("The side-question identity is invalid.");
    const prior = this.options.read(id);
    if (!prior || prior.runId !== runId) throw new Error("The selected side question is no longer current.");
    const handle = await this.options.getExistingHandle(id);
    if (!handle || handle.workerFailure) throw unknown("The original side-question worker is unavailable. No replacement worker was opened.");
    try {
      const result = await handle.cancelBtw(runId);
      if (!result || result.runId !== runId || await this.options.getExistingHandle(id) !== handle || handle.workerFailure) throw new Error("The original side question is unavailable.");
      return this.save(id, result);
    } catch { throw unknown("Side-question cancellation is unconfirmed. Refresh to inspect the original run."); }
  }); }
}
