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
import { parseImageAttachments } from "../../../packages/shared/src/attachments";
import { detachedAnswerDraft, type DetachedQuestionSnapshot } from '../../../packages/shared/src/detached-questions';
import { parseNewChatExecution } from '../../../packages/shared/src/new-chat';
import { hasNewChatIntent } from './new-chat-protocol';
import { hasEnvironmentIntent } from './environment-protocol';
import { parseEnvironmentSelection } from '../../../packages/shared/src/environment-selection';
import {
  initializeLocalEnvironmentPreparations,
  LocalEnvironmentPreparations,
  type LocalEnvironmentPreparation,
  type LocalEnvironmentPreparationInput,
  type LocalEnvironmentPreparationTransition,
} from "./local-environments/preparations";
import type { LocalEnvironmentWorkerEnvironment } from "./local-environments/environment";

export type { DraftInput } from "../../../packages/shared/src/protocol";
import type { DraftInput } from "../../../packages/shared/src/protocol";

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
type EnvironmentPreparationAccessor = Pick<LocalEnvironmentPreparations, "get" | "list" | "transition" | "public">;

/** Host-owned app state. Native OMP files remain the source of transcripts. */
export class HostStore {
  readonly host: HostIdentity;
  readonly environmentPreparations: EnvironmentPreparationAccessor;
  private readonly db: Database;
  private readonly environmentPreparationStore: LocalEnvironmentPreparations;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const databasePath = join(dataDir, "state.sqlite");
    this.db = new Database(databasePath, { create: true, strict: true });
    chmodSync(databasePath, 0o600);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 5) throw new Error(`Unsupported host state schema version ${version}`);
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
        initializeLocalEnvironmentPreparations(this.db);
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
      this.environmentPreparationStore = new LocalEnvironmentPreparations(this.db, this.host.id);
      this.environmentPreparations = this.environmentPreparationStore;
      this.recoverInterruptedSessions();
      this.environmentPreparationStore.reconcileInterrupted();
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
    if ("lastConsumption" in input) throw new Error("Draft consumption receipts are owned by the host.");
    if (input.attachments !== undefined) input = { ...input, attachments: parseImageAttachments(input.attachments, this.host.id) };
    if (input.approvalMode !== undefined) approvalMode(input.approvalMode);
    if (input.execution !== undefined) input = { ...input, execution: parseNewChatExecution(input.execution, input.projectId) };
    if (Object.hasOwn(input, 'environment')) input = { ...input, environment: parseEnvironmentSelection(input.environment, input.projectId) };
    return this.db.transaction((): DraftWriteResult => {
      const currentDraft = this.getDraft(input.id);
      if (currentDraft?.environment !== undefined && input.environment === undefined) throw new Error('This draft requires the environment protocol; its selection was preserved.');
      if (currentDraft?.execution !== undefined && input.execution === undefined) throw new Error('This draft requires the new-chat execution protocol; its choices were preserved.');
      if (currentDraft?.attachments !== undefined && input.attachments === undefined) throw new Error("This draft requires the attachment command protocol; its content was preserved.");
      if (input.approvalMode !== undefined) this.requirePermissionVersion();
      if (input.attachments !== undefined) this.requireVersion(3);
      if (input.execution !== undefined) this.requireVersion(4);
      if (input.environment !== undefined) this.requireVersion(5);
      if ((currentDraft?.revision ?? 0) !== expectedRevision) {
        const conflict: DraftConflict = {
          id: crypto.randomUUID(), draftId: input.id, attempted: input, expectedRevision,
          currentDraft: currentDraft ?? null, createdAt: Date.now(),
        };
        this.db.query("INSERT INTO draft_conflicts (id, draft_id, data) VALUES (?, ?, ?)")
          .run(conflict.id, input.id, JSON.stringify(conflict));
        return { ok: false, currentDraft, conflict };
      }
      const draft: Draft = { ...input, ...(currentDraft?.lastConsumption ? { lastConsumption: currentDraft.lastConsumption } : {}), revision: expectedRevision + 1, updatedAt: Date.now() };
      this.db.query("INSERT INTO drafts (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
        .run(draft.id, JSON.stringify(draft));
      return { ok: true, draft };
    }).immediate();
  }

  /** Clear only the submitted revision; a newer edit belongs to the next send. */
  consumeDraft(submitted: { id: string; revision: number }, commandId?: string): Draft | undefined {
    if (!Number.isSafeInteger(submitted.revision) || submitted.revision < 0) throw new Error("Invalid submitted draft revision");
    return this.db.transaction(() => {
      const current = this.getDraft(submitted.id);
      if (!current || current.revision !== submitted.revision) return undefined;
      const needsReceipt = current.attachments !== undefined || current.execution !== undefined || current.environment !== undefined;
      if (needsReceipt && !commandId) throw new Error("Draft consumption requires its accepted command identity.");
      const cleared: Draft = { ...current, text: "", revision: current.revision + 1, updatedAt: Date.now(),
        ...(current.attachments !== undefined ? { attachments: [] } : {}),
        ...(needsReceipt ? { lastConsumption: { commandId: commandId!, submittedRevision: submitted.revision } } : {}) };
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
    const attachments = command?.type === "draft.put" ? command.draft.attachments
      : command?.type === "session.prompt" || command?.type === "session.steer" ? command.attachments : undefined;
    if (attachments !== undefined) parseImageAttachments(attachments, this.host.id);
    return this.db.transaction((): CommandClaim => {
      const existing = this.getCommand(id);
      if (existing) return { kind: existing.requestHash === requestHash ? existing.state : "conflict", record: existing };
      if (command && hasApprovalIntent(command)) this.requirePermissionVersion();
      if (attachments !== undefined) this.requireVersion(3);
      if (command && hasNewChatIntent(command)) this.requireVersion(4);
      if (command && hasEnvironmentIntent(command)) this.requireVersion(5);
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
      const command = record.command;
      if (result.ok && result.admission && (command?.type === "session.prompt" || command?.type === "session.steer") && command.draft) {
        this.consumeDraft(command.draft, id);
      }
      if (result.ok && command?.type === 'session.question.answer' && result.value && 'type' in result.value
        && result.value.type === 'session.question.answer' && result.value.receipt.questionId === command.questionId) {
        this.consumeDraft(command.draft, id);
      }
      const finished: CommandRecord = { ...record, state: "done", result, updatedAt: Date.now() };
      this.db.query("UPDATE commands SET data = ? WHERE id = ?").run(JSON.stringify(finished), id);
      return finished;
    }).immediate();
  }

  /** First preparation use upgrades the database together with the captured record. */
  createEnvironmentPreparation(input: LocalEnvironmentPreparationInput): LocalEnvironmentPreparation {
    return this.db.transaction(() => {
      const project = this.getProject(input.projectId);
      if (!project || project.hostId !== this.host.id) throw new Error("Unknown local-environment project");
      if (project.path !== input.sourceRoot) throw new Error("Local-environment source root differs from its project");
      this.requireVersion(5);
      return this.environmentPreparationStore.create(input);
    }).immediate();
  }

  /** Commit a command receipt and its exact preparation phase as one SQLite change. */
  finishCommandWithEnvironmentTransition(
    id: string,
    requestHash: string,
    result: CommandResult,
    preparation: { id: string; expectedRevision: number; transition: LocalEnvironmentPreparationTransition },
  ): { command: CommandRecord; preparation: LocalEnvironmentPreparation } {
    return this.db.transaction(() => {
      const prior = this.getCommand(id);
      if (prior?.state === "done") {
        const command = this.finishCommand(id, requestHash, result);
        const current = this.environmentPreparationStore.get(preparation.id);
        if (!current) throw new Error("Cannot finish a command for an unknown local-environment preparation");
        return { command, preparation: current };
      }
      const transitioned = this.environmentPreparations.transition(preparation.id, preparation.expectedRevision, preparation.transition);
      const command = this.finishCommand(id, requestHash, result);
      return { command, preparation: transitioned };
    }).immediate();
  }

  /** Resolve host-private setup state for one admitted native session. */
  getSessionEnvironment(sessionId: string): LocalEnvironmentWorkerEnvironment | undefined {
    const preparation = this.environmentPreparations.list().find(record => record.sessionId === sessionId && record.phase !== "removed");
    if (!preparation?.environment) return undefined;
    return {
      environmentDelta: structuredClone(preparation.environmentDelta ?? null),
      sourceRoot: preparation.sourceRoot,
      worktreeRoot: preparation.worktreePath,
    };
  }

  /** Bind native identity, setup exports and the successful receipt in one durable commit. */
  finishEnvironmentSessionCreation(
    commandId: string, requestHash: string, session: SessionSummary,
    preparation: { id: string; expectedRevision: number },
  ): CommandResult {
    return this.db.transaction(() => {
      const prior = this.getCommand(commandId);
      if (!prior || prior.requestHash !== requestHash) throw new Error("Environment creation command identity does not match.");
      if (prior.state === 'done') return prior.result!;
      const record = this.environmentPreparations.get(preparation.id);
      if (!record || record.revision !== preparation.expectedRevision || record.phase !== 'native-creating'
        || record.projectId !== session.projectId || record.hostId !== session.hostId || record.worktreePath !== session.cwd)
        throw new Error("Native session differs from its captured environment preparation.");
      const value = this.upsertSession(session);
      const result: CommandResult = { ok: true, commandId, value };
      this.finishCommandWithEnvironmentTransition(commandId, requestHash, result, { ...preparation, transition: { type: 'native-create.succeeded', sessionId: session.id } });
      return result;
    }).immediate();
  }

  get lastEventSequence(): number {
    return this.db.query<{ sequence: number }, []>("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events").get()!.sequence;
  }

  /** Reconcile only a matching durable native acceptance after a lost host
   * receipt. Neither a new command nor delivery replay is performed. */
  reconcileQuestionAcceptance(sessionId: string, question: DetachedQuestionSnapshot): boolean {
    if (question.status !== 'accepted' || !question.acceptance) return false;
    return this.db.transaction(() => {
      const accepted = question.acceptance!, prior = this.getCommand(accepted.commandId), command = prior?.command;
      if (!prior || command?.type !== 'session.question.answer' || command.sessionId !== sessionId || command.questionId !== question.questionId || command.questionEntryId !== question.questionEntryId
        || detachedAnswerDraft(command.answers) !== detachedAnswerDraft(accepted.answers)) return false;
      if (prior.state === 'done' && (prior.result?.ok || prior.result?.error.code !== 'OUTCOME_UNKNOWN')) return false;
      const result: CommandResult = { ok: true, commandId: prior.id, value: { type: 'session.question.answer', receipt: {
        questionId: question.questionId, acceptanceEntryId: accepted.acceptanceEntryId, delivery: 'waiting',
      } } };
      this.consumeDraft(command.draft, prior.id);
      this.db.query('UPDATE commands SET data = ? WHERE id = ?').run(JSON.stringify({ ...prior, state: 'done', result, updatedAt: Date.now() }), prior.id);
      return true;
    }).immediate();
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
  private requirePermissionVersion(): void { this.requireVersion(2); }
  private requireVersion(minimum: 2 | 3 | 4 | 5): void {
    const current = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (current > 5) throw new Error(`Unsupported host state schema version ${current}`);
    if (current < minimum) this.db.exec(`PRAGMA user_version = ${minimum}`);
  }
}
