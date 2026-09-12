import type { ModelChoice } from './protocol';
import type { OmpApprovalMode } from './settings';
import { parseNewChatExecution, type NewChatExecution } from './new-chat';
import { parseEnvironmentSelection, type LocalEnvironmentSelection } from './environment-selection';

export const AUTOMATIONS_CAPABILITY = 'local-automations-v1';
export const AUTOMATIONS_OWNER_HEADER = 'X-Agent-Automations-Host';
export type AutomationStatus = 'active' | 'paused' | 'deleted';
export type AutomationNotificationPolicy = 'all' | 'failed-runs-only';

/** The owner host resolves identifiers through its own catalog; paths are never supplied by the client. */
export type AutomationDestination =
  | { kind: 'heartbeat'; sessionId: string }
  | { kind: 'cron'; projectId: string | null; execution: NewChatExecution;
      environment: LocalEnvironmentSelection; model: ModelChoice; thinkingLevel: string | null;
      approvalMode: OmpApprovalMode | null };

/** Saving creates the original empty conversation once; subsequent runs continue its resolved ID. */
export type AutomationInputDestination = AutomationDestination | (Omit<Extract<AutomationDestination, { kind: 'cron' }>, 'kind' | 'model'> & { kind: 'heartbeat-new'; model: ModelChoice | null });

export interface AutomationInput {
  name: string;
  prompt: string;
  rrule: string;
  destination: AutomationInputDestination;
  notificationPolicy: AutomationNotificationPolicy;
  status: 'active' | 'paused';
}

export interface Automation extends Omit<AutomationInput, 'status' | 'destination'> {
  destination: AutomationDestination;
  id: string;
  hostId: string;
  revision: number;
  status: AutomationStatus;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
}

export type AutomationRunStatus = 'reserved' | 'running' | 'completed' | 'failed' | 'unknown' | 'skipped';
/** A run keeps its admitted task snapshot even when the task is subsequently edited or deleted. */
export interface AutomationRun {
  id: string;
  hostId: string;
  automationId: string;
  automationRevision: number;
  automationName: string;
  prompt: string;
  destination: AutomationDestination;
  notificationPolicy: AutomationNotificationPolicy;
  scheduledFor: number;
  trigger: 'schedule' | 'manual';
  status: AutomationRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  sessionId: string | null;
  createCommandId: string;
  promptCommandId: string;
  error: string | null;
  readAt: number | null;
  archivedAt: number | null;
}

export interface AutomationsSnapshot {
  hostId: string;
  tasks: Automation[];
  runs: AutomationRun[];
  nextRunCursor: string | null;
}

export interface AutomationMutationResult {
  hostId: string;
  requestId: string;
  task: Automation | null;
  run: AutomationRun | null;
  snapshot: AutomationsSnapshot;
}

export interface AutomationsQuery { automationId?: string; before?: string }
export interface AutomationsBridge {
  list(hostId: string, query?: AutomationsQuery): Promise<AutomationsSnapshot>;
  mutate(hostId: string, mutation: AutomationMutation): Promise<AutomationMutationResult>;
}

export type AutomationMutation =
  | { type: 'save'; requestId: string; id: string; expectedRevision: number; input: AutomationInput }
  | { type: 'delete' | 'run'; requestId: string; id: string; expectedRevision: number }
  | { type: 'history'; requestId: string; runId: string; read: boolean; archived: boolean };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  return text(value, label, 256);
}

export function parseAutomationDestination(value: unknown): AutomationDestination {
  const item = record(value, 'automation destination');
  if (item.kind === 'heartbeat') return { kind: 'heartbeat', sessionId: identifier(item.sessionId, 'original conversation') };
  if (item.kind !== 'cron') throw new Error('Select an original conversation or a new task.');
  const creation = parseCreationDestination(item);
  if (!creation.model) throw new Error('Choose a model for new tasks.');
  return { kind: 'cron', ...creation, model: creation.model };
}

function parseCreationDestination(item: Record<string, unknown>): Omit<Extract<AutomationInputDestination, { kind: 'heartbeat-new' }>, 'kind'> {
  const projectId = item.projectId === null ? null : identifier(item.projectId, 'automation project');
  const model = item.model === null ? null : record(item.model, 'automation model');
  const thinkingLevel = item.thinkingLevel === null ? null : text(item.thinkingLevel, 'reasoning effort', 64);
  const approvalMode = item.approvalMode;
  if (approvalMode !== null && approvalMode !== 'always-ask' && approvalMode !== 'write' && approvalMode !== 'yolo') throw new Error('Invalid automation permission mode.');
  const execution = parseNewChatExecution(item.execution, projectId);
  const environment = parseEnvironmentSelection(item.environment, projectId);
  if (execution.type === 'local' && environment !== null) throw new Error('Select an environment only for a worktree task.');
  return { projectId, execution, environment,
    model: model === null ? null : { provider: text(model.provider, 'model provider', 256), id: text(model.id, 'model identifier', 512) }, thinkingLevel, approvalMode };
}

/** Recurrence semantics and native model/target availability are validated by the host before saving. */
export function parseAutomationInput(value: unknown): AutomationInput {
  const item = record(value, 'automation');
  if (item.status !== 'active' && item.status !== 'paused') throw new Error('Invalid automation status.');
  if (item.notificationPolicy !== 'all' && item.notificationPolicy !== 'failed-runs-only') throw new Error('Invalid automation notification policy.');
  const rawDestination = record(item.destination, 'automation destination');
  const destination: AutomationInputDestination = rawDestination.kind === 'heartbeat-new'
    ? { ...parseCreationDestination(rawDestination), kind: 'heartbeat-new' } : parseAutomationDestination(rawDestination);
  return { name: text(item.name, 'automation name', 200).trim(), prompt: text(item.prompt, 'automation prompt', 100_000).trim(),
    rrule: text(item.rrule, 'recurrence rule', 4096).trim(), destination,
    notificationPolicy: item.notificationPolicy, status: item.status };
}

export function parseAutomationMutation(value: unknown): AutomationMutation {
  const item = record(value, 'automation operation');
  const requestId = identifier(item.requestId, 'automation request ID');
  if (item.type === 'history') {
    if (typeof item.read !== 'boolean' || typeof item.archived !== 'boolean') throw new Error('Invalid automation history state.');
    return { type: 'history', requestId, runId: identifier(item.runId, 'automation run'), read: item.read, archived: item.archived };
  }
  const id = identifier(item.id, 'automation ID');
  if (!Number.isSafeInteger(item.expectedRevision) || (item.expectedRevision as number) < 0) throw new Error('Invalid automation revision.');
  const expectedRevision = item.expectedRevision as number;
  if (item.type === 'save') return { type: 'save', requestId, id, expectedRevision, input: parseAutomationInput(item.input) };
  if (item.type === 'delete' || item.type === 'run') return { type: item.type, requestId, id, expectedRevision };
  throw new Error('Unknown automation operation.');
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid ${label}.`);
  return value as number;
}

function nullableTime(value: unknown): number | null {
  return value === null ? null : integer(value, 'automation timestamp');
}

export function parseAutomation(value: unknown, hostId: string): Automation {
  const item = record(value, 'saved automation');
  if (item.hostId !== hostId || !['active', 'paused', 'deleted'].includes(String(item.status))) throw new Error('The automation belongs to another host or has invalid state.');
  const input = parseAutomationInput({ ...item, status: item.status === 'deleted' ? 'paused' : item.status });
  return { ...input, destination: parseAutomationDestination(item.destination), status: item.status as AutomationStatus, id: identifier(item.id, 'automation ID'), hostId,
    revision: integer(item.revision, 'automation revision', 1), createdAt: integer(item.createdAt, 'automation creation'),
    updatedAt: integer(item.updatedAt, 'automation update'), nextRunAt: nullableTime(item.nextRunAt), lastRunAt: nullableTime(item.lastRunAt) };
}

export function parseAutomationRun(value: unknown, hostId: string): AutomationRun {
  const item = record(value, 'automation run');
  if (item.hostId !== hostId || !['reserved', 'running', 'completed', 'failed', 'unknown', 'skipped'].includes(String(item.status))) throw new Error('The run belongs to another host or has invalid state.');
  if (item.trigger !== 'manual' && item.trigger !== 'schedule') throw new Error('Invalid automation run trigger.');
  if (item.notificationPolicy !== 'all' && item.notificationPolicy !== 'failed-runs-only') throw new Error('Invalid automation notification policy.');
  return { hostId, id: identifier(item.id, 'automation run'), automationId: identifier(item.automationId, 'automation ID'),
    automationRevision: integer(item.automationRevision, 'automation run revision', 1), automationName: text(item.automationName, 'automation name', 200),
    prompt: text(item.prompt, 'automation prompt', 100_000), destination: parseAutomationDestination(item.destination), notificationPolicy: item.notificationPolicy,
    trigger: item.trigger, status: item.status as AutomationRunStatus, scheduledFor: integer(item.scheduledFor, 'scheduled time'),
    createdAt: integer(item.createdAt, 'run creation'), updatedAt: integer(item.updatedAt, 'run update'), completedAt: nullableTime(item.completedAt),
    sessionId: item.sessionId === null ? null : identifier(item.sessionId, 'run conversation'),
    createCommandId: identifier(item.createCommandId, 'create command'), promptCommandId: identifier(item.promptCommandId, 'prompt command'),
    error: item.error === null ? null : text(item.error, 'run error', 4096), readAt: nullableTime(item.readAt), archivedAt: nullableTime(item.archivedAt) };
}

export function parseAutomationsQuery(value: unknown = {}): AutomationsQuery {
  const item = record(value, 'automation query');
  return { ...(item.automationId === undefined ? {} : { automationId: identifier(item.automationId, 'automation ID') }),
    ...(item.before === undefined ? {} : { before: text(item.before, 'history cursor', 512) }) };
}

export function parseAutomationsSnapshot(value: unknown, hostId: string): AutomationsSnapshot {
  const item = record(value, 'automation snapshot');
  if (item.hostId !== hostId || !Array.isArray(item.tasks) || item.tasks.length > 1000 || !Array.isArray(item.runs) || item.runs.length > 100) throw new Error('Invalid automation snapshot owner or size.');
  // Array.from visits every index, including sparse inputs crossing a local bridge.
  const tasks = Array.from(item.tasks, task => parseAutomation(task, hostId));
  const runs = Array.from(item.runs, run => parseAutomationRun(run, hostId));
  if (new Set(tasks.map(task => task.id)).size !== tasks.length || new Set(runs.map(run => run.id)).size !== runs.length) throw new Error('Duplicate automation records.');
  return { hostId, tasks, runs, nextRunCursor: item.nextRunCursor === null ? null : text(item.nextRunCursor, 'history cursor', 512) };
}

export function parseAutomationMutationResult(value: unknown, hostId: string, mutation: AutomationMutation): AutomationMutationResult {
  const item = record(value, 'automation result');
  if (item.hostId !== hostId || item.requestId !== mutation.requestId) throw new Error('The automation response belongs to a different request. Inspect the original request before retrying.');
  const task = item.task === null ? null : parseAutomation(item.task, hostId);
  const run = item.run === null ? null : parseAutomationRun(item.run, hostId);
  if (mutation.type === 'history' ? !run || run.id !== mutation.runId : !task || task.id !== mutation.id) throw new Error('The automation result belongs to a different record.');
  if (mutation.type === 'run' && (!run || run.automationId !== mutation.id)) throw new Error('The automation run belongs to a different task.');
  return { hostId, requestId: mutation.requestId, task, run, snapshot: parseAutomationsSnapshot(item.snapshot, hostId) };
}
