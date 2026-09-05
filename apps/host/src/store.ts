import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { arch, hostname, platform } from "node:os";
import { basename, join } from "node:path";
import type {
  CommandResult,
  Draft,
  HostCommand,
  HostEvent,
  HostIdentity,
  Project,
  SessionSummary,
} from "../../../packages/shared/src/protocol.ts";
import type { StoredPreferencesState } from "./preferences/store";
import { approvalMode, hasApprovalIntent, validateCommandApproval } from "./approval";

export type DraftInput = Omit<Draft, "revision" | "updatedAt">;

export interface DraftConflict {
  id: string;
  draftId: string;
  attempted: DraftInput;
  expectedRevision: number;
  currentDraft: Draft | null;
  createdAt: number;
}

export type DraftWriteResult =
  | { ok: true; draft: Draft }
  | { ok: false; currentDraft?: Draft; conflict: DraftConflict };

export interface CommandRecord {
  id: string;
  requestHash: string;
  command?: HostCommand;
  state: "pending" | "done";
  result: CommandResult | null;
  createdAt: number;
  updatedAt: number;
}

export interface CommandClaim {
  kind: "claimed" | "pending" | "done" | "conflict";
  record: CommandRecord;
}

type WithoutSequence<T> = T extends { sequence: number } ? Omit<T, "sequence"> : never;
export type EventInput = WithoutSequence<HostEvent>;
type JsonRow = { data: string };

/** Host-owned app state. Native OMP files remain the source of transcripts. */
export class HostStore {
  readonly host: HostIdentity;
  private readonly db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const databasePath = join(dataDir, "state.sqlite");
    this.db = new Database(databasePath, { create: true, strict: true });
    chmodSync(databasePath, 0o600);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 2) throw new Error(`Unsupported host state schema version ${version}`);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS draft_conflicts (id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS draft_conflicts_by_draft ON draft_conflicts(draft_id);
          CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
        `);
        if (version === 0) this.db.exec("PRAGMA user_version = 1");
      }).immediate();
      this.host = this.db.transaction(() => {
        const saved = this.db.query<JsonRow, [string]>("SELECT data FROM metadata WHERE key = ?").get("host");
        const identity: HostIdentity = {
          id: saved ? (JSON.parse(saved.data) as HostIdentity).id : crypto.randomUUID(),
          name: hostname(),
          platform: platform(),
          architecture: arch(),
        };
        this.db.query("INSERT INTO metadata (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
          .run("host", JSON.stringify(identity));
        return identity;
      }).immediate();
      this.recoverInterruptedSessions();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  readThemeFileMarker(): { currentHash?: string; pendingHash?: string } | undefined {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM metadata WHERE key = ?").get("theme-file-marker");
    return row ? JSON.parse(row.data) : undefined;
  }
  writeThemeFileMarker(marker: { currentHash?: string; pendingHash?: string }): void {
    this.db.query("INSERT INTO metadata (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
      .run("theme-file-marker", JSON.stringify(marker));
  }

  readPreferencesState(): StoredPreferencesState | undefined {
    const row = this.db.query<JsonRow, []>("SELECT data FROM metadata WHERE key = 'preferences.v1'").get();
    return row ? JSON.parse(row.data) as StoredPreferencesState : undefined;
  }

  /** The counter and every merged value commit together, including across store connections. */
  updatePreferencesState<T>(update: (current: StoredPreferencesState | undefined) => { state: StoredPreferencesState; result: T }): T {
    return this.db.transaction(() => {
      const { state, result } = update(this.readPreferencesState());
      this.db.query("INSERT INTO metadata (key, data) VALUES ('preferences.v1', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(JSON.stringify(state));
      return result;
    }).immediate();
  }

  listProjects(): Project[] {
    return this.db.query<JsonRow, []>("SELECT data FROM projects ORDER BY rowid").all()
      .map(({ data }) => JSON.parse(data) as Project);
  }

  getProject(id: string): Project | undefined {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM projects WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) as Project : undefined;
  }

  addProject(input: { path: string; name?: string }): Project {
    const path = realpathSync(input.path);
    if (!statSync(path).isDirectory()) throw new Error("Project path must be a directory");
    return this.db.transaction(() => {
      const existing = this.db.query<JsonRow, [string]>("SELECT data FROM projects WHERE path = ?").get(path);
      if (existing) return JSON.parse(existing.data) as Project;
      const project: Project = {
        id: crypto.randomUUID(), hostId: this.host.id, path,
        name: input.name?.trim() || basename(path) || path, createdAt: Date.now(),
      };
      this.db.query("INSERT INTO projects (id, path, data) VALUES (?, ?, ?)")
        .run(project.id, path, JSON.stringify(project));
      return project;
    }).immediate();
  }

  listSessions(): SessionSummary[] {
    return this.db.query<JsonRow, []>("SELECT data FROM sessions").all()
      .map(({ data }) => JSON.parse(data) as SessionSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  getSession(id: string): SessionSummary | undefined {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM sessions WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) as SessionSummary : undefined;
  }

  upsertSession(session: SessionSummary): SessionSummary {
    if (session.hostId !== this.host.id) throw new Error("Session belongs to another host");
    if (session.projectId !== null && !this.getProject(session.projectId)) throw new Error("Unknown session project");
    if (session.approvalOverride !== undefined) approvalMode(session.approvalOverride);
    return this.db.transaction(() => {
      if (session.approvalOverride !== undefined) this.requirePermissionVersion();
      this.db.query("INSERT INTO sessions (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
        .run(session.id, JSON.stringify(session));
      return session;
    }).immediate();
  }

  listDrafts(): Draft[] {
    return this.db.query<JsonRow, []>("SELECT data FROM drafts ORDER BY id").all()
      .map(({ data }) => JSON.parse(data) as Draft);
  }

  getDraft(id: string): Draft | undefined {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM drafts WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) as Draft : undefined;
  }

  putDraft(input: DraftInput, expectedRevision: number): DraftWriteResult {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid draft revision");
    if (input.approvalMode !== undefined) approvalMode(input.approvalMode);
    return this.db.transaction((): DraftWriteResult => {
      if (input.approvalMode !== undefined) this.requirePermissionVersion();
      const currentDraft = this.getDraft(input.id);
      if ((currentDraft?.revision ?? 0) !== expectedRevision) {
        const conflict: DraftConflict = {
          id: crypto.randomUUID(), draftId: input.id, attempted: input, expectedRevision,
          currentDraft: currentDraft ?? null, createdAt: Date.now(),
        };
        this.db.query("INSERT INTO draft_conflicts (id, draft_id, data) VALUES (?, ?, ?)")
          .run(conflict.id, input.id, JSON.stringify(conflict));
        return { ok: false, currentDraft, conflict };
      }
      const draft: Draft = { ...input, revision: expectedRevision + 1, updatedAt: Date.now() };
      this.db.query("INSERT INTO drafts (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
        .run(draft.id, JSON.stringify(draft));
      return { ok: true, draft };
    }).immediate();
  }

  /** Clear only the submitted revision; a newer edit belongs to the next send. */
  consumeDraft(submitted: { id: string; revision: number }): Draft | undefined {
    if (!Number.isSafeInteger(submitted.revision) || submitted.revision < 0) throw new Error("Invalid submitted draft revision");
    return this.db.transaction(() => {
      const current = this.getDraft(submitted.id);
      if (!current || current.revision !== submitted.revision) return undefined;
      const cleared: Draft = { ...current, text: "", revision: current.revision + 1, updatedAt: Date.now() };
      this.db.query("UPDATE drafts SET data = ? WHERE id = ?").run(JSON.stringify(cleared), current.id);
      return cleared;
    }).immediate();
  }

  listDraftConflicts(draftId?: string): DraftConflict[] {
    const rows = draftId === undefined
      ? this.db.query<JsonRow, []>("SELECT data FROM draft_conflicts ORDER BY rowid").all()
      : this.db.query<JsonRow, [string]>("SELECT data FROM draft_conflicts WHERE draft_id = ? ORDER BY rowid").all(draftId);
    return rows.map(({ data }) => JSON.parse(data) as DraftConflict);
  }

  getCommand(id: string): CommandRecord | undefined {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM commands WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) as CommandRecord : undefined;
  }

  /**
   * A pending claim is never reissued, including after a service restart.
   * Keep provider login secrets outside this recoverable app-command ledger.
   */
  claimCommand(id: string, requestHash: string, command?: HostCommand): CommandClaim {
    if (!id || !requestHash) throw new Error("Command ID and request hash are required");
    if (command) validateCommandApproval(command);
    return this.db.transaction((): CommandClaim => {
      const existing = this.getCommand(id);
      if (existing) return { kind: existing.requestHash === requestHash ? existing.state : "conflict", record: existing };
      if (command && hasApprovalIntent(command)) this.requirePermissionVersion();
      const now = Date.now();
      const record: CommandRecord = {
        id, requestHash, ...(command === undefined ? {} : { command }),
        state: "pending", result: null, createdAt: now, updatedAt: now,
      };
      this.db.query("INSERT INTO commands (id, data) VALUES (?, ?)").run(id, JSON.stringify(record));
      return { kind: "claimed", record };
    }).immediate();
  }

  finishCommand(id: string, requestHash: string, result: CommandResult): CommandRecord {
    return this.db.transaction(() => {
      const record = this.getCommand(id);
      if (!record) throw new Error("Cannot finish an unclaimed command");
      if (record.requestHash !== requestHash) throw new Error("Command ID was already used with a different payload");
      if (result.commandId !== id) throw new Error("Result command ID does not match its claim");
      if (record.state === "done") return record;
      const finished: CommandRecord = { ...record, state: "done", result, updatedAt: Date.now() };
      this.db.query("UPDATE commands SET data = ? WHERE id = ?").run(JSON.stringify(finished), id);
      return finished;
    }).immediate();
  }

  get lastEventSequence(): number {
    return this.db.query<{ sequence: number }, []>("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events").get()!.sequence;
  }

  appendEvent(input: EventInput): HostEvent {
    const inserted = this.db.query("INSERT INTO events (data) VALUES (?)").run(JSON.stringify(input));
    return { ...input, sequence: Number(inserted.lastInsertRowid) } as HostEvent;
  }

  eventsAfter(sequence: number, limit = 500): HostEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid event sequence");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Event limit must be between 1 and 1000");
    return this.db.query<{ sequence: number; data: string }, [number, number]>(
      "SELECT sequence, data FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?",
    ).all(sequence, limit).map(({ sequence: eventSequence, data }) => ({ ...JSON.parse(data), sequence: eventSequence } as HostEvent));
  }

  private recoverInterruptedSessions(): void {
    this.db.transaction(() => {
      for (const session of this.listSessions()) {
        if (session.status === "running") {
          this.upsertSession({
            ...session, status: "interrupted", updatedAt: Date.now(),
            error: "The host service restarted during this turn. Its outcome is unknown; inspect the session before continuing.",
          });
        }
      }
    }).immediate();
  }

  /** Never downgrade: old hosts must refuse even after an override is cleared. */
  private requirePermissionVersion(): void { this.db.exec("PRAGMA user_version = 2"); }
}
