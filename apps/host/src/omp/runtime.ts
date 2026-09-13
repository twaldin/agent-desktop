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
import { realpath } from "node:fs/promises";
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
export type OmpRuntimeEvent = AgentSessionEvent | OmpBridgeEvent | { type: "queued_messages_changed"; snapshot: NativeQueuedMessagesSnapshot };
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
export interface OmpPromptOptions { model?: ModelChoice; thinkingLevel?: string; images?: PreparedPromptImage[]; selectedText?: NativeSelectedTextInput; wholeFiles?: NativeWholeFileInput }
export interface OmpBrowserTabCreateResult {
  tab: NativeBrowserTabMetadata;
  targetDisposition: "created-page" | "created-surface" | "adopted-existing-target";
}
export interface OmpSession {
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
      this.#assertActive();
      const manager = SessionManager.create(cwd, options.sessionDirectory);
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
        disposed, admissionPending, promptInFlight, mutationPending: goalMutation || accountMutation || Boolean(mcpMutation),
        interruptsInFlight, interactionsPending: (ui?.list().length ?? 0) > 0,
      }), async () => { await session.setActiveToolsByName(goalPreviousTools); });
      const assertIdle = () => {
        assertSessionActive();
        if (promptInFlight || accountMutation || goalMutation || mcpMutation || session.isStreaming || session.hasPostPromptWork) throw new Error("OMP session is busy");
      };
      const assertSnapshotReady = (operation = "moving this task") => {
        assertIdle();
        if (session.queuedMessageCount || ui?.list().length || btw.get()?.status === "running" || interruptsInFlight || mcpReads.size || outputRead || htmlPreviews.active || mcpApps.pending) throw new Error(`Resolve queued messages, questions, side answers, MCP reads, HTML previews, and interrupts before ${operation}.`);
      };
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
      const handle: OmpSession = {
        get id() { return session.sessionId; },
        get sessionFile() { return session.sessionFile ?? sessionFile; },
        get cwd() { return manager.getCwd(); },
        get model() { return session.model ? { provider: session.model.provider, id: session.model.id } : null; },
        get thinkingLevel() { return session.configuredThinkingLevel(); },
        get isStreaming() { return session.isStreaming; },
        get hasPostPromptWork() { return session.hasPostPromptWork || Boolean(mcp.getAuthorization()?.pending); },
        get title() { return session.sessionName ?? manager.getHeader()?.title; },
        get createdAt() { return Date.parse(manager.getHeader()!.timestamp); },
        modelFallbackMessage: result.modelFallbackMessage,
        getMessages: () => {
          assertSessionActive();
          return transcript();
        },
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
            if (admissionPending || accountMutation || goalMutation || mcpMutation || interruptsInFlight || session.hasPostPromptWork
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
            if (admissionPending || accountMutation || goalMutation || mcpMutation || interruptsInFlight || session.hasPostPromptWork
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
        startPrompt: (text, promptOptions = {}) => {
          assertSessionActive();
          if (promptInFlight || accountMutation || goalMutation || mcpMutation || session.isStreaming || session.hasPostPromptWork) throw new Error("OMP session is busy; steer the running session instead");
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
          promptInFlight = true;
          admissionPending = true;
          const controller = new AbortController();
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
              skillPrompt = NativeSkillPrompt.fromText(session, text);
              if ((selectedText || wholeFiles) && skillPrompt) throw new Error("Selected text and whole-file attachments are not supported on native skill prompts; no input was executed.");
              if (skillPrompt && imagePrompt) throw new Error("Images on native skill invocations are not connected yet; the draft was retained.");
              // Startup extension messages are not receipts for the submitted draft.
              const nativeRun = beginNativePrompt(manager, async () => {
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
                return dispatchNativePrompt(session, nativeText, imagePrompt?.images, skillPrompt, {
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
              }, () => session.settleInFlightMessagePersistence(), imagePrompt, skillPrompt, selectedText, wholeFiles);
              void nativeRun.accepted.then(value => { if (value) nativeGoalController.resetSuppression(); receipt.resolve(value); }, receipt.reject);
              const completed = await nativeRun.completion;
              await nativeGoalController.settleFinalization();
              return completed;
          })().catch(error => { receipt.reject(error); throw error; }).finally(() => { wholeFiles?.close(); selectedText?.close(); imagePrompt?.close(); skillPrompt?.close(); });
          void receipt.promise.catch(() => {});
          void completion.catch(() => {});
          const run = { accepted: receipt.promise, completion };
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
          if (admissionPending || mcpMutation) throw new Error("OMP is still accepting a prompt or reloading MCP servers");
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
            if (admissionPending || mcpMutation) throw new Error("OMP is still accepting a prompt or reloading MCP servers");
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
          const mcpDisposal = Promise.allSettled([mcpApps.dispose(), mcp.dispose(), htmlPreviews.dispose()]);
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
            await Promise.allSettled([...mcpReads, ...(outputRead ? [outputRead] : [])]);
            const cleanupErrors = mcpDrains.flatMap(result => result.status === "rejected" ? [result.reason] : []);
            const clean = async (work: () => unknown) => { try { await work(); } catch (error) { cleanupErrors.push(error); } };
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
