import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseLocalEnvironment, type ModelChoice, type OmpApprovalMode, type WorktreeStartingState } from "@agent-desktop/shared";
import type { LocalEnvironmentEnvironmentDelta, LocalEnvironmentRunResult } from "./runner";

export type LocalEnvironmentPreparationPhase =
  | "validated" | "worktree-creating" | "worktree-created"
  | "setup-running" | "setup-failed" | "setup-succeeded"
  | "native-creating" | "session-created"
  | "cleanup-running" | "cleanup-failed" | "cleanup-succeeded"
  | "removed" | "unknown";
export type LocalEnvironmentUncertainOperation = "worktree-create" | "setup" | "native-create" | "cleanup";

export interface LocalEnvironmentConfigSnapshot {
  configPath: string;
  revision: string;
  /** Exact validated bytes. Host-private because scripts may contain secrets. */
  raw: string;
}

type StoredRunResult = Omit<LocalEnvironmentRunResult, "environmentDelta">;

export interface LocalEnvironmentPreparation {
  version: 1;
  id: string;
  revision: number;
  hostId: string;
  projectId: string;
  sourceRoot: string;
  worktreePath: string;
  startingState: WorktreeStartingState;
  draft: { id: string; revision: number };
  model?: ModelChoice;
  approvalMode?: OmpApprovalMode;
  environment: LocalEnvironmentConfigSnapshot | null;
  phase: LocalEnvironmentPreparationPhase;
  uncertainOperation?: LocalEnvironmentUncertainOperation;
  setupResult?: StoredRunResult;
  cleanupResult?: StoredRunResult;
  /** Host-private; never include this object in transport projections. */
  environmentDelta?: LocalEnvironmentEnvironmentDelta | null;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LocalEnvironmentPreparationInput {
  id: string;
  projectId: string;
  sourceRoot: string;
  worktreePath: string;
  startingState: WorktreeStartingState;
  draft: { id: string; revision: number };
  model?: ModelChoice;
  approvalMode?: OmpApprovalMode;
  environment: LocalEnvironmentConfigSnapshot | null;
}

export type LocalEnvironmentPreparationTransition =
  | { type: "worktree-create.started" }
  | { type: "worktree-create.succeeded"; worktreePath: string }
  | { type: "setup.started" }
  | { type: "setup.failed"; result: LocalEnvironmentRunResult }
  | { type: "setup.succeeded"; result: LocalEnvironmentRunResult }
  | { type: "native-create.started" }
  | { type: "native-create.succeeded"; sessionId: string }
  | { type: "cleanup.started" }
  | { type: "cleanup.failed"; result: LocalEnvironmentRunResult }
  | { type: "cleanup.succeeded"; result?: LocalEnvironmentRunResult }
  | { type: "removed" };

export interface LocalEnvironmentPreparationPublic {
  id: string;
  revision: number;
  hostId: string;
  projectId: string;
  worktreePath: string;
  phase: LocalEnvironmentPreparationPhase;
  uncertainOperation?: LocalEnvironmentUncertainOperation;
  needsAttention: boolean;
  environment: null | { configPath: string; revision: string; name: string };
  setup?: Pick<StoredRunResult, "status" | "cancelReason" | "exitCode" | "signal" | "startedAt" | "finishedAt" | "outputTruncated">;
  cleanup?: Pick<StoredRunResult, "status" | "cancelReason" | "exitCode" | "signal" | "startedAt" | "finishedAt" | "outputTruncated">;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
}

type Row = { data: string };
const revisionPattern = /^[a-f0-9]{64}$/;
const dispatched = new Map<LocalEnvironmentPreparationPhase, LocalEnvironmentUncertainOperation>([
  ["worktree-creating", "worktree-create"], ["setup-running", "setup"], ["native-creating", "native-create"], ["cleanup-running", "cleanup"],
]);
const approvalModes = new Set<OmpApprovalMode>(["always-ask", "write", "yolo"]);

function identifier(value: string, label: string): string {
  if (typeof value !== "string" || !value || value.length > 500 || value.includes("\0")) throw new Error(`${label} is invalid.`);
  return value;
}
function absolute(value: string, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) throw new Error(`${label} must be a normalized absolute path.`);
  return value;
}
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function configSnapshot(value: LocalEnvironmentConfigSnapshot | null, sourceRoot: string): LocalEnvironmentConfigSnapshot | null {
  if (value === null) return null;
  const configPath = absolute(value.configPath, "Environment config path");
  if (!inside(sourceRoot, configPath)) throw new Error("Environment config must belong to its source project.");
  if (Buffer.byteLength(value.raw) > 1024 * 1024) throw new Error("Environment config exceeds 1 MiB.");
  if (!revisionPattern.test(value.revision) || createHash("sha256").update(value.raw).digest("hex") !== value.revision) throw new Error("Environment config revision does not match its exact bytes.");
  parseLocalEnvironment(value.raw);
  return { configPath, revision: value.revision, raw: value.raw };
}
function startingState(value: WorktreeStartingState): WorktreeStartingState {
  if (value?.type === "working-tree") return { type: "working-tree" };
  if (value?.type === "branch" && typeof value.branchName === "string" && value.branchName.length > 0 && value.branchName.length <= 500 && !value.branchName.includes("\0")) return { type: "branch", branchName: value.branchName };
  throw new Error("Invalid worktree starting state.");
}
function storedResult(result: LocalEnvironmentRunResult, expected: "succeeded" | "failed"): StoredRunResult {
  if (expected === "succeeded" ? result.status !== "succeeded" : result.status === "succeeded") throw new Error(`Environment lifecycle result must be ${expected}.`);
  const { environmentDelta: _privateDelta, ...stored } = structuredClone(result);
  return stored;
}
function delta(value: LocalEnvironmentEnvironmentDelta | null): LocalEnvironmentEnvironmentDelta | null {
  if (value === null) return null;
  if (value.version !== 1 || !value.set || typeof value.set !== "object" || Array.isArray(value.set) || !Array.isArray(value.unset)) throw new Error("Invalid environment delta.");
  const set: Record<string, string> = {};
  let bytes = 0;
  for (const [key, item] of Object.entries(value.set)) {
    if (!key || key.includes("=") || key.includes("\0") || typeof item !== "string" || item.includes("\0")) throw new Error("Invalid environment delta.");
    bytes += Buffer.byteLength(key) + Buffer.byteLength(item); set[key] = item;
  }
  const unset = value.unset.map(key => {
    identifier(key, "Environment variable");
    if (key.includes("=")) throw new Error("Invalid environment delta.");
    return key;
  });
  bytes += unset.reduce((sum, key) => sum + Buffer.byteLength(key), 0);
  if (bytes > 4 * 1024 * 1024) throw new Error("Environment delta exceeds 4 MiB.");
  return { version: 1, set, unset };
}
function publicRun(value?: StoredRunResult): LocalEnvironmentPreparationPublic["setup"] {
  if (!value) return undefined;
  return { status: value.status, ...(value.cancelReason ? { cancelReason: value.cancelReason } : {}), exitCode: value.exitCode, signal: value.signal,
    startedAt: value.startedAt, finishedAt: value.finishedAt, outputTruncated: value.outputTruncated };
}

export class LocalEnvironmentPreparationConflict extends Error {
  constructor(readonly current: LocalEnvironmentPreparation | undefined) { super("The local-environment preparation changed. Refresh before acting again."); }
}

/** Install only from the owning HostStore schema migration/initialization path. */
export function initializeLocalEnvironmentPreparations(database: Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS local_environment_preparations (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL,
    data TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS local_environment_preparations_project ON local_environment_preparations(host_id, project_id);`);
}

/** Synchronous host-private CAS storage. External effects are performed by its caller. */
export class LocalEnvironmentPreparations {
  constructor(private database: Database, readonly hostId: string) { identifier(hostId, "Host identity"); }

  create(input: LocalEnvironmentPreparationInput): LocalEnvironmentPreparation {
    const sourceRoot = absolute(input.sourceRoot, "Source root"), worktreePath = absolute(input.worktreePath, "Worktree path");
    if (sourceRoot === worktreePath) throw new Error("Worktree path must differ from the source root.");
    if (!Number.isSafeInteger(input.draft.revision) || input.draft.revision < 0) throw new Error("Draft revision is invalid.");
    if (input.model && (!input.model.provider || !input.model.id || input.model.provider.includes("\0") || input.model.id.includes("\0"))) throw new Error("Model choice is invalid.");
    if (input.approvalMode !== undefined && !approvalModes.has(input.approvalMode)) throw new Error("Approval mode is invalid.");
    const now = Date.now(), record: LocalEnvironmentPreparation = {
      version: 1, id: identifier(input.id, "Preparation identity"), revision: 1, hostId: this.hostId,
      projectId: identifier(input.projectId, "Project identity"), sourceRoot, worktreePath,
      startingState: startingState(input.startingState), draft: { id: identifier(input.draft.id, "Draft identity"), revision: input.draft.revision },
      ...(input.model ? { model: structuredClone(input.model) } : {}), ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
      environment: configSnapshot(input.environment, sourceRoot), phase: "validated", createdAt: now, updatedAt: now,
    };
    this.database.query("INSERT INTO local_environment_preparations (id, host_id, project_id, worktree_path, revision, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.id, record.hostId, record.projectId, record.worktreePath, record.revision, JSON.stringify(record));
    return structuredClone(record);
  }

  get(id: string): LocalEnvironmentPreparation | undefined {
    const row = this.database.query<Row, [string, string]>("SELECT data FROM local_environment_preparations WHERE id = ? AND host_id = ?").get(id, this.hostId);
    return row ? JSON.parse(row.data) as LocalEnvironmentPreparation : undefined;
  }

  list(projectId?: string): LocalEnvironmentPreparation[] {
    const rows = projectId === undefined
      ? this.database.query<Row, [string]>("SELECT data FROM local_environment_preparations WHERE host_id = ? ORDER BY rowid").all(this.hostId)
      : this.database.query<Row, [string, string]>("SELECT data FROM local_environment_preparations WHERE host_id = ? AND project_id = ? ORDER BY rowid").all(this.hostId, projectId);
    return rows.map(row => JSON.parse(row.data) as LocalEnvironmentPreparation);
  }

  transition(id: string, expectedRevision: number, transition: LocalEnvironmentPreparationTransition): LocalEnvironmentPreparation {
    const current = this.get(id);
    if (!current || current.revision !== expectedRevision) throw new LocalEnvironmentPreparationConflict(current);
    const next = this.apply(current, transition);
    next.revision++; next.updatedAt = Date.now(); delete next.uncertainOperation;
    const result = this.database.query("UPDATE local_environment_preparations SET revision = ?, data = ? WHERE id = ? AND host_id = ? AND revision = ?")
      .run(next.revision, JSON.stringify(next), id, this.hostId, expectedRevision);
    if (result.changes !== 1) throw new LocalEnvironmentPreparationConflict(this.get(id));
    return structuredClone(next);
  }

  /** Call once from actual host startup. This records uncertainty and performs no external replay. */
  reconcileInterrupted(): LocalEnvironmentPreparation[] {
    return this.database.transaction(() => {
      const changed: LocalEnvironmentPreparation[] = [];
      for (const current of this.list()) {
        const operation = dispatched.get(current.phase);
        if (!operation) continue;
        const next = { ...current, phase: "unknown" as const, uncertainOperation: operation, revision: current.revision + 1, updatedAt: Date.now() };
        const result = this.database.query("UPDATE local_environment_preparations SET revision = ?, data = ? WHERE id = ? AND host_id = ? AND revision = ?")
          .run(next.revision, JSON.stringify(next), next.id, this.hostId, current.revision);
        if (result.changes !== 1) throw new LocalEnvironmentPreparationConflict(this.get(next.id));
        changed.push(structuredClone(next));
      }
      return changed;
    }).immediate();
  }

  public(record: LocalEnvironmentPreparation): LocalEnvironmentPreparationPublic {
    if (record.hostId !== this.hostId) throw new Error("Preparation belongs to another host.");
    const parsed = record.environment ? parseLocalEnvironment(record.environment.raw) : undefined;
    return {
      id: record.id, revision: record.revision, hostId: record.hostId, projectId: record.projectId, worktreePath: record.worktreePath,
      phase: record.phase, ...(record.uncertainOperation ? { uncertainOperation: record.uncertainOperation } : {}),
      needsAttention: record.phase === "setup-failed" || record.phase === "cleanup-failed" || record.phase === "unknown",
      environment: record.environment && parsed ? { configPath: record.environment.configPath, revision: record.environment.revision, name: parsed.name } : null,
      ...(record.setupResult ? { setup: publicRun(record.setupResult)! } : {}), ...(record.cleanupResult ? { cleanup: publicRun(record.cleanupResult)! } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}), createdAt: record.createdAt, updatedAt: record.updatedAt,
    };
  }

  private apply(current: LocalEnvironmentPreparation, transition: LocalEnvironmentPreparationTransition): LocalEnvironmentPreparation {
    const next = structuredClone(current), require = (...phases: LocalEnvironmentPreparationPhase[]) => {
      if (!phases.includes(current.phase)) throw new Error(`Cannot apply ${transition.type} while preparation is ${current.phase}.`);
    };
    switch (transition.type) {
      case "worktree-create.started": require("validated"); next.phase = "worktree-creating"; break;
      case "worktree-create.succeeded":
        require("worktree-creating");
        if (absolute(transition.worktreePath, "Created worktree path") !== current.worktreePath) throw new Error("Created worktree path differs from the captured target.");
        next.phase = "worktree-created"; break;
      case "setup.started": require("worktree-created", "setup-failed"); if (!current.environment) throw new Error("No environment setup was selected."); next.phase = "setup-running"; break;
      case "setup.failed": require("setup-running"); next.setupResult = storedResult(transition.result, "failed"); next.environmentDelta = null; next.phase = "setup-failed"; break;
      case "setup.succeeded": require("setup-running"); next.setupResult = storedResult(transition.result, "succeeded"); next.environmentDelta = delta(transition.result.environmentDelta); next.phase = "setup-succeeded"; break;
      case "native-create.started": require(current.environment ? "setup-succeeded" : "worktree-created"); next.phase = "native-creating"; break;
      case "native-create.succeeded": require("native-creating"); next.sessionId = identifier(transition.sessionId, "Session identity"); next.phase = "session-created"; break;
      case "cleanup.started": require("worktree-created", "setup-failed", "setup-succeeded", "session-created", "cleanup-failed"); next.phase = "cleanup-running"; break;
      case "cleanup.failed": require("cleanup-running"); next.cleanupResult = storedResult(transition.result, "failed"); next.phase = "cleanup-failed"; break;
      case "cleanup.succeeded": require("cleanup-running"); if (transition.result) next.cleanupResult = storedResult(transition.result, "succeeded"); next.phase = "cleanup-succeeded"; break;
      case "removed": require("cleanup-succeeded"); next.phase = "removed"; break;
    }
    return next;
  }
}
