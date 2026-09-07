import type { NativeMcpAuthorizationSnapshot, NativeMcpAuthorizationReply } from "@agent-desktop/shared";
import type { NativeSessionMcpResourceRequest, NativeSessionMcpResourceResult } from "@agent-desktop/shared";
import { NativeSessionMcp } from "./mcp-session";
import type { NativeSessionMcpSnapshot, NativeSessionMcpReload, NativeSessionMcpReconnect } from "@agent-desktop/shared";
import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { goalControlState, parseNativeBrowserTabMetadata, type DetachedQuestionSnapshot, type GoalMutationRequest, type ModelChoice, type ModelInfo, type NativeBrowserTabMetadata, type NativeGoalActivity, type NativeSessionActivity, type ResolveDetachedQuestionReceipt, type ResolveDetachedQuestionRequest, type TranscriptMessage } from "@agent-desktop/shared";
import { createHash } from "node:crypto";
import {
  AgentRegistry, createAgentSession, discoverAuthStorage, getAgentDir,
  ModelRegistry, SessionManager, Settings,
  loadSessionExtensions,
  type AgentSession, type AgentSessionEvent, type AuthStorage,
} from "@oh-my-pi/pi-coding-agent";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AUTO_THINKING, parseCliThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { initThemeSync } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import { parseTitleSlotLine } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { invalidate } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { TranscriptMirror, projectGoalCompletions } from "./transcript";
import { beginNativePrompt, type OmpPromptRun, type OmpPromptReceipt } from "./prompt";
import { dispatchNativePrompt } from "./commands";
import { NativeSkillPrompt } from "./skills";
import { discoverComposerActions, sessionComposerActions, composerCompletions, type NativeComposerCatalog, type NativeComposerCompletions } from "./composer-actions";
import type { ComposerCompletionQuery } from "@agent-desktop/shared";
import { NativeSteerAdmission, type OmpSteerReceipt } from "./steer";
import { createNativeAccountSelectionBridge } from "../omp-accounts/session-selection";
import type { SessionAccountList } from "../omp-accounts/types";
import { OmpInteractionBridge, type OmpBridgeEvent, type OmpInteraction, type OmpInteractionResponse } from "./interactions";
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
export type { PreparedPromptImage, OmpRecordedImage } from "./images";
export type { OmpPromptRun, OmpPromptReceipt } from "./prompt";
export type { OmpSteerReceipt } from "./steer";
export type { OmpDetachedQuestionDeliveryRun } from "./detached-questions";

function detachedQuestionRejected(message: string): Error {
  const error = new Error(message); error.name = "DetachedQuestionRejected"; return error;
}

type NativeModel = NonNullable<AgentSession["model"]>;
export type OmpRuntimeEvent = AgentSessionEvent | OmpBridgeEvent;
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
export interface OmpOpenOptions { sessionFile: string; onEvent?: OmpEventListener; interactions?: boolean; approvalOverride?: OmpApprovalMode }
export interface OmpPromptOptions { model?: ModelChoice; thinkingLevel?: string; images?: PreparedPromptImage[] }
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
  getSessionActivity(): NativeSessionActivity;
  refreshGoalUsage(): Promise<void>;
  mutateGoal(request: GoalMutationRequest): Promise<NativeGoalActivity | null>;
  getGoalContinuationEligibility(): GoalContinuationEligibility;
  startGoalContinuation(expectedGoalId: string): OmpGoalContinuationRun;
  listQuestions(): Promise<DetachedQuestionSnapshot[]>;
  resolveQuestion(request: ResolveDetachedQuestionRequest): Promise<ResolveDetachedQuestionReceipt>;
  startQuestionDelivery(questionId: string): OmpDetachedQuestionDeliveryRun;
  readSessionMcpResource(request: NativeSessionMcpResourceRequest): Promise<NativeSessionMcpResourceResult>;
  getSessionMcp(): NativeSessionMcpSnapshot;
  startSessionMcpAuthorization(request: NativeSessionMcpReconnect): NativeMcpAuthorizationSnapshot;
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
  getImage(nativeEntryId: string, blockIndex: number): Promise<OmpRecordedImage>;
  createBrowserTab(name: string): Promise<OmpBrowserTabCreateResult>;
  subscribe(listener: OmpEventListener): () => void;
  startPrompt(text: string, options?: OmpPromptOptions): OmpPromptRun;
  prompt(text: string, options?: OmpPromptOptions): Promise<boolean>;
  steer(text: string, expectedApprovalMode?: OmpApprovalMode, options?: { images?: PreparedPromptImage[] }): Promise<OmpSteerReceipt>;
  abort(): Promise<void>;
  setModel(model: ModelChoice): Promise<void>;
  listAccountChoices(): Promise<SessionAccountList>;
  pinAccount(credentialId: number): Promise<SessionAccountList>;
  releaseAccountForReselection(): Promise<SessionAccountList>;
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

async function requireDirectory(directory: string): Promise<string> {
  const resolved = await realpath(directory);
  if (!(await stat(resolved)).isDirectory()) throw new Error("OMP working directory must be a directory");
  await access(resolved, constants.R_OK | constants.X_OK);
  return resolved;
}

async function readSessionHeader(sessionFile: string): Promise<{ id: string; cwd: string }> {
  const file = await open(sessionFile, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // 18.1.10 may put its fixed-width physical title slot before the semantic
    // session header. Use native slot recognition and retain legacy support.
    const headerLine = parseTitleSlotLine(lines[0]) ? lines[1] : lines[0];
    const header: unknown = JSON.parse(headerLine);
    if (!header || typeof header !== "object" || !("type" in header) || header.type !== "session"
      || !("id" in header) || typeof header.id !== "string"
      || !("cwd" in header) || typeof header.cwd !== "string") {
      throw new Error("Cannot open an OMP session without a valid native identity and working directory");
    }
    return { id: header.id, cwd: header.cwd };
  } finally { await file.close(); }
}

/** Bun-only native runtime. The owning host, never a window, controls its lifetime. */
export class OmpRuntime {
  #agentDir: string;
  #discovery = new Map<string, NativeContext>();
  #discoveryTails = new Map<string, Promise<unknown>>();
  #sessions = new Set<OmpSession>();
  #setups = new Set<Promise<OmpSession>>();
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
  getComposerCompletions(cwd: string, query: ComposerCompletionQuery): Promise<NativeComposerCompletions> {
    return this.#withDiscovery(cwd, false, async context => composerCompletions(await discoverComposerActions(cwd, this.#agentDir, context.settings), query), false);
  }

  #setup(operation: () => Promise<OmpSession>): Promise<OmpSession> {
    this.#assertActive();
    const pending = operation();
    this.#setups.add(pending);
    const remove = () => { this.#setups.delete(pending); };
    void pending.then(remove, remove);
    return pending;
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
      await requireDirectory(header.cwd);
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
      if (reservation !== undefined) await detachedQuestions.repairOnReopen();
      const result = await createAgentSession({
        cwd: options.cwd, agentDir: this.#agentDir,
        settings: context.settings, modelRegistry: context.registry, authStorage: context.auth,
        agentRegistry, sessionManager: manager, model, thinkingLevel,
        preloadedExtensions,
        // Tools cannot run until create finishes and installs the bridge below.
        hasUI: false, interactivePrompts: options.interactions === true,
        deferUsageReserveConfirmation: true,
        extensions: [detachedQuestions.extension],
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
      const mcp = new NativeSessionMcp(session, result.mcpManager);
      const steering = new NativeSteerAdmission(session, manager);
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
        return messages.sort((left, right) => (left.nativeId ? order.get(left.nativeId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER)
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
        session.setUsageFallbackConfirmer((confirmation, signal) => ui.confirm(
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
      const mcpReads = new Set<Promise<NativeSessionMcpResourceResult>>();
      let mcpMutation: Promise<unknown> | undefined;
      let goalPreviousTools = session.getEnabledToolNames().filter(name => name !== "goal");
      const assertSessionActive = () => { if (disposed) throw new Error("OMP session is disposed"); if (promotionState !== "idle") throw new Error("The native session is transitioning after side-chat promotion. Reopen it after worker retirement."); };
      const assertInteractionActive = () => { if (disposed || promotionState === "retired") throw new Error("The native interaction owner has retired."); };
      const accountBridge = createNativeAccountSelectionBridge(async () => session);
      const controls = new NativeSessionControls(session, options.approvalOverride);
      const nativeGoalController = goalController = new NativeGoalController(session, manager, () => ({
        disposed, admissionPending, promptInFlight, mutationPending: goalMutation || accountMutation || Boolean(mcpMutation),
        interruptsInFlight, interactionsPending: (ui?.list().length ?? 0) > 0,
      }), async () => { await session.setActiveToolsByName(goalPreviousTools); });
      const assertIdle = () => {
        assertSessionActive();
        if (promptInFlight || accountMutation || goalMutation || mcpMutation || session.isStreaming || session.hasPostPromptWork) throw new Error("OMP session is busy");
      };
      const trackMcpMutation = <T>(run: Promise<T>) => {
        mcpMutation = run;
        const clear = () => { if (mcpMutation === run) mcpMutation = undefined; };
        void run.then(clear, clear);
        return run;
      };
      const listAccounts = async () => {
        assertSessionActive();
        await auth.revalidateCredentials();
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
          const operation = mcp.startAuthorization(request, { cwd: manager.getCwd(), authStorage: auth, assertOwner: assertSessionActive });
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
        getImage: async (nativeEntryId, blockIndex) => {
          assertSessionActive();
          if (typeof nativeEntryId !== "string" || nativeEntryId.length > 200 || !Number.isSafeInteger(blockIndex) || blockIndex < 0) throw new Error("Invalid native image identity");
          const entry = manager.getEntry(nativeEntryId);
          if (entry?.type !== "message" || !("content" in entry.message) || !Array.isArray(entry.message.content)) throw new Error("Native image entry is unavailable");
          return readNativeImage(entry.message.content[blockIndex]);
        },
        createBrowserTab: async name => {
          assertSessionActive();
          const module = await import("@oh-my-pi/pi-coding-agent/tools/browser") as unknown as {
            createBrowserTabForSession?: (session: AgentSession, request: { name: string }) => Promise<{
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
          const value = await module.createBrowserTabForSession(session, { name });
          if (value.ownerSessionId !== session.sessionId || value.created !== true) throw new Error("Native browser creation changed session ownership.");
          return {
            tab: parseNativeBrowserTabMetadata({ ...value, state: "alive" }),
            targetDisposition: value.targetDisposition,
          };
        },
        subscribe: listener => {
          assertSessionActive(); listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        startPrompt: (text, promptOptions = {}) => {
          assertSessionActive();
          if (promptInFlight || accountMutation || goalMutation || mcpMutation || session.isStreaming || session.hasPostPromptWork) throw new Error("OMP session is busy; steer the running session instead");
          const images = copyPreparedImages(promptOptions.images);
          const imagePrompt = images?.length ? new NativeImagePrompt(images, text) : undefined;
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
              skillPrompt = NativeSkillPrompt.fromText(session, text);
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
                return dispatchNativePrompt(session, text, imagePrompt?.images, skillPrompt, {
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
                  reconnectMcp: async serverName => {
                    assertSessionActive();
                    if (interruptsInFlight || controller.signal.aborted || session.queuedMessageCount > 0
                      || ui?.list().length || btw.get()?.status === "running")
                      throw new Error("Resolve pending native work before reconnecting an MCP server.");
                    const ticket = mcp.read();
                    return trackMcpMutation(mcp.reconnect({ epoch: ticket.epoch, expectedRevision: ticket.revision, serverName }));
                  },
                });
              }, () => session.settleInFlightMessagePersistence(), imagePrompt, skillPrompt);
              void nativeRun.accepted.then(value => { if (value) nativeGoalController.resetSuppression(); receipt.resolve(value); }, receipt.reject);
              const completed = await nativeRun.completion;
              await nativeGoalController.settleFinalization();
              return completed;
          })().catch(error => { receipt.reject(error); throw error; }).finally(() => { imagePrompt?.close(); skillPrompt?.close(); });
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
        pinAccount: async credentialId => {
          assertIdle(); accountMutation = true;
          try { await auth.revalidateCredentials(); return await accountBridge.pin(session.sessionId, credentialId); }
          finally { accountMutation = false; }
        },
        releaseAccountForReselection: async () => {
          assertIdle(); accountMutation = true;
          try {
            await auth.revalidateCredentials();
            if (session.model) auth.releaseSessionCredentialForReselection(session.model.provider, session.sessionId);
            return await accountBridge.list(session.sessionId);
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
          const mcpDisposal = mcp.dispose();
          btw.dispose();
          detachedQuestions.dispose();
          admissionAbort?.abort();
          ui?.dispose();
          steering.cancelQueued("Session stopped before this steer left the native queue");
          disposeCall = (async () => {
            // Resolving/cancelling UI above releases native branch hooks. A branch
            // already in flight still owns both files until it settles.
            await promotionCall?.catch(() => {});
            await mcpDisposal;
            await mcpMutation?.catch(() => {});
            await Promise.allSettled([...mcpReads]);
            session.beginDispose();
            try { await session.dispose(); }
            finally {
              await steering.settleCancelled("Session stopped after native delivery; durable steer admission could not be verified");
              await detachedQuestions.settle();
              steering.close();
              unsubscribe(); listeners.clear(); auth.close();
              this.#sessions.delete(handle); for (const file of reservedPaths) this.#reservedFiles.delete(file);
            }
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
