import { TodoExternalEditorRecords } from "./todo-external-editor-records";
import { PullRequestWriteRecords } from "./pull-request-write-records";
import { parseDeviceAccessPolicy, parseDeviceAccessUpdate, DeviceAccessConflictError, type DeviceAccessPolicy } from "../../../packages/shared/src/device-access";
import { PluginAcquisitionRecords } from "./integrations/acquisition-records";
import { BrowserCloseRecords } from "./browser-close-records";
import { BrowserCreationRecords } from "./browser-creation-records";
import { DraftBrowserOwnerRecords } from "./browser-draft-owner-records";
import { DraftBrowserCreationRecords } from "./draft-browser-creation-records";
import { parseBrowserRecoveryRecord, type BrowserRecoveryRecord } from "./browser-recovery-record";
import { TerminalCreationRecords } from "./terminals/creation-records";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { arch, hostname, platform } from "node:os";
import { basename, join, sep } from "node:path";
import type { ManagedWorktreeSnapshotReceipt } from "./workspace/service";
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
import { hasRepeatedWholeFileIntent, hasRepeatedWholeFileSources, parseInlineWholeFileMentions, parseWholeFileAttachments } from "../../../packages/shared/src/whole-file";
import { parseSelectedTextAttachments } from "../../../packages/shared/src/selected-text";
import { detachedAnswerDraft, type DetachedQuestionSnapshot } from '../../../packages/shared/src/detached-questions';
import { parseNewChatExecution, hasRemoteExecution, hasRemoteStartingState } from '../../../packages/shared/src/new-chat';
import { hasNewChatIntent, hasRemoteWorktreeIntent } from './new-chat-protocol';
import { hasEnvironmentIntent } from './environment-protocol';
import { parseEnvironmentSelection } from '../../../packages/shared/src/environment-selection';
import type { QueuedSubmissionReceipt } from '../../../packages/shared/src/queued-submissions';
import {
  initializeLocalEnvironmentPreparations,
  LocalEnvironmentPreparations,
  type LocalEnvironmentPreparation,
  type LocalEnvironmentPreparationInput,
  type LocalEnvironmentPreparationTransition,
} from "./local-environments/preparations";
import type { LocalEnvironmentWorkerEnvironment } from "./local-environments/environment";
import type { GitSubmissionReceipt, GitSubmissionTarget } from "../../../packages/shared/src/git-submissions";
import type { WorkspaceTarget } from "../../../packages/shared/src/workspace";
import { AutomationRecords, initializeAutomationRecords } from "./automation-records";
import { BrowserAutocompleteRecords } from "./browser-autocomplete-records";
import { PlanExternalEditorRecords } from "./plan-external-editor-records";

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

export interface WorktreeRemovalIntent {
  version: 1;
  id: string;
  commandId: string;
  requestHash: string;
  projectId: string;
  sourceRoot: string;
  worktreePath: string;
  snapshot: ManagedWorktreeSnapshotReceipt;
  state: "pending" | "finalized";
  revision: number;
  createdAt: number;
  updatedAt: number;
}

const removalIntentPrefix = "worktree-removal.v1:";
const gitSubmissionPrefix = "git-submission.v1:";
const gitSubmissionLatestPrefix = "git-submission.latest.v1:";
const gitSubmissionRecoveryPrefix = "git-submission.recovery.v1:";

export interface GitSubmissionRecovery { ownerCwd: string; gitRoot: string; ownerStamp: string; privateIndexPath?: string }
export interface GitSubmissionAdvance {
  phase?: GitSubmissionReceipt["phase"]; progress?: string; generatedMessage?: string;
  branch?: GitSubmissionReceipt["branch"]; commit?: GitSubmissionReceipt["commit"]; push?: GitSubmissionReceipt["push"];
  recovery?: GitSubmissionRecovery;
}

type WithoutSequence<T> = T extends { sequence: number } ? Omit<T, "sequence"> : never;
export type EventInput = WithoutSequence<HostEvent>;
type JsonRow = { data: string };
type EnvironmentPreparationAccessor = Pick<LocalEnvironmentPreparations, "get" | "list" | "transition" | "public" | "getOutput" | "beginOutput" | "updateOutput">;

/** Host-owned app state. Native OMP files remain the source of transcripts. */
export class HostStore {
  readonly host: HostIdentity;
  readonly pluginAcquisitions: PluginAcquisitionRecords;
  readonly browserCreations: BrowserCreationRecords;
  readonly browserCloses: BrowserCloseRecords;
  readonly draftBrowserOwners: DraftBrowserOwnerRecords;
  readonly draftBrowserCreations: DraftBrowserCreationRecords;
  readonly terminalCreations: TerminalCreationRecords;
  readonly environmentPreparations: EnvironmentPreparationAccessor;
  readonly automations: AutomationRecords;
  readonly pullRequestWrites: PullRequestWriteRecords;
  readonly browserAutocomplete: BrowserAutocompleteRecords;
  readonly planExternalEditors: PlanExternalEditorRecords;
  readonly todoExternalEditors: TodoExternalEditorRecords;
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
      if (version > 26) throw new Error(`Unsupported host state schema version ${version}`);
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
        initializeAutomationRecords(this.db);
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
      this.pluginAcquisitions = new PluginAcquisitionRecords(this.db);
      this.browserCreations = new BrowserCreationRecords(this.db, this.host.id, () => {
        // The downgrade fence must not turn a valid legacy default policy into
        // missing-policy corruption on reopen. Preserve its exact semantics.
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(16);
      });
      this.draftBrowserOwners = new DraftBrowserOwnerRecords(this.db, this.host.id, input => {
        const draft = this.getDraft(input.draftId);
        if (!draft || draft.revision !== input.draftRevision || draft.projectId !== input.projectId) throw new Error("The draft browser owner changed before its durable claim");
        if (input.projectId !== null) {
          const project = this.getProject(input.projectId);
          if (!project || project.hostId !== this.host.id || project.path !== input.cwd) throw new Error("The draft browser project changed before its durable claim");
        }
        // A projectless cwd is supplied only by the owning host's admission path.
        // This persistence primitive does not grant access to a client-supplied path.
      }, () => {
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(19);
      });
      this.draftBrowserCreations = new DraftBrowserCreationRecords(this.db, this.host.id, this.draftBrowserOwners);
      this.browserCloses = new BrowserCloseRecords(this.db, this.host.id, owner => {
        if (owner.kind === "session") {
          if (!this.getSession(owner.sessionId)) throw new Error("The browser session no longer exists.");
        } else {
          const saved = this.draftBrowserOwners.get(owner.ownerId);
          if (!saved || saved.retiredAt !== undefined || saved.draftId !== owner.draftId || saved.draftRevision !== owner.draftRevision) throw new Error("The draft browser owner changed before close admission.");
        }
      }, () => {
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(20);
      });
      this.terminalCreations = new TerminalCreationRecords(this.db, this.host.id, () => {
        // Preserve the legacy policy before raising the downgrade fence.
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(17);
      });
      this.environmentPreparationStore = new LocalEnvironmentPreparations(this.db, this.host.id);
      this.environmentPreparations = this.environmentPreparationStore;
      this.automations = new AutomationRecords(this.db, this.host.id, () => {
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(23);
      });
      this.pullRequestWrites = new PullRequestWriteRecords(this.db, this.host.id, () => {
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(24);
      });
      this.browserAutocomplete = new BrowserAutocompleteRecords(
        () => this.readMetadata("browser-autocomplete-history.v1"),
        value => this.writeMetadata("browser-autocomplete-history.v1", value),
      );
      this.planExternalEditors = new PlanExternalEditorRecords(this.db, this.host.id, () => {
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(26);
      });
      this.todoExternalEditors = new TodoExternalEditorRecords(this.db, this.host.id, () => {
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(26);
      });
      this.getDeviceAccessPolicy(); // Refuse corrupt or missing restrictions before serving any connection.
      this.recoverInterruptedSessions();
      this.recoverInterruptedGitSubmissions();
      this.recoverInterruptedQueuedSubmissions();
      this.recoverInterruptedBrowserContinuations();
      this.environmentPreparationStore.reconcileInterrupted();
      this.automations.reconcileInterrupted();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  readMetadata<T>(key: string, maxBytes?: number): T | undefined {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("Invalid metadata record bound.");
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM metadata WHERE key = ?").get(key);
    if (row && maxBytes !== undefined && Buffer.byteLength(row.data) > maxBytes) throw new Error("Retained metadata record exceeds its bound.");
    return row ? JSON.parse(row.data) as T : undefined;
  }
  writeMetadata<T>(key: string, value: T): void {
    this.db.query("INSERT INTO metadata (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
      .run(key, JSON.stringify(value));
  }

  /** Compose synchronous metadata transitions with the same immediate transaction used by record stores. */
  transactionMetadata<T>(run: () => T): T {
    return this.db.transaction(() => {
      const value = run();
      if (value && typeof value === "object" && "then" in value && typeof value.then === "function")
        throw new Error("Metadata transactions require a synchronous callback.");
      return value;
    }).immediate();
  }

  /** Exact-prefix enumeration; overflow is an error, never permission to forget a retained fence. */
  metadataKeys(prefix: string, limit = 2048): string[] {
    if (!prefix || prefix.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16_384)
      throw new Error("Invalid metadata enumeration bound.");
    const rows = this.db.query<{ key: string }, [string, string, number]>(
      "SELECT key FROM metadata WHERE substr(key, 1, length(?)) = ? ORDER BY key LIMIT ?",
    ).all(prefix, prefix, limit + 1);
    if (rows.length > limit) throw new Error("Retained metadata exceeds its enumeration bound.");
    return rows.map(row => row.key);
  }

  deleteMetadata(key: string): void {
    this.db.query("DELETE FROM metadata WHERE key = ?").run(key);
  }

  getDeviceAccessPolicy(): DeviceAccessPolicy {
    const policy = this.readMetadata<unknown>("device-access.v1");
    if (policy !== undefined) return parseDeviceAccessPolicy(policy);
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version >= 13) throw new Error("Host device access policy is missing.");
    // Preserve the existing same-user identity policy until an explicit local change.
    return { revision: 0, enabled: true, revokedNodeIds: [] };
  }

  updateDeviceAccessPolicy(value: unknown): DeviceAccessPolicy {
    const { expectedRevision, change } = parseDeviceAccessUpdate(value);
    return this.db.transaction(() => {
      const current = this.getDeviceAccessPolicy();
      if (current.revision !== expectedRevision) throw new DeviceAccessConflictError();
      const revoked = new Set(current.revokedNodeIds);
      if (change.type === "device") { if (change.allowed) revoked.delete(change.nodeId); else revoked.add(change.nodeId); }
      const next = parseDeviceAccessPolicy({ revision: current.revision + 1, enabled: change.type === "availability" ? change.enabled : current.enabled, revokedNodeIds: [...revoked] });
      this.writeMetadata("device-access.v1", next);
      // Atomically prevent old hosts from ignoring restrictions, including after re-enabling access.
      this.requireVersion(13);
      return next;
    }).immediate();
  }

  getActionEnvironmentSelection(canonicalCwd: string): { revision: number; configPath: string | null } | undefined {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM metadata WHERE key = ?").get(`environment-selection:${canonicalCwd}`);
    return row ? JSON.parse(row.data) : undefined;
  }
  putActionEnvironmentSelection(canonicalCwd: string, configPath: string | null, expectedRevision: number): { revision: number; configPath: string | null } {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid environment selection revision.");
    return this.db.transaction(() => {
      const current = this.getActionEnvironmentSelection(canonicalCwd);
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error("The environment selection changed elsewhere. Refresh before selecting again.");
      this.requireVersion(5);
      const next = { revision: expectedRevision + 1, configPath };
      this.db.query("INSERT INTO metadata (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
        .run(`environment-selection:${canonicalCwd}`, JSON.stringify(next));
      return next;
    }).immediate();
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
      // Commit the downgrade fence with the first v2 record; legacy-only writes do not migrate the database.
      if (state.version === 2) {
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(state.records.some(record => record.key === "general.commandKeymap" && !record.deleted && record.value.version === 2) ? 15 : 14);
      }
      this.db.query("INSERT INTO metadata (key, data) VALUES ('preferences.v1', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(JSON.stringify(state));
      return result;
    }).immediate();
  }

  listProjects(): Project[] {
    return this.db.query<JsonRow, []>("SELECT data FROM projects ORDER BY rowid").all()
      .map(({ data }) => JSON.parse(data) as Project).filter(project => project.removedAt === undefined);
  }

  getProject(id: string): Project | undefined {
    const row = this.db.query<JsonRow, [string]>("SELECT data FROM projects WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) as Project : undefined;
  }

  getCataloguedProject(id: string): Project | undefined {
    const project = this.getProject(id);
    return project?.removedAt === undefined ? project : undefined;
  }

  addProject(input: { path: string; name?: string }): Project {
    const path = realpathSync(input.path);
    if (!statSync(path).isDirectory()) throw new Error("Project path must be a directory");
    return this.db.transaction(() => {
      const existing = this.db.query<JsonRow, [string]>("SELECT data FROM projects WHERE path = ?").get(path);
      if (existing) {
        const project = JSON.parse(existing.data) as Project;
        if (project.removedAt === undefined) return project;
        const restored: Project = { ...project, name: input.name?.trim() || project.name };
        delete restored.removedAt;
        this.db.query("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify(restored), restored.id);
        return restored;
      }
      const project: Project = {
        id: crypto.randomUUID(), hostId: this.host.id, path,
        name: input.name?.trim() || basename(path) || path, createdAt: Date.now(),
      };
      this.db.query("INSERT INTO projects (id, path, data) VALUES (?, ?, ?)")
        .run(project.id, path, JSON.stringify(project));
      return project;
    }).immediate();
  }

  renameProject(id: string, name: string): Project {
    return this.db.transaction(() => {
      const project = this.getCataloguedProject(id);
      if (!project || project.hostId !== this.host.id) throw new Error("Project is not in this host's catalog.");
      const renamed: Project = { ...project, name: name.trim() };
      if (!renamed.name) throw new Error("Project name cannot be empty.");
      this.db.query("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify(renamed), id);
      return renamed;
    }).immediate();
  }

  /** Remove only catalog presentation. The row remains the durable owner for
   * existing sessions, drafts, and already-admitted work. */
  removeProject(id: string): Project {
    return this.db.transaction(() => {
      const project = this.getCataloguedProject(id);
      if (!project || project.hostId !== this.host.id) throw new Error("Project is not in this host's catalog.");
      const removed: Project = { ...project, removedAt: Date.now() };
      this.db.query("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify(removed), id);
      return removed;
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
    if (input.wholeFileAttachments !== undefined) input = { ...input, wholeFileAttachments: hasRepeatedWholeFileIntent({ wholeFileAttachments: input.wholeFileAttachments })
      ? parseInlineWholeFileMentions(input.wholeFileAttachments, input.text.length) : parseWholeFileAttachments(input.wholeFileAttachments,input.text.length) };
    if (input.selectedTextAttachments !== undefined) input = { ...input, selectedTextAttachments: parseSelectedTextAttachments(input.selectedTextAttachments) };
    if (input.approvalMode !== undefined) approvalMode(input.approvalMode);
    if (input.execution !== undefined) input = { ...input, execution: parseNewChatExecution(input.execution, input.projectId) };
    if (Object.hasOwn(input, 'environment')) input = { ...input, environment: parseEnvironmentSelection(input.environment, input.projectId) };
    return this.db.transaction((): DraftWriteResult => {
      const currentDraft = this.getDraft(input.id);
      if (currentDraft?.environment !== undefined && input.environment === undefined) throw new Error('This draft requires the environment protocol; its selection was preserved.');
      if (currentDraft?.execution !== undefined && input.execution === undefined) throw new Error('This draft requires the new-chat execution protocol; its choices were preserved.');
      if (currentDraft?.attachments !== undefined && input.attachments === undefined) throw new Error("This draft requires the attachment command protocol; its content was preserved.");
      if (currentDraft?.selectedTextAttachments !== undefined && input.selectedTextAttachments === undefined) throw new Error("This draft requires the selected-text command protocol; its content was preserved.");
      if (currentDraft?.wholeFileAttachments !== undefined && input.wholeFileAttachments === undefined) throw new Error("This draft requires the whole-file protocol; its content was preserved.");
      if (input.wholeFileAttachments !== undefined) this.requireVersion(hasRepeatedWholeFileSources(input.wholeFileAttachments) ? 11 : input.wholeFileAttachments.some(file=>file.textOffset!==undefined)?10:9);
      if (input.approvalMode !== undefined) this.requirePermissionVersion();
      if (input.attachments !== undefined) this.requireVersion(3);
      if (input.execution !== undefined) this.requireVersion(4);
      if (hasRemoteExecution(input.execution)) this.requireRemoteStartingVersion();
      if (input.environment !== undefined) this.requireVersion(5);
      if (input.selectedTextAttachments !== undefined) this.requireVersion(8);
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
      const needsReceipt = current.attachments !== undefined || current.execution !== undefined || current.environment !== undefined || current.selectedTextAttachments !== undefined || current.wholeFileAttachments !== undefined;
      if (needsReceipt && !commandId) throw new Error("Draft consumption requires its accepted command identity.");
      const cleared: Draft = { ...current, text: "", revision: current.revision + 1, updatedAt: Date.now(),
        ...(current.attachments !== undefined ? { attachments: [] } : {}),
        ...(current.wholeFileAttachments !== undefined ? { wholeFileAttachments: [] } : {}),
        ...(current.selectedTextAttachments !== undefined ? { selectedTextAttachments: [] } : {}),
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
    const selectedTextAttachments = command?.type === "draft.put" ? command.draft.selectedTextAttachments
      : command?.type === "session.prompt" || command?.type === "session.steer" ? command.selectedTextAttachments : undefined;
    const wholeFileAttachments = command?.type === "draft.put" ? command.draft.wholeFileAttachments
      : command?.type === "session.prompt" || command?.type === "session.steer" ? command.wholeFileAttachments : undefined;
    if (wholeFileAttachments !== undefined) {
      const textLength = command?.type === "draft.put" ? command.draft.text.length : command?.type === "session.prompt" || command?.type === "session.steer" ? command.text.length : undefined;
      if (hasRepeatedWholeFileSources(wholeFileAttachments)) parseInlineWholeFileMentions(wholeFileAttachments, textLength!);
      else parseWholeFileAttachments(wholeFileAttachments, textLength);
    }
    if (attachments !== undefined) parseImageAttachments(attachments, this.host.id);
    if (selectedTextAttachments !== undefined) parseSelectedTextAttachments(selectedTextAttachments);
    return this.db.transaction((): CommandClaim => {
      const existing = this.getCommand(id);
      if (existing) return { kind: existing.requestHash === requestHash ? existing.state : "conflict", record: existing };
      if (command && hasApprovalIntent(command)) this.requirePermissionVersion();
      if (attachments !== undefined) this.requireVersion(3);
      if (selectedTextAttachments !== undefined) this.requireVersion(8);
      if (wholeFileAttachments !== undefined) this.requireVersion(hasRepeatedWholeFileSources(wholeFileAttachments) ? 11 : wholeFileAttachments.some(file=>file.textOffset!==undefined)?10:9);
      if (command && hasNewChatIntent(command)) this.requireVersion(4);
      if (command && hasRemoteWorktreeIntent(command)) this.requireRemoteStartingVersion();
      if (command && hasEnvironmentIntent(command)) this.requireVersion(5);
      if (command?.type === "workspace.mutate" && command.action.type === "git.submit") this.requireVersion(12);
      if (command?.type === "session.create" && command.browserContinuation) {
        const policy=this.getDeviceAccessPolicy();
        if(this.readMetadata("device-access.v1")===undefined)this.writeMetadata("device-access.v1",policy);
        this.requireVersion(21);
      }
      if (command?.type === "session.follow-up") {
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(13);
      }
      if (command?.type === "session.fork" || command?.type === "session.fork.resume") {
        const policy = this.getDeviceAccessPolicy();
        if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
        this.requireVersion(25);
      }
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
        if (command.wholeFileAttachments?.length && result.admission.kind !== "user-message") throw new Error("Whole-file draft consumption requires its ordinary native user receipt.");
        if (command.selectedTextAttachments?.length && result.admission.kind !== "user-message") throw new Error("Selected-text draft consumption requires its ordinary native user receipt.");
        this.consumeDraft(command.draft, id);
      }
      if (result.ok && command?.type === 'session.question.answer' && result.value && 'type' in result.value
        && result.value.type === 'session.question.answer' && result.value.receipt.questionId === command.questionId) {
        this.consumeDraft(command.draft, id);
      }
      if (result.ok && command?.type === "session.btw.start" && command.draft && result.value && "type" in result.value
        && result.value.type === "session.btw" && result.value.snapshot?.sessionId === command.sessionId
        && result.value.snapshot.runId === id && result.value.snapshot.question === command.question) {
        this.consumeDraft(command.draft, id);
      }
      const finished: CommandRecord = { ...record, state: "done", result, updatedAt: Date.now() };
      this.db.query("UPDATE commands SET data = ? WHERE id = ?").run(JSON.stringify(finished), id);
      return finished;
    }).immediate();
  }

  beginQueuedSubmission(id: string, requestHash: string): QueuedSubmissionReceipt {
    return this.db.transaction(() => {
      const record = this.getCommand(id);
      if (!record || record.requestHash !== requestHash || record.command?.type !== "session.follow-up")
        throw new Error("Queued submission requires its retained command.");
      const existing = this.queuedSubmissionReceipt(record);
      if (existing) return existing;
      if (record.state !== "pending") throw new Error("Queued submission command is already finished without a receipt.");
      const now = Date.now();
      const receipt: QueuedSubmissionReceipt = { version: 1, commandId: id, hostId: this.host.id,
        sessionId: record.command.sessionId, delivery: record.command.delivery, phase: "admitting", outcome: "pending",
        revision: 1, createdAt: now, updatedAt: now };
      const next: CommandRecord = { ...record, state: "done", result: { ok: true, commandId: id,
        value: { type: "session.follow-up", receipt } }, updatedAt: now };
      this.db.query("UPDATE commands SET data = ? WHERE id = ?").run(JSON.stringify(next), id);
      return receipt;
    }).immediate();
  }

  advanceQueuedSubmission(id: string, requestHash: string, update:
    | { phase: "queued" }
    | { phase: "settled"; outcome: "succeeded"; entryId: string }
    | { phase: "settled"; outcome: "not-recorded" | "unknown"; message: string }): QueuedSubmissionReceipt {
    return this.db.transaction(() => {
      const record = this.getCommand(id);
      if (!record || record.requestHash !== requestHash || record.command?.type !== "session.follow-up")
        throw new Error("Queued submission owner changed.");
      const current = this.queuedSubmissionReceipt(record);
      if (!current) throw new Error("Queued submission has no durable admission receipt.");
      if (current.phase === "settled") return current;
      if (update.phase === "queued" && current.phase !== "admitting") return current;
      const now = Date.now();
      const receipt: QueuedSubmissionReceipt = { ...current, phase: update.phase,
        outcome: update.phase === "queued" ? "pending" : update.outcome,
        revision: current.revision + 1, updatedAt: now,
        ...(update.phase === "settled" && update.outcome === "succeeded" ? { entryId: update.entryId } : {}),
        ...(update.phase === "settled" && update.outcome !== "succeeded" ? { message: update.message.slice(0, 4096) } : {}) };
      if (update.phase === "queued" || update.outcome === "succeeded") this.consumeDraft(record.command.draft, id);
      const next: CommandRecord = { ...record, state: "done", result: { ok: true, commandId: id,
        value: { type: "session.follow-up", receipt } }, updatedAt: now };
      this.db.query("UPDATE commands SET data = ? WHERE id = ?").run(JSON.stringify(next), id);
      return receipt;
    }).immediate();
  }

  getQueuedSubmission(id: string): QueuedSubmissionReceipt | undefined {
    const record = this.getCommand(id);
    return record ? this.queuedSubmissionReceipt(record) : undefined;
  }

  beginGitSubmission(id: string, requestHash: string): GitSubmissionReceipt {
    return this.db.transaction(() => {
      const command = this.getCommand(id);
      if (!command || command.requestHash !== requestHash || command.command?.type !== "workspace.mutate" || command.command.action.type !== "git.submit")
        throw new Error("Git submission requires its retained pending command.");
      const target = this.gitSubmissionTarget(command.command.target);
      const existing = this.readGitSubmission(id);
      if (existing) return existing;
      if (command.state !== "pending") throw new Error("Git submission command is already finished without a receipt.");
      const latest = this.readMetadata<{ id: string }>(`${gitSubmissionLatestPrefix}${this.gitSubmissionOwnerKey(target)}`);
      if (latest && latest.id !== id) {
        const prior = this.readGitSubmission(latest.id);
        if (prior && (prior.outcome === "pending" || prior.outcome === "unknown" && prior.acknowledgedAt === undefined))
          throw new Error("Inspect the existing Git submission before starting another one.");
      }
      this.requireVersion(12);
      const now = Date.now();
      const receipt: GitSubmissionReceipt = { commandId: id, hostId: this.host.id, target, operation: command.command.action.intent.operation,
        revision: 1, phase: "queued", outcome: "pending", cancelRequested: false, createdAt: now, updatedAt: now };
      this.writeMetadata(`${gitSubmissionPrefix}${id}`, receipt);
      this.writeMetadata(`${gitSubmissionLatestPrefix}${this.gitSubmissionOwnerKey(target)}`, { id });
      return receipt;
    }).immediate();
  }

  getGitSubmission(target: GitSubmissionTarget, id?: string): GitSubmissionReceipt | undefined {
    const targetKey = this.gitSubmissionOwnerKey(this.gitSubmissionTarget(target));
    const resolved = id ?? this.readMetadata<{ id: string }>(`${gitSubmissionLatestPrefix}${targetKey}`)?.id;
    if (!resolved) return undefined;
    const receipt = this.readGitSubmission(resolved);
    return receipt && receipt.hostId === this.host.id && this.gitSubmissionOwnerKey(receipt.target) === targetKey ? receipt : undefined;
  }

  advanceGitSubmission(id: string, requestHash: string, expectedRevision: number, update: GitSubmissionAdvance): GitSubmissionReceipt {
    return this.db.transaction(() => {
      const receipt = this.requiredGitSubmission(id, requestHash);
      if (receipt.outcome !== "pending" || receipt.revision !== expectedRevision) throw new Error("Git submission changed; refresh before advancing it.");
      if (update.phase === "completed") throw new Error("Git submission completion requires its finish transaction.");
      if (update.phase && !phaseAllowed(receipt.operation, receipt.phase, update.phase)) throw new Error("Git submission phase transition is not allowed.");
      if (receipt.cancelRequested && update.phase && ["branch", "committing", "pushing"].includes(update.phase)) throw new Error("Git submission cancellation prevents mutation.");
      if (update.progress !== undefined && (typeof update.progress !== "string" || update.progress.includes("\0") || update.progress.length > 4_096)) throw new Error("Git submission progress is invalid.");
      if (update.generatedMessage !== undefined && (typeof update.generatedMessage !== "string" || update.generatedMessage.includes("\0") || !update.generatedMessage.trim() || update.generatedMessage.length > 1_000_000)) throw new Error("Generated Git submission message is invalid.");
      const merged = mergeGitSubmission(receipt, update);
      const next = { ...merged, revision: receipt.revision + 1, updatedAt: Date.now() };
      this.writeMetadata(`${gitSubmissionPrefix}${id}`, next);
      if (update.recovery) this.writeMetadata(`${gitSubmissionRecoveryPrefix}${id}`, update.recovery);
      return next;
    }).immediate();
  }

  finishGitSubmission(id: string, requestHash: string, expectedRevision: number, update: GitSubmissionAdvance & { outcome: "succeeded" | "failed" | "cancelled" | "unknown"; error?: GitSubmissionReceipt["error"] }): GitSubmissionReceipt {
    return this.db.transaction(() => {
      const receipt = this.requiredGitSubmission(id, requestHash);
      if (receipt.outcome !== "pending" || receipt.revision !== expectedRevision) throw new Error("Git submission changed; refresh before finishing it.");
      if (receipt.cancelRequested && update.outcome === "succeeded") throw new Error("Git submission cancellation prevents success.");
      const merged = mergeGitSubmission(receipt, update);
      if (update.outcome === "succeeded" && !successfulGitSubmission(merged)) throw new Error("Git submission success requires its confirmed operation receipt.");
      const next: GitSubmissionReceipt = { ...merged, phase: "completed", outcome: update.outcome, error: update.error,
        revision: receipt.revision + 1, updatedAt: Date.now() };
      this.writeMetadata(`${gitSubmissionPrefix}${id}`, next);
      this.finishCommand(id, requestHash, { ok: true, commandId: id, value: { type: "git.submit", receipt: next } });
      return next;
    }).immediate();
  }

  requestGitSubmissionCancel(target: GitSubmissionTarget, id: string): GitSubmissionReceipt {
    return this.db.transaction(() => {
      const receipt = this.getGitSubmission(target, id);
      if (!receipt || receipt.outcome !== "pending" || !["queued", "preparing", "generating"].includes(receipt.phase)) throw new Error("Git submission can no longer be cancelled.");
      if (receipt.cancelRequested) return receipt;
      const next = { ...receipt, cancelRequested: true, revision: receipt.revision + 1, updatedAt: Date.now() };
      this.writeMetadata(`${gitSubmissionPrefix}${id}`, next); return next;
    }).immediate();
  }

  acknowledgeGitSubmission(target: GitSubmissionTarget, id: string): GitSubmissionReceipt {
    return this.db.transaction(() => {
      const receipt = this.getGitSubmission(target, id);
      if (!receipt || receipt.outcome !== "unknown") throw new Error("Only an unknown Git submission can be acknowledged.");
      if (receipt.acknowledgedAt !== undefined) return receipt;
      const next = { ...receipt, acknowledgedAt: Date.now(), revision: receipt.revision + 1, updatedAt: Date.now() };
      this.writeMetadata(`${gitSubmissionPrefix}${id}`, next);
      const command = this.getCommand(id);
      if (command?.state === "done" && command.result?.ok && command.result.value && "type" in command.result.value && command.result.value.type === "git.submit") {
        const updated: CommandRecord = { ...command, result: { ...command.result, value: { type: "git.submit", receipt: next } }, updatedAt: next.updatedAt };
        this.db.query("UPDATE commands SET data = ? WHERE id = ?").run(JSON.stringify(updated), id);
      }
      return next;
    }).immediate();
  }

  /** First preparation use upgrades the database together with the captured record. */
  createEnvironmentPreparation(input: LocalEnvironmentPreparationInput): LocalEnvironmentPreparation {
    return this.db.transaction(() => {
      const project = this.getProject(input.projectId);
      if (!project || project.hostId !== this.host.id) throw new Error("Unknown local-environment project");
      if (project.path !== input.sourceRoot) throw new Error("Local-environment source root differs from its project");
      if (input.forkSource) {
        const source = this.getSession(input.forkSource.id), command = this.getCommand(input.id)?.command;
        if (!source || command?.type !== "session.fork" || command.sessionId !== source.id || source.projectId !== project.id
          || source.cwd !== input.forkSource.cwd || source.sessionFile !== input.forkSource.sessionFile)
          throw new Error("Fork worktree preparation lost its captured source owner.");
        this.requireVersion(25);
      }
      this.requireVersion(input.directories !== undefined ? 6 : 5);
      if (hasRemoteStartingState(input.startingState)) this.requireRemoteStartingVersion();
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
    const inherited = this.readMetadata<{ cwd: string; environment: LocalEnvironmentWorkerEnvironment }>(`session-environment:${sessionId}`);
    if (inherited) {
      if (this.getSession(sessionId)?.cwd !== inherited.cwd) throw new Error('Inherited session environment no longer matches its native working directory.');
      return structuredClone(inherited.environment);
    }
    const preparation = this.environmentPreparations.list().find(record => record.sessionId === sessionId && record.phase !== "removed");
    if (!preparation?.environment) return undefined;
    const worktreeRoot = preparation.version === 2
      ? join(preparation.worktreePath, preparation.directories.workspaceRelativePath)
      : preparation.worktreePath;
    return {
      environmentDelta: structuredClone(preparation.environmentDelta ?? null),
      sourceRoot: preparation.sourceRoot,
      worktreeRoot,
    };
  }

  /** Bind a proven, closed native child and its empty draft without touching the source draft. */
  finishSessionFork(commandId: string, input: import("./session-fork").SessionForkIntent): CommandResult {
    return this.db.transaction(() => {
      const claim = this.getCommand(commandId), key = `session-fork.v1:${input.source.id}`;
      const intent = this.readMetadata<import("./session-fork").SessionForkIntent>(key);
      const command = claim?.command;
      if (!claim || !intent || intent.commandId !== input.commandId
        || !(command?.type === "session.fork" && commandId === intent.commandId && command.sessionId === intent.source.id
          || command?.type === "session.fork.resume" && command.operationId === intent.commandId && command.sessionId === intent.source.id))
        throw new Error("Fork binding lost its original command ownership.");
      if (claim.state === "done") return claim.result!;
      const child = intent.child, source = this.getSession(intent.source.id);
      if (!child || !source || source.hostId !== this.host.id || child.hostId !== this.host.id
        || child.id === source.id || child.sessionFile === intent.source.sessionFile || child.sessionFile !== intent.targetFile
        || child.cwd !== intent.targetCwd || child.projectId !== intent.source.projectId
        || !["binding", "complete"].includes(intent.state))
        throw new Error("Fork binding differs from its proven native child.");
      if (intent.state === "binding") {
        if (this.getSession(child.id) || this.getDraft(`session:${child.id}`)) throw new Error("Fork cannot replace an existing child or draft.");
        this.upsertSession(child);
        const draft = this.putDraft({ id: `session:${child.id}`, text: "", projectId: child.projectId, model: child.model,
          ...(child.approvalOverride ? { approvalMode: child.approvalOverride } : {}) }, 0);
        if (!draft.ok) throw new Error("The new Fork composer could not be bound.");
        if (intent.environment) this.writeMetadata(`session-environment:${child.id}`, { cwd: child.cwd, environment: intent.environment });
        if (intent.execution.type === "worktree") {
          const preparation = this.environmentPreparations.get(intent.commandId);
          if (!preparation || preparation.forkSource?.id !== source.id || preparation.projectId !== child.projectId
            || preparation.worktreePath !== intent.worktreePath) throw new Error("Fork lost its owned worktree preparation.");
          this.environmentPreparations.transition(preparation.id, preparation.revision, { type: "native-fork.confirmed", sessionId: child.id });
        }
        this.writeMetadata(key, { ...intent, state: "complete", error: undefined });
      } else if (this.getSession(child.id)?.sessionFile !== child.sessionFile) {
        throw new Error("The completed Fork child is no longer bound to its recorded file.");
      }
      const result: CommandResult = { ok: true, commandId, value: {
        type: "session.forked", commandId: intent.commandId, sourceSessionId: intent.source.id, session: child,
      } };
      if (commandId !== intent.commandId) {
        const original = this.getCommand(intent.commandId);
        if (original?.state === "pending" && original.command?.type === "session.fork" && original.command.sessionId === intent.source.id)
          this.finishCommand(original.id, original.requestHash, { ...result, commandId: original.id });
      }
      this.finishCommand(commandId, claim.requestHash, result);
      return result;
    }).immediate();
  }

  /** A Plan replacement cannot execute until catalog and original setup exports
   * are bound atomically. The command remains pending through prompt admission. */
  bindPlanDecisionDestination(intent: import("./plan-decisions").PlanDecisionIntent, session: SessionSummary,
    environment: LocalEnvironmentWorkerEnvironment | undefined): void {
    this.db.transaction(() => {
      const claim = this.getCommand(intent.commandId), origin = this.getSession(intent.originId);
      if (!claim || claim.state !== "pending" || claim.command?.type !== "session.plan.mutate"
        || claim.command.sessionId !== intent.originId || claim.command.reviewId !== intent.reviewId
        || claim.command.reviewRevision !== intent.reviewRevision || !origin || session.hostId !== origin.hostId
        || session.projectId !== origin.projectId || session.cwd !== origin.cwd || session.id === origin.id
        || session.sessionFile === origin.sessionFile || this.getSession(session.id)
        || intent.destination?.id !== session.id || intent.destination.sessionFile !== session.sessionFile)
        throw new Error("Native Plan replacement does not match its original command and owner.");
      this.requireVersion(7);
      this.upsertSession(session);
      if (environment) this.writeMetadata(`session-environment:${session.id}`, { cwd: session.cwd, environment });
      this.writeMetadata(`plan-decision:${intent.originId}`, intent);
      this.writeMetadata(`plan-decision-command:${intent.commandId}`, intent);
      if (intent.execution) this.writeMetadata(`plan-decision-owner:${session.id}`,
        { originId: intent.originId, originalCommandId: intent.commandId });
    }).immediate();
  }

  getPlanDecisionForSession(sessionId: string): import("./plan-decisions").PlanDecisionIntent | undefined {
    const direct = this.readMetadata<import("./plan-decisions").PlanDecisionIntent>(`plan-decision:${sessionId}`);
    if (direct) {
      const exact = this.readMetadata<import("./plan-decisions").PlanDecisionIntent>(`plan-decision-command:${direct.commandId}`);
      if (exact?.originId === sessionId && exact.originId === direct.originId && exact.commandId === direct.commandId) return exact;
      return undefined;
    }
    const owner = this.readMetadata<{ originId: string; originalCommandId: string }>(`plan-decision-owner:${sessionId}`);
    const intent = owner ? this.readMetadata<import("./plan-decisions").PlanDecisionIntent>(`plan-decision-command:${owner.originalCommandId}`) : undefined;
    return intent && intent.commandId === owner?.originalCommandId && intent.execution?.owner.id === sessionId ? intent : undefined;
  }

  getPlanDecisionByCommand(commandId: string, originId: string, executionOwnerId: string): import("./plan-decisions").PlanDecisionIntent | undefined {
    const intent = this.readMetadata<import("./plan-decisions").PlanDecisionIntent>(`plan-decision-command:${commandId}`);
    return intent?.commandId === commandId && intent.originId === originId && intent.execution?.owner.id === executionOwnerId ? intent : undefined;
  }

  reservePlanExecutionRetry(intent: import("./plan-decisions").PlanDecisionIntent, attemptId: string,
    request: import("../../../packages/shared/src/session-plan").PlanExecutionRetryRequest): void {
    this.db.transaction(() => {
      const current = this.getPlanDecisionByCommand(request.originalCommandId, request.originSessionId, request.sessionId), claim = this.getCommand(attemptId);
      if (!claim || claim.state !== "pending" || claim.command?.type !== "session.plan.execution.retry"
        || claim.command.sessionId !== request.sessionId || claim.command.originSessionId !== request.originSessionId
        || claim.command.originalCommandId !== request.originalCommandId || claim.command.expectedAttemptId !== request.expectedAttemptId
        || !current?.execution || current.commandId !== intent.commandId || current.originId !== request.originSessionId
        || current.execution.owner.id !== request.sessionId || current.execution.state !== "ready"
        || current.execution.latestAttemptId !== request.expectedAttemptId)
        throw new Error("The Plan execution retry is stale or has no matching durable continuation.");
      current.execution = { ...current.execution, state: "pending", latestAttemptId: attemptId };
      this.writeMetadata(`plan-decision-command:${current.commandId}`, current);
      const latest = this.readMetadata<import("./plan-decisions").PlanDecisionIntent>(`plan-decision:${current.originId}`);
      if (latest?.commandId === current.commandId) this.writeMetadata(`plan-decision:${current.originId}`, current);
    }).immediate();
  }

  finishPlanExecutionRetry(intent: import("./plan-decisions").PlanDecisionIntent, attemptId: string,
    state: "ready" | "entered" | "unknown", result: CommandResult): CommandResult {
    return this.db.transaction(() => {
      const current = this.getPlanDecisionByCommand(intent.commandId, intent.originId, intent.execution!.owner.id), claim = this.getCommand(attemptId);
      if (!current?.execution || current.commandId !== intent.commandId || current.originId !== intent.originId
        || current.execution.latestAttemptId !== attemptId || current.execution.state !== "pending"
        || !claim || claim.state !== "pending" || claim.command?.type !== "session.plan.execution.retry"
        || result.commandId !== attemptId) throw new Error("The Plan execution retry settlement lost its reserved owner.");
      current.execution = { ...current.execution, state };
      this.writeMetadata(`plan-decision-command:${current.commandId}`, current);
      const latest = this.readMetadata<import("./plan-decisions").PlanDecisionIntent>(`plan-decision:${current.originId}`);
      if (latest?.commandId === current.commandId) this.writeMetadata(`plan-decision:${current.originId}`, current);
      this.finishCommand(attemptId, claim.requestHash, result);
      return result;
    }).immediate();
  }

  finishPlanDecision(intent: import("./plan-decisions").PlanDecisionIntent, result: CommandResult): CommandResult {
    return this.db.transaction(() => {
      const claim = this.getCommand(intent.commandId);
      if (!claim || claim.command?.type !== "session.plan.mutate" || claim.command.sessionId !== intent.originId
        || claim.command.reviewId !== intent.reviewId || claim.command.reviewRevision !== intent.reviewRevision
        || result.commandId !== intent.commandId) throw new Error("Plan decision receipt does not match its original command.");
      if (claim.state === "done") return claim.result!;
      this.writeMetadata(`plan-decision:${intent.originId}`, intent);
      this.writeMetadata(`plan-decision-command:${intent.commandId}`, intent);
      if (intent.execution) this.writeMetadata(`plan-decision-owner:${intent.execution.owner.id}`,
        { originId: intent.originId, originalCommandId: intent.commandId });
      this.finishCommand(intent.commandId, claim.requestHash, result);
      return result;
    }).immediate();
  }

  finishBtwPromotion(commandId: string, session: SessionSummary, environment: LocalEnvironmentWorkerEnvironment | undefined,
    intent: import('./btw-promotion').BtwPromotionIntent, intentKey: string): CommandResult {
    return this.db.transaction(() => {
      const claim = this.getCommand(commandId);
      if (!claim || claim.command?.type !== 'session.btw.promote' || claim.command.sessionId !== intent.originId
        || claim.command.runId !== intent.runId || intent.commandId !== commandId) throw new Error('Side promotion command identity does not match.');
      if (claim.state === 'done') return claim.result!;
      const cancelled = intent.state === 'cancelled';
      const origin = this.getSession(intent.originId);
      if (!origin || session.hostId !== origin.hostId || session.cwd !== origin.cwd || session.projectId !== origin.projectId
        || (cancelled ? session.id !== origin.id : session.id === origin.id || session.sessionFile === origin.sessionFile || Boolean(this.getSession(session.id))))
        throw new Error('Side promotion differs from its original session.');
      if (!cancelled) {
        this.requireVersion(7); // Older hosts must not reopen a branch without inherited setup exports.
        this.upsertSession(session);
        if (environment) this.writeMetadata(`session-environment:${session.id}`, { cwd: session.cwd, environment });
      }
      this.writeMetadata(intentKey, intent);
      const result: CommandResult = { ok: true, commandId, value: { type: 'session.btw.promote', cancelled, session } };
      this.finishCommand(commandId, claim.requestHash, result);
      return result;
    }).immediate();
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
      const expectedCwd = record?.version === 2 ? join(record.worktreePath, record.directories.workspaceRelativePath) : record?.worktreePath;
      if (!record || record.revision !== preparation.expectedRevision || record.phase !== 'native-creating'
        || record.projectId !== session.projectId || record.hostId !== session.hostId || expectedCwd !== session.cwd)
        throw new Error("Native session differs from its captured environment preparation.");
      const value = this.upsertSession(session);
      const result: CommandResult = { ok: true, commandId, value };
      this.finishCommandWithEnvironmentTransition(commandId, requestHash, result, { ...preparation, transition: { type: 'native-create.succeeded', sessionId: session.id } });
      return result;
    }).immediate();
  }

  listWorktreeRemovalIntents(includeFinalized = false): WorktreeRemovalIntent[] {
    return this.db.query<JsonRow, [string]>("SELECT data FROM metadata WHERE key LIKE ? ORDER BY key").all(`${removalIntentPrefix}%`)
      .map(({ data }) => JSON.parse(data) as WorktreeRemovalIntent)
      .filter(record => includeFinalized || record.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  getWorktreeRemovalIntent(worktreePath: string): WorktreeRemovalIntent | undefined {
    const records = this.listWorktreeRemovalIntents(true).filter(record => record.worktreePath === worktreePath);
    return records.find(record => record.state === "pending") ?? records.at(-1);
  }

  /** Persist the exact removal authority after cleanup and before Git dispatch. */
  createWorktreeRemovalIntent(input: Omit<WorktreeRemovalIntent, "version" | "requestHash" | "state" | "revision" | "createdAt" | "updatedAt">): WorktreeRemovalIntent {
    return this.db.transaction(() => {
      this.requireVersion(6);
      const command = this.getCommand(input.commandId);
      const project = this.getProject(input.projectId);
      if (!command || command.state !== "pending") throw new Error("Worktree removal requires its pending command identity.");
      if (!project || project.hostId !== this.host.id || project.path !== input.sourceRoot) throw new Error("Worktree removal source ownership changed.");
      if (input.snapshot.worktreePath !== input.worktreePath) throw new Error("Worktree removal snapshot belongs to another path.");
      const existing = this.listWorktreeRemovalIntents().find(record => record.worktreePath === input.worktreePath);
      if (existing) {
        if (existing.commandId === input.commandId && existing.id === input.id
          && JSON.stringify(existing.snapshot) === JSON.stringify(input.snapshot)) return existing;
        throw Object.assign(new Error("A prior worktree removal has an unresolved outcome. Inspect it before trying another removal."), { code: "OUTCOME_UNKNOWN" });
      }
      const now = Date.now();
      const record: WorktreeRemovalIntent = { ...structuredClone(input), version: 1, requestHash: command.requestHash, state: "pending", revision: 1, createdAt: now, updatedAt: now };
      this.db.query("INSERT INTO metadata (key, data) VALUES (?, ?)").run(`${removalIntentPrefix}${record.id}`, JSON.stringify(record));
      return record;
    }).immediate();
  }

  /** Finalize deletion metadata and every linked session as one SQLite commit. */
  finalizeWorktreeRemoval(id: string, expectedRevision: number): { intent: WorktreeRemovalIntent; sessions: SessionSummary[] } {
    return this.db.transaction(() => {
      const row = this.db.query<JsonRow, [string]>("SELECT data FROM metadata WHERE key = ?").get(`${removalIntentPrefix}${id}`);
      if (!row) throw new Error("Unknown worktree removal intent.");
      const current = JSON.parse(row.data) as WorktreeRemovalIntent;
      if (current.state === "finalized") return { intent: current, sessions: this.listSessions().filter(session => session.archived && withinPath(current.worktreePath, session.cwd)) };
      if (current.revision !== expectedRevision) throw new Error("Worktree removal intent changed elsewhere.");
      const project = this.getProject(current.projectId);
      if (!project || project.path !== current.sourceRoot || current.snapshot.worktreePath !== current.worktreePath) throw new Error("Worktree removal ownership changed.");
      const preparation = this.environmentPreparations.list().find(record => record.worktreePath === current.worktreePath && record.phase !== "removed");
      if (preparation) {
        if (preparation.projectId !== current.projectId || preparation.sourceRoot !== current.sourceRoot || preparation.phase !== "cleanup-succeeded")
          throw new Error("Worktree environment cleanup is not durably complete.");
        this.environmentPreparations.transition(preparation.id, preparation.revision, { type: "removed" });
      }
      const sessions: SessionSummary[] = [];
      for (const session of this.listSessions()) if (withinPath(current.worktreePath, session.cwd)) {
        const archived = this.upsertSession({ ...session, archived: true, updatedAt: Date.now() });
        sessions.push(archived);
      }
      const intent: WorktreeRemovalIntent = { ...current, state: "finalized", revision: current.revision + 1, updatedAt: Date.now() };
      this.db.query("UPDATE metadata SET data = ? WHERE key = ?").run(JSON.stringify(intent), `${removalIntentPrefix}${id}`);
      const command = this.getCommand(current.commandId);
      if (!command || command.requestHash !== current.requestHash) throw new Error("Worktree removal command identity disappeared or changed.");
      if (command.state === "done" && (command.result?.ok || command.result?.error.code !== "OUTCOME_UNKNOWN")) {
        throw new Error("Worktree removal command already has a different definitive outcome.");
      }
      const result: CommandResult = { ok: true, commandId: current.commandId, value: { type: "worktree.remove" } };
      this.db.query("UPDATE commands SET data = ? WHERE id = ?").run(JSON.stringify({ ...command, state: "done", result, updatedAt: Date.now() }), command.id);
      return { intent, sessions };
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

  appendEvent(input: EventInput, sessionActivity = false): HostEvent {
    return this.db.transaction(() => {
      const inserted = this.db.query("INSERT INTO events (data) VALUES (?)").run(JSON.stringify(input));
      const sequence = Number(inserted.lastInsertRowid);
      if (sessionActivity) {
        const session = "sessionId" in input && typeof input.sessionId === "string" ? this.getSession(input.sessionId) : undefined;
        if (session) this.upsertSession({ ...session, activitySequence: sequence });
      }
      return { ...input, sequence } as HostEvent;
    }).immediate();
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

  private recoverInterruptedGitSubmissions(): void {
    this.db.transaction(() => {
      for (const { data } of this.db.query<JsonRow, []>("SELECT data FROM commands").all()) {
        const command = JSON.parse(data) as CommandRecord;
        if (command.state !== "pending" || command.command?.type !== "workspace.mutate" || command.command.action.type !== "git.submit") continue;
        let target: GitSubmissionTarget;
        try { target = this.gitSubmissionTarget(command.command.target); } catch { continue; }
        const prior = this.readGitSubmission(command.id);
        const now = Date.now();
        const receipt: GitSubmissionReceipt = prior
          ? { ...prior, outcome: prior.outcome === "pending" ? "unknown" : prior.outcome, phase: prior.phase, error: prior.outcome === "pending" ? { code: "OUTCOME_UNKNOWN", message: "The host restarted during this Git submission. Inspect the repository before continuing." } : prior.error, revision: prior.outcome === "pending" ? prior.revision + 1 : prior.revision, updatedAt: now }
          : { commandId: command.id, hostId: this.host.id, target, operation: command.command.action.intent.operation, revision: 1, phase: "queued", outcome: "unknown", cancelRequested: false, error: { code: "OUTCOME_UNKNOWN", message: "The host restarted before this Git submission received a durable receipt. Inspect the repository before continuing." }, createdAt: command.createdAt, updatedAt: now };
        this.writeMetadata(`${gitSubmissionPrefix}${command.id}`, receipt);
        this.writeMetadata(`${gitSubmissionLatestPrefix}${this.gitSubmissionOwnerKey(target)}`, { id: command.id });
        // Retries of the original command must return these preserved partials,
        // rather than a generic pending-command error without its receipt.
        this.finishCommand(command.id, command.requestHash, { ok: true, commandId: command.id, value: { type: "git.submit", receipt } });
      }
    }).immediate();
  }

  private recoverInterruptedQueuedSubmissions(): void {
    this.db.transaction(() => {
      for (const { data } of this.db.query<JsonRow, []>("SELECT data FROM commands").all()) {
        const record = JSON.parse(data) as CommandRecord;
        if (record.command?.type !== "session.follow-up") continue;
        const receipt = this.queuedSubmissionReceipt(record);
        if (receipt && receipt.outcome !== "pending") continue;
        const now = Date.now();
        const recovered: QueuedSubmissionReceipt = { version: 1, commandId: record.id, hostId: this.host.id,
          sessionId: record.command.sessionId, delivery: record.command.delivery, phase: "settled", outcome: "unknown",
          revision: (receipt?.revision ?? 0) + 1, createdAt: receipt?.createdAt ?? record.createdAt, updatedAt: now,
          message: "The host restarted before this queued submission reached a verified native entry. Retry checks this original command and never enqueues it again." };
        const next: CommandRecord = { ...record, state: "done", updatedAt: now,
          result: { ok: true, commandId: record.id, value: { type: "session.follow-up", receipt: recovered } } };
        this.db.query("UPDATE commands SET data = ? WHERE id = ?").run(JSON.stringify(next), record.id);
      }
    }).immediate();
  }

  private queuedSubmissionReceipt(record: CommandRecord): QueuedSubmissionReceipt | undefined {
    const value = record.result?.ok ? record.result.value : undefined;
    return value && "type" in value && value.type === "session.follow-up" ? value.receipt : undefined;
  }

  private gitSubmissionTarget(target: WorkspaceTarget): GitSubmissionTarget {
    if ("filePath" in target) throw new Error("Standalone files cannot submit Git changes.");
    if ("projectId" in target) { const project = this.getProject(target.projectId); if (!project || project.hostId !== this.host.id) throw new Error("Git submission project belongs to another host."); }
    else { const session = this.getSession(target.sessionId); if (!session || session.hostId !== this.host.id) throw new Error("Git submission session belongs to another host."); }
    return target;
  }
  private gitSubmissionOwnerKey(target: GitSubmissionTarget): string { return "projectId" in target ? `project:${target.projectId}` : `session:${target.sessionId}`; }
  private readGitSubmission(id: string): GitSubmissionReceipt | undefined { return this.readMetadata<GitSubmissionReceipt>(`${gitSubmissionPrefix}${id}`); }
  private requiredGitSubmission(id: string, requestHash: string): GitSubmissionReceipt {
    const command = this.getCommand(id);
    const receipt = this.readGitSubmission(id);
    if (!receipt || !command || command.requestHash !== requestHash || command.command?.type !== "workspace.mutate" || command.command.action.type !== "git.submit") throw new Error("Unknown Git submission.");
    return receipt;
  }

  recordBrowserContinuation(input: { commandId: string; sessionId: string; ownerId: string; pages: readonly { name:string; targetId:string; backend:"worker"|"cmux"; operationId:string }[] }): void {
    this.db.transaction(() => {
      const command=this.getCommand(input.commandId);
      if(!command||command.command?.type!=="session.create"||!command.command.browserContinuation) throw new Error("Browser continuation lost its command or session owner.");
      const current=this.readMetadata<unknown>(`browser-continuation.v1:${input.sessionId}`);
      if(current&&typeof current==="object"&&(current as {version?:unknown}).version===2){
        const recovery=parseBrowserRecoveryRecord(current);
        if(recovery.commandId!==input.commandId||recovery.sessionId!==input.sessionId||recovery.ownerId!==input.ownerId)
          throw new Error("Browser continuation changed its recovery owner.");
        return;
      }
      this.requireVersion(21);
      this.writeMetadata(`browser-continuation.v1:${input.sessionId}`, {version:1,hostId:this.host.id,...input,recordedAt:Date.now()});
    }).immediate();
  }

  recordBrowserRecovery(input: BrowserRecoveryRecord): void {
    const record=parseBrowserRecoveryRecord(input);
    this.db.transaction(()=>{
      const command=this.getCommand(record.commandId);
      if(!command||command.command?.type!=="session.create"||!command.command.browserContinuation||record.hostId!==this.host.id)throw new Error("Browser recovery lost its durable command owner.");
      const existing=this.readMetadata<unknown>(`browser-continuation.v1:${record.sessionId}`);
      if(existing&&typeof existing==="object"&&(existing as {version?:unknown}).version===2){
        const current=parseBrowserRecoveryRecord(existing);
        const endpoint=(value:BrowserRecoveryRecord["source"])=>({version:value.version,pid:value.pid,instanceId:value.instanceId,socketPath:value.socketPath,token:value.token});
        const stable=(value:BrowserRecoveryRecord)=>JSON.stringify({hostId:value.hostId,commandId:value.commandId,sessionId:value.sessionId,ownerId:value.ownerId,
          source:endpoint(value.source),destination:endpoint(value.destination),bindings:value.bindings.map(binding=>({workerPid:binding.workerPid,name:binding.name,
            targetId:binding.targetId,ownerId:binding.ownerId,operationId:binding.operationId,backend:binding.backend}))});
        if(stable(current)!==stable(record)||current.status==="ready"&&record.status!=="ready")throw new Error("Browser recovery changed its durable native owner.");
      }
      const policy=this.getDeviceAccessPolicy();
      if(this.readMetadata("device-access.v1")===undefined)this.writeMetadata("device-access.v1",policy);
      this.requireVersion(22);
      this.writeMetadata(`browser-continuation.v1:${record.sessionId}`,record);
    }).immediate();
  }

  /** Bind a recovered native session and the original create receipt together.
   * The browser recovery record remains until both retained workers are retired. */
  finishBrowserRecoveredSession(commandId:string,session:SessionSummary):CommandResult{
    return this.db.transaction(()=>{
      const command=this.getCommand(commandId);
      if(!command||command.state!=="pending"||command.command?.type!=="session.create"||!command.command.browserContinuation)
        throw new Error("Browser recovery lost its pending creation command.");
      if(session.id!==this.listBrowserRecoveries().find(record=>record.commandId===commandId)?.sessionId)
        throw new Error("Recovered browser session differs from its durable owner.");
      const value=this.upsertSession(session);
      const result:CommandResult={ok:true,commandId,value};
      this.finishCommand(commandId,command.requestHash,result);
      return result;
    }).immediate();
  }

  listBrowserRecoveries():readonly BrowserRecoveryRecord[]{
    return this.db.query<{data:string},[]>("SELECT data FROM metadata WHERE key LIKE 'browser-continuation.v1:%'").all().flatMap(row=>{
      let value:unknown;try{value=JSON.parse(row.data)}catch{throw new Error("Invalid browser recovery record.")}
      return value&&typeof value==="object"&&(value as {version?:unknown}).version===2?[parseBrowserRecoveryRecord(value)]:[];
    });
  }

  removeBrowserRecovery(sessionId:string):void{this.db.query("DELETE FROM metadata WHERE key = ?").run(`browser-continuation.v1:${sessionId}`);}

  private recoverInterruptedBrowserContinuations(): void {
    const rows=this.db.query<{data:string},[]>("SELECT data FROM metadata WHERE key LIKE 'browser-continuation.v1:%'").all();
    for(const row of rows){
      let value:{version?:unknown;hostId?:unknown;sessionId?:unknown};
      try{value=JSON.parse(row.data);}catch{throw new Error("Invalid browser continuation recovery record.");}
      if(value.version===2)continue;
      if(value.version!==1||value.hostId!==this.host.id||typeof value.sessionId!=="string")throw new Error("Invalid browser continuation recovery owner.");
      const session=this.getSession(value.sessionId); if(!session)continue;
      this.db.query("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify({...session,status:"error",error:"The host restarted after this conversation inherited a live browser. Browser authority was not reacquired; inspect the original browser and start a new tab before continuing.",updatedAt:Date.now()}),session.id);
    }
  }

  private requireRemoteStartingVersion(): void {
    // Preserve the existing default policy before crossing the policy-required floor.
    const policy = this.getDeviceAccessPolicy();
    if (this.readMetadata("device-access.v1") === undefined) this.writeMetadata("device-access.v1", policy);
    this.requireVersion(18);
  }

  /** Never downgrade: old hosts must refuse even after an override is cleared. */
  private requirePermissionVersion(): void { this.requireVersion(2); }
  private requireVersion(minimum: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26): void {
    const current = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (current > 26) throw new Error(`Unsupported host state schema version ${current}`);
    if (current < minimum) this.db.exec(`PRAGMA user_version = ${minimum}`);
  }
}

function withinPath(parent: string, path: string): boolean {
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function phaseAllowed(operation: GitSubmissionReceipt["operation"], previous: GitSubmissionReceipt["phase"], next: GitSubmissionReceipt["phase"]): boolean {
  if (previous === next) return true;
  if (operation === "push") return previous === "queued" && next === "pushing";
  if (previous === "queued") return next === "branch" || next === "preparing";
  if (previous === "branch") return next === "preparing";
  if (previous === "preparing") return next === "generating" || next === "committing";
  if (previous === "generating") return next === "committing";
  return previous === "committing" && operation === "commit-and-push" && next === "pushing";
}
function successfulGitSubmission(receipt: GitSubmissionReceipt): boolean {
  const pushConfirmed = receipt.push?.outcome === "succeeded" && receipt.push.applied.remote === "confirmed"
    && (receipt.push.upstreamRequested ? receipt.push.applied.upstream === "configured" : receipt.push.applied.upstream === "not-requested");
  if (receipt.operation === "push") return receipt.phase === "pushing" && pushConfirmed;
  if (!receipt.commit || receipt.phase !== (receipt.operation === "commit-and-push" ? "pushing" : "committing")) return false;
  return receipt.operation === "commit" || pushConfirmed && receipt.push?.sourceCommit === receipt.commit.commit;
}
function preserve<T>(previous: T | undefined, next: T | undefined, name: string): T | undefined {
  if (previous !== undefined && next !== undefined && JSON.stringify(previous) !== JSON.stringify(next)) throw new Error(`Git submission cannot replace its recorded ${name}.`);
  return previous ?? next;
}
function mergeGitSubmission(receipt: GitSubmissionReceipt, update: GitSubmissionAdvance): GitSubmissionReceipt {
  return { ...receipt, ...(update.phase ? { phase: update.phase } : {}), ...(update.progress !== undefined ? { progress: update.progress } : {}),
    ...(preserve(receipt.generatedMessage, update.generatedMessage, "generated message") ? { generatedMessage: preserve(receipt.generatedMessage, update.generatedMessage, "generated message") } : {}),
    ...(preserve(receipt.branch, update.branch, "branch") ? { branch: preserve(receipt.branch, update.branch, "branch") } : {}),
    ...(preserve(receipt.commit, update.commit, "commit") ? { commit: preserve(receipt.commit, update.commit, "commit") } : {}),
    ...(preserve(receipt.push, update.push, "push") ? { push: preserve(receipt.push, update.push, "push") } : {}) };
}
