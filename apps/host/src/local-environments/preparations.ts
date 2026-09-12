import { parseWorktreeStartingState } from '../../../../packages/shared/src/new-chat';
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseLocalEnvironment, type LocalEnvironmentExecutionOutput, type LocalEnvironmentPreparationPhase, type LocalEnvironmentPreparationPublic, type LocalEnvironmentUncertainOperation, type ModelChoice, type OmpApprovalMode, type WorktreeStartingState } from "@agent-desktop/shared";
import type { LocalEnvironmentEnvironmentDelta, LocalEnvironmentRunResult } from "./runner";
import { validateWorktreeDirectoryContext, type WorktreeDirectoryContext } from "./worktree-directories";

export type { LocalEnvironmentPreparationPhase, LocalEnvironmentPreparationPublic, LocalEnvironmentUncertainOperation } from "@agent-desktop/shared";

export interface LocalEnvironmentConfigSnapshot {
  configPath: string;
  revision: string;
  /** Exact validated bytes. Host-private because scripts may contain secrets. */
  raw: string;
}

type StoredRunResult = Omit<LocalEnvironmentRunResult, "environmentDelta">;

interface LocalEnvironmentPreparationBase {
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

export interface LocalEnvironmentPreparationV1 extends LocalEnvironmentPreparationBase {
  version: 1;
  directories?: never;
  selectedEnvironment?: never;
}

export interface LocalEnvironmentPreparationV2 extends LocalEnvironmentPreparationBase {
  version: 2;
  directories: WorktreeDirectoryContext;
  /** Original source selection retained even when materialization changes the effective environment. */
  selectedEnvironment: LocalEnvironmentConfigSnapshot | null;
}

export type LocalEnvironmentPreparation = LocalEnvironmentPreparationV1 | LocalEnvironmentPreparationV2;

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
  /** Presence creates a version-2 preparation and requires a materialized environment receipt. */
  directories?: WorktreeDirectoryContext;
}

export type LocalEnvironmentPreparationTransition =
  | { type: "outcome.unknown" }
  | { type: "worktree-create.started" }
  | { type: "worktree-create.succeeded"; worktreePath: string; materializedEnvironment?: LocalEnvironmentConfigSnapshot | null }
  | { type: "setup.started" }
  | { type: "setup.failed"; result: LocalEnvironmentRunResult }
  | { type: "setup.succeeded"; result: LocalEnvironmentRunResult }
  | { type: "native-create.started" }
  | { type: "native-create.succeeded"; sessionId: string }
  | { type: "cleanup.started" }
  | { type: "cleanup.failed"; result: LocalEnvironmentRunResult }
  | { type: "cleanup.succeeded"; result?: LocalEnvironmentRunResult }
  | { type: "removed" };

type Row = { data: string };
type OutputRow = { data: string };
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
function directorySnapshot(value: WorktreeDirectoryContext, sourceRoot: string, selected: LocalEnvironmentConfigSnapshot | null): WorktreeDirectoryContext {
  const directories = validateWorktreeDirectoryContext(value);
  if (directories.sourceWorkspaceRoot !== sourceRoot) throw new Error("Preparation source root differs from its directory context.");
  if (selected === null) {
    if (directories.configCwdRelativePath !== null) throw new Error("An environment owner was captured without an environment selection.");
    return structuredClone(directories);
  }
  if (directories.configCwdRelativePath === null) throw new Error("The selected environment has no captured config owner.");
  const relativeConfig = relative(directories.sourceGitRoot, selected.configPath);
  const owner = directories.configCwdRelativePath;
  const allowed = [".agent-desktop", ".codex"].some(namespace => {
    const directory = joinRelative(owner, namespace, "environments");
    return relativeConfig.startsWith(`${directory}${sep}`) && !relativeConfig.slice(directory.length + 1).includes(sep)
      && relativeConfig.endsWith(".toml");
  });
  if (!allowed) throw new Error("The selected environment does not match its captured config owner.");
  return structuredClone(directories);
}
function joinRelative(...parts: string[]): string {
  return parts.filter(Boolean).join(sep);
}
function materializedSnapshot(current: LocalEnvironmentPreparationV2, value: LocalEnvironmentConfigSnapshot | null): LocalEnvironmentConfigSnapshot | null {
  if (value === null) return null;
  if (!current.selectedEnvironment) throw new Error("A materialized environment cannot appear without an original selection.");
  const capturedRelative = relative(current.directories.sourceGitRoot, current.selectedEnvironment.configPath);
  const mapped = resolve(current.worktreePath, capturedRelative);
  if (value.configPath !== current.selectedEnvironment.configPath && value.configPath !== mapped)
    throw new Error("Materialized environment path differs from the captured source mapping.");
  if (value.configPath === current.selectedEnvironment.configPath
      && (value.revision !== current.selectedEnvironment.revision || value.raw !== current.selectedEnvironment.raw))
    throw new Error("Materialized source environment differs from its captured snapshot.");
  const ownerRoot = value.configPath === current.selectedEnvironment.configPath ? current.directories.sourceGitRoot : current.worktreePath;
  return configSnapshot(value, ownerRoot);
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
  ); CREATE INDEX IF NOT EXISTS local_environment_preparations_project ON local_environment_preparations(host_id, project_id);
  CREATE TABLE IF NOT EXISTS local_environment_execution_output (
    preparation_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    run_revision INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (preparation_id, host_id)
  ); CREATE INDEX IF NOT EXISTS local_environment_execution_output_host ON local_environment_execution_output(host_id);`);
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
    const directoriesInput = input.directories;
    const selectedEnvironment = configSnapshot(input.environment, directoriesInput ? directoriesInput.sourceGitRoot : sourceRoot);
    const directories = directoriesInput ? directorySnapshot(directoriesInput, sourceRoot, selectedEnvironment) : undefined;
    const now = Date.now(), base: LocalEnvironmentPreparationBase = {
      id: identifier(input.id, "Preparation identity"), revision: 1, hostId: this.hostId,
      projectId: identifier(input.projectId, "Project identity"), sourceRoot, worktreePath,
      startingState: parseWorktreeStartingState(input.startingState), draft: { id: identifier(input.draft.id, "Draft identity"), revision: input.draft.revision },
      ...(input.model ? { model: structuredClone(input.model) } : {}), ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
      environment: selectedEnvironment, phase: "validated", createdAt: now, updatedAt: now,
    };
    const record: LocalEnvironmentPreparation = directories
      ? { ...base, version: 2, directories, selectedEnvironment }
      : { ...base, version: 1 };
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

  getOutput(id: string): LocalEnvironmentExecutionOutput | null {
    const row = this.database.query<OutputRow, [string, string]>("SELECT data FROM local_environment_execution_output WHERE preparation_id = ? AND host_id = ?").get(id, this.hostId);
    return row ? JSON.parse(row.data) as LocalEnvironmentExecutionOutput : null;
  }

  beginOutput(record: LocalEnvironmentPreparation, lifecycle: "setup" | "cleanup"): LocalEnvironmentExecutionOutput {
    if (record.hostId !== this.hostId) throw new Error("Preparation belongs to another host.");
    const expectedPhase = lifecycle === "setup" ? "setup-running" : "cleanup-running";
    return this.database.transaction(() => {
      const current = this.get(record.id);
      if (!current || current.revision !== record.revision || current.phase !== expectedPhase)
        throw new LocalEnvironmentPreparationConflict(current);
      const prior = this.getOutput(record.id);
      if (prior && (!prior.finished || prior.runRevision === record.revision))
        throw new Error("This local-environment run was already dispatched.");
      const output: LocalEnvironmentExecutionOutput = {
        preparationId: record.id, runRevision: record.revision, lifecycle, sequence: 0,
        stdout: "", stderr: "", truncated: false, cancellationRequested: false, finished: false,
      };
      this.database.query("INSERT INTO local_environment_execution_output (preparation_id, host_id, run_revision, data) VALUES (?, ?, ?, ?) ON CONFLICT(preparation_id, host_id) DO UPDATE SET run_revision = excluded.run_revision, data = excluded.data")
        .run(record.id, this.hostId, record.revision, JSON.stringify(output));
      return output;
    }).immediate();
  }

  updateOutput(
    id: string,
    runRevision: number,
    update: (current: LocalEnvironmentExecutionOutput) => LocalEnvironmentExecutionOutput,
  ): LocalEnvironmentExecutionOutput {
    return this.database.transaction(() => {
      const current = this.getOutput(id);
      if (!current || current.runRevision !== runRevision) throw new Error("The local-environment run changed.");
      if (current.finished) throw new Error("The local-environment run already finished.");
      const next = update(structuredClone(current));
      if (next.preparationId !== id || next.runRevision !== runRevision || next.lifecycle !== current.lifecycle)
        throw new Error("Local-environment output identity cannot change.");
      if (next.sequence !== current.sequence + 1) throw new Error("Local-environment output sequence must advance exactly once.");
      if ((current.cancellationRequested && !next.cancellationRequested) || (current.truncated && !next.truncated))
        throw new Error("Local-environment output flags cannot be cleared.");
      if (Buffer.byteLength(next.stdout) + Buffer.byteLength(next.stderr) > 8 * 1024 * 1024)
        throw new Error("Local-environment output exceeds 8 MiB.");
      const changed = this.database.query("UPDATE local_environment_execution_output SET data = ? WHERE preparation_id = ? AND host_id = ? AND run_revision = ?")
        .run(JSON.stringify(next), id, this.hostId, runRevision);
      if (changed.changes !== 1) throw new Error("The local-environment run changed.");
      return structuredClone(next);
    }).immediate();
  }

  transition(id: string, expectedRevision: number, transition: LocalEnvironmentPreparationTransition): LocalEnvironmentPreparation {
    const current = this.get(id);
    if (!current || current.revision !== expectedRevision) throw new LocalEnvironmentPreparationConflict(current);
    const next = this.apply(current, transition);
    next.revision++; next.updatedAt = Date.now(); if (next.phase !== "unknown") delete next.uncertainOperation;
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
      case "outcome.unknown": {
        const operation = dispatched.get(current.phase);
        if (!operation) throw new Error("Only a dispatched operation can become unknown.");
        next.phase = "unknown"; next.uncertainOperation = operation; break;
      }
      case "worktree-create.started": require("validated"); next.phase = "worktree-creating"; break;
      case "worktree-create.succeeded":
        require("worktree-creating");
        if (absolute(transition.worktreePath, "Created worktree path") !== current.worktreePath) throw new Error("Created worktree path differs from the captured target.");
        if (current.version === 2) {
          if (!("materializedEnvironment" in transition) || transition.materializedEnvironment === undefined)
            throw new Error("Version-2 preparation requires a materialized environment receipt.");
          next.environment = materializedSnapshot(current, transition.materializedEnvironment ?? null);
        } else if ("materializedEnvironment" in transition) throw new Error("Legacy preparation cannot accept a materialized environment receipt.");
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
