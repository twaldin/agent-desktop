import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { parseAutomation, parseAutomationRun, type Automation, type AutomationInput, type AutomationMutation,
  type AutomationRun, type AutomationsQuery, type AutomationsSnapshot } from "../../../packages/shared/src/automations";

const TASK_LIMIT = 1000;
const TASK_BYTES = 4 * 1024 * 1024;
const RUN_PAGE_LIMIT = 100;
const RUN_PAGE_BYTES = 4 * 1024 * 1024;
const ERROR_LIMIT = 4096;

type JsonRow = { data: string };
type MutationOf<T extends AutomationMutation["type"]> = AutomationMutation & { type: T };
type RequestState = { version: 1; hostId: string; requestId: string; requestHash: string; state: "pending" | "done";
  task: Automation | null; run: AutomationRun | null; createdAt: number; updatedAt: number };

export class AutomationConflictError extends Error {}
export class AutomationRequestConflictError extends Error {}

export function initializeAutomationRecords(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS automation_runs_history ON automation_runs(automation_id, created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS automation_requests (request_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
}

const requestHash = (value: AutomationMutation) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const boundedError = (value: unknown) => (value instanceof Error ? value.message : String(value)).slice(0, ERROR_LIMIT) || "Automation failed.";
const cursor = (run: AutomationRun) => Buffer.from(JSON.stringify([run.createdAt, run.id])).toString("base64url");
function decodeCursor(value: string): readonly [number, string] {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] < 0
      || typeof parsed[1] !== "string" || !parsed[1] || parsed[1].length > 256) throw new Error();
    return [parsed[0], parsed[1]];
  } catch { throw new Error("Invalid automation history cursor."); }
}

/** Durable task, run and mutation records. All methods return parsed copies;
 * native execution and recurrence policy remain in AutomationService. */
export class AutomationRecords {
  constructor(private readonly db: Database, readonly hostId: string, private readonly requireSchema: () => void,
    private readonly now = Date.now) {}

  private task(id: string): Automation | undefined {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM automations WHERE id = ?").get(id);
    return row ? parseAutomation(JSON.parse(row.data), this.hostId) : undefined;
  }
  get(id: string): Automation | undefined { const value = this.task(id); return value && structuredClone(value); }
  list(): Automation[] {
    return this.db.query<JsonRow, []>("SELECT data FROM automations ORDER BY id").all().map(row => parseAutomation(JSON.parse(row.data), this.hostId));
  }
  getRun(id: string): AutomationRun | undefined {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM automation_runs WHERE id = ?").get(id);
    return row ? structuredClone(parseAutomationRun(JSON.parse(row.data), this.hostId)) : undefined;
  }

  jitterSalt(): string {
    return this.db.transaction(() => {
      const row = this.db.query<JsonRow, [string]>("SELECT data FROM metadata WHERE key = ?").get("automation-jitter.v1");
      if (row) {
        const value = JSON.parse(row.data) as unknown;
        if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) throw new Error("Invalid automation jitter identity.");
        return value;
      }
      this.requireSchema(); const value = randomUUID();
      this.db.query("INSERT INTO metadata(key,data) VALUES (?,?)").run("automation-jitter.v1", JSON.stringify(value));
      return value;
    }).immediate();
  }

  claim(mutation: AutomationMutation): RequestState {
    const hash = requestHash(mutation);
    return this.db.transaction(() => {
      const row = this.db.query<JsonRow, [string]>("SELECT data FROM automation_requests WHERE request_id = ?").get(mutation.requestId);
      if (row) {
        const value = this.parseRequest(JSON.parse(row.data), mutation.requestId);
        if (value.requestHash !== hash) throw new AutomationRequestConflictError("The automation request ID was already used with different input.");
        return value;
      }
      this.requireSchema(); const time = this.now();
      const value: RequestState = { version: 1, hostId: this.hostId, requestId: mutation.requestId, requestHash: hash,
        state: "pending", task: null, run: null, createdAt: time, updatedAt: time };
      this.writeRequest(value); return value;
    }).immediate();
  }

  private parseRequest(value: unknown, id: string): RequestState {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid automation request record.");
    const item = value as RequestState;
    if (item.version !== 1 || item.hostId !== this.hostId || item.requestId !== id || !/^[a-f0-9]{64}$/.test(item.requestHash)
      || (item.state !== "pending" && item.state !== "done") || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.updatedAt))
      throw new Error("Invalid automation request record.");
    const task = item.task === null ? null : parseAutomation(item.task, this.hostId);
    const run = item.run === null ? null : parseAutomationRun(item.run, this.hostId);
    if (item.state === "pending" && (task || run)) throw new Error("Pending automation request has a result.");
    return { ...item, task, run };
  }
  private writeRequest(value: RequestState): void {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 256 * 1024) throw new Error("Automation request receipt exceeds its limit.");
    this.db.query("INSERT INTO automation_requests(request_id,data) VALUES (?,?) ON CONFLICT(request_id) DO UPDATE SET data=excluded.data")
      .run(value.requestId, data);
  }
  private finishRequest(requestId: string, hash: string, task: Automation | null, run: AutomationRun | null): RequestState {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM automation_requests WHERE request_id = ?").get(requestId);
    if (!row) throw new Error("Automation request lost its durable claim.");
    const prior = this.parseRequest(JSON.parse(row.data), requestId);
    if (prior.requestHash !== hash) throw new AutomationRequestConflictError("The automation request changed before completion.");
    if (prior.state === "done") return prior;
    const result: RequestState = { ...prior, state: "done", task, run, updatedAt: this.now() };
    this.writeRequest(result); return result;
  }

  save(mutation: Extract<AutomationMutation, { type: "save" }>, input: AutomationInput & { destination: Automation["destination"] }, nextRunAt: number | null): RequestState {
    const hash = requestHash(mutation);
    return this.db.transaction(() => {
      const current = this.task(mutation.id);
      if (mutation.expectedRevision === 0 ? current !== undefined : !current || current.revision !== mutation.expectedRevision || current.status === "deleted")
        throw new AutomationConflictError("The automation changed. Reload it before saving.");
      const time = this.now(), task: Automation = { ...input, id: mutation.id, hostId: this.hostId,
        revision: (current?.revision ?? 0) + 1, status: input.status, createdAt: current?.createdAt ?? time, updatedAt: time,
        nextRunAt: input.status === "active" ? nextRunAt : null, lastRunAt: current?.lastRunAt ?? null };
      const visible = this.list().filter(item => item.status !== "deleted" && item.id !== task.id).concat(task);
      if (visible.length > TASK_LIMIT || visible.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0) > TASK_BYTES)
        throw new Error("Automation storage is full. Delete an existing task or shorten its prompt before saving.");
      this.db.query("INSERT INTO automations(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(task.id, JSON.stringify(task));
      return this.finishRequest(mutation.requestId, hash, task, null);
    }).immediate();
  }

  delete(mutation: MutationOf<"delete">): RequestState {
    const hash = requestHash(mutation);
    return this.db.transaction(() => {
      const current = this.task(mutation.id);
      if (!current || current.revision !== mutation.expectedRevision || current.status === "deleted") throw new AutomationConflictError("The automation changed. Reload it before deleting.");
      const task: Automation = { ...current, status: "deleted", revision: current.revision + 1, nextRunAt: null, updatedAt: this.now() };
      this.db.query("UPDATE automations SET data = ? WHERE id = ?").run(JSON.stringify(task), task.id);
      return this.finishRequest(mutation.requestId, hash, task, null);
    }).immediate();
  }

  reserveManual(mutation: MutationOf<"run">, nextRunAt: number | null): RequestState {
    const hash = requestHash(mutation);
    return this.db.transaction(() => {
      const task = this.task(mutation.id);
      if (!task || task.revision !== mutation.expectedRevision || task.status === "deleted") throw new AutomationConflictError("The automation changed. Reload it before running.");
      const time = this.now(), run = this.newRun(task, time, "manual");
      this.writeRun(run); const updated = { ...task, lastRunAt: time, nextRunAt: task.status === "active" ? nextRunAt : null, updatedAt: time };
      this.db.query("UPDATE automations SET data = ? WHERE id = ?").run(JSON.stringify(updated), task.id);
      return this.finishRequest(mutation.requestId, hash, updated, run);
    }).immediate();
  }

  reserveDue(now: number, maximum: number, next: (task: Automation, now: number) => number | null): AutomationRun[] {
    return this.db.transaction(() => {
      const active = new Set(this.db.query<JsonRow, []>("SELECT data FROM automation_runs").all()
        .map(row => parseAutomationRun(JSON.parse(row.data), this.hostId))
        .filter(run => run.status === "reserved" || run.status === "running").map(run => run.automationId));
      const due = this.list().filter(task => !active.has(task.id) && task.status === "active" && task.nextRunAt !== null && task.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt! - b.nextRunAt! || a.id.localeCompare(b.id)).slice(0, maximum);
      const runs: AutomationRun[] = [];
      for (const task of due) {
        const scheduledFor = task.nextRunAt!, run = this.newRun(task, scheduledFor, "schedule"); this.writeRun(run); runs.push(run);
        const updated: Automation = { ...task, lastRunAt: scheduledFor, nextRunAt: next(task, now), updatedAt: now };
        this.db.query("UPDATE automations SET data = ? WHERE id = ?").run(JSON.stringify(updated), task.id);
      }
      return runs;
    }).immediate();
  }

  private newRun(task: Automation, scheduledFor: number, trigger: AutomationRun["trigger"]): AutomationRun {
    const id = randomUUID(), time = this.now();
    return { id, hostId: this.hostId, automationId: task.id, automationRevision: task.revision, automationName: task.name,
      prompt: task.prompt, destination: task.destination, notificationPolicy: task.notificationPolicy, scheduledFor, trigger,
      status: "reserved", createdAt: time, updatedAt: time, completedAt: null, sessionId: task.destination.kind === "heartbeat" ? task.destination.sessionId : null,
      createCommandId: `automation:${id}:create`, promptCommandId: `automation:${id}:prompt`, error: null, readAt: null, archivedAt: null };
  }
  private writeRun(run: AutomationRun): void {
    this.db.query("INSERT INTO automation_runs(id,automation_id,created_at,archived_at,data) VALUES (?,?,?,?,?)")
      .run(run.id, run.automationId, run.createdAt, null, JSON.stringify(run));
  }

  advanceRun(id: string, status: AutomationRun["status"], update: { sessionId?: string | null; error?: unknown } = {}): AutomationRun {
    return this.db.transaction(() => {
      const current = this.getRun(id); if (!current) throw new Error("Automation run is missing.");
      if (["completed", "failed", "unknown", "skipped"].includes(current.status)) return current;
      const terminal = ["completed", "failed", "unknown", "skipped"].includes(status), time = this.now();
      const run: AutomationRun = { ...current, status, updatedAt: time, completedAt: terminal ? time : null,
        ...(update.sessionId === undefined ? {} : { sessionId: update.sessionId }), ...(update.error === undefined ? {} : { error: boundedError(update.error) }) };
      this.db.query("UPDATE automation_runs SET data = ? WHERE id = ?").run(JSON.stringify(run), id); return run;
    }).immediate();
  }

  history(mutation: Extract<AutomationMutation, { type: "history" }>): RequestState {
    const hash = requestHash(mutation);
    return this.db.transaction(() => {
      const current = this.getRun(mutation.runId); if (!current) throw new Error("Automation run does not exist.");
      const time = this.now(), run: AutomationRun = { ...current, readAt: mutation.read ? current.readAt ?? time : null,
        archivedAt: mutation.archived ? current.archivedAt ?? time : null, updatedAt: time };
      this.db.query("UPDATE automation_runs SET archived_at = ?, data = ? WHERE id = ?").run(run.archivedAt, JSON.stringify(run), run.id);
      return this.finishRequest(mutation.requestId, hash, this.task(run.automationId) ?? null, run);
    }).immediate();
  }

  reconcileInterrupted(): number {
    return this.db.transaction(() => {
      let changed = 0;
      for (const row of this.db.query<JsonRow, []>("SELECT data FROM automation_runs").all()) {
        const run = parseAutomationRun(JSON.parse(row.data), this.hostId);
        if (run.status !== "reserved" && run.status !== "running") continue;
        const time = this.now(), next: AutomationRun = { ...run, status: "unknown", updatedAt: time, completedAt: time,
          error: "The host restarted before this automation run returned a durable result. Inspect its conversation before running it again." };
        this.db.query("UPDATE automation_runs SET data = ? WHERE id = ?").run(JSON.stringify(next), run.id); changed++;
      }
      return changed;
    }).immediate();
  }

  snapshot(query: AutomationsQuery = {}): AutomationsSnapshot {
    const tasks = this.list().filter(task => task.status !== "deleted").sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const before = query.before ? decodeCursor(query.before) : undefined;
    const clauses = ["1 = 1"], values: Array<string | number> = [];
    if (query.automationId !== undefined) { clauses.push("automation_id = ?"); values.push(query.automationId); }
    if (before) { clauses.push("(created_at < ? OR (created_at = ? AND id < ?))"); values.push(before[0], before[0], before[1]); }
    const all = this.db.query<JsonRow, Array<string | number>>(`SELECT data FROM automation_runs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 101`)
      .all(...values).map(row => parseAutomationRun(JSON.parse(row.data), this.hostId));
    const runs: AutomationRun[] = []; let bytes = 0, consumed = 0;
    for (const run of all) {
      const size = Buffer.byteLength(JSON.stringify(run));
      if (runs.length && (runs.length >= RUN_PAGE_LIMIT || bytes + size > RUN_PAGE_BYTES)) break;
      runs.push(run); bytes += size; consumed++;
    }
    return { hostId: this.hostId, tasks: structuredClone(tasks), runs: structuredClone(runs),
      nextRunCursor: consumed < all.length && runs.length ? cursor(runs.at(-1)!) : null };
  }
}
