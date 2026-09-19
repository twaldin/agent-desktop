import { parseTodoExternalEditorRequest, type TodoExternalEditorRequest } from "../../../../packages/shared/src/todo-external-editor";
import { parsePreparedTodoExternalEditor, type PreparedTodoExternalEditor } from "./todo-external-editor";
import { exportNativeSession, nativeExportIntent } from "./session-export";
import { NativeSessionUsage, type NativeUsagePreparation, type NativeUsageResult } from "./session-usage";
import type { SessionUsage, UsageRefresh, UsageResetPrepare } from "../../../../packages/shared/src/session-usage";
import { NativePlanExecutionAdmission, NativePlanMessageAdmissionError, type OmpPlanExecutionRun } from "./plan-execution-admission";
import { NativePlanController, NativePlanError, resolveNativePlanInvocation } from "./plan-controller";
import { getEditorCommand } from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import { parsePlanExternalEditorRequest, type PlanExternalEditorRequest } from "../../../../packages/shared/src/plan-external-editor";
import { parsePreparedPlanExternalEditor, type PreparedPlanExternalEditor } from "./plan-external-editor";
import { projectSessionPlan } from "./plan-state";
import { parsePlanDecisionPreparation, type OmpPlanDecisionPreparation } from "./plan-decision";
import { parsePlanControlRequest, parsePlanDocumentReadRequest, parsePlanMutationRequest,
  type PlanDocumentReadRequest, type PlanMutationRequest, type PlanDecisionReceipt,
  type PlanControlRequest, type PlanControlResult, type SessionPlan } from "../../../../packages/shared/src/session-plan";
import type { PlanDocumentSection } from "../../../../packages/shared/src/plan-document";
import { NativeSessionTodos } from "./session-todos";
import { parseTodoCommandId, parseTodoMutationRequest, type SessionTodos, type TodoMutationRequest, type TodoMutationResult } from "../../../../packages/shared/src/session-todos";
import { shouldEnterPlanModeOnStartup } from "@oh-my-pi/pi-coding-agent/plan-mode/startup";
import { resolveOwnedDialectFromEnv } from "@oh-my-pi/pi-agent-core/agent-loop";
import { NativeForceToolController } from "./force-tool";
import { NativeForceToolAdmission, assertForceToolRecoveryAndEnter } from "./force-tool-admission";
import { wrapForceToolRecoveryOutcome } from "./force-tool-recovery-outcome";
import { parseForceToolPromptFields, type ForceToolCancelResult, type ForceToolState, type ForceToolTicket, type ForceToolGuard, type ForceToolRecovery } from "../../../../packages/shared/src/force-tool";
import { HtmlPreviews } from './html-previews';
import { parseHtmlPreviewRequest, type HtmlPreviewRequest, type HtmlPreviewLease } from '../../../../packages/shared/src/html-preview';
import { inspectSessionOutputs, recordedGeneratedImage, sessionOutputBranch } from "./session-outputs";
import type { SessionAccountSelection } from "@agent-desktop/shared";
import { executeMcpAppTool } from "./mcp-app-tool";
import { McpFileResources } from "./mcp-file-resource";
import { NativeMcpApps } from "./mcp-apps";
import type { NativeMcpAppRequest, NativeMcpAppResponse } from "@agent-desktop/shared";
import { projectSelectedText } from "./selected-text-history";
import { lookupFileMentionImage } from "./file-mentions";
import type { NativeMcpAuthorizationSnapshot, NativeMcpAuthorizationReply, NativeMcpAuthorizationStart } from "@agent-desktop/shared";
import type { NativeSessionMcpResourceRequest, NativeSessionMcpResourceResult } from "@agent-desktop/shared";
import { NativeSessionMcp } from "./mcp-session";
import type { NativeSessionMcpSnapshot, NativeSessionMcpReload, NativeSessionMcpReconnect } from "@agent-desktop/shared";
import { mkdir, realpath } from "node:fs/promises";
import { readSessionHeader, requireDirectory, type SessionStartupIdentity } from "./session-files";
import path from "node:path";
import { goalControlState, parseNativeBrowserTabMetadata, type DetachedQuestionSnapshot, type GoalMutationRequest, type ModelChoice, type ModelInfo, type NativeBrowserTabMetadata, type NativeGoalActivity, type NativeSessionActivity, type ResolveDetachedQuestionReceipt, type ResolveDetachedQuestionRequest, type TranscriptMessage } from "@agent-desktop/shared";
import { createHash } from "node:crypto";
import {
  AgentRegistry, createAgentSession, discoverAuthStorage, discoverSlashCommands, getAgentDir,
  ModelRegistry, SessionManager, Settings,
  loadSessionExtensions,
  type AgentSession, type AgentSessionEvent, type AuthStorage,
} from "@oh-my-pi/pi-coding-agent";
import { applyProviderGlobalsFromSettings } from "@oh-my-pi/pi-coding-agent/config/provider-globals";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { setProjectDir, untilAborted } from "@oh-my-pi/pi-utils";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AUTO_THINKING, parseCliThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { initThemeSync } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import { invalidate } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { reset as resetCapabilityCache } from "@oh-my-pi/pi-coding-agent/discovery";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { TranscriptMirror, projectGoalCompletions } from "./transcript";
import { nativeMcpArtifact, projectMcpArtifacts } from "./mcp-artifacts";
import { beginNativePrompt, type OmpPromptRun, type OmpPromptReceipt } from "./prompt";
import { dispatchNativePrompt } from "./commands";
import { NativeSkillPrompt } from "./skills";
import { copyNativeSelectedTextInput, NativeSelectedTextPrompt, type NativeSelectedTextInput } from "./selected-text";
import { copyNativeWholeFileInput, NativeWholeFilePrompt, type NativeWholeFileInput } from "./whole-file";
import { projectWholeFiles } from "./whole-file-history";
import { hasRepeatedWholeFileSources, serializeRepeatedWholeFilePrompt, serializeWholeFilePrompt } from "@agent-desktop/shared";
import { discoverComposerActions, discoverSkillInventory, sessionComposerActions, composerCompletions, type NativeComposerCatalog, type NativeComposerCompletions, type NativeSkillInventoryCatalog } from "./composer-actions";
import type { ComposerCompletionQuery } from "@agent-desktop/shared";
import { NativeSteerAdmission, type OmpQueuedSubmissionRun, type OmpSteerReceipt } from "./steer";
import { NativeQueuedMessages } from "./queued-messages";
import type { NativeQueuedMessageMutation, NativeQueuedMessageMutationReceipt, NativeQueuedMessagesSnapshot } from "../../../../packages/shared/src/queued-messages";
import { createNativeAccountSelectionBridge } from "../omp-accounts/session-selection";
import type { SessionAccountList } from "../omp-accounts/types";
import { nativeApprovalInteractionClassification, OmpInteractionBridge, type OmpBridgeEvent, type OmpInteraction, type OmpInteractionResponse } from "./interactions";
import { initializeDesktopExtensions } from "./extensions";
import { modelCapabilities, NativeSessionControls } from "../omp-settings/models";
import { composerCatalog } from "../omp-settings/composer";
import type { OmpApprovalMode, OmpComposerCatalog, OmpModelCapabilities, OmpSessionControls, OmpSessionControlMutation } from "@agent-desktop/shared";
import { approvalMode } from "../approval";
import { copyPreparedImages, NativeImagePrompt, readNativeImage, type PreparedPromptImage, type OmpRecordedImage } from "./images";
import { NativeGoalController, type GoalContinuationEligibility, type OmpGoalContinuationRun } from "./goal-controller";
import { NativeDetachedQuestions, type OmpDetachedQuestionDeliveryRun } from "./detached-questions";
import { NativeBtwController } from "./btw";
import type { NativeBtwSnapshot, NativeBtwStart } from "../../../../packages/shared/src/btw";
import { forkNativeSession, type NativeSessionForkInput, type NativeSessionForkResult } from "./session-fork";
export type { PreparedPromptImage, OmpRecordedImage } from "./images";
export type { OmpPromptRun, OmpPromptReceipt } from "./prompt";
export type { OmpSteerReceipt } from "./steer";
export type { OmpDetachedQuestionDeliveryRun } from "./detached-questions";

function detachedQuestionRejected(message: string): Error {
  const error = new Error(message); error.name = "DetachedQuestionRejected"; return error;
}

type NativeModel = NonNullable<AgentSession["model"]>;
export type OmpRuntimeEvent = AgentSessionEvent | OmpBridgeEvent | { type: "plan_changed" } | { type: "todos_changed" } | { type: "queued_messages_changed"; snapshot: NativeQueuedMessagesSnapshot };
export type OmpEventListener = (event: OmpRuntimeEvent) => void;
export interface OmpSessionOptions {
  cwd: string;
  model?: ModelChoice;
  thinkingLevel?: string;
  approvalOverride?: OmpApprovalMode;
  sessionDirectory?: string;
  onEvent?: OmpEventListener;
  /** Enable only when the daemon provides an actual pending-interaction UI. */
  interactions?: boolean;
}
export interface OmpOpenOptions { expectedIdentity?: SessionStartupIdentity; sessionFile: string; onEvent?: OmpEventListener; interactions?: boolean; approvalOverride?: OmpApprovalMode }
export interface OmpPromptOptions { commandId?: string; commandVersion?: number; forceTool?: ForceToolGuard; forceRecovery?: ForceToolRecovery; model?: ModelChoice; thinkingLevel?: string; images?: PreparedPromptImage[]; selectedText?: NativeSelectedTextInput; wholeFiles?: NativeWholeFileInput }
export interface OmpBrowserTabCreateResult {
  tab: NativeBrowserTabMetadata;
  targetDisposition: "created-page" | "created-surface" | "adopted-existing-target";
}
export interface OmpSession {
  getExportIntent(text: string): Promise<import("./session-export").NativeExportIntent>;
  exportSession(input: import("./session-export").NativeSessionExportInput): Promise<void>;
  readUsage(mode: UsageRefresh): Promise<SessionUsage | null>;
  prepareUsageReset(request: UsageResetPrepare): Promise<NativeUsagePreparation>;
  redeemUsageReset(ticket: string, redeemRequestId: string): Promise<NativeUsageResult>;
  readonly id: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly model: ModelChoice | null;
  readonly thinkingLevel: string | undefined;
  readonly isStreaming: boolean;
  readonly hasPostPromptWork: boolean;
  readonly title: string | undefined;
  readonly createdAt: number;
  readonly modelFallbackMessage: string | undefined;
  getMessages(): TranscriptMessage[];
  flushSession(): Promise<{ sessionId: string; sessionFile: string; cwd: string }>;
  getSessionActivity(): NativeSessionActivity;
  refreshGoalUsage(): Promise<void>;
  mutateGoal(request: GoalMutationRequest): Promise<NativeGoalActivity | null>;
  getGoalContinuationEligibility(): GoalContinuationEligibility;
  startGoalContinuation(expectedGoalId: string): OmpGoalContinuationRun;
  listQuestions(): Promise<DetachedQuestionSnapshot[]>;
  resolveQuestion(request: ResolveDetachedQuestionRequest): Promise<ResolveDetachedQuestionReceipt>;
  startQuestionDelivery(questionId: string): OmpDetachedQuestionDeliveryRun;
  sessionMcpApp(request: NativeMcpAppRequest): Promise<NativeMcpAppResponse>;
  readSessionMcpResource(request: NativeSessionMcpResourceRequest): Promise<NativeSessionMcpResourceResult>;
  getSessionMcp(): NativeSessionMcpSnapshot;
  startSessionMcpAuthorization(request: NativeMcpAuthorizationStart): NativeMcpAuthorizationSnapshot;
  getSessionMcpAuthorization(): NativeMcpAuthorizationSnapshot | null;
  respondSessionMcpAuthorization(request: NativeMcpAuthorizationReply): NativeMcpAuthorizationSnapshot;
  cancelSessionMcpAuthorization(authorizationId: string): NativeMcpAuthorizationSnapshot;
  reloadSessionMcp(request: NativeSessionMcpReload): Promise<NativeSessionMcpSnapshot>;
  reconnectSessionMcp(request: NativeSessionMcpReconnect): Promise<NativeSessionMcpSnapshot>;
  getBtw(): NativeBtwSnapshot | null;
  startBtw(input: NativeBtwStart): NativeBtwSnapshot;
  cancelBtw(runId: string): NativeBtwSnapshot | null;
  promoteBtw(runId: string, operationId?: string): Promise<{ cancelled: boolean; sessionId: string; sessionFile: string }>;
  getComposerActions(): Promise<NativeComposerCatalog>;
  getComposerCompletions(query: ComposerCompletionQuery): Promise<NativeComposerCompletions>;
  openHtmlPreview(request: HtmlPreviewRequest): Promise<HtmlPreviewLease>;
  releaseHtmlPreview(leaseId: string): Promise<void>;
  getSessionOutputs(): Promise<import("@agent-desktop/shared").SessionOutputs>;
  getImage(nativeEntryId: string, blockIndex: number, source?: "generated"): Promise<OmpRecordedImage>;
  createBrowserTab(name: string, initialUrl?: string): Promise<OmpBrowserTabCreateResult>;
  installRetainedBrowserEvaluation(input: {
    sourceOwnerId: string; operationId: string; name: string; targetId: string; kindTag: NativeBrowserTabMetadata["kindTag"]; safeDir: string;
    backend: "cdp" | "cmux"; descriptor?: Record<string, unknown>; state?: Record<string, unknown>;
  }, transport: { post(frame: unknown): void; installReceiver?(receive:(frame:unknown)=>void):void; request(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<Record<string, unknown>> }): Promise<{ receive(frame: unknown): void; dispose(): Promise<void> }>;
  subscribe(listener: OmpEventListener): () => void;
  getForceTool(): ForceToolState;
  getPlan(): SessionPlan;
  getTodoExternalEditorAvailable(): boolean;
  prepareTodoExternalEditor(request: TodoExternalEditorRequest): Promise<PreparedTodoExternalEditor>;
  getPlanExternalEditorAvailable(): boolean;
  preparePlanExternalEditor(request: PlanExternalEditorRequest): Promise<PreparedPlanExternalEditor>;
  getPlanDocumentSection(request: PlanDocumentReadRequest): PlanDocumentSection;
  controlPlan(request: PlanControlRequest): Promise<PlanControlResult>;
  preparePlanDecision(commandId: string, request: PlanMutationRequest): Promise<OmpPlanDecisionPreparation>;
  startPlanExecution(phaseId: string): OmpPlanExecutionRun;
  getTodos(): SessionTodos;
  mutateTodos(commandId: string, request: TodoMutationRequest): Promise<TodoMutationResult>;
  cancelForceTool(input: { ticket: ForceToolTicket; directiveId: string }): ForceToolCancelResult;
  startPrompt(text: string, options?: OmpPromptOptions): OmpPromptRun;
  prompt(text: string, options?: OmpPromptOptions): Promise<boolean>;
  steer(text: string, expectedApprovalMode?: OmpApprovalMode, options?: { images?: PreparedPromptImage[] }): Promise<OmpSteerReceipt>;
  startFollowUp(text: string, delivery: "follow-up" | "steer", expectedApprovalMode?: OmpApprovalMode, images?: PreparedPromptImage[]): OmpQueuedSubmissionRun;
  getQueuedMessages(): NativeQueuedMessagesSnapshot;
  mutateQueuedMessages(mutation: NativeQueuedMessageMutation): NativeQueuedMessageMutationReceipt;
  assertTaskLocationReady(): void;
  moveSession(cwd: string): Promise<{ id: string; cwd: string; sessionFile: string }>;
  abort(): Promise<void>;
  setModel(model: ModelChoice): Promise<void>;
  listAccountChoices(): Promise<SessionAccountList>;
  pinAccount(credentialId: number, expectedSelection?: SessionAccountSelection): Promise<SessionAccountList>;
  releaseAccountForReselection(expectedSelection?: SessionAccountSelection): Promise<SessionAccountList>;
  listInteractions(): Promise<OmpInteraction[]>;
  respondInteraction(id: string, response: OmpInteractionResponse): Promise<void>;
  cancelInteractions(reason?: "cancelled" | "disconnected"): Promise<void>;
  getControls(): Promise<OmpSessionControls>;
  mutateControls(request: OmpSessionControlMutation): Promise<OmpSessionControls>;
  setApprovalOverride(mode: OmpApprovalMode | undefined, expectedRevision: string): Promise<OmpSessionControls>;
  dispose(): Promise<void>;
}

interface NativeContext { settings: Settings; registry: ModelRegistry; auth: AuthStorage }

/** Load configured extension providers into a registry before resolving models.
 * Keep the resulting extension instances when attaching a session so provider
 * factories are evaluated once and rebound by the SDK under the same session. */
async function loadExtensionProviders(registry: ModelRegistry, settings: Settings, cwd: string, retainRegistrations = false) {
  const extensions = await loadSessionExtensions({}, cwd, settings, new EventBus());
  const activeSources = extensions.extensions.map(extension => extension.path);
  registry.syncExtensionSources(activeSources);
  for (const sourceId of new Set(activeSources)) registry.clearSourceRegistrations(sourceId);
  for (const { name, config, sourceId } of extensions.runtime.pendingProviderRegistrations) registry.registerProvider(name, config, sourceId);
  if (!retainRegistrations) extensions.runtime.pendingProviderRegistrations = [];
  await registry.refreshRuntimeProviders();
  return extensions;
}

function goalFromNativeModeData(modeData: Record<string, unknown> | undefined): Goal | undefined {
  const goal = modeData?.goal;
  if (!goal || typeof goal !== "object") return undefined;
  const value = goal as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.objective !== "string" || typeof value.status !== "string"
    || typeof value.tokensUsed !== "number" || typeof value.timeUsedSeconds !== "number"
    || typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return undefined;
  return { id: value.id, objective: value.objective, status: value.status as Goal["status"],
    ...(typeof value.tokenBudget === "number" ? { tokenBudget: value.tokenBudget } : {}),
    tokensUsed: value.tokensUsed, timeUsedSeconds: value.timeUsedSeconds, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function goalActivity(session: AgentSession): NativeGoalActivity | null {
  const state = session.getGoalModeState();
  return state ? { ...state.goal, objective: state.goal.objective.slice(0, 16_384), enabled: state.enabled, mode: state.mode,
    ...(state.reason ? { reason: state.reason } : {}) } : null;
}

function goalRejected(message: string): Error {
  const error = new Error(message);
  error.name = "GoalMutationRejected";
  return error;
}

function goalOutcomeUnknown(error: unknown): Error {
  const result = new Error(error instanceof Error ? error.message : "Native goal mutation failed.");
  result.name = error instanceof Error ? error.name : "Error";
  Object.assign(result, { code: "OUTCOME_UNKNOWN" as const });
  return result;
}

/** Apply OMP's cold interactive-session goal reconciliation to a headless SDK session. */
async function restoreNativeGoalMode(session: AgentSession, manager: SessionManager): Promise<void> {
  const context = manager.buildSessionContext();
  if (context.mode !== "goal" && context.mode !== "goal_paused") return;
  if (!session.settings.get("goal.enabled")) {
    session.goalRuntime.clearAccounting();
    manager.appendModeChange("none");
    return;
  }
  const goal = goalFromNativeModeData(context.modeData);
  if (!goal) {
    manager.appendModeChange("none");
    return;
  }
  session.setGoalModeState({ enabled: goal.status === "complete" ? false : context.mode === "goal", mode: goal.status === "complete" ? "exiting" : "active", goal,
    ...(goal.status === "complete" ? { reason: "completed" as const } : {}) });
  if (goal.status === "complete") {
    await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "goal"));
    await manager.appendEntriesAtomically(() => {
      manager.appendModeChange("none");
      manager.appendCustomEntry("goal-completed", { objective: goal.objective, tokensUsed: goal.tokensUsed,
        tokenBudget: goal.tokenBudget, timeUsedSeconds: goal.timeUsedSeconds });
    });
    session.setGoalModeState(undefined);
    return;
  }
  const restored = await session.goalRuntime.onThreadResumed();
  if (restored?.goal) {
    const previousTools = session.getEnabledToolNames().filter(name => name !== "goal");
    await session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
  }
}

function toModelInfo(model: NativeModel, registry: ModelRegistry): ModelInfo {
  // Never forward the whole native Model: its headers may contain credentials.
  return {
    id: model.id, provider: model.provider, name: model.name,
    reasoning: model.reasoning, input: [...model.input],
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    authenticated: registry.hasConfiguredAuth(model),
    // Same baked metadata read used by native getSupportedEfforts().
    thinkingLevels: model.reasoning ? [...(model.thinking?.efforts ?? [])] : [],
  };
}

/** Bun-only native runtime. The owning host, never a window, controls its lifetime. */
export class OmpRuntime {
  #agentDir: string;
  #discovery = new Map<string, NativeContext>();
  #discoveryTails = new Map<string, Promise<unknown>>();
  #sessions = new Set<OmpSession>();
  #setups = new Set<Promise<unknown>>();
  #reservedFiles = new Set<string>();
  #disposed = false;
  #disposeCall?: Promise<void>;

  constructor(options: { agentDir?: string } = {}) {
    this.#agentDir = options.agentDir ?? getAgentDir();
  }

  async #context(cwd: string, loadExtensions = true): Promise<NativeContext> {
    // Readonly Settings cannot reload itself. Both capability files and the
    // default ModelsConfigFile may be cached by the native process.
    for (const file of [path.join(this.#agentDir, "config.yml"), path.join(this.#agentDir, "config.yaml"), path.join(cwd, ".omp", "config.yml")]) invalidate(file);
    ModelsConfigFile.relocate(path.join(this.#agentDir, "models.yml")).invalidate();
    const settings = await Settings.loadReadOnly({ cwd, agentDir: this.#agentDir });
    const auth = await discoverAuthStorage(this.#agentDir);
    try {
      const registry = new ModelRegistry(auth, path.join(this.#agentDir, "models.yml"), { settings });
      if (registry.getError()) throw new Error("OMP model configuration is invalid; review the native models.yml");
      await registry.hydrateCredentialScopedModelCaches();
      if (loadExtensions) await loadExtensionProviders(registry, settings, cwd);
      return { settings, auth, registry };
    } catch (error) { auth.close(); throw error; }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("OMP runtime is disposed");
  }

  async #withDiscovery<T>(cwd: string, refresh: boolean | undefined, read: (context: NativeContext) => T | Promise<T>, loadExtensions = true): Promise<T> {
    this.#assertActive();
    const resolved = await requireDirectory(cwd);
    const contextKey = `${resolved}\0${loadExtensions ? "providers" : "metadata"}`;
    this.#assertActive();
    const pending = (this.#discoveryTails.get(resolved) ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.#assertActive();
      let context = this.#discovery.get(contextKey);
      if (!context || refresh) {
        if (refresh) resetCapabilityCache();
        const replacement = await this.#context(resolved, loadExtensions);
        try {
          if (refresh) {
            await replacement.auth.revalidateCredentials();
            await replacement.registry.refresh("online-if-uncached");
          }
          this.#assertActive();
        } catch (error) { replacement.auth.close(); throw error; }
        // All reads for this cwd share the queue, so nobody is still using the
        // old store when it closes. Failed refreshes retain the previous context.
        context?.auth.close();
        this.#discovery.set(contextKey, replacement);
        context = replacement;
      }
      return read(context);
    });
    this.#discoveryTails.set(resolved, pending);
    void pending.finally(() => { if (this.#discoveryTails.get(resolved) === pending) this.#discoveryTails.delete(resolved); }).catch(() => {});
    return pending;
  }

  /** Configured auth means native credential availability, not a successful provider probe. */
  listModels(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    return this.#withDiscovery(cwd, options.refresh, context => {
      const available = new Set(context.registry.getAvailable().map(model => `${model.provider}/${model.id}`));
      return context.registry.getAll().map(model => ({ ...toModelInfo(model, context.registry),
        available: available.has(`${model.provider}/${model.id}`),
        disabledInSettings: context.settings.get("disabledProviders").includes(model.provider),
      }));
    });
  }

  async listModelCapabilities(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<OmpModelCapabilities[]> {
    return this.#withDiscovery(cwd, options.refresh, context => {
      const available = new Set(context.registry.getAvailable().map(model => `${model.provider}/${model.id}`));
      return context.registry.getAll().map(model => {
        const result = modelCapabilities(model);
        result.capabilities.available = available.has(`${model.provider}/${model.id}`);
        result.capabilities.disabledInSettings = context.settings.get("disabledProviders").includes(model.provider);
        return result;
      });
    });
  }

  getComposerCatalog(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<OmpComposerCatalog> {
    return this.#withDiscovery(cwd, options.refresh, context => composerCatalog(cwd, context.settings, context.registry));
  }

  getComposerActions(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<NativeComposerCatalog> {
    return this.#withDiscovery(cwd, options.refresh, context => discoverComposerActions(cwd, this.#agentDir, context.settings), false);
  }
  getSkillInventory(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<NativeSkillInventoryCatalog> {
    return this.#withDiscovery(cwd, options.refresh, context => discoverSkillInventory(cwd, context.settings), false);
  }
  getComposerCompletions(cwd: string, query: ComposerCompletionQuery): Promise<NativeComposerCompletions> {
    return this.#withDiscovery(cwd, false, async context => composerCompletions(await discoverComposerActions(cwd, this.#agentDir, context.settings), query), false);
  }

  #setup<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertActive();
    const pending = operation();
    this.#setups.add(pending);
    const remove = () => { this.#setups.delete(pending); };
    void pending.then(remove, remove);
    return pending;
  }

  forkSession(input: NativeSessionForkInput): Promise<NativeSessionForkResult> {
    return this.#setup(() => forkNativeSession(input));
  }

  create(options: OmpSessionOptions): Promise<OmpSession> {
    return this.#setup(async () => {
      const cwd = await requireDirectory(options.cwd);
      const selectedSessionDirectory = options.sessionDirectory ?? SessionManager.getDefaultSessionDir(cwd);
      await mkdir(selectedSessionDirectory, { recursive: true });
      const sessionDirectory = await requireDirectory(selectedSessionDirectory);
      this.#assertActive();
      // Keep creation and later native /new paths identical to #open's
      // canonical path, including macOS /var and /private/var aliases.
      const manager = SessionManager.create(cwd, sessionDirectory);
      return this.#attach(manager, { ...options, cwd });
    });
  }

  /** Only for a file whose exclusive ownership the host has already established.
   * OMP 18.1.10 does not provide a cross-process session lock. */
  open(options: OmpOpenOptions): Promise<OmpSession> {
    return this.#setup(() => this.#open(options));
  }

  async #open(options: OmpOpenOptions): Promise<OmpSession> {
    const sessionFile = await realpath(options.sessionFile);
    this.#assertActive();
    if (this.#reservedFiles.has(sessionFile)) throw new Error("OMP session is already open in this runtime");
    this.#reservedFiles.add(sessionFile);
    let manager: SessionManager | undefined;
    try {
      const header = await readSessionHeader(sessionFile);
      const directory = await requireDirectory(header.cwd);
      const expected = options.expectedIdentity;
      if (expected && (header.id !== expected.id || header.cwd !== expected.cwd || directory !== expected.directory)) {
        throw new Error("OMP session identity or working directory changed after worker startup was captured");
      }
      manager = await SessionManager.open(sessionFile);
      if (manager.getSessionId() !== header.id || manager.getCwd() !== header.cwd) {
        throw new Error("OMP changed the session identity or working directory while opening it");
      }
      return await this.#attach(manager, { cwd: header.cwd, onEvent: options.onEvent, interactions: options.interactions, approvalOverride: options.approvalOverride }, sessionFile);
    } catch (error) {
      this.#reservedFiles.delete(sessionFile);
      await manager?.close();
      throw error;
    }
  }

  async #attach(manager: SessionManager, options: OmpSessionOptions, reservation?: string): Promise<OmpSession> {
    let context: NativeContext | undefined;
    let native: AgentSession | undefined;
    let bridge: OmpInteractionBridge | undefined;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("OMP did not allocate a session file");
    const reservedFile = reservation ?? path.resolve(sessionFile);
    this.#reservedFiles.add(reservedFile);
    const reservedPaths = new Set([reservedFile]);
    try {
      // Session extension factories are preloaded exactly once below, after
      // host-owned settings overrides are applied. Discovery contexts still
      // load providers so their catalogs include extension models.
      context = await this.#context(options.cwd, false);
      this.#assertActive();
      // The native TUI startup normally initializes this module-global before
      // AskTool builds even its headless selector labels. SDK workers skip that
      // startup path, so initialize the same native theme from actual settings.
      initThemeSync(context.settings.get("symbolPreset"), context.settings.get("colorBlindMode"),
        context.settings.get("theme.dark"), context.settings.get("theme.light"));
      // SDK construction loads extension factories and tool policy. Restore the
      // owning host's intent before any native startup work observes Settings.
      if (options.approvalOverride !== undefined) context.settings.override("tools.approvalMode", approvalMode(options.approvalOverride));
      const preloadedExtensions = await loadExtensionProviders(context.registry, context.settings, options.cwd, true);
      const thinkingLevel = options.thinkingLevel === undefined ? undefined : parseCliThinkingLevel(options.thinkingLevel);
      if (options.thinkingLevel !== undefined && thinkingLevel === undefined) throw new Error("Unknown OMP thinking level");
      const model = options.model ? this.#findModel(context.registry, options.model, context.settings) : undefined;
      const agentRegistry = new AgentRegistry();
      const detachedQuestions = new NativeDetachedQuestions(manager);
      // Pinned SDK ordering appends caller inline extensions after discovered
      // extensions and awaits approval handlers in order. This last relevant
      // handler therefore marks only after user hooks have finished asking.
      const approvalClassification = nativeApprovalInteractionClassification(() => bridge);
      if (reservation !== undefined) await detachedQuestions.repairOnReopen();
      const result = await createAgentSession({
        cwd: options.cwd, agentDir: this.#agentDir,
        settings: context.settings, modelRegistry: context.registry, authStorage: context.auth,
        agentRegistry, sessionManager: manager, model, thinkingLevel,
        preloadedExtensions,
        // Tools cannot run until create finishes and installs the bridge below.
        hasUI: false, enableMcpApps: true, interactivePrompts: options.interactions === true,
        deferUsageReserveConfirmation: true,
        extensions: [detachedQuestions.extension, approvalClassification],
      });
      native = result.session;
      this.#assertActive();
      await restoreNativeGoalMode(native, manager);
      // Native 18.1.10 omits the initial auto receipt, and an unchanged first
      // classification does not add it. Record the actual new-session choice
      // before exposing its file; never infer missing intent on an existing log.
      if (reservation === undefined && native.configuredThinkingLevel() === AUTO_THINKING
        && !manager.getBranch().some(entry => entry.type === "thinking_level_change")) {
        manager.appendThinkingLevelChange(native.thinkingLevel, AUTO_THINKING);
      }
      await manager.ensureOnDisk();
      const session = native;
      const btw = new NativeBtwController(session);
      const mcp = new NativeSessionMcp(session, result.mcpManager, true);
      const steering = new NativeSteerAdmission(session, manager);
      const planExecution = new NativePlanExecutionAdmission(session, manager);
      const queuedMessages = new NativeQueuedMessages(session, steering);
      const auth = context.auth;
      const registry = context.registry;
      const mirror = new TranscriptMirror();
      const transcriptEntries = () => manager.getBranch().flatMap(entry => entry.type === "message" ? [{ id: entry.id, message: entry.message as unknown }]
        : entry.type === "custom_message" ? [{ id: entry.id, message: { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, attribution: entry.attribution, timestamp: Date.parse(entry.timestamp) } as unknown }] : []);
      const transcript = () => {
        const branch = manager.getBranch();
        const messages = mirror.snapshot(session.buildTranscriptSessionContext({ collapseCompactedHistory: false, keepDanglingToolCalls: true }).messages, transcriptEntries());
        const order = new Map(branch.map((entry, index) => [entry.id, index]));
        for (const entry of branch) {
          if (entry.type !== "custom" || entry.customType !== "agent-desktop.command-output" || !entry.data || typeof entry.data !== "object") continue;
          const data = entry.data as Record<string, unknown>;
          if (typeof data.command !== "string" || typeof data.output !== "string") continue;
          messages.push({ id: entry.id, nativeId: entry.id, role: "commandOutput", text: "", content: [], blocks: [],
            timestamp: Date.parse(entry.timestamp), lifecycle: "complete", commandOutput: { entryId: entry.id, command: data.command, output: data.output } });
        }
        projectGoalCompletions(messages, branch);
        projectMcpArtifacts(messages, branch);
        return projectWholeFiles(projectSelectedText(messages, branch), branch).sort((left, right) => (left.nativeId ? order.get(left.nativeId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER)
          - (right.nativeId ? order.get(right.nativeId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER));
      };
      // Reserve identities from resumed history before a prompt can emit events,
      // including providers that reuse a tool call ID in a later turn.
      mirror.snapshot(
        session.buildTranscriptSessionContext({ collapseCompactedHistory: false, keepDanglingToolCalls: true }).messages,
        transcriptEntries(),
      );
      let promotionState: "idle" | "running" | "retired" = "idle";
      let promotionCall: Promise<{ cancelled: boolean; sessionId: string; sessionFile: string }> | undefined;
      const listeners = new Set<OmpEventListener>();
      if (options.onEvent) listeners.add(options.onEvent);
      const unsubscribeQueuedMessages = queuedMessages.subscribe(snapshot => {
        if (promotionState !== "idle") return;
        for (const listener of listeners) listener({ type: "queued_messages_changed", snapshot });
      });
      const emitBridge = (event: OmpBridgeEvent) => {
        // Native branch hooks may ask for input. Keep only those interactions
        // on the still-owned origin; new-branch presentation waits for reopen.
        if (promotionState === "idle" || promotionState === "running" && (event.type === "extension_interaction_requested" || event.type === "extension_interaction_resolved"))
          for (const listener of listeners) listener(event);
      };
      let goalController: NativeGoalController | undefined;
      let planController: NativePlanController | undefined;
      let todosController: NativeSessionTodos | undefined;
      if (options.interactions) {
        bridge = new OmpInteractionBridge(session.sessionId, emitBridge);
        result.setToolUIContext(bridge, true);
        const ui = bridge;
        session.setUsageFallbackConfirmer((confirmation, signal) => ui.permissionConfirm(
          "Coding-plan reserve reached",
          `${confirmation.from} has ${confirmation.remainingPercent === undefined ? "reached its configured reserve" : `${confirmation.remainingPercent.toFixed(1)}% remaining`}. Switch to ${confirmation.to}?`,
          { signal },
        ));
      }
      const ui = bridge;
      let extensionStartup: Promise<void> | undefined;
      const unsubscribe = session.subscribe(event => {
        if (promotionState !== "idle") return;
        goalController?.observe(event);
        planController?.observeEvent(event);
        todosController?.observeEvent(event);
        detachedQuestions.observe(event);
        mirror.accept(event);
        for (const listener of listeners) listener(event);
      });
      let disposed = false;
      let disposeCall: Promise<void> | undefined;
      let promptInFlight = false;
      let admissionPending = false;
      let admissionAbort: AbortController | undefined;
      let interruptsInFlight = 0;
      let interruptEpoch = 0;
      let accountMutation = false;
      let goalMutation = false;
      let planMutation: Promise<unknown> | undefined;
      let planTransitionInFlight = false;
      const outputEpoch = crypto.randomUUID();
      const htmlPreviews = new HtmlPreviews();
      let outputRead: Promise<import("@agent-desktop/shared").SessionOutputs> | undefined;
      const mcpReads = new Set<Promise<NativeSessionMcpResourceResult>>();
      let mcpMutation: Promise<unknown> | undefined;
      let goalPreviousTools = session.getEnabledToolNames().filter(name => name !== "goal");
      const assertSessionActive = () => { if (disposed) throw new Error("OMP session is disposed"); if (promotionState !== "idle") throw new Error("The native session is transitioning after side-chat promotion. Reopen it after worker retirement."); };
      const mcpFiles = new McpFileResources(manager.getCwd());
      const mcpApps = new NativeMcpApps({ executeTool: async (connection, tool, args, signal, assertOwner, metadata) => {
        // Share the session's normal extension startup with prompt admission.
        // A closing app releases only its waiter; startup stays session-owned.
        if (ui) { extensionStartup ??= initializeDesktopExtensions(session, ui); await untilAborted(signal, () => extensionStartup!); }
        signal.throwIfAborted(); assertOwner();
        return executeMcpAppTool(session, ui, connection, tool, args, signal, assertOwner, metadata);
      }, artifact: entryId => {
        const entry = manager.getBranch().find(entry => entry.id === entryId);
        return entry?.type === "message" ? nativeMcpArtifact(entry.id, entry.message) : undefined;
      }, filePath: source => path.join(mcpFiles.workspace.cwd, source.path), fileResource: (...args) => mcpFiles.request(...args), watchFile: (...args) => mcpFiles.watch(...args), manager: result.mcpManager, snapshot: () => mcp.read(), assertOwner: () => { assertSessionActive(); if (mcpMutation) throw new Error("MCP servers are changing."); } });
      const assertInteractionActive = () => { if (disposed || promotionState === "retired") throw new Error("The native interaction owner has retired."); };
      const accountBridge = createNativeAccountSelectionBridge(async () => session, { assertActive: assertSessionActive, revalidate: () => auth.revalidateCredentials() });
      const controls = new NativeSessionControls(session, options.approvalOverride);
      const nativeGoalController = goalController = new NativeGoalController(session, manager, () => ({
        disposed, admissionPending, promptInFlight, mutationPending: goalMutation || accountMutation || Boolean(mcpMutation) || Boolean(planMutation) || Boolean(planController?.busy) || Boolean(todosController?.busy),
        interruptsInFlight, interactionsPending: (ui?.list().length ?? 0) > 0,
      }), async () => { await session.setActiveToolsByName(goalPreviousTools); });
      const assertIdle = () => {
        assertSessionActive();
        if (usage.busy || promptInFlight || accountMutation || goalMutation || planMutation || planController?.busy || todosController?.busy || mcpMutation || session.isStreaming || session.hasPostPromptWork) throw new Error("OMP session is busy");
      };
      const assertSnapshotReady = (operation = "moving this task") => {
        assertIdle();
        if (session.queuedMessageCount || ui?.list().length || btw.get()?.status === "running" || interruptsInFlight || mcpReads.size || outputRead || htmlPreviews.active || mcpApps.pending) throw new Error(`Resolve queued messages, questions, side answers, MCP reads, HTML previews, and interrupts before ${operation}.`);
      };
      const usage = new NativeSessionUsage(session, () => assertSnapshotReady("inspecting provider usage"), assertSessionActive);
      const taskLocationOutcomeUnknown = (message: string) => Object.assign(new Error(message), { name: "TaskLocationOutcomeUnknown", code: "OUTCOME_UNKNOWN" });
      const trackMcpMutation = <T>(run: Promise<T>) => {
        mcpMutation = run;
        const clear = () => { if (mcpMutation === run) mcpMutation = undefined; };
        void run.then(clear, clear);
        return run;
      };
      result.mcpManager?.setAuthHandler(async (serverName, challenge, nativeContext) => {
        assertSessionActive();
        // Tools invoke this during their running turn. Do not acquire the idle
        // gate or reload the manager that is awaiting this callback.
        if (!options.interactions || !nativeContext || interruptsInFlight || mcpMutation
          || admissionAbort?.signal.aborted) throw new Error("Native MCP authorization cannot start during pending session work.");
        const pending = mcp.startToolAuthorization(serverName, challenge, nativeContext, {
          cwd: manager.getCwd(), authStorage: auth, assertOwner: assertSessionActive,
        });
        void trackMcpMutation(pending.operation.completion);
        return pending.config;
      });
      const listAccounts = async () => {
        assertSessionActive();
        return accountBridge.list(session.sessionId);
      };
      // The SDK returns the dialect selected for this Agent's constructor.
      // Later settings edits must not invent a different wire owner.
      const constructionDialect = result.nativeDialect;
      let forceAdmissionDepth = 0;
      let nativeForceDispatchDepth = 0;
      const forceOwnerId = session.sessionId;
      let forceOwnershipRevision = 0;
      let previousForceOwnership: readonly unknown[] | undefined;
      const getForceOwnershipRevision = () => {
        // Scope depth only changes presentation. Revision follows the actual
        // owner and canonical command identities, including runner replacement.
        const current = [disposed, promotionState, session.sessionId, session.isDisposed, session.extensionRunner,
          session.extensionRunner?.getCommand("force")?.handler,
          session.customCommands.find(command => command.command.name === "force")?.command.execute];
        if (previousForceOwnership && current.some((value, index) => value !== previousForceOwnership![index])) forceOwnershipRevision++;
        previousForceOwnership = current;
        return forceOwnershipRevision;
      };
      const forceTool = new NativeForceToolController(session, {
        getDialect: () => constructionDialect ?? resolveOwnedDialectFromEnv(Bun.env.PI_DIALECT),
        getOwnershipRevision: getForceOwnershipRevision,
        getOwnershipReason: () => disposed || promotionState !== "idle" || session.sessionId !== forceOwnerId
          ? "The original native force owner has retired."
          : nativeForceDispatchDepth === 0 && (session.extensionRunner?.getCommand("force") || session.customCommands.some(command => command.command.name === "force"))
            ? "An extension or custom command owns /force in this session." : undefined,
        getBusyReason: () => (forceAdmissionDepth === 0 && (promptInFlight || admissionPending))
          || accountMutation || goalMutation || planMutation || planController?.busy || todosController?.busy || mcpMutation || interruptsInFlight || session.hasPostPromptWork
          || session.queuedMessageCount || ui?.list().length || btw.get()?.status === "running"
          ? "Resolve current native work before changing the force queue." : undefined,
      });
      const withinForceAdmission = <T>(operation: () => T): T => {
        forceAdmissionDepth++;
        try { return operation(); } finally { forceAdmissionDepth--; }
      };
      const forceAdmissionPort = {
        getState: () => forceTool.getState(),
        captureArm: <T>(input: Parameters<NativeForceToolController["captureArm"]>[0], invoke: () => T) => {
          return withinForceAdmission(() => forceTool.captureArm(input, invoke));
        },
        cancel: (input: Parameters<NativeForceToolController["cancel"]>[0]) => forceTool.cancel(input),
        assertRecovery: (input: ForceToolRecovery) => withinForceAdmission(() => forceTool.assertRecovery(input)),
      };
      const planEpoch = crypto.randomUUID();
      const nativePlan = planController = new NativePlanController(session, manager, {
        assertOwner: () => {
          if (planTransitionInFlight) {
            if (disposed || promotionState === "retired") throw new Error("The original native Plan owner has retired.");
          } else assertSessionActive();
        },
        confirmExit: () => {
          if (!ui) throw new Error("The native Plan confirmation UI is unavailable; the plan was retained.");
          return ui.confirm("Exit plan mode?", "Your plan is saved. Exit plan mode without approving it?");
        },
        onChanged: () => { if (!disposed && promotionState === "idle") for (const listener of listeners) listener({ type: "plan_changed" }); },
      });
      const trackPlanMutation = <T>(work: () => Promise<T>): Promise<T> => {
        assertSessionActive();
        if (planMutation) throw new Error("The original native Plan operation is still settling.");
        // Reserve before invoking code that can emit a synchronous callback.
        const operation = Promise.resolve().then(work);
        planMutation = operation;
        const clear = () => { if (planMutation === operation) planMutation = undefined; };
        void operation.then(clear, clear);
        return operation;
      };
      const readPlan = () => {
        assertSessionActive();
        const review = nativePlan.readReview(), snapshot = nativePlan.snapshot();
        const busyReason = !resolveNativePlanInvocation(session, "/plan") ? "An extension or custom command owns /plan in this session." : nativePlan.busy || planMutation || accountMutation || goalMutation || mcpMutation || todosController?.busy || admissionPending || interruptsInFlight
          || session.isCompacting || session.isAborting || session.hasPostPromptWork
          ? "Wait for the owning native operation to settle." : undefined;
        return projectSessionPlan({ epoch: planEpoch, snapshot, review, enabled: session.settings.get("plan.enabled"), busyReason });
      };
      const readPlanDocumentSection = (raw: PlanDocumentReadRequest): PlanDocumentSection => {
        const request = parsePlanDocumentReadRequest(raw), original = readPlan(), review = original.review;
        if (request.sessionId !== session.sessionId || request.ticket.epoch !== original.ticket.epoch
          || request.ticket.nativeSessionId !== original.ticket.nativeSessionId || request.ticket.revision !== original.ticket.revision
          || request.reviewId !== review?.id || request.reviewRevision !== review.revision
          || request.selection.documentRevision !== review.document?.documentRevision)
          throw new Error("The original Plan document changed. Refresh before inspecting this section.");
        const section = nativePlan.readReviewDocumentSection({ reviewId: review.id, reviewRevision: review.revision,
          documentRevision: request.selection.documentRevision, renderColumns: request.selection.renderColumns,
          sectionId: request.selection.sectionId });
        const current = readPlan();
        if (current.ticket.epoch !== original.ticket.epoch || current.ticket.nativeSessionId !== original.ticket.nativeSessionId
          || current.ticket.revision !== original.ticket.revision || current.review?.id !== review.id
          || current.review.revision !== review.revision
          || current.review.document?.documentRevision !== request.selection.documentRevision)
          throw new Error("The original Plan document changed during inspection.");
        return section;
      };
      await trackPlanMutation(() => nativePlan.restore());
      if (shouldEnterPlanModeOnStartup(manager, session.settings)) await trackPlanMutation(() => nativePlan.enter());
      // Todos are branch state owned by this loaded session. A /todo slash
      // dispatch runs inside its own prompt admission, so only that depth may
      // ignore the prompt gate; every other native operation still blocks it.
      let todoDispatchDepth = 0;
      const nativeTodos = todosController = new NativeSessionTodos(session, manager, {
        assertOwner: assertSessionActive,
        getBusyReason: () => usage.busy || (todoDispatchDepth === 0 && (promptInFlight || admissionPending))
          || accountMutation || goalMutation || planMutation || planController?.busy || mcpMutation || interruptsInFlight
          || session.isStreaming || session.isCompacting || session.isAborting || session.hasPostPromptWork
          || session.queuedMessageCount || ui?.list().length || btw.get()?.status === "running"
          ? "Resolve current native work before changing Todos." : undefined,
        onChanged: () => { if (!disposed && promotionState === "idle") for (const listener of listeners) listener({ type: "todos_changed" }); },
      });
      const handle: OmpSession = {
        readUsage: mode => usage.read(mode),
        prepareUsageReset: request => usage.prepare(request),
        redeemUsageReset: (ticket, requestId) => usage.redeem(ticket, requestId),
        get id() { return session.sessionId; },
        get sessionFile() { return session.sessionFile ?? sessionFile; },
        get cwd() { return manager.getCwd(); },
        get model() { return session.model ? { provider: session.model.provider, id: session.model.id } : null; },
        get thinkingLevel() { return session.configuredThinkingLevel(); },
        get isStreaming() { return session.isStreaming; },
        get hasPostPromptWork() { return usage.busy || session.hasPostPromptWork || Boolean(mcp.getAuthorization()?.pending) || nativePlan.busy || Boolean(planMutation) || nativeTodos.busy; },
        get title() { return session.sessionName ?? manager.getHeader()?.title; },
        get createdAt() { return Date.parse(manager.getHeader()!.timestamp); },
        modelFallbackMessage: result.modelFallbackMessage,
        getMessages: () => {
          assertSessionActive();
          return transcript();
        },
        getExportIntent: async text => { assertSessionActive(); return nativeExportIntent(session, text); },
        exportSession: input => exportNativeSession(session, input, () => assertSnapshotReady("exporting this conversation")),
        flushSession: async () => {
          assertSnapshotReady("forking this conversation");
          const source = { sessionId: manager.getSessionId(), sessionFile: session.sessionFile ?? sessionFile, cwd: manager.getCwd() };
          await manager.flush();
          assertSnapshotReady("forking this conversation");
          if (manager.getSessionId() !== source.sessionId || (session.sessionFile ?? sessionFile) !== source.sessionFile || manager.getCwd() !== source.cwd)
            throw new Error("The native source identity changed while flushing for Fork.");
          return source;
        },
        getSessionActivity: () => {
          // IPC needs final identity/activity metadata while this worker retires.
          if (disposed) throw new Error("OMP session is disposed");
          const goal = goalActivity(session);
          const nativeJobs = session.getAsyncJobSnapshot({ recentLimit: 20 });
          const job = (value: NonNullable<typeof nativeJobs>["running"][number]) => ({ ...value, id: value.id.slice(0, 200), label: value.label.slice(0, 500), ...(value.agentId ? { agentId: value.agentId.slice(0, 200) } : {}) });
          const jobs = nativeJobs ? { availability: "available" as const, value: {
            running: nativeJobs.running.slice(0, 100).map(job), recent: nativeJobs.recent.slice(0, 20).map(job),
            delivery: { queued: nativeJobs.delivery.queued, delivering: nativeJobs.delivery.delivering,
              ...(nativeJobs.delivery.nextRetryAt === undefined ? {} : { nextRetryAt: nativeJobs.delivery.nextRetryAt }),
              pendingJobIds: nativeJobs.delivery.pendingJobIds.slice(0, 100).map(id => id.slice(0, 200)) },
          } } : { availability: "unavailable" as const, reason: "This native session has no asynchronous job manager." };
          const agents = agentRegistry.list().filter(ref => ref.kind !== "main").slice(0, 100).map(ref => ({
            id: ref.id.slice(0, 200), displayName: ref.displayName.slice(0, 500), status: ref.status, running: agentRegistry.isRunning(ref),
            ...(ref.parentId ? { parentId: ref.parentId.slice(0, 200) } : {}), createdAt: ref.createdAt, lastActivity: ref.lastActivity,
            ...(ref.activity ? { activity: ref.activity.slice(0, 500) } : {}),
          }));
          return { goal: { availability: "available", value: goal }, jobs, agents: { availability: "available", value: agents },
            sources: { availability: "unsupported", reason: "OMP 18.1.10 does not expose a stable consumed-source registry for this session." } };
        },
        refreshGoalUsage: async () => { assertSessionActive(); await nativeGoalController.refreshUsage(); },
        getGoalContinuationEligibility: () => nativeGoalController.eligibility(),
        startGoalContinuation: expectedGoalId => {
          assertSessionActive();
          const run = nativeGoalController.begin(expectedGoalId, async prompt => {
            const controller = new AbortController();
            admissionAbort = controller;
            promptInFlight = true; admissionPending = true;
            try {
              await auth.revalidateCredentials();
              assertSessionActive();
              controller.signal.throwIfAborted();
              admissionPending = false;
              return await session.promptCustomMessage({ customType: "goal-continuation", content: prompt,
                display: false, attribution: "agent" }, { streamingBehavior: "followUp" });
            } finally { promptInFlight = false; admissionPending = false; if (admissionAbort === controller) admissionAbort = undefined; }
          });
          return run;
        },
        listQuestions: async () => {
          assertSessionActive();
          // A host may reconcile a lost answer receipt from this snapshot.
          // Never expose an unflushed in-memory acceptance as durable evidence.
          const snapshot = await detachedQuestions.snapshot(); assertSessionActive(); return snapshot;
        },
        resolveQuestion: request => {
          assertSessionActive();
          if (interruptsInFlight) throw detachedQuestionRejected("The native turn is being interrupted. Refresh its question state before answering.");
          return detachedQuestions.resolve(request);
        },
        startQuestionDelivery: questionId => {
          assertSessionActive();
          const startedBeforeInterrupt = interruptEpoch;
          const preflight = () => {
            assertSessionActive();
            if (admissionPending || accountMutation || goalMutation || planMutation || planController?.busy || nativeTodos.busy || mcpMutation || interruptsInFlight || session.hasPostPromptWork
              || session.queuedMessageCount > 0 || (ui?.list().length ?? 0) > 0) {
              throw detachedQuestionRejected("The native session cannot accept a detached answer yet.");
            }
            return session.isStreaming ? "steer" as const : "followUp" as const;
          };
          const dispatch = (text: string, mode: "steer" | "followUp") => {
            // Journaling the attempt yields. Stop may finish during that flush,
            // so recheck its epoch before queuing any native user message.
            let reason: string | undefined;
            try {
              if (interruptEpoch !== startedBeforeInterrupt) reason = "Interrupted before native answer delivery.";
              else if (preflight() !== mode) reason = "The native turn changed before answer delivery.";
            } catch (error) { reason = error instanceof Error ? error.message : String(error); }
            if (reason) return { accepted: Promise.resolve({ kind: "not-recorded" as const, reason }), completion: Promise.resolve(false) };
            const completed = Promise.withResolvers<boolean>();
            const stop = session.subscribe(event => {
              if (event.type !== "agent_end") return;
              stop(); completed.resolve(true);
            });
            const admission = (mode === "steer" ? steering.submit(text) : steering.submitFollowUp(text)).then(receipt => {
              if (receipt.kind !== "user-message") { stop(); completed.reject(new Error(receipt.reason)); }
              return receipt;
            }, error => { stop(); completed.reject(error); throw error; });
            void completed.promise.catch(() => {});
            return { accepted: admission, completion: completed.promise };
          };
          return detachedQuestions.startDelivery(questionId, preflight, dispatch);
        },
        getSessionMcp: () => { assertSessionActive(); return mcp.read(); },
        startSessionMcpAuthorization: request => {
          assertIdle();
          if (admissionPending || interruptsInFlight || session.queuedMessageCount > 0 || ui?.list().length || btw.get()?.status === "running")
            throw new Error("Resolve pending native work before authorizing an MCP server.");
          const operation = mcp.startAuthorization(request, { commandId: request.commandId, cwd: manager.getCwd(), authStorage: auth, assertOwner: assertSessionActive });
          trackMcpMutation(operation.completion);
          return operation.snapshot();
        },
        getSessionMcpAuthorization: () => { assertSessionActive(); return mcp.getAuthorization()?.snapshot() ?? null; },
        respondSessionMcpAuthorization: request => {
          assertSessionActive();
          const operation = mcp.getAuthorization();
          if (!operation || operation.id !== request.authorizationId) throw new Error("MCP authorization owner changed.");
          operation.respond(request.requestId, request.response);
          return operation.snapshot();
        },
        cancelSessionMcpAuthorization: authorizationId => {
          assertSessionActive();
          const operation = mcp.getAuthorization();
          if (!operation || operation.id !== authorizationId) throw new Error("MCP authorization owner changed.");
          operation.cancel();
          return operation.snapshot();
        },
        reloadSessionMcp: request => {
          assertIdle();
          if (admissionPending || interruptsInFlight || session.queuedMessageCount > 0 || ui?.list().length || btw.get()?.status === "running")
            throw new Error("Resolve pending native work before reloading MCP servers.");
          return trackMcpMutation(mcp.reload(request));
        },
        sessionMcpApp: request => mcpApps.request(request),
        readSessionMcpResource: request => {
          assertSessionActive();
          if (mcpReads.size >= 8) throw new Error("Wait for pending MCP resource reads.");
          const run = mcp.readResource(request);
          mcpReads.add(run);
          void run.then(() => mcpReads.delete(run), () => mcpReads.delete(run));
          return run;
        },
        reconnectSessionMcp: request => {
          assertIdle();
          if (admissionPending || interruptsInFlight || session.queuedMessageCount > 0 || ui?.list().length || btw.get()?.status === "running")
            throw new Error("Resolve pending native work before reconnecting an MCP server.");
          return trackMcpMutation(mcp.reconnect(request));
        },
        getBtw: () => { assertSessionActive(); return btw.get(); },
        startBtw: input => { assertSessionActive(); if (mcpMutation) throw new Error("MCP servers are reloading."); return btw.start(input); },
        cancelBtw: runId => { assertSessionActive(); return btw.cancel(runId); },
        promoteBtw: (runId, operationId) => {
          assertIdle();
          if (ui?.list().length || interruptsInFlight) throw new Error("Resolve pending native interactions before promoting a side answer.");
          const originId = session.sessionId, originFile = session.sessionFile;
          promotionState = "running";
          promotionCall = (async () => {
          try {
            const promoted = await btw.promote(runId, operationId);
            if (!promoted.cancelled) {
              if (session.sessionId === originId || !promoted.sessionFile || promoted.sessionFile !== session.sessionFile)
                throw new Error("Native side-chat promotion did not establish a new persisted identity.");
              await manager.flush();
            }
            return { cancelled: promoted.cancelled, sessionId: session.sessionId, sessionFile: session.sessionFile! };
          } finally {
            const changed = session.sessionId !== originId || session.sessionFile !== originFile;
            // Hold both paths until native disposal has been acknowledged. Never
            // let old handle callbacks/tool contexts continue under a new owner.
            if (session.sessionFile) { const file = path.resolve(session.sessionFile); this.#reservedFiles.add(file); reservedPaths.add(file); }
            promotionState = changed ? "retired" : "idle";
          }
          })();
          return promotionCall;
        },
        mutateGoal: async request => {
          // Pause/drop mirror InteractiveMode: they may settle between native
          // tool executions without aborting the provider turn. Other goal
          // changes remain idle-only.
          const runningSafe = request.mutation.type === "pause" || request.mutation.type === "drop";
          if (!runningSafe) {
            try { assertIdle(); } catch { throw goalRejected("The native session is busy. Wait for its current work to finish."); }
          } else {
            assertSessionActive();
            if (admissionPending || accountMutation || goalMutation || planMutation || planController?.busy || nativeTodos.busy || mcpMutation || interruptsInFlight || session.hasPostPromptWork
              || nativeGoalController.hasActiveToolExecution() || (ui?.list().length ?? 0) > 0) {
              throw goalRejected("The native session has an active tool, approval, ask, or admission. Wait for it to settle.");
            }
          }
          if (!session.settings.get("goal.enabled")) throw goalRejected("Goals are disabled in this session's native settings.");
          const context = manager.buildSessionContext();
          if (context.mode === "plan" || context.mode === "plan_paused" || session.getVibeModeState()?.enabled) {
            throw goalRejected("Exit the session's current native mode before changing its goal.");
          }
          const current = session.getGoalModeState();
          if (request.expectedGoal === null) {
            if (request.mutation.type !== "create" || current?.goal) throw goalRejected("The native goal changed. Refresh before trying again.");
          } else if (!current?.goal || current.goal.id !== request.expectedGoal.id) {
            throw goalRejected("The native goal changed. Refresh before trying again.");
          }
          const mutation = request.mutation;
          if (current?.mode === "exiting" || current?.goal.status === "complete") throw goalRejected("A completed native goal is read-only.");
          if (mutation.type === "create" && current?.goal) throw goalRejected("This session already has a native goal.");
          if (mutation.type === "replace" && (!current?.enabled || !["active", "budget-limited"].includes(current.goal.status))) throw goalRejected("Only an active native goal can be replaced.");
          if (mutation.type === "pause" && (!current?.enabled || !["active", "budget-limited"].includes(current.goal.status))) throw goalRejected("This native goal is not active.");
          if (mutation.type === "resume" && (current?.enabled || current?.goal.status !== "paused")) throw goalRejected("This native goal is not paused.");
          const activating = mutation.type === "create" || mutation.type === "replace" || mutation.type === "resume";
          let restorationTools = goalPreviousTools;
          if (activating) {
            try { restorationTools = session.getEnabledToolNames().filter(name => name !== "goal"); }
            catch { throw goalRejected("The native tool presentation is unavailable. Refresh before changing this goal."); }
          }
          const fingerprint = createHash("sha256").update(goalControlState(goalActivity(session))).digest("hex");
          if (fingerprint !== request.goalFingerprint) throw goalRejected("The native goal changed. Refresh before trying again.");
          goalMutation = true;
          try {
            try {
              if (mutation.type === "create") await session.goalRuntime.createGoal({ objective: mutation.objective, tokenBudget: mutation.tokenBudget });
              else if (mutation.type === "replace") await session.goalRuntime.replaceGoal({ objective: mutation.objective, tokenBudget: mutation.tokenBudget });
              else if (mutation.type === "pause") await session.goalRuntime.pauseGoal();
              else if (mutation.type === "resume") await session.goalRuntime.resumeGoal();
              else if (mutation.type === "drop") await session.goalRuntime.dropGoal();
              else if (mutation.type === "setBudget") await session.goalRuntime.onBudgetMutated(mutation.tokenBudget);
              if (activating) {
                await session.setActiveToolsByName([...new Set([...restorationTools, "goal"])]);
                goalPreviousTools = restorationTools;
              } else if (mutation.type === "pause" || mutation.type === "drop") {
                await session.setActiveToolsByName(goalPreviousTools);
                if (mutation.type === "drop") goalPreviousTools = session.getEnabledToolNames().filter(name => name !== "goal");
              }
              await manager.flush();
              if (activating) nativeGoalController.resetSuppression();
              return goalActivity(session);
            } catch (error) {
              throw goalOutcomeUnknown(error);
            }
          } finally { goalMutation = false; }
        },
        getComposerActions: async () => { assertSessionActive(); return sessionComposerActions(session, result.extensionsResult?.extensions ?? []); },
        getComposerCompletions: async query => { assertSessionActive(); return composerCompletions(sessionComposerActions(session, result.extensionsResult?.extensions ?? []), query, session, result.mcpManager); },
        openHtmlPreview: async input => {
          assertSessionActive();
          const request = parseHtmlPreviewRequest(input), cwd = manager.getCwd(), branch = manager.getBranch();
          if (request.epoch !== outputEpoch) throw new Error("The original output worker changed.");
          if (request.output.branch !== sessionOutputBranch(branch)) throw new Error("The original output branch changed. Refresh the Suggested output.");
          const retained = branch.map(entry => entry.id);
          const current = async () => {
            assertSessionActive();
            if (cwd !== manager.getCwd()) return false;
            const now = manager.getBranch(), ids = new Set(now.map(entry => entry.id));
            if (retained.some(id => !ids.has(id))) return false;
            const outputs = await inspectSessionOutputs(now, cwd, outputEpoch);
            assertSessionActive();
            const finalIds = new Set(manager.getBranch().map(entry => entry.id));
            return retained.every(id => finalIds.has(id)) && cwd === manager.getCwd() && outputs.outputs.some(output => output.kind === 'html-preview'
              && output.path === request.output.path && output.entryId === request.output.entryId && output.revision === request.output.revision);
          };
          if (!await current()) throw new Error("The original saved HTML changed. Refresh its output.");
          return htmlPreviews.open(request, cwd, branch, current);
        },
        releaseHtmlPreview: async id => { htmlPreviews.release(id); },
        getSessionOutputs: () => {
          assertSessionActive();
          if (outputRead) return outputRead;
          const branch = manager.getBranch(), cwd = manager.getCwd();
          const identity = JSON.stringify(branch.map(entry => entry.id));
          const pending = (async () => {
            const value = await inspectSessionOutputs(branch, cwd, outputEpoch);
            assertSessionActive();
            if (manager.getCwd() !== cwd || JSON.stringify(manager.getBranch().map(entry => entry.id)) !== identity) throw new Error("The saved outputs changed during inspection. Refresh the original task.");
            return value;
          })();
          outputRead = pending;
          const settled = () => { if (outputRead === pending) outputRead = undefined; };
          void pending.then(settled, settled);
          return pending;
        },
        getImage: async (nativeEntryId, blockIndex, source) => {
          assertSessionActive();
          if (typeof nativeEntryId !== "string" || nativeEntryId.length > 200 || !Number.isSafeInteger(blockIndex) || blockIndex < 0) throw new Error("Invalid native image identity");
          const entry = manager.getBranch().find(entry => entry.id === nativeEntryId);
          if (source !== undefined && source !== "generated") throw new Error("Invalid saved image namespace.");
          if (source === "generated") return recordedGeneratedImage(entry, blockIndex);
          if (entry?.type === "message" && entry.message.role === "fileMention") {
            const image = lookupFileMentionImage(entry.message, blockIndex);
            if (!image) throw new Error("Native referenced image is unavailable");
            return image;
          }
          if (entry?.type !== "message" || !("content" in entry.message) || !Array.isArray(entry.message.content)) throw new Error("Native image entry is unavailable");
          return readNativeImage(entry.message.content[blockIndex]);
        },
        createBrowserTab: async (name, initialUrl) => {
          assertSessionActive();
          const module = await import("@oh-my-pi/pi-coding-agent/tools/browser") as unknown as {
            BROWSER_TAB_CREATE_INITIAL_URL_VERSION?: number;
            createBrowserTabForSession?: (session: AgentSession, request: { name: string; initialUrl?: string }) => Promise<{
              created: true; name: string; ownerSessionId: string; targetId: string;
              backend: "worker" | "cmux"; kindTag: NativeBrowserTabMetadata["kindTag"];
              targetDisposition: OmpBrowserTabCreateResult["targetDisposition"];
              url: string; title: string; viewport: NativeBrowserTabMetadata["viewport"];
            }>;
          };
          if (typeof module.createBrowserTabForSession !== "function") {
            const error = new Error("This pinned native OMP package does not include browser tab creation.");
            error.name = "BrowserTabCreateRejected";
            throw error;
          }
          if (initialUrl !== undefined && module.BROWSER_TAB_CREATE_INITIAL_URL_VERSION !== 1) {
            const error = new Error("This pinned native OMP package does not support initial browser navigation.");
            error.name = "BrowserTabCreateRejected";
            throw error;
          }
          const value = await module.createBrowserTabForSession(session, { name, ...(initialUrl === undefined ? {} : { initialUrl }) });
          if (value.ownerSessionId !== session.sessionId || value.created !== true) throw new Error("Native browser creation changed session ownership.");
          return {
            tab: parseNativeBrowserTabMetadata({ ...value, state: "alive" }),
            targetDisposition: value.targetDisposition,
          };
        },
        installRetainedBrowserEvaluation: async (input, transport) => {
          assertSessionActive();
          const module = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor") as unknown as {
            installRetainedBrowserEvaluation?: (input: Record<string, unknown>, transport: { post(frame:unknown):void; installReceiver?(receive:(frame:unknown)=>void):void; request(method:string,params:Record<string,unknown>,options?:{timeoutMs?:number}):Promise<Record<string,unknown>> }) => Promise<{ receive(frame: unknown): void; dispose(): Promise<void> }>;
          };
          if (typeof module.installRetainedBrowserEvaluation !== "function") throw new Error("This pinned native OMP package does not include retained browser installation.");
          return module.installRetainedBrowserEvaluation({ ...input, ownerSessionId: session.sessionId }, transport);
        },
        subscribe: listener => {
          assertSessionActive(); listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        getPlan: readPlan,
        getPlanDocumentSection: readPlanDocumentSection,
        getPlanExternalEditorAvailable: () => { assertSessionActive(); return !!getEditorCommand(); },
        preparePlanExternalEditor: async raw => {
          const request = parsePlanExternalEditorRequest(raw);
          assertIdle();
          const original = readPlan();
          const current = () => {
            const value = readPlan();
            if (request.sessionId !== session.sessionId || request.ticket.epoch !== value.ticket.epoch
              || request.ticket.nativeSessionId !== value.ticket.nativeSessionId || request.ticket.revision !== value.ticket.revision
              || request.reviewId !== value.review?.id || request.reviewRevision !== value.review.revision
              || request.documentRevision !== value.review.document?.documentRevision || value.review.status !== "ready"
              || value.busyReason || value.reconciliationRequired || !value.enabled)
              throw new Error("The original Plan editor owner is unavailable. Refresh before editing.");
          };
          current();
          const editorCommand = getEditorCommand();
          if (!editorCommand) throw new Error("No editor configured on the owning host. Set VISUAL or EDITOR.");
          const prepared = await nativePlan.prepareExternalEditor(request);
          current();
          if (getEditorCommand() !== editorCommand || readPlan().ticket.revision !== original.ticket.revision)
            throw new Error("The Plan editor configuration changed during preparation.");
          return parsePreparedPlanExternalEditor({ request, nativeSessionId: session.sessionId, sessionFile: session.sessionFile,
            cwd: manager.getCwd(), ...prepared, editorCommand,
            environment: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          }, request);
        },
        getTodoExternalEditorAvailable: () => { assertSessionActive(); return !!getEditorCommand(); },
        prepareTodoExternalEditor: async raw => {
          const request = parseTodoExternalEditorRequest(raw);
          assertSessionActive();
          if (request.sessionId !== session.sessionId) throw new Error("The original Todos editor target changed.");
          const prepared = nativeTodos.prepareExternalEditor(request.ticket);
          const editorCommand = getEditorCommand();
          if (!editorCommand) throw new Error("No editor configured on the owning host. Set VISUAL or EDITOR.");
          return parsePreparedTodoExternalEditor({ request, nativeSessionId: session.sessionId, sessionFile: session.sessionFile,
            cwd: manager.getCwd(), ...prepared, editorCommand,
            environment: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          }, request);
        },
        getTodos: () => { assertSessionActive(); return nativeTodos.read(); },
        mutateTodos: async (commandId, raw) => {
          // Identity/parse failures precede admission; the owner tags its own
          // revision, shadow, busy and persistence outcomes.
          let request: TodoMutationRequest;
          try { parseTodoCommandId(commandId); request = parseTodoMutationRequest(raw); assertSessionActive(); }
          catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "TODOS_REJECTED" as const }); }
          if (request.sessionId !== session.sessionId)
            throw Object.assign(new Error("The native Todos target changed before dispatch."), { code: "TODOS_REJECTED" as const });
          return nativeTodos.mutate(commandId, request);
        },
        controlPlan: async raw => {
          let dispatched = false;
          try {
          const request = parsePlanControlRequest(raw), original = readPlan();
          if (request.sessionId !== session.sessionId || request.ticket.epoch !== original.ticket.epoch
            || request.ticket.nativeSessionId !== original.ticket.nativeSessionId || request.ticket.revision !== original.ticket.revision)
            throw new Error("The original Plan state changed. Refresh before choosing an action.");
          if (original.reconciliationRequired || planMutation || nativePlan.busy || nativeTodos.busy || accountMutation || goalMutation || mcpMutation
            || admissionPending || interruptsInFlight || session.isCompacting || session.isAborting || session.hasPostPromptWork)
            throw new Error("Resolve pending native work before changing the Plan state.");
          const invocation = request.action === "toggle" || request.action === "review"
            ? resolveNativePlanInvocation(session, request.action === "toggle" ? "/plan" : "/plan-review") : undefined;
          if ((request.action === "toggle" || request.action === "review") && !invocation)
            throw new Error("The native Plan command no longer owns this action.");
          let cancelled = false;
          dispatched = true;
          await trackPlanMutation(async () => {
            assertSessionActive(); invocation?.assertCurrent();
            if (request.action === "toggle") cancelled = Boolean((await nativePlan.toggle(invocation!)).cancelled);
            else if (request.action === "review") await nativePlan.openLatestReview(invocation);
            else if (request.action === "dismiss") nativePlan.dismissReview(request);
            else if (request.action === "reopen") nativePlan.reopenReview(request);
          });
          return { state: readPlan(), ...(cancelled ? { cancelled: true as const } : {}) };
          } catch (error) {
            const code = !dispatched || error instanceof NativePlanError && error.outcome === "rejected" ? "PLAN_REJECTED" : "OUTCOME_UNKNOWN";
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code });
          }
        },
        startPlanExecution: phaseId => {
          assertSessionActive();
          if (!phaseId || phaseId.length > 200 || phaseId.includes("\0")) throw new Error("Invalid native Plan phase identity.");
          if (promptInFlight || admissionPending || planMutation || nativePlan.busy || nativeTodos.busy || accountMutation || goalMutation || mcpMutation || interruptsInFlight)
            throw new Error("The original native owner has another pending admission.");
          const originalId = session.sessionId, originalFile = session.sessionFile;
          const controller = new AbortController();
          promptInFlight = admissionPending = true; admissionAbort = controller;
          const accepted = Promise.withResolvers<Awaited<OmpPlanExecutionRun["accepted"]>>();
          let nativeRun: OmpPlanExecutionRun | undefined, claimed = false;
          const assertOriginal = () => {
            assertSessionActive();
            if (session.sessionId !== originalId || session.sessionFile !== originalFile) throw new Error("The original Plan execution owner changed.");
          };
          const completion = (async () => {
            await auth.revalidateCredentials();
            if (ui) { extensionStartup ??= initializeDesktopExtensions(session, ui); await extensionStartup; }
            assertOriginal(); controller.signal.throwIfAborted();
            const handoff = await trackPlanMutation(() => nativePlan.claimExecution({ phaseId }));
            claimed = true;
            assertOriginal(); controller.signal.throwIfAborted();
            nativeRun = planExecution.start({ prompt: handoff.prompt, attribution: handoff.branch === "refine" ? "refinement" : "approval", assertCurrent: assertOriginal });
            const admission = nativeRun.accepted.then(async receipt => {
              await nativePlan.settleExecutionAdmission({ phaseId, outcome: receipt ? "entered" : "not-entered" });
              if (receipt) nativeGoalController.resetSuppression();
              accepted.resolve(receipt);
            }, async error => {
              try { await nativePlan.settleExecutionAdmission({ phaseId, outcome: "unknown" }); }
              catch (settlement) { throw new AggregateError([error, settlement], "Native Plan admission and settlement failed."); }
              throw error;
            });
            void admission.catch(error => accepted.reject(new NativePlanMessageAdmissionError(error)));
            const results = await Promise.allSettled([admission, nativeRun.completion]);
            const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
            if (failures.length) throw new AggregateError(failures, "Native Plan execution failed.");
            await nativeGoalController.settleFinalization();
            await nativePlan.settleAfterTurn();
          })().catch(async error => {
            if (claimed && !nativeRun) {
              // The durable claim exists but no native prompt call was made.
              try { await nativePlan.settleExecutionAdmission({ phaseId, outcome: "not-entered" }); }
              catch (settlement) { error = new AggregateError([error, settlement], "Native Plan pre-dispatch settlement failed."); }
            }
            accepted.reject(error); throw error;
          }).finally(() => {
            promptInFlight = false; admissionPending = false;
            if (admissionAbort === controller) admissionAbort = undefined;
          });
          void accepted.promise.catch(() => {}); void completion.catch(() => {});
          const clearAdmission = () => { admissionPending = false; };
          void accepted.promise.then(clearAdmission, clearAdmission);
          return { accepted: accepted.promise, completion, abort: async () => {
            controller.abort(); await session.abort(); await completion;
          } };
        },
        preparePlanDecision: async (commandId, raw) => {
          const request = parsePlanMutationRequest(raw);
          if (!commandId || commandId.length > 200 || commandId.includes("\0")) throw new Error("Invalid Plan command identity.");
          try { assertIdle(); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "PLAN_REJECTED" }); }
          const original = readPlan();
          if (request.sessionId !== session.sessionId || request.ticket.epoch !== original.ticket.epoch
            || request.ticket.nativeSessionId !== original.ticket.nativeSessionId || request.ticket.revision !== original.ticket.revision
            || request.reviewId !== original.review?.id || request.reviewRevision !== original.review.revision)
            throw Object.assign(new Error("The original Plan review changed. Refresh before choosing an action."), { code: "PLAN_REJECTED" });
          if (original.reconciliationRequired || original.review.status !== "ready" || original.busyReason || admissionPending
            || interruptsInFlight || ui?.list().length || btw.get()?.status === "running")
            throw Object.assign(new Error("Resolve the original Plan work before making another decision."), { code: "PLAN_REJECTED" });
          const originId = session.sessionId, originFile = session.sessionFile;
          const mutation = request.mutation;
          const documentRevision = original.review.document?.documentRevision;
          if (!documentRevision || mutation.action === "document" && mutation.documentAction.expectedDocumentRevision !== documentRevision)
            throw Object.assign(new Error("The original Plan document owner changed. Refresh before choosing an action."), { code: "PLAN_REJECTED" });
          const replacing = mutation.action === "save" || mutation.action === "approve" && mutation.context === "fresh";
          const receipt: PlanDecisionReceipt = { commandId, reviewId: request.reviewId, reviewRevision: request.reviewRevision,
            action: mutation.action, outcome: "applied", artifact: "unchanged", transition: "unchanged", execution: "not-requested" };
          return trackPlanMutation(async () => {
            assertSessionActive();
            // Native newSession changes identity inside this worker. Suppress
            // old-owner transcript events while retaining branch-hook questions.
            if (replacing) { planTransitionInFlight = true; promotionState = "running"; }
            try {
              const binding = { reviewId: request.reviewId, reviewRevision: request.reviewRevision };
              const prepared: OmpPlanDecisionPreparation = { receipt };
              if (mutation.action === "edit") {
                await nativePlan.editReview({ ...binding, documentRevision, content: mutation.content }); receipt.artifact = "written";
              } else if (mutation.action === "document") {
                const result = await nativePlan.mutateReviewDocument({ ...binding, action: mutation.documentAction,
                  renderColumns: mutation.renderColumns });
                receipt.artifact = result.artifactChanged ? "written" : "unchanged";
              } else if (mutation.action === "refine") {
                const result = await nativePlan.prepareRefinement({ ...binding, documentRevision, text: mutation.text });
                if (result.kind === "admission") { prepared.execution = { phaseId: result.phaseId }; receipt.execution = "not-entered"; }
              } else if (mutation.action === "approve") {
                const result = await nativePlan.decide({ ...binding, documentRevision,
                  action: mutation.context, executionRole: mutation.executionRole });
                receipt.execution = "not-entered";
                receipt.planExit = "completed";
                const compactOutcome = result.kind === "execution" ? result.phase.compactOutcome
                  : result.kind === "cancelled" && result.branch === "compact" ? result.compactOutcome : undefined;
                const compactMessage = result.kind === "execution" ? result.phase.compactMessage
                  : result.kind === "cancelled" && result.branch === "compact" ? result.compactMessage : undefined;
                if (compactOutcome) receipt.compaction = { outcome: compactOutcome, ...(compactMessage ? { message: compactMessage } : {}) };
                if (result.kind === "cancelled") receipt.outcome = "cancelled";
                else if (result.kind === "execution") prepared.execution = { phaseId: result.phase.phaseId };
                else {
                  prepared.execution = { phaseId: result.receipt.phaseId };
                  prepared.transition = result.receipt.newIdentity;
                  receipt.transition = "new-session"; receipt.destinationSessionId = result.receipt.newIdentity.nativeSessionId;
                }
              } else {
                const result = await nativePlan.saveAndStartNew({ ...binding, documentRevision, destination: mutation.destination });
                receipt.artifact = result.transition === "unknown" ? "unknown" : "written";
                receipt.planExit = result.planExit ?? "completed";
                if (result.savedDestination) receipt.savedDestination = result.savedDestination;
                if (result.transition === "cancelled") receipt.outcome = "cancelled";
                else {
                  receipt.transition = result.transition;
                  if (result.transition === "unknown") { receipt.outcome = "unknown"; receipt.message = result.message; }
                  if (result.newIdentity && result.newIdentity.nativeSessionId !== originId) {
                    prepared.transition = result.newIdentity; receipt.destinationSessionId = result.newIdentity.nativeSessionId;
                  }
                }
              }
              return parsePlanDecisionPreparation(prepared, commandId);
            } catch (error) {
              if (error instanceof NativePlanError && error.outcome === "rejected") throw Object.assign(error, { code: "PLAN_REJECTED" });
              if (!(error instanceof NativePlanError)) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "OUTCOME_UNKNOWN" });
              receipt.outcome = "unknown"; receipt.message = error.message;
              if (mutation.action === "approve" || mutation.action === "save") receipt.planExit = error.planExit ?? "unknown";
              if (error.compaction) receipt.compaction = error.compaction;
              receipt.artifact = mutation.action === "edit" || mutation.action === "save"
                || mutation.action === "document" && mutation.documentAction.kind !== "annotate" ? "unknown" : "unchanged";
              receipt.execution = mutation.action === "approve" || mutation.action === "refine" ? "unknown" : "not-requested";
              if (replacing) receipt.transition = "unknown";
              const replacement = error.receipt?.newIdentity;
              if (error.receipt?.savedDestination) receipt.savedDestination = error.receipt.savedDestination;
              if (replacement) receipt.destinationSessionId = replacement.nativeSessionId;
              return parsePlanDecisionPreparation({ receipt, ...(replacement ? { transition: replacement } : {}) }, commandId);
            } finally {
              if (replacing) {
                const changed = session.sessionId !== originId || session.sessionFile !== originFile;
                if (session.sessionFile) { const file = path.resolve(session.sessionFile); this.#reservedFiles.add(file); reservedPaths.add(file); }
                promotionState = changed ? "retired" : "idle";
                planTransitionInFlight = false;
              }
            }
          });
        },
        getForceTool: () => { assertSessionActive(); return forceTool.getState(); },
        cancelForceTool: input => { assertSessionActive(); return forceTool.cancel(input); },
        startPrompt: (text, promptOptions = {}) => {
          assertSessionActive();
          if (usage.busy || promptInFlight || accountMutation || goalMutation || planMutation || planController?.busy || nativeTodos.busy || mcpMutation || session.isStreaming || session.hasPostPromptWork) throw new Error("OMP session is busy; steer the running session instead");
          const forceFields = parseForceToolPromptFields(promptOptions);
          if (forceFields.forceRecovery && ((promptOptions.commandVersion ?? 0) < 18 || !promptOptions.commandId))
            throw new Error("Force prompt recovery requires command protocol 18 and its original operation identity.");
          promptOptions = { ...promptOptions, ...forceFields };
          if (promptOptions.forceRecovery && (promptOptions.images?.length || promptOptions.selectedText || promptOptions.wholeFiles))
            throw new Error("Force prompt recovery retains plain text only; attached content was not admitted by the original arm.");
          const images = copyPreparedImages(promptOptions.images);
          // Detach the renderer/worker payload before native setup can await.
          // A selected context is persisted separately, so its ordinary user
          // text must itself fit OMP's durable-string bound.
          const selectedTextInput = copyNativeSelectedTextInput(promptOptions.selectedText);
          const wholeFileInput = copyNativeWholeFileInput(promptOptions.wholeFiles, text.length);
          const nativeText = wholeFileInput ? hasRepeatedWholeFileSources(wholeFileInput.attachments)
            ? serializeRepeatedWholeFilePrompt(text, wholeFileInput.attachments) : serializeWholeFilePrompt(text, wholeFileInput.attachments) : text;
          if (selectedTextInput?.attachments.length && text.length > 500_000)
            throw new Error("Prompt text exceeds the native durable-history limit when selected text is attached.");
          if (wholeFileInput?.attachments.some(item => item.textOffset !== undefined) && nativeText.length > 500_000)
            throw new Error("Serialized inline whole-file prompt exceeds the native durable-history limit.");
          const selectedText = NativeSelectedTextPrompt.fromInput(session, selectedTextInput);
          const wholeFiles = NativeWholeFilePrompt.fromInput(session, wholeFileInput, text);
          // A slash handler may finish locally, rewrite the input, or record a
          // special native message. Never append selected context before it.
          if ((selectedText || wholeFiles) && text.trimStart().startsWith("/")) throw new Error("Selected text and whole-file attachments are only supported for ordinary prompts; slash commands and skills were not executed.");
          const imagePrompt = images?.length ? new NativeImagePrompt(images, nativeText) : undefined;
          const controller = new AbortController();
          const assertForceAdmissionOwner = () => {
            assertSessionActive();
            if (admissionAbort !== controller || controller.signal.aborted || !admissionPending)
              throw new Error("The original force prompt admission has retired.");
          };
          const forceAdmission = new NativeForceToolAdmission(forceAdmissionPort, session, promptOptions, assertForceAdmissionOwner);
          let recoveryPromptEntered = false;
          promptInFlight = true;
          admissionPending = true;
          admissionAbort = controller;
          let skillPrompt: NativeSkillPrompt | undefined;
          const receipt = Promise.withResolvers<OmpPromptReceipt | null>();
          const completion = (async () => {
              await auth.revalidateCredentials();
              if (ui) {
                // Deferred until the handle exists: session_start may itself wait
                // for user input, which must never deadlock worker initialization.
                extensionStartup ??= initializeDesktopExtensions(session, ui);
                await extensionStartup;
              }
              assertSessionActive();
              if (controller.signal.aborted) throw new Error("OMP prompt aborted before native acceptance");
              // Extension startup can add skills, so resolve them only after it
              // has completed, but before admission attribution is installed.
              skillPrompt = promptOptions.forceRecovery ? undefined : NativeSkillPrompt.fromText(session, text);
              if ((selectedText || wholeFiles) && skillPrompt) throw new Error("Selected text and whole-file attachments are not supported on native skill prompts; no input was executed.");
              if (skillPrompt && imagePrompt) throw new Error("Images on native skill invocations are not connected yet; the draft was retained.");
              // Startup extension messages are not receipts for the submitted draft.
              const dispatchedRun = forceAdmission.wrapRun(beginNativePrompt(manager, async () => {
                if (promptOptions.model) await session.setModel(this.#findModel(registry, promptOptions.model, session.settings));
                if (controller.signal.aborted) throw new Error("OMP prompt aborted before native acceptance");
                if (promptOptions.thinkingLevel !== undefined) {
                  const selection = parseCliThinkingLevel(promptOptions.thinkingLevel);
                  if (selection === undefined) throw new Error("Unknown OMP thinking level");
                  session.setThinkingLevel(selection, false);
                }
                await imagePrompt?.prepare(session, manager);
                await skillPrompt?.prepare();
                if (controller.signal.aborted) throw new Error("OMP prompt aborted before native acceptance");
                selectedText?.prepare(session, nativeText, { allowImages: imagePrompt !== undefined });
                await selectedText?.append();
                await wholeFiles?.prepare(session);
                assertSessionActive();
                if (controller.signal.aborted) throw new Error("OMP prompt aborted after attachment context append");
                if (promptOptions.forceRecovery) return assertForceToolRecoveryAndEnter(forceAdmissionPort, promptOptions.forceRecovery,
                  assertForceAdmissionOwner, async () => {
                    recoveryPromptEntered = true;
                    return { agentInvoked: await session.prompt(nativeText) };
                  });
                return dispatchNativePrompt(session, nativeText, imagePrompt?.images, skillPrompt, {
                  plan: async raw => {
                    const invocation = resolveNativePlanInvocation(session, raw);
                    if (!invocation) throw new Error("The original native Plan command no longer owns this input.");
                    const transition = await trackPlanMutation(async () => {
                      if (invocation.name === "plan-review") {
                        await nativePlan.openLatestReview(invocation); return undefined;
                      }
                      return nativePlan.toggle(invocation);
                    });
                    assertSessionActive(); invocation.assertCurrent();
                    if (controller.signal.aborted) throw new Error("The native Plan command was interrupted after its mode change.");
                    if (transition?.prompt) return { agentInvoked: await session.prompt(transition.prompt) };
                    return { agentInvoked: false, handledCommand: invocation.name };
                  },
                  todo: async raw => {
                    // Extension/custom precedence already resolved in the
                    // dispatcher; the owner still refuses a shadowed builtin and
                    // guards the live revision against concurrent panel edits.
                    todoDispatchDepth++;
                    try {
                      const current = nativeTodos.read();
                      return await nativeTodos.mutate(promptOptions.commandId ?? `prompt:${crypto.randomUUID()}`,
                        { sessionId: session.sessionId, ticket: current.ticket, mutation: { action: "command", text: raw } });
                    } finally { todoDispatchDepth--; }
                  },
                  forceTool: forceAdmission,
                  withNativeForceInvocation: operation => {
                    // Synchronous, exact-token-checked sections only. Never hold
                    // this exception across output/history awaits or recovery.
                    nativeForceDispatchDepth++;
                    try { return withinForceAdmission(operation); }
                    finally { nativeForceDispatchDepth--; }
                  },
                  inspectMcp: () => { assertSessionActive(); return mcp.read(); },
                  reloadMcp: async () => {
                    // This callback runs inside the existing native-command admission.
                    // Also fence side chats, whose lifecycle may otherwise overlap a prompt.
                    assertSessionActive();
                    if (interruptsInFlight || controller.signal.aborted || session.queuedMessageCount > 0
                      || ui?.list().length || btw.get()?.status === "running")
                      throw new Error("Resolve pending native work before reloading MCP servers.");
                    const ticket = mcp.read();
                    await trackMcpMutation(mcp.reload({ epoch: ticket.epoch, expectedRevision: ticket.revision }));
                  },
                  authorizeMcp: async serverName => {
                    // The slash command already owns prompt admission. Reserve
                    // MCP work without trying to reacquire the idle prompt gate.
                    assertSessionActive();
                    if (interruptsInFlight || controller.signal.aborted || session.queuedMessageCount > 0
                      || ui?.list().length || btw.get()?.status === "running")
                      throw new Error("Resolve pending native work before authorizing an MCP server.");
                    const ticket = mcp.read();
                    const operation = mcp.startAuthorization({epoch:ticket.epoch,expectedRevision:ticket.revision,serverName}, {
                      cwd:manager.getCwd(),authStorage:auth,assertOwner:assertSessionActive,
                    });
                    const cancel = () => operation.cancel();
                    controller.signal.addEventListener("abort",cancel,{once:true});
                    try { return await trackMcpMutation(operation.completion); }
                    finally { controller.signal.removeEventListener("abort",cancel); }
                  },
                  reconnectMcp: async serverName => {
                    assertSessionActive();
                    if (interruptsInFlight || controller.signal.aborted || session.queuedMessageCount > 0
                      || ui?.list().length || btw.get()?.status === "running")
                      throw new Error("Resolve pending native work before reconnecting an MCP server.");
                    const ticket = mcp.read();
                    return trackMcpMutation(mcp.reconnect({ epoch: ticket.epoch, expectedRevision: ticket.revision, serverName }));
                  },
                });
              }, () => session.settleInFlightMessagePersistence(), imagePrompt, skillPrompt, selectedText, wholeFiles, forceAdmission));
              const nativeRun = promptOptions.forceRecovery
                ? wrapForceToolRecoveryOutcome(dispatchedRun, () => recoveryPromptEntered) : dispatchedRun;
              void nativeRun.accepted.then(value => { if (value) nativeGoalController.resetSuppression(); receipt.resolve(value); }, receipt.reject);
              const completed = await nativeRun.completion;
              await nativeGoalController.settleFinalization();
              await planMutation;
              await nativePlan.settleAfterTurn();
              await nativeTodos.settle();
              return completed;
          })().catch(error => { receipt.reject(error); throw error; }).finally(() => { wholeFiles?.close(); selectedText?.close(); imagePrompt?.close(); skillPrompt?.close(); });
          void receipt.promise.catch(() => {});
          void completion.catch(() => {});
          const run = { accepted: receipt.promise, completion, get forceToolReceipt() { return forceAdmission.forceToolReceipt; } };
          const clearAdmission = () => { admissionPending = false; };
          void run.accepted.then(clearAdmission, clearAdmission);
          const clearTurn = () => { promptInFlight = false; admissionPending = false; admissionAbort = undefined; };
          void run.completion.then(clearTurn, clearTurn);
          return run;
        },
        prompt: (text, promptOptions) => handle.startPrompt(text, promptOptions).completion,
        steer: async (text, expectedApprovalMode, options) => {
          assertSessionActive();
          if (options?.images?.length) throw new Error("Image attachments are not supported on steering input yet; no input was queued");
          if (admissionPending || planMutation || nativePlan.busy || nativeTodos.busy || mcpMutation) throw new Error("OMP is still accepting a prompt or settling native maintenance.");
          // The host snapshot can precede a concurrently admitted Interrupt.
          // Recheck in the owning worker before native steer can queue an idle
          // auto-continuation or land after abort's initial queue cancellation.
          if (interruptsInFlight || !session.isStreaming) return { kind: "not-recorded", reason: "There is no running native turn accepting steering input" };
          if (expectedApprovalMode !== undefined && approvalMode(expectedApprovalMode) !== session.settings.get("tools.approvalMode")) return { kind: "not-recorded", reason: "The running turn uses a different native permission mode. Stop it before changing permissions." };
          return steering.submit(text);
        },
        startFollowUp: (text, delivery, expectedApprovalMode, images) => {
          const assertCurrent = () => {
            assertSessionActive();
            if (admissionPending || planMutation || nativePlan.busy || nativeTodos.busy || mcpMutation) throw new Error("OMP is still accepting a prompt or settling native maintenance.");
            if (interruptsInFlight || !session.isStreaming) throw new Error("There is no running native turn accepting a follow-up");
            if (expectedApprovalMode !== undefined && approvalMode(expectedApprovalMode) !== session.settings.get("tools.approvalMode"))
              throw new Error("The running turn uses a different native permission mode. Stop it before changing permissions.");
          };
          assertCurrent();
          return steering.start(text, delivery, images, images?.length ? assertCurrent : undefined);
        },
        getQueuedMessages: () => { assertSessionActive(); return queuedMessages.snapshot(); },
        mutateQueuedMessages: mutation => { assertSessionActive(); return queuedMessages.mutate(mutation); },
        assertTaskLocationReady: assertSnapshotReady,
        moveSession: async cwd => {
          assertSnapshotReady();
          const destination = await requireDirectory(cwd), source = manager.getCwd();
          if (destination === source) return { id: session.sessionId, cwd: source, sessionFile: session.sessionFile! };
          await session.settings.flush(); await manager.flush();
          const saved = manager.captureState();
          const rescope = async (next: string) => {
            setProjectDir(next); await session.settings.reloadForCwd(next);
            applyProviderGlobalsFromSettings(session.settings); clearClaudePluginRootsCache();
            session.setTitleSystemPrompt(await resolvePromptInput(discoverTitleSystemPromptFile(next), "title system prompt"));
            resetCapabilities(); await session.refreshSkills();
            session.setSlashCommands(await discoverSlashCommands({ cwd: next, extensionRoots: session.effectiveExtensionRoots }));
          };
          try { await session.moveSession(destination, path.dirname(session.sessionFile!)); await rescope(destination); }
          catch (error) {
            try { await manager.rollbackMove(saved); await rescope(source); }
            catch (restoreError) { throw taskLocationOutcomeUnknown(`Native task location changed but rollback could not be verified: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`); }
            throw error;
          }
          if (session.sessionId !== handle.id || manager.getCwd() !== destination) throw taskLocationOutcomeUnknown("Native task identity or working directory changed unexpectedly.");
          return { id: session.sessionId, cwd: destination, sessionFile: session.sessionFile! };
        },
        abort: async () => {
          assertSessionActive(); admissionAbort?.abort(); ui?.cancelAll("aborted"); mcp.cancelAuthorization();
          interruptEpoch++;
          interruptsInFlight++;
          steering.cancelQueued("Interrupted before this steer left the native queue");
          try { await Promise.all([session.abort(), mcp.getAuthorization()?.completion]); }
          finally {
            try { await steering.settleCancelled("Interrupted after native delivery; durable steer admission could not be verified"); }
            finally { interruptsInFlight--; }
          }
        },
        setModel: async choice => {
          assertIdle(); accountMutation = true;
          try {
            await auth.revalidateCredentials();
            await session.setModel(this.#findModel(registry, choice, session.settings));
          } finally { accountMutation = false; }
        },
        listAccountChoices: listAccounts,
        pinAccount: async (credentialId, expectedSelection) => {
          assertIdle(); accountMutation = true;
          try { return await accountBridge.pin(session.sessionId, credentialId, expectedSelection); }
          finally { accountMutation = false; }
        },
        releaseAccountForReselection: async expectedSelection => {
          assertIdle(); accountMutation = true;
          try {
            return await accountBridge.release(session.sessionId, expectedSelection);
          } finally { accountMutation = false; }
        },
        listInteractions: async () => { assertInteractionActive(); return ui?.list() ?? []; },
        respondInteraction: async (id, response) => {
          assertInteractionActive();
          if (!ui) throw new Error("OMP interaction bridge is not installed");
          ui.respond(id, response);
        },
        cancelInteractions: async (reason = "cancelled") => { assertInteractionActive(); ui?.cancelAll(reason); },
        getControls: async () => { assertSessionActive(); return controls.read(); },
        setApprovalOverride: async (mode, expectedRevision) => {
          assertIdle();
          return controls.setApprovalOverride(mode, expectedRevision);
        },
        mutateControls: async request => {
          assertIdle(); accountMutation = true;
          try {
            return await controls.mutate(request, async choice => {
              await auth.revalidateCredentials();
              await session.setModel(this.#findModel(registry, choice, session.settings));
            });
          } finally { accountMutation = false; }
        },
        dispose: () => {
          if (disposeCall) return disposeCall;
          disposed = true;
          usage.dispose();
          const mcpDisposal = Promise.allSettled([mcpApps.dispose(), mcp.dispose(), htmlPreviews.dispose(), planExecution.dispose()]);
          btw.dispose();
          detachedQuestions.dispose();
          admissionAbort?.abort();
          ui?.dispose();
          steering.cancelQueued("Session stopped before this steer left the native queue");
          disposeCall = (async () => {
            // Resolving/cancelling UI above releases native branch hooks. A branch
            // already in flight still owns both files until it settles.
            await promotionCall?.catch(() => {});
            const mcpDrains = await mcpDisposal;
            await extensionStartup?.catch(() => {});
            await mcpMutation?.catch(() => {});
            await planMutation?.catch(() => {});
            await Promise.allSettled([...mcpReads, ...(outputRead ? [outputRead] : [])]);
            const cleanupErrors = mcpDrains.flatMap(result => result.status === "rejected" ? [result.reason] : []);
            const clean = async (work: () => unknown) => { try { await work(); } catch (error) { cleanupErrors.push(error); } };
            await clean(() => nativePlan.dispose());
            await clean(() => nativeTodos.settle());
            await clean(() => forceTool.dispose());
            await clean(() => session.beginDispose());
            await clean(() => session.dispose());
            await clean(() => steering.settleCancelled("Session stopped after native delivery; durable steer admission could not be verified"));
            await clean(() => detachedQuestions.settle());
            await clean(unsubscribeQueuedMessages); await clean(() => queuedMessages.close());
            await clean(() => steering.close()); await clean(unsubscribe); await clean(() => accountBridge.dispose());
            listeners.clear(); await clean(() => auth.close());
            this.#sessions.delete(handle); for (const file of reservedPaths) this.#reservedFiles.delete(file);
            if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Native session cleanup failed.");
          })();
          return disposeCall;
        },
      };
      this.#sessions.add(handle);
      return handle;
    } catch (error) {
      bridge?.dispose();
      try { if (native) await native.dispose(); else await manager.close(); }
      finally { context?.auth.close(); this.#reservedFiles.delete(reservedFile); }
      throw error;
    }
  }

  #findModel(registry: ModelRegistry, choice: ModelChoice, settings: Settings): NativeModel {
    if (settings.get("disabledProviders").includes(choice.provider)) throw new Error("OMP provider is disabled in this session's native settings");
    const model = registry.find(choice.provider, choice.id);
    if (!model) throw new Error(`OMP model is not available: ${choice.provider}/${choice.id}`);
    if (!registry.hasConfiguredAuth(model)) throw new Error(`OMP has no configured authentication for ${choice.provider}`);
    return model;
  }

  dispose(): Promise<void> {
    if (this.#disposeCall) return this.#disposeCall;
    this.#disposed = true;
    this.#disposeCall = (async () => {
      // A session under construction owns native resources before it reaches
      // #sessions. Wait for its active-state check and cleanup before exit.
      await Promise.allSettled([...this.#setups]);
      await Promise.allSettled([...this.#discoveryTails.values()]);
      const results = await Promise.allSettled([...this.#sessions].map(session => session.dispose()));
      for (const context of this.#discovery.values()) context.auth.close();
      this.#discovery.clear();
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "OMP session disposal failed");
    })();
    return this.#disposeCall;
  }
}
