import { GOAL_COMPOSER_CAPABILITY, goalPromptFromDraft } from "../../../packages/shared/src/goal-composer";
import { SESSION_TREE_CAPABILITY } from "../../../packages/shared/src/session-tree";
import { SessionTreeHttp, mutateSessionTree, projectTreeJournalReceipt } from "./session-tree-http";
import { TodoExternalEditorHttp, type TodoExternalEditorHttpAction } from "./todo-external-editor-http";
import { TodoExternalEditors } from "./todo-external-editors";
import { SessionExportService } from "./session-export";
import { SessionExportHttp } from "./session-export-http";
import { SESSION_EXPORT_CAPABILITY } from "@agent-desktop/shared";
import { SessionUsageService } from "./session-usage";
import { ResetAccountAdmissions } from "./session-reset-admission";
import { NativeResetPolicy } from "./native-reset-policy";
import { NativeResetPolicyWorkerOwner } from "./omp-workers/reset-policy-owner";
import { SessionUsageHttp, usageCommandHeaders } from "./session-usage-http";
import { PlanExternalEditorHttp, type PlanExternalEditorHttpAction } from "./plan-external-editor-http";
import { PlanExternalEditors } from "./plan-external-editors";
import { PlanEditorTerminals } from "./plan-editor-terminal";
import { SESSION_PLAN_OWNER_HEADER } from "../../../packages/shared/src/session-plan";
import { SESSION_TODOS_CAPABILITY, SESSION_TODOS_OWNER_HEADER } from "../../../packages/shared/src/session-todos";
import { SessionTodosHttp, projectTodoJournalReceipt, mutateSessionTodos } from "./session-todos-http";
import { PlanDecisionService } from "./plan-decisions";
import { projectPlanDecisionJournalReceipt, SessionPlanHttp } from "./session-plan-http";
import { SessionForceToolHttp, projectForceToolJournalReceipt } from "./session-force-tool-http";
import { forceToolReceiptFromError } from "./omp/force-tool-admission";
import { assertForceToolRecoveryCommand } from "./force-tool-recovery";
import { parseForceToolReceipt } from "../../../packages/shared/src/force-tool";
import { PULL_REQUEST_WRITES_CAPABILITY } from "../../../packages/shared/src/pull-request-write";
import { PullRequests } from "./pull-requests";
import { PullRequestsHttp } from "./pull-requests-http";
import { PULL_REQUESTS_CAPABILITY } from "../../../packages/shared/src/pull-requests";
import { HtmlPreviewHttp } from './html-preview-http';
import { McpOwnerHttp } from "./mcp-owner-http";
import { SIDEBAR_NAVIGATION_CAPABILITY } from "../../../packages/shared/src/sidebar-navigation";
import { isUnreadSessionEvent } from "../../../packages/shared/src/session-read";
import { BranchQueryPeer } from "./branch-query-peer";
import { BRANCH_QUERY_CAPABILITY } from "@agent-desktop/shared";
import { RepositoryWatchPeer } from "./repository-watch-peer";
import { REPOSITORY_WATCH_CAPABILITY } from "@agent-desktop/shared";
import { SessionSearch, SessionSearchError } from "./session-search";
import { readStoredSessionText } from "./session-search-reader";
import { SESSION_SEARCH_OWNER_HEADER } from "@agent-desktop/shared";
import { DeviceAccessHttp } from "./device-access-http";
import { hasInlineFileIntent, hasRepeatedWholeFileIntent, requiresInlineFileProtocol, requiresRepeatedWholeFileProtocol, hasWholeFileIntent, requiresWholeFileProtocol } from "./whole-file-protocol";
import { sameWholeFileAttachments, MAX_WHOLE_FILE_ATTACHMENTS } from "@agent-desktop/shared";
import { hasSelectedTextIntent, requiresSelectedTextProtocol } from "./selected-text-protocol";
import { PluginAcquisitionOperations } from "./integrations/acquisition-operations";
import { PluginAcquisitionHttp } from "./integrations/acquisition-http";
import { SessionMcpAuthorizationHttp } from "./session-mcp-authorization-http";
import { SessionMcpAppHttp } from "./session-mcp-app-http";
import { SessionMcpResourceHttp } from "./session-mcp-resource-http";
import { SessionOutputsHttp } from "./session-outputs-http";
import { SessionTurnReviewHttp } from "./session-turn-review-http";
import { SessionMcpHttp } from "./session-mcp-http";
import { BtwPromotionService } from "./btw-promotion";
import { SessionForkError, SessionForkService } from "./session-fork";
import { hasSessionForkIntent, SESSION_FORK_CAPABILITY } from "@agent-desktop/shared";
import { LocalEnvironmentActions } from "./local-environments/actions";
import { hasNewChatIntent, requiresNewChatProtocol, hasRemoteWorktreeIntent, remoteWorktreeProtocolError } from './new-chat-protocol';
import { hasEnvironmentIntent, requiresEnvironmentProtocol } from './environment-protocol';
import { LocalEnvironmentRuns } from './local-environments/runs';
import { WorktreeEnvironmentLifecycle } from './local-environments/lifecycle';
import { EnvironmentSessions } from './environment-sessions';
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { register as registerExitCleanup } from "@oh-my-pi/pi-utils/postmortem";
import type { CommandEnvelope, CommandResult, HostCommand, HostEvent, HostState, ModelInfo, OmpApprovalMode, OmpSessionControls, SessionSummary } from "@agent-desktop/shared";
import { acquireHostLease } from "./lease";
import { WorkerRuntime, type WorkerSession } from "./omp-workers";
import { getDataDirectory, type LocalConnection } from "./paths";
import { HostStore, type EventInput } from "./store";
import { parseCommandEnvelope } from "./validation";
import { TailnetNetwork, TAILNET_PORT } from "./network";
import { hasAttachmentIntent, requiresAttachmentProtocol } from "./attachment-protocol";
import { ImageAttachmentsHttp, AttachmentRequestError } from "./attachment-http";
import { AttachmentImageError } from "./attachments";
import { sameSelectedTextAttachments, MAX_SELECTED_TEXT_SERIALIZED_CHARS, sameImageAttachments, detachedAnswerDraft, SESSION_ACTIVITY_OWNER_HEADER, WORKSPACE_OWNER_HEADER } from "@agent-desktop/shared";
import type { PreparedPromptImage } from "./omp/images";
import { AccountsHttp } from "./accounts-http";
import { parseInteractionAnswer } from "./interaction-http";
import { HostWorkspaces, parseWorkspaceQuery, parseWorkspaceTarget } from "./workspace-http";
import { checkoutRefusalResult } from "./checkout-refusal";
import { applicationKeybindingAdmissionDefinitions } from "../../../packages/shared/src/application-commands";
import { PreferenceError } from "../../../packages/shared/src/preferences";
import { KeybindingError } from "../../../packages/shared/src/command-keybindings";
import { PreferencesSync } from "./preferences-sync";
import { ComposerActionsHttp } from "./composer-actions-http";
import { SkillFiles, type SkillFileAuthorization } from "./skill-files";
import { hasNativeBtwComposerWinner } from "./omp/composer-actions";
import { nativeBtwQuestion } from "@agent-desktop/shared";
import { ExtensionUiHttp } from "./extension-ui-http";
import { SessionActivityHttp } from "./session-activity-http";
import { SessionProcessesHttp } from "./session-processes-http";
import { SessionProcessRequests, type SessionProcessesHandle } from "./session-process-requests";
import { SessionJobsHttp } from "./session-jobs-http";
import { SessionSubagentsHttp } from "./session-subagents-http";
import { BtwService } from "./btw";
import { BtwHttp } from "./btw-http";
import { GoalControlHttp } from "./goal-control-http";
import { GoalContinuationController } from "./goal-continuation";
import { QuestionDeliveryController } from "./question-delivery";
import { BrowserMetadataHttp } from "./browser-metadata-http";
import { BrowserObservationHttp } from "./browser-observation-http";
import { BrowserCloseHttp } from "./browser-close-http";
import { BrowserCloseRequests } from "./browser-close-requests";
import { BrowserControlHttp } from "./browser-control-http";
import { BrowserHistoryHttp } from "./browser-history-http";
import { BrowserAutocompleteHttp } from "./browser-autocomplete-http";
import { BrowserAutocompleteService, type BrowserAutocompleteHandle } from "./browser-autocomplete-service";
import { BrowserFrameHttp } from "./browser-frame-http";
import { BrowserCreateHttp } from "./browser-create-http";
import { DraftBrowserHttp } from "./draft-browser-http";
import { DraftBrowserWorkers } from "./browser-draft-workers";
import { BrowserFirstSend, isBrowserContinuationOutcomeUnknown } from "./browser-first-send";
import type { BrowserRecoveryRecord } from "./browser-recovery-record";
import { IntegrationsHttp } from "./integrations-http";
import { SettingsHttp } from "./settings-http";
import { ThemeFile, ThemeConflictError } from "./theme-file";
import { TerminalManager, TmuxTerminalManager, TmuxTerminalsHttp } from "./terminals";
import { TerminalsHttp } from "./terminals-http";
import { TerminalCreationHttp } from "./terminals/creation-http";
import { TaskLocationError, TaskLocations } from "./task-location";
import { ThemeAssets } from "./theme-assets";
import { approvalMode, hasApprovalIntent } from "./approval";
import { OmpSettingsError } from "./omp-settings";
import { ApprovalRecovery } from "./approval-recovery";
import { NotificationEvents } from "./notification-events";
import { WorkspaceFileOpen, type WorkspaceFileOpenRuntime } from "./workspace-open";
import { QueuedMessagesHttp } from "./queued-messages-http";
import { AutomationService } from "./automations";
import { AutomationsHttp } from "./automations-http";
import { AUTOMATIONS_CAPABILITY } from "../../../packages/shared/src/automations";

type SocketData = { after: number; remoteAddress?: string; nodeId?: string; repositoryWatches?: RepositoryWatchPeer; branchQueries?: BranchQueryPeer };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function startHost(options: { dataDirectory?: string; port?: number; agentDirectory?: string; discoveryDirectory?: string; tailscale?: boolean; workerPath?: string; nativeTerminalBundle?: string; skillFileReveal?: (canonicalPath: string) => Promise<void>; workspaceFileOpen?: WorkspaceFileOpenRuntime; automationTickMs?: number } = {}) {
  const dataDirectory = options.dataDirectory ?? getDataDirectory();
  const lease = acquireHostLease(dataDirectory);
  const environmentAbort = new AbortController();
  let store!: HostStore;
  let runtime!: WorkerRuntime;
  let nativeResetPolicy: NativeResetPolicy | undefined;
  let draftBrowsers: DraftBrowserHttp | undefined;
  let sessionProcesses: SessionProcessesHttp | undefined;
  let browserObservations: BrowserObservationHttp | undefined;
  let browserHistory: BrowserHistoryHttp | undefined;
  let browserAutocomplete: BrowserAutocompleteHttp | undefined;
  let browserCloseRequests: BrowserCloseRequests | undefined;
  let workspaces!: HostWorkspaces;
  let browserFirstSend!: BrowserFirstSend;
  const repositoryWatchPeers = new Set<RepositoryWatchPeer | BranchQueryPeer>();
  function retireRepositoryWatchPeer(peer: ServerWebSocket<SocketData>): void {
    const owners = [peer.data.repositoryWatches, peer.data.branchQueries];
    peer.data.repositoryWatches = undefined; peer.data.branchQueries = undefined;
    for (const owner of owners) if (owner) {
      void owner.dispose().catch(error => console.error("Repository query/watch connection cleanup failed:", error))
        .finally(() => repositoryWatchPeers.delete(owner));
    }
  }

  async function drainRepositoryWatchPeers(): Promise<void> {
    const results = await Promise.allSettled([...repositoryWatchPeers].map(watches => watches.dispose()));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Repository watch connections did not finish cleanup.");
  }
  let accounts: AccountsHttp | undefined;
  let preferences: PreferencesSync | undefined;
  let settings: SettingsHttp | undefined;
  let integrations: IntegrationsHttp | undefined;
  let acquisitions: PluginAcquisitionHttp | undefined;
  let theme: ThemeFile | undefined;
  let terminals: TerminalManager | undefined;
  let terminalsHttp: TerminalsHttp | undefined;
  let nativeTerminals: TmuxTerminalManager | undefined;
  let nativeTerminalsHttp: TmuxTerminalsHttp | undefined;
  let terminalCreationHttp: TerminalCreationHttp | undefined;
  let planExternalEditors: PlanExternalEditors | undefined;
  let todoExternalEditors: TodoExternalEditors | undefined;
  let themeAssets: ThemeAssets | undefined;
  let goalContinuations: GoalContinuationController | undefined;
  let questionDeliveries: QuestionDeliveryController | undefined;
  let automations: AutomationService | undefined;
  let pullRequests: PullRequests | undefined;
  let mcpOwners: McpOwnerHttp | undefined;
  let server: ReturnType<typeof Bun.serve<SocketData>> | undefined;
  let publishedConnection = false;
  let tailServer: ReturnType<typeof Bun.serve<SocketData>> | undefined;
  let networkTimer: ReturnType<typeof setInterval> | undefined;
  let networkCall: Promise<void> | undefined;
  const network = options.tailscale ? new TailnetNetwork(() => store.getDeviceAccessPolicy()) : undefined;
  const temporary = join(dataDirectory, `connection.${process.pid}.tmp`);
  try {
  store = new HostStore(dataDirectory);
  const resetAdmissions = new ResetAccountAdmissions(store);
  nativeResetPolicy = new NativeResetPolicy({ store, admissions: resetAdmissions });
  const mutatingWorkspaces = new Set<string>();
  const within = (parent: string, path: string) => path === parent || path.startsWith(parent + sep);
  const reserveWorkspaceMutation = (path: string) => {
    if ([...mutatingWorkspaces].some(current => within(current, path) || within(path, current))) {
      throw new Error("This workspace is already being changed. Wait for it to finish before trying again.");
    }
    if (store.listSessions().some(session => within(path, session.cwd) && (session.status === "running" || executions.has(session.id)))) {
      throw new Error("A session is still working in this workspace. Stop it and wait for its work to finish before changing the workspace.");
    }
    if ([...(terminals?.list() ?? []), ...(nativeTerminals?.list() ?? [])].some(terminal => within(path, terminal.cwd) && terminal.exitedAt === undefined)) {
      throw new Error("A terminal is still open in this workspace. Close it before changing the workspace.");
    }
    mutatingWorkspaces.add(path);
    return () => { mutatingWorkspaces.delete(path); };
  };
  const environmentActions = new LocalEnvironmentActions(store, () => nativeTerminals, cwd => {
    assertWorkspaceAvailable(cwd);
    mutatingWorkspaces.add(cwd);
    return () => { mutatingWorkspaces.delete(cwd); };
  });
  workspaces = new HostWorkspaces(store, dataDirectory, reserveWorkspaceMutation, {
    before: async path => {
      const record = store.environmentPreparations.list().find(item => item.worktreePath === path && item.phase !== 'removed');
      if (!record) return;
      const result = await environmentLifecycle.cleanup(record.id, record.revision);
      if (result.phase !== 'cleanup-succeeded') throw new Error('Environment cleanup failed. The worktree was preserved; inspect cleanup before explicitly retrying removal.');
    },
    committed: sessions => {
      for (const session of sessions) {
        goalContinuations?.cancel(session.id);
        questionDeliveries?.cancel(session.id);
      }
      publishState();
    },
  }, environmentActions, new WorkspaceFileOpen(options.workspaceFileOpen), {
    generate: (input, generationOptions) => runtime.generateCommit(input, generationOptions),
    changed: (target, repositoryChange) => publish({ type: "workspace", target, ...(repositoryChange === undefined ? {} : { repositoryChange }) }),
  });
  const environmentRuns = new LocalEnvironmentRuns(store.environmentPreparations);
  const environmentLifecycle = new WorktreeEnvironmentLifecycle(store, workspaces, { signal: environmentAbort.signal }, environmentRuns);
  function assertWorkspaceAvailable(cwd: string): void {
    if ([...mutatingWorkspaces].some(path => within(path, cwd))) throw new Error("This workspace is being changed. Wait for it to finish before starting work.");
  }
  // Native postmortem allows 10s for this process's cleanup. Leave time to
  // settle command receipts and remove our locator after a stuck child exits.
  runtime = new WorkerRuntime({ agentDir: options.agentDirectory, workerPath: options.workerPath, shutdownTimeoutMs: 5000,
    createResetPolicyOwner: context => new NativeResetPolicyWorkerOwner({ store, policy: nativeResetPolicy!, context }), onWorkerFailure(failure) {
    if (stopping || failure.browserOwnerId) return; // The draft registry owns these failures; they are not model discovery.
    if (failure.sessionId && store.getSession(failure.sessionId)) {
      updateSession(failure.sessionId, { status: "error", error: failure.message });
      const failed = handles.get(failure.sessionId);
      void failed?.then(handle => handle.dispose()).finally(() => {
        if (handles.get(failure.sessionId!) === failed) handles.delete(failure.sessionId!);
      }).catch(error => console.error("Failed worker cleanup:", errorMessage(error)));
    } else if (!failure.mcpOwnerId) {
      modelsError = failure.message; modelsLoading = false; publishState();
    }
  } });
  const token = randomBytes(32).toString("hex");
  const peers = new Set<ServerWebSocket<SocketData>>();
  function closePeer(peer: ServerWebSocket<SocketData>, code: number, reason: string): void {
    peers.delete(peer); retireRepositoryWatchPeer(peer); peer.close(code, reason);
  }
  const deviceAccess = new DeviceAccessHttp(store, Boolean(network), () => {
    for (const peer of peers) {
      if (peer.data.remoteAddress && (!peer.data.nodeId || !network!.allows(peer.data.nodeId))) {
        closePeer(peer, 1008, "Device authorization changed");
      }
    }
    publish({ type: "device-access" });
  });
  const handles = new Map<string, Promise<WorkerSession>>();
  // A lost permission-apply receipt must never leave an old worker eligible for
  // another prompt. Failed cleanup stays blocked rather than guessing ownership.
  const approvalRecovery = new ApprovalRecovery();
  const commands = new Map<string, Promise<CommandResult>>();
  const sessionTails = new Map<string, Promise<unknown>>();
  const followUpAdmissionTails = new Map<string, Promise<unknown>>();
  const executions = new Map<string, Promise<unknown>>();
  const automationCommands = new WeakSet<CommandEnvelope>();
  const automationPromptCompletions = new Map<string, Promise<"completed" | "failed" | "stopped">>();
  const runtimeErrors = new Map<string, string>();
  mcpOwners = new McpOwnerHttp(store, options.discoveryDirectory ?? homedir(), runtime);
  const draftBrowserWorkers = new DraftBrowserWorkers(store, resolve(options.discoveryDirectory ?? homedir()), runtime);
  browserFirstSend = new BrowserFirstSend(store, draftBrowserWorkers,join(dataDirectory,"browser-recovery"));
  const environmentSessions = new EnvironmentSessions({ store, workspaces, runtime, runs: environmentRuns, reserve: reserveWorkspaceMutation, browserFirstSend,
    signal: environmentAbort.signal, onEvent: onRuntimeEvent,
    onHandle: handle => { handles.set(handle.id, Promise.resolve(handle)); }, changed: () => publishState() });
  let models: ModelInfo[] = [];
  let modelsLoading = true;
  let modelsError: string | undefined;
  let stopping = false;
  const taskLocations = new TaskLocations({ store, dataDirectory, getHandle: id => getHandle(id,true), publish, publishState, reserve: reserveWorkspaceMutation });
  const sessionExports = new SessionExportService({ store, dataDirectory,
    current: async (id, handle) => { const owner = handles.get(id); return await owner === handle && !stopping && handles.get(id) === owner; },
    busy: id => executions.has(id) || sessionForks.isActive(id),
  });
  const sessionExportHttp = new SessionExportHttp(store.host.id, sessionExports);
  const sessionForks = new SessionForkService({ store, workspaces, runtime, dataDirectory, runs: environmentRuns,
    signal: environmentAbort.signal, reserve: reserveWorkspaceMutation,
    existing: async id => handles.get(id)?.catch(() => undefined),
    busy: id => executions.has(id) || taskLocations.requiresRecovery(id),
    environment: async projectId => {
      const selected = await environmentActions.catalog({ projectId });
      if (selected.selectedConfigPath === null) return null;
      if (!selected.configRevision) throw new Error("The selected worktree environment is unavailable. Repair its selection before forking.");
      return { projectId, configPath: selected.selectedConfigPath, revision: selected.configRevision };
    },
    changed: snapshot => { publish({ type: "session.fork", sessionId: snapshot.sessionId, snapshot }); publishState(); },
  });
  let modelsRefresh: Promise<void> | undefined;
  let refreshRequested = false;
  let preferencePeers: Parameters<PreferencesSync["sync"]>[0] = [];
  const notificationEvents = new NotificationEvents({ eventsAfter: (sequence, limit) => store.eventsAfter(sequence, limit),
    emit: event => publish(event), session: id => store.getSession(id) });
  notificationEvents.settleStaleInteractions();
  themeAssets = new ThemeAssets(dataDirectory);
  const attachments = new ImageAttachmentsHttp({ dataDirectory, hostId: store.host.id,
    getNativeImage: async (sessionId, nativeEntryId, blockIndex, source) => (await getHandle(sessionId)).getImage(nativeEntryId, blockIndex, source) });
  function syncThemeAsset(): void {
    const background = preferences?.store.get("theme.background");
    if (background && !background.deleted && background.key === "theme.background" && background.value.kind === "asset") {
      void themeAssets!.sync(background.value.sha256, preferencePeers).then(changed => { if (changed && !stopping) publish({ type: "preferences" }); }).catch(() => {});
    }
  }
  preferences = new PreferencesSync(store, () => { theme?.schedule(); syncThemeAsset(); publish({ type: "preferences" }); publishState(); });
  theme = new ThemeFile({ dataDirectory, store, preferences, changed: () => publish({ type: "preferences" }) });
  await theme.start();
  terminals = new TerminalManager();
  const resolveTerminalTarget: ConstructorParameters<typeof TerminalsHttp>[0]["resolveTarget"] = target => {
    if ("filePath" in target) throw new Error("A standalone file cannot own a terminal.");
    const cwd = "sessionId" in target ? store.getSession(target.sessionId)?.cwd : store.getProject(target.projectId)?.path;
    if (!cwd) throw new Error("The selected terminal owner does not exist on this host.");
    assertWorkspaceAvailable(cwd);
    return cwd;
  };
  const terminalEnvironment: NonNullable<ConstructorParameters<typeof TerminalsHttp>[0]["environmentForTarget"]> = target =>
    "sessionId" in target ? store.getSessionEnvironment(target.sessionId) : undefined;
  terminalsHttp = new TerminalsHttp({ manager: terminals, resolveTarget: resolveTerminalTarget, environmentForTarget: terminalEnvironment, invalidate: event => {
    if (stopping) return;
    const payload = JSON.stringify({ type: "terminal", event });
    for (const peer of peers) {
      if (peer.getBufferedAmount() > 8 * 1024 * 1024) peer.close(1013, "Reconnect to resume terminal output");
      else peer.send(payload);
    }
  } });
  const nativeBundle = options.nativeTerminalBundle ?? join(import.meta.dir, "../../../runtime/tmux", `${process.platform}-${process.arch}`);
  if (options.nativeTerminalBundle || existsSync(nativeBundle)) {
    nativeTerminals = await TmuxTerminalManager.open({ dataDirectory, hostId: store.host.id, bundleDirectory: nativeBundle });
    terminalCreationHttp = new TerminalCreationHttp({ manager: nativeTerminals, records: store.terminalCreations,
      hostId: store.host.id, controlEpoch: crypto.randomUUID(), resolveTarget: resolveTerminalTarget, environmentForTarget: terminalEnvironment });
    nativeTerminalsHttp = new TmuxTerminalsHttp({ manager: nativeTerminals, resolveTarget: resolveTerminalTarget, environmentForTarget: terminalEnvironment, invalidate: event => {
      if (stopping) return;
      const payload = JSON.stringify({ type: "native-terminal", event });
      for (const peer of peers) {
        if (peer.getBufferedAmount() > 8 * 1024 * 1024) peer.close(1013, "Reconnect to resume native terminal output");
        else peer.send(payload);
      }
    } });
  } else if (existsSync(join(dataDirectory, "native-terminals-v1/catalog.json"))) {
    throw new Error("The private terminal bundle is missing. Restore this host's installed runtime before reopening its terminal catalog.");
  }

  function refreshModels(): void {
    refreshRequested = true;
    if (modelsRefresh || stopping) return;
    modelsRefresh = (async () => {
      do {
        refreshRequested = false;
        modelsLoading = true; publishState();
        try { models = await runtime.listModels(options.discoveryDirectory ?? homedir(), { refresh: true }); modelsError = undefined; }
        catch (error) { modelsError = errorMessage(error); }
        finally { modelsLoading = false; publishState(); }
      } while (refreshRequested && !stopping);
    })().finally(() => { modelsRefresh = undefined; });
  }
  function ordered<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const pending = (sessionTails.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(operation);
    sessionTails.set(sessionId, pending);
    const finish = () => { if (sessionTails.get(sessionId) === pending) sessionTails.delete(sessionId); };
    void pending.then(finish, finish);
    return pending;
  }
  accounts = new AccountsHttp({ agentDir: options.agentDirectory, cwd: options.discoveryDirectory ?? homedir(),
    selection: {
      list: async id => (await getHandle(id)).listAccountChoices(),
      pin: (id, credentialId, expectedSelection) => ordered(id, async () => (await getHandle(id)).pinAccount(credentialId, expectedSelection)),
    },
    release: (id, expectedSelection) => ordered(id, async () => (await getHandle(id)).releaseAccountForReselection(expectedSelection)),
    changed: refresh => { publish({ type: "accounts" }); if (refresh) refreshModels(); },
  });
  const resolveComposerCwd = (target?: import("@agent-desktop/shared").WorkspaceTarget) => {
    if (!target) return options.discoveryDirectory ?? homedir();
    if ("filePath" in target) throw new Error("A standalone file cannot own composer actions or skills.");
    const cwd = "sessionId" in target ? store.getSession(target.sessionId)?.cwd : store.getProject(target.projectId)?.path;
    if (!cwd) throw new Error("The composer target is not catalogued on this host.");
    return cwd;
  };
  const skillAuthorizationKey = (ref: import("@agent-desktop/shared").NativeSkillFileRef) => `skill-file.v1:${createHash("sha256").update(JSON.stringify(ref)).digest("hex")}`;
  const skillFiles = new SkillFiles({ hostId: store.host.id, runtime, resolveCwd: resolveComposerCwd, reveal: options.skillFileReveal, fileOpenRuntime: options.workspaceFileOpen,
    authorizations: {
      get: ref => store.readMetadata<SkillFileAuthorization>(skillAuthorizationKey(ref)),
      put: (ref, value) => store.writeMetadata(skillAuthorizationKey(ref), value),
    } });
  const composerActions = new ComposerActionsHttp({ hostId: store.host.id, runtime, getHandle, resolveCwd: resolveComposerCwd, skillFiles });
  goalContinuations = new GoalContinuationController({
    session: id => store.getSession(id), ordered, getHandle,
    executing: id => executions.has(id),
    hasDraft: id => { const draft = store.getDraft(`session:${id}`); return Boolean(draft?.text.trim() || draft?.attachments?.length || draft?.selectedTextAttachments?.length || draft?.wholeFileAttachments?.length || store.getSession(id)?.questionDeliveryPending); },
    checkpoint: (id, state) => {
      const current = store.getSession(id);
      if (current && !stopping && JSON.stringify(current.goalContinuation) !== JSON.stringify(state)) updateSession(id, { goalContinuation: state });
    },
    isCurrent: async (id, handle) => !stopping && await handles.get(id)?.catch(() => undefined) === handle,
    error: (id, error) => { if (!stopping && store.getSession(id)?.status !== 'interrupted') updateSession(id, { status: 'error', error: errorMessage(error) }); },
    start: (id, handle, goalId) => {
      const current = store.getSession(id);
      if (!current || stopping || current.archived || current.status !== 'idle' || executions.has(id)) {
        const error = new Error('This conversation is no longer ready for goal continuation.'); error.name = 'GoalContinuationRejected'; throw error;
      }
      assertWorkspaceAvailable(current.cwd);
      runtimeErrors.delete(id);
      updateSession(id, { status: 'running', error: undefined });
      let run;
      try { run = handle.startGoalContinuation(goalId); }
      catch (error) { updateSession(id, { status: 'idle' }); throw error; }
      let notificationOutcome: 'completed' | 'failed' | 'stopped' = 'failed';
      const completion = run.completion.then(() => {
        const error = runtimeErrors.get(id), latest = store.getSession(id);
        notificationOutcome = latest?.status === 'interrupted' ? 'stopped' : error ? 'failed' : 'completed';
        if (latest && !stopping) updateSession(id, { status: latest.status === 'interrupted' ? 'interrupted' : error ? 'error' : 'idle', error });
      }).catch(error => {
        notificationOutcome = store.getSession(id)?.status === 'interrupted' ? 'stopped' : 'failed';
        if (!stopping && store.getSession(id)?.status !== 'interrupted') updateSession(id, { status: 'error', error: errorMessage(error) });
      }).finally(() => { if (executions.get(id) === completion) executions.delete(id); goalContinuations?.request(id); });
      executions.set(id, completion);
      void run.accepted.then(receipt => completion.then(() => {
        if (!stopping) notificationEvents.completion(id, `completion:${id}:goal:${goalId}:entry:${receipt.entryId}`, notificationOutcome);
      })).catch(() => {});
      return run;
    },
  });
  questionDeliveries = new QuestionDeliveryController({
    session: id => store.getSession(id), ordered, getHandle,
    hasDraft: id => { const draft = store.getDraft(`session:${id}`); return Boolean(draft?.text.trim() || draft?.attachments?.length || draft?.selectedTextAttachments?.length || draft?.wholeFileAttachments?.length); },
    isCurrent: async (id, handle) => !stopping && await handles.get(id)?.catch(() => undefined) === handle,
    checkpoint: (id, pending) => {
      if (!stopping && store.getSession(id)?.questionDeliveryPending !== pending) updateSession(id, { questionDeliveryPending: pending });
      if (!pending) goalContinuations?.request(id);
    },
    changed: id => publish({ type: 'interactions', sessionId: id }),
    error: (id, error) => { if (!stopping && store.getSession(id)?.status !== 'interrupted') updateSession(id, { error: errorMessage(error) }); },
    start: (id, handle, questionId) => {
      const current = store.getSession(id);
      if (!current || stopping || current.archived || !['idle', 'running'].includes(current.status)) {
        const error = new Error('This conversation is not ready for detached answer delivery.'); error.name = 'DetachedQuestionRejected'; throw error;
      }
      assertWorkspaceAvailable(current.cwd);
      const run = handle.startQuestionDelivery(questionId);
      // A steer shares the current execution. An idle native follow-up owns a
      // new execution until its actual agent_end, not just its admission.
      if (!executions.has(id)) {
        runtimeErrors.delete(id); updateSession(id, { status: 'running', error: undefined });
        const completion = run.completion.then(() => {
          if (!stopping && store.getSession(id)?.status !== 'interrupted') updateSession(id, { status: runtimeErrors.has(id) ? 'error' : 'idle', error: runtimeErrors.get(id) });
        }).catch(error => {
          if (!stopping && store.getSession(id)?.status !== 'interrupted') updateSession(id, { status: error instanceof Error && error.name === 'DetachedQuestionRejected' ? 'idle' : 'error', error: error instanceof Error && error.name === 'DetachedQuestionRejected' ? undefined : errorMessage(error) });
        }).finally(() => { if (executions.get(id) === completion) executions.delete(id); questionDeliveries?.request(id); goalContinuations?.request(id); });
        executions.set(id, completion);
      }
      return run;
    },
  });
  const goalControls = new GoalControlHttp({ hostId: store.host.id, sessionExists: id => !stopping && Boolean(store.getSession(id)), getHandle, ordered,
    getExistingHandle: async id => { const pending = handles.get(id); return pending ? await pending.catch(() => undefined) : undefined; },
    completed: (id, input, goal) => {
      goalContinuations!.cancel(id);
      if (goal?.enabled && goal.status === 'active') {
        const activates = ['create', 'replace', 'resume'].includes(input.mutation.type);
        if (activates) updateSession(id, { status: executions.has(id) ? 'running' : 'idle', error: undefined, goalContinuation: { goalId: goal.id } });
        goalContinuations!.request(id);
      } else updateSession(id, { goalContinuation: undefined });
    } });
  const extensionUi = new ExtensionUiHttp({ hostId: store.host.id, sessionExists: id => !stopping && Boolean(store.getSession(id)),
    existing: async id => stopping ? undefined : handles.get(id)?.catch(() => undefined) });
  const sessionActivity = new SessionActivityHttp({ hostId: store.host.id, sessionExists: id => Boolean(store.getSession(id)),
    getActivity: async id => (await getHandle(id)).getSessionActivity(), goalControlTicket: activity => goalControls.ticket(activity) });
  const processBindings = new WeakMap<SessionProcessesHandle, Promise<WorkerSession>>();
  sessionProcesses = new SessionProcessesHttp(store.host.id, new SessionProcessRequests(store.processOperations, {
    getExistingHandle: async id => {
      const pending = handles.get(id);
      if (stopping || !pending) return undefined;
      const handle = await pending.catch(() => undefined);
      if (!handle || stopping || handles.get(id) !== pending) return undefined;
      // Each admission retains its own original registry promise. A later read
      // of the same handle cannot overwrite an earlier request's binding.
      const bound: SessionProcessesHandle = { get workerFailure() { return handle.workerFailure; },
        nativeProcesses: request => handle.nativeProcesses(request) };
      processBindings.set(bound, pending);
      return bound;
    },
    isCurrent: (id, handle) => !stopping && handles.get(id) === processBindings.get(handle),
  }));
  const sessionJobs = new SessionJobsHttp({ hostId: store.host.id,
    sessionExists: id => !stopping && Boolean(store.getSession(id)),
    getExistingHandle: async id => stopping ? undefined : handles.get(id)?.catch(() => undefined) });
  const sessionSubagents = new SessionSubagentsHttp({ hostId: store.host.id,
    sessionExists: id => !stopping && Boolean(store.getSession(id)),
    getExistingHandle: async id => stopping ? undefined : handles.get(id)?.catch(() => undefined) });
  const planDecisions = new PlanDecisionService({ store,
    existing: async id => stopping ? undefined : handles.get(id)?.catch(() => undefined),
    forget: async (id, handle) => {
      const pending = handles.get(id);
      if (pending && await pending.catch(() => undefined) === handle && handles.get(id) === pending) handles.delete(id);
    },
    reopen: id => getHandle(id),
    busy: id => stopping || executions.has(id),
    active: commandId => commands.has(commandId),
    execute: async (handle, phaseId) => {
      const id = handle.id, current = store.getSession(id);
      if (stopping || !current || current.archived || executions.has(id)
        || await handles.get(id)?.catch(() => undefined) !== handle || current.sessionFile !== handle.sessionFile)
        throw new Error("The original approved Plan owner is no longer available.");
      assertWorkspaceAvailable(current.cwd);
      goalContinuations?.cancel(id); runtimeErrors.delete(id);
      const run = handle.startPlanExecution(phaseId);
      updateSession(id, { status: "running", error: undefined });
      let notificationOutcome: "completed" | "failed" | "stopped" = "failed";
      const completion = run.completion.then(() => {
        const latest = store.getSession(id), error = runtimeErrors.get(id);
        notificationOutcome = latest?.status === "interrupted" ? "stopped" : error ? "failed" : "completed";
        if (!stopping && latest) updateSession(id, { model: handle.model, title: handle.title || latest.title,
          status: latest.status === "interrupted" ? "interrupted" : error ? "error" : "idle", error });
      }, error => {
        notificationOutcome = store.getSession(id)?.status === "interrupted" ? "stopped" : "failed";
        if (!stopping && store.getSession(id)?.status !== "interrupted") updateSession(id, { status: "error", error: errorMessage(error) });
      }).finally(() => {
        if (executions.get(id) === completion) executions.delete(id);
        questionDeliveries?.request(id); goalContinuations?.request(id);
      });
      executions.set(id, completion);
      const receipt = await run.accepted;
      if (receipt) void completion.then(() => {
        if (!stopping) notificationEvents.completion(id, `completion:${id}:plan:${phaseId}:entry:${receipt.entryId}`, notificationOutcome);
      });
      if (stopping || await handles.get(id)?.catch(() => undefined) !== handle)
        throw Object.assign(new Error("Plan execution admission lost its original host owner."), { code: "OUTCOME_UNKNOWN" });
      return receipt ? "entered" : "not-entered";
    },
  });
  const btwPromotion = new BtwPromotionService({ store,
    existing: async id => handles.get(id)?.catch(() => undefined),
    busy: id => executions.has(id),
    forget: (id, handle) => { const pending = handles.get(id); if (pending) void pending.then(value => { if (value === handle && handles.get(id) === pending) handles.delete(id); }); },
  });
  const btw = new BtwService({
    promotionBlocked: (id, runId) => btwPromotion.blocked(id, runId),
    session: id => store.getSession(id),
    read: id => store.readMetadata<import("@agent-desktop/shared").NativeBtwSnapshot>(`btw:${id}`) ?? null,
    write: (id, value) => store.writeMetadata(`btw:${id}`, value),
    getHandle,
    getExistingHandle: async id => { const pending = handles.get(id); return pending ? await pending.catch(() => undefined) : undefined; },
  });
  const sessionMcpAuthorization = new SessionMcpAuthorizationHttp({ hostId: store.host.id,
    sessionExists: id => !stopping && Boolean(store.getSession(id)),
    existing: async id => handles.get(id)?.catch(() => undefined),
    receipt: (sessionId, commandId) => {
      const entry = store.getCommand(commandId);
      if (!entry || entry.command?.type !== "session.mcp.authorize" || entry.command.sessionId !== sessionId || entry.command.hostId !== store.host.id) return {commandId,state:"absent"};
      if (entry.state === "pending") return {commandId,state:commands.has(commandId)?"pending":"unknown"};
      const result = entry.result;
      const value = result?.ok ? result.value : undefined;
      if (value && "type" in value && value.type === "session.mcp.authorization") return {commandId,state:"succeeded",authorizationId:value.authorizationId};
      return {commandId,state:result && !result.ok && result.error.code !== "OUTCOME_UNKNOWN" ? "failed" : "unknown"};
    },
  });
  const sessionMcpApps = new SessionMcpAppHttp({ hostId: store.host.id,
    sessionExists: id => !stopping && Boolean(store.getSession(id)),
    existing: async id => handles.get(id)?.catch(() => undefined),
  });
  const sessionMcpResources = new SessionMcpResourceHttp({ hostId: store.host.id,
    sessionExists: id => !stopping && Boolean(store.getSession(id)),
    existing: async id => handles.get(id)?.catch(() => undefined),
  });
  const htmlPreviews = new HtmlPreviewHttp({ hostId: store.host.id, sessionExists: id => !stopping && Boolean(store.getSession(id)), existing: async id => handles.get(id)?.catch(() => undefined) });
  const sessionOutputs = new SessionOutputsHttp({ hostId: store.host.id, sessionExists: id => !stopping && Boolean(store.getSession(id)), existing: async id => handles.get(id)?.catch(() => undefined) });
  const turnReview = new SessionTurnReviewHttp({ hostId: store.host.id, sessionExists: id => !stopping && Boolean(store.getSession(id)), existing: async id => handles.get(id)?.catch(() => undefined) });
  if (nativeTerminals) planExternalEditors = new PlanExternalEditors({
    hostId: store.host.id, controlEpoch: crypto.randomUUID(), records: store.planExternalEditors,
    terminals: new PlanEditorTerminals(dataDirectory, nativeTerminals),
    capture: async id => {
      const catalog = store.getSession(id), pending = handles.get(id);
      if (stopping || !catalog || catalog.archived || !pending) return;
      const handle = await pending.catch(() => undefined);
      if (!handle) return;
      const assertCurrent = () => {
        const current = store.getSession(id), decision = store.getPlanDecisionForSession(id);
        if (stopping || !current || current.archived || current.sessionFile !== catalog.sessionFile || current.cwd !== catalog.cwd
          || handles.get(id) !== pending || handle.workerFailure || handle.id !== id
          || handle.sessionFile !== catalog.sessionFile || handle.cwd !== catalog.cwd || executions.has(id)
          || decision?.state === "pending" || decision?.state === "unknown")
          throw new Error("The original Plan editor owner is unavailable or has an unresolved decision.");
      };
      assertCurrent();
      return { handle, assertCurrent };
    },
  });
  const planExternalEditorHttp = planExternalEditors ? new PlanExternalEditorHttp({ hostId: store.host.id,
    service: planExternalEditors, sessionExists: id => !stopping && Boolean(store.getSession(id)) }) : undefined;
  if (nativeTerminals) todoExternalEditors = new TodoExternalEditors({
    hostId: store.host.id, controlEpoch: crypto.randomUUID(), records: store.todoExternalEditors,
    terminals: new PlanEditorTerminals(dataDirectory, nativeTerminals, "todo"),
    capture: async id => {
      const catalog = store.getSession(id), pending = handles.get(id);
      if (stopping || !catalog || catalog.archived || !pending) return;
      const handle = await pending.catch(() => undefined);
      if (!handle) return;
      const assertCurrent = () => {
        const current = store.getSession(id), decision = store.getPlanDecisionForSession(id);
        if (stopping || !current || current.archived || current.sessionFile !== catalog.sessionFile || current.cwd !== catalog.cwd
          || handles.get(id) !== pending || handle.workerFailure || handle.id !== id
          || handle.sessionFile !== catalog.sessionFile || handle.cwd !== catalog.cwd || executions.has(id)
          || decision?.state === "pending" || decision?.state === "unknown")
          throw new Error("The original Todos editor owner is unavailable or has an unresolved decision.");
      };
      assertCurrent();
      return { handle, assertCurrent };
    },
  });
  const todoExternalEditorHttp = todoExternalEditors ? new TodoExternalEditorHttp({ hostId: store.host.id,
    service: todoExternalEditors, sessionExists: id => !stopping && Boolean(store.getSession(id)) }) : undefined;
  const todosOwners = {
    sessionExists: (id: string) => !stopping && Boolean(store.getSession(id)),
    existing: async (id: string) => stopping ? undefined : handles.get(id)?.catch(() => undefined),
  };
  const sessionTreeHttp = new SessionTreeHttp({ ...todosOwners, hostId: store.host.id,
    receipt: (sessionId, commandId) => projectTreeJournalReceipt(store.getCommand(commandId), sessionId, commandId, commands.has(commandId)),
  });
  const sessionTodosHttp = new SessionTodosHttp({ ...todosOwners, hostId: store.host.id,
    receipt: (sessionId, commandId) => projectTodoJournalReceipt(store.getCommand(commandId), sessionId, commandId, commands.has(commandId)),
  });
  const sessionUsage = new SessionUsageService({ store, admissions: resetAdmissions, ordered, open: id => getHandle(id), commandActive: id => commands.has(id),
    existing: async id => stopping ? undefined : handles.get(id)?.catch(() => undefined),
    assertActive: () => { if (stopping) throw new Error("Host is stopping."); },
  });
  const sessionUsageHttp = new SessionUsageHttp({ hostId: store.host.id, sessionExists: id => !stopping && Boolean(store.getSession(id)),
    read: (id, mode, commandId) => sessionUsage.read(id, mode, commandId),
  });
  const sessionPlanHttp = new SessionPlanHttp({ hostId: store.host.id,
    receipt: (sessionId, commandId) => projectPlanDecisionJournalReceipt(store.getCommand(commandId), sessionId, commandId, commands.has(commandId)),
    continuation: sessionId => planDecisions.continuation(sessionId),
    sessionExists: id => !stopping && Boolean(store.getSession(id)),
    existing: async id => stopping ? undefined : handles.get(id)?.catch(() => undefined),
  });
  const forceToolHttp = new SessionForceToolHttp({ hostId: store.host.id,
    sessionExists: id => !stopping && Boolean(store.getSession(id)),
    existing: async id => {
      const handle = await handles.get(id)?.catch(() => undefined);
      return handle ? { getForceToolState: async () => {
        const value = await handle.getForceTool();
        if (stopping || await handles.get(id)?.catch(() => undefined) !== handle)
          throw new Error("The original force-tool worker changed during inspection.");
        return value;
      } } : undefined;
    },
    receipt: (sessionId, commandId) => projectForceToolJournalReceipt(store.getCommand(commandId), sessionId, commandId, commands.has(commandId)),
  });
  const sessionMcpHttp = new SessionMcpHttp({hostId:store.host.id, sessionExists:id=>!stopping && Boolean(store.getSession(id)),
    existing:async id=>handles.get(id)?.catch(()=>undefined),
    receipt:(sessionId,commandId)=>{
      const entry=store.getCommand(commandId);
      if (!entry || (entry.command?.type !== 'session.mcp.reload' && entry.command?.type !== 'session.mcp.reconnect' && entry.command?.type !== 'session.mcp.unauth') || entry.command.sessionId !== sessionId) return {commandId,state:'absent'};
      if(entry.state==='pending') return {commandId,state:commands.has(commandId)?'pending':'unknown'};
      const result=entry.result;
      return {commandId,state:result?.ok?'succeeded':result && !result.ok && result.error.code!=='OUTCOME_UNKNOWN'?'failed':'unknown',
        ...(result && !result.ok ? {message:result.error.message} : {})};
    }});
  const btwHttp = new BtwHttp({ hostId: store.host.id, sessionExists: id => Boolean(store.getSession(id)), service: btw });
  const browserAutocompleteService = new BrowserAutocompleteService(store.host.id, store.browserAutocomplete);
  const autocompleteHandles = new WeakMap<object, BrowserAutocompleteHandle>();
  const autocompleteHandle = (handle: Awaited<ReturnType<typeof getHandle>> | undefined) => {
    if (!handle?.getBrowserHistory) return undefined;
    let projected = autocompleteHandles.get(handle);
    if (!projected) {
      projected = { workerPid: handle.workerPid, get workerFailure() { return handle.workerFailure; }, getBrowserHistory: target => handle.getBrowserHistory!(target) };
      autocompleteHandles.set(handle, projected);
    }
    return projected;
  };
  const browserControls = new BrowserControlHttp({ hostId: store.host.id, sessionExists: id => Boolean(store.getSession(id)),
    getExistingHandle: async id => { const pending = handles.get(id); return pending ? await pending.catch(() => undefined) : undefined; },
    afterCompletedNavigation: async (id,input) => {
      const pending=handles.get(id),handle=pending?await pending.catch(()=>undefined):undefined;
      if (!handle?.getBrowserHistory) return;
      await browserAutocompleteService.observeNavigation({kind:"session",id},input.target,
        {workerPid:handle.workerPid,workerFailure:handle.workerFailure,getBrowserHistory:target=>handle.getBrowserHistory!(target)},
        async()=>!stopping&&Boolean(store.getSession(id))&&await handles.get(id)?.catch(()=>undefined)===handle);
    } });
  browserHistory = new BrowserHistoryHttp({ hostId: store.host.id, sessionExists: id => Boolean(store.getSession(id)),
    getExistingHandle: async id => { const pending = handles.get(id),handle=pending?await pending.catch(()=>undefined):undefined;return handle?.getBrowserHistory?{workerPid:handle.workerPid,workerFailure:handle.workerFailure,getBrowserHistory:target=>handle.getBrowserHistory!(target)}:undefined; } });
  browserAutocomplete = new BrowserAutocompleteHttp({ hostId: store.host.id, service: browserAutocompleteService, sessionExists: id => Boolean(store.getSession(id)),
    getExistingHandle: async id => { const pending=handles.get(id),handle=pending?await pending.catch(()=>undefined):undefined;return autocompleteHandle(handle); } });
  browserCloseRequests = new BrowserCloseRequests(store.browserCloses, store.host.id, browserControls.epoch);
  const browserClose = new BrowserCloseHttp(browserCloseRequests, store.host.id, id => Boolean(store.getSession(id)),
    async id => { const pending = handles.get(id); return pending ? await pending.catch(() => undefined) : undefined; });
  const browserMetadata = new BrowserMetadataHttp({ hostId: store.host.id, sessionExists: id => Boolean(store.getSession(id)),
    creationTicket: () => ({ controlEpoch: browserControls.epoch, observedAt: Date.now() }),
    getExistingHandle: async id => {
      const pending = handles.get(id)??(store.listBrowserRecoveries().some(record=>record.sessionId===id)?getHandle(id):undefined);
      if (!pending) return undefined;
      try { return await pending; }
      catch { return { workerFailure: { message: "The native session worker is unavailable." }, getBrowserMetadata: async () => ({ availability: "unavailable" as const, reason: "The native session worker is unavailable." }) }; }
    } });
  draftBrowsers = new DraftBrowserHttp(store, draftBrowserWorkers, browserControls.epoch, Date.now, browserAutocompleteService);
  browserObservations = new BrowserObservationHttp({ hostId: store.host.id,
    sessionExists: id => !stopping && Boolean(store.getSession(id)),
    getSessionHandle: async id => handles.get(id)?.catch(() => undefined),
    draftReady: owner => !stopping && draftBrowserWorkers.inspect(owner).state === "ready",
    getDraftHandle: owner => draftBrowserWorkers.getExisting(owner) });
  const browserCreate = new BrowserCreateHttp({ records: store.browserCreations, hostId: store.host.id, controlEpoch: browserControls.epoch,
    sessionExists: id => Boolean(store.getSession(id)), getHandle,
    getExistingHandle: async id => { const pending = handles.get(id); return pending ? await pending.catch(() => undefined) : undefined; } });
  const browserFrames = new BrowserFrameHttp({ hostId: store.host.id, controlEpoch: browserControls.epoch, sessionExists: id => Boolean(store.getSession(id)),
    getExistingHandle: async id => {
      const pending = handles.get(id);
      return pending ? await pending.catch(() => undefined) : undefined;
    } });
  const resolveIntegrationCwd = async (target?: import("@agent-desktop/shared").WorkspaceTarget) => {
    if (target && "filePath" in target) throw new Error("A standalone file cannot own integration settings.");
    const cwd = !target ? options.discoveryDirectory ?? homedir() : "sessionId" in target ? store.getSession(target.sessionId)?.cwd : store.getProject(target.projectId)?.path;
    if (!cwd) throw new Error("The selected integration owner does not exist on this host.");
    const canonical = await realpath(cwd);
    if (canonical !== resolve(cwd)) throw new Error("The integration owner's directory has changed. Re-add the project before editing configuration.");
    return canonical;
  };
  integrations = new IntegrationsHttp({ runtime, resolveCwd:resolveIntegrationCwd,
    changed: target => publish({type:"settings",target}) });
  // The exclusive host lease is held. A predecessor worker may still drain;
  // profile locks in its adapter prevent a new operation or review overtaking it.
  store.pluginAcquisitions.recoverInterrupted();
  const acquisitionOperations = new PluginAcquisitionOperations(store.pluginAcquisitions, {
    read:cwd=>runtime.getMarketplaceCatalog(cwd), mutate:(cwd,revision,action)=>runtime.acquirePlugin(cwd,revision,action),
  },()=>publish({type:"settings"}));
  acquisitions = new PluginAcquisitionHttp({operations:acquisitionOperations,read:cwd=>runtime.getMarketplaceCatalog(cwd),resolveCwd:resolveIntegrationCwd});
  settings = new SettingsHttp({ agentDir: options.agentDirectory, defaultCwd: options.discoveryDirectory ?? homedir(), runtime,
    resolveCwd: target => {
      if (!target) return options.discoveryDirectory ?? homedir();
      if ("filePath" in target) throw new Error("A standalone file cannot own native settings.");
      const cwd = "sessionId" in target ? store.getSession(target.sessionId)?.cwd : store.getProject(target.projectId)?.path;
      if (!cwd) throw new Error("The selected settings owner does not exist on this host.");
      return cwd;
    },
    getHandle: async id => ({
      getControls: async () => (await getHandle(id)).getControls(),
      mutateControls: mutation => ordered(id, async () => {
        if ((mutation.operation === "override" || mutation.operation === "clear-override") && mutation.path === "tools.approvalMode") {
          return applySessionApproval(id, mutation.operation === "override" ? approvalMode(mutation.value) : undefined, mutation.expectedRevision);
        }
        const result = await (await getHandle(id)).mutateControls(mutation);
        if (!stopping) updateSession(id, { model: result.model });
        return result;
      }),
    }),
    changed: change => {
      publish({ type: "settings", ...change });
      if (!change.sessionId) refreshModels();
    },
  });

  const sessionSearch = new SessionSearch(store.host.id, () => store.listSessions(), readStoredSessionText);
  const queuedMessages = new QueuedMessagesHttp({ hostId: store.host.id,
    sessionExists: id => !stopping && Boolean(store.getSession(id)), getHandle });
  automations = new AutomationService({
    records: store.automations,
    dispatch: (envelope, version) => { automationCommands.add(envelope); return dispatch(envelope, version); },
    waitForPrompt: async commandId => {
      const completion = automationPromptCompletions.get(commandId);
      if (!completion) return "unknown";
      try { return await completion; }
      finally { automationPromptCompletions.delete(commandId); }
    },
    sessionState: async sessionId => {
      const session = store.getSession(sessionId);
      if (!session) return { session: undefined, busy: false, hasDraft: false, hasInteraction: false };
      const handle = await getHandle(sessionId);
      const draft = store.getDraft(`session:${sessionId}`);
      return { session, busy: executions.has(sessionId) || handle.isStreaming || handle.hasPostPromptWork,
        hasDraft: Boolean(draft && (draft.text.trim() || draft.attachments?.length || draft.selectedTextAttachments?.length || draft.wholeFileAttachments?.length)),
        hasInteraction: (await handle.listInteractions()).length > 0 || (await handle.listQuestions()).some(question => question.status === "open") };
    },
    validateDestination: destination => {
      if (destination.kind === "heartbeat") return;
      if (destination.projectId && !store.getCataloguedProject(destination.projectId)) throw new Error("The automation project is unavailable on this host.");
      if (destination.model && !models.some(model => model.provider === destination.model!.provider && model.id === destination.model!.id))
        throw new Error(modelsLoading ? "The model catalog is still loading. Try again when it is ready." : "The automation model is unavailable on this host.");
    },
    changed: () => publish({ type: "automations" }),
    notify: run => { if (run.sessionId) notificationEvents.completion(run.sessionId, `automation:${run.id}`, run.status === "completed" ? "completed" : "failed", run.completedAt ?? run.updatedAt); },
    tickMs: options.automationTickMs,
  });
  pullRequests = new PullRequests({ hostId: store.host.id, writes: store.pullRequestWrites });
  const pullRequestsHttp = new PullRequestsHttp(store.host.id, pullRequests);
  const automationsHttp = new AutomationsHttp(store.host.id, automations);
  automations.start();

  function snapshot(): HostState {
    const preferenceError = Object.keys(preferences?.errors ?? {}).length ? "App preferences are waiting to synchronize with some connected hosts." : undefined;
    return { protocolVersion: 1, sessionUsage: { version: 1, commandVersion: 20, nativePolicy: false }, host: store.host, projects: store.listProjects(), sessions: store.listSessions(),
      sessionExports: SESSION_EXPORT_CAPABILITY,
      sessionForks: SESSION_FORK_CAPABILITY,
      goalComposer: GOAL_COMPOSER_CAPABILITY,
      sidebarNavigation: SIDEBAR_NAVIGATION_CAPABILITY,
      drafts: store.listDrafts(), models, modelsLoading, automations: { capability: AUTOMATIONS_CAPABILITY }, pullRequests: PULL_REQUESTS_CAPABILITY, pullRequestWrites: PULL_REQUEST_WRITES_CAPABILITY, repositoryWatches: REPOSITORY_WATCH_CAPABILITY, branchQueries: BRANCH_QUERY_CAPABILITY, sessionSearch: { version: 1 }, forceTool: { version: 1, commandVersion: 18 }, plan: { version: 1, commandVersion: 19, document: { version: 1, commandVersion: 20 } }, queuedMessages: { version: 1, submissions: { version: 1, commandVersion: 13, images: { commandVersion: 17 } } }, taskLocations: { version: 1, commandVersion: 14 }, browserContinuations:{version:1,commandVersion:15}, commandKeybindings: { commandVersion: 11, snapshotVersion: 2, numberTargetVersion: 1 }, gitSubmissions: { commandVersion: 10 }, imageAttachments: attachments.capabilities, wholeFiles: { commandVersion: 7, ordinaryPrompt: true, maxFiles: MAX_WHOLE_FILE_ATTACHMENTS, inlineMentions: {commandVersion:8,repeatedSources:{commandVersion:9}} }, selectedText: { commandVersion: 6, maxSerializedChars: MAX_SELECTED_TEXT_SERIALIZED_CHARS, ordinaryPrompt: true }, newChatExecution: { commandVersion: 4, worktrees: true, startingRefs: { commandVersion: 12, remote: true } }, localEnvironments: { configuration: true, ...(nativeTerminals ? { actions: true as const } : {}), execution: { commandVersion: 5, scriptOutput: true, scriptCancellation: true } }, diagnostics: modelsError || preferenceError ? { models: modelsError, preferences: preferenceError } : undefined,
      todos: SESSION_TODOS_CAPABILITY, tree: SESSION_TREE_CAPABILITY,
      lastEventSequence: store.lastEventSequence, notifications: notificationEvents.current() };
  }
  function publish(input: EventInput, sessionActivity = false): void {
    if (stopping) return;
    const durable = sessionActivity && (input.type === "runtime" || input.type === "interactions") ? { ...input, sessionActivity: true as const } : input;
    const event = store.appendEvent(durable, sessionActivity);
    const payload = JSON.stringify(event);
    for (const peer of peers) {
      if (peer.getBufferedAmount() > 8 * 1024 * 1024) closePeer(peer, 1013, "Reconnect to resume events");
      else peer.send(payload);
    }
  }
  function publishState(): void {
    void workspaces.reconcileRepositoryWatchOwners().catch(error => console.error("Repository watch owner cleanup failed:", error));
    publish({ type: "state", state: snapshot() });
  }
  function updateSession(id: string, update: Partial<SessionSummary>): SessionSummary {
    const current = store.getSession(id);
    if (!current) throw new Error("Session does not exist on this host.");
    const result = store.upsertSession({ ...current, ...update, updatedAt: Date.now() });
    publishState();
    return result;
  }
  function onRuntimeEvent(sessionId: string, event: unknown): void {
    if (stopping) return;
    const value = event as { type?: string; message?: { errorMessage?: string } };
    if (value.type === "extension_ui_changed") {
      const changed = event as { epoch: string; revision: number };
      publish({ type: "extension-ui", sessionId, epoch: changed.epoch, revision: changed.revision });
      return;
    }
    if (value.type === "queued_messages_changed") {
      const payload = JSON.stringify({ type: "queued-messages", sessionId });
      for (const peer of peers) {
        if (peer.getBufferedAmount() > 8 * 1024 * 1024) closePeer(peer, 1013, "Reconnect to refresh queued messages");
        else peer.send(payload);
      }
      return;
    }
    if (value.type === "extension_interaction_requested" || value.type === "extension_interaction_resolved") {
      if (value.type === "extension_interaction_requested") notificationEvents.interactionRequested((value as import('@agent-desktop/shared').OmpBridgeEvent & { type: 'extension_interaction_requested' }).interaction);
      else notificationEvents.interactionResolved(sessionId, (value as import('@agent-desktop/shared').OmpBridgeEvent & { type: 'extension_interaction_resolved' }).id);
      if (value.type === "extension_interaction_resolved") goalContinuations?.request(sessionId);
      if (value.type === "extension_interaction_resolved") questionDeliveries?.request(sessionId);
      publish({ type: "interactions", sessionId }, isUnreadSessionEvent(event));
      return;
    }
    if (value.type === 'goal_updated' || value.type === 'agent_end' || value.type === 'tool_execution_end') goalContinuations?.request(sessionId);
    if (value.type === 'agent_end' || value.type === 'tool_execution_end') questionDeliveries?.request(sessionId);
    if (value.type === 'agent_end' || value.type === 'tool_execution_end') refreshDetachedNotifications(sessionId);
    if (value.type === "message_end" && value.message?.errorMessage) runtimeErrors.set(sessionId, value.message.errorMessage);
    publish({ type: "runtime", sessionId, event }, isUnreadSessionEvent(event));
  }
  async function recoverBrowserRecord(record:BrowserRecoveryRecord):Promise<WorkerSession>{
    const recovered=await runtime.recoverBrowserContinuation({...record,onEvent:event=>onRuntimeEvent(record.sessionId,event)});
    if(record.status==="arming")store.recordBrowserRecovery({...record,status:"ready",recordedAt:Date.now()});
    let disposal:Promise<void>|undefined;
    return new Proxy(recovered.session,{get(target,key){
      if(key!=="dispose")return Reflect.get(target,key,target);
      return ()=>disposal??=(async()=>{
        const outcomes=await Promise.allSettled([target.dispose(),recovered.closeSource()]);
        const errors=outcomes.flatMap(outcome=>outcome.status==="rejected"?[outcome.reason]:[]);
        if(errors.length)throw new AggregateError(errors,"Retained browser session cleanup failed; its recovery record was preserved.");
        store.removeBrowserRecovery(record.sessionId);
      })();
    }});
  }

  async function recoverPendingBrowserCreation(record:BrowserRecoveryRecord):Promise<CommandResult>{
    const claim=store.getCommand(record.commandId),command=claim?.command;
    if(!claim||claim.state!=="pending"||command?.type!=="session.create"||!command.browserContinuation)
      throw new Error("Browser recovery lost its pending creation command.");
    const handle=await handles.get(record.sessionId)?.catch(()=>undefined)??await recoverBrowserRecord(record);
    try{
      const now=Date.now(),session:SessionSummary={id:handle.id,hostId:store.host.id,projectId:command.projectId??null,cwd:handle.cwd,
        title:handle.title||"New conversation",status:"idle",sessionFile:handle.sessionFile,model:handle.model,
        createdAt:Number.isFinite(handle.createdAt)?handle.createdAt:now,updatedAt:now,archived:false,error:handle.modelFallbackMessage,
        approvalOverride:command.approvalMode};
      let result:CommandResult;
      if(command.environment!==undefined){
        const preparation=store.environmentPreparations.get(record.commandId);
        if(!preparation||preparation.phase!=="native-creating")throw new Error("Recovered browser environment is not awaiting its original native session.");
        result=store.finishEnvironmentSessionCreation(record.commandId,claim.requestHash,session,{id:preparation.id,expectedRevision:preparation.revision});
      }else result=store.finishBrowserRecoveredSession(record.commandId,session);
      handles.set(record.sessionId,Promise.resolve(handle));publishState();return result;
    }catch(error){
      // The exact workers are already acquired. Retain them for a same-command
      // recovery attempt; disposal would destroy the only evidence of outcome.
      handles.set(record.sessionId,Promise.resolve(handle));throw error;
    }
  }

  async function getHandle(sessionId: string, locationRecovery = false): Promise<WorkerSession> {
    if (stopping) throw new Error('The host is stopping. Reconnect before opening this session.');
    if (sessionForks.isActive(sessionId)) throw new Error("This conversation is taking an owned Fork snapshot. Wait for it to finish before starting native work.");
    if (!locationRecovery && taskLocations.requiresRecovery(sessionId)) throw new Error("This task is blocked on location recovery. Review and resume its original move before running native work.");
    await approvalRecovery.wait(sessionId);
    if (stopping) throw new Error('The host is stopping. Reconnect before opening this session.');
    let pending = handles.get(sessionId);
    if (!pending) {
      const session = store.getSession(sessionId);
      if (!session) throw new Error("Session does not exist on this host.");
      assertWorkspaceAvailable(session.cwd);
      const browserRecovery=store.listBrowserRecoveries().find(record=>record.sessionId===sessionId);
      const opened=browserRecovery
        ? recoverBrowserRecord(browserRecovery)
        : runtime.open({ sessionFile: session.sessionFile, interactions: true, approvalOverride: session.approvalOverride, onEvent: event => onRuntimeEvent(sessionId, event) }, store.getSessionEnvironment(sessionId));
      pending = opened.then(async handle => {
        try {
          if (stopping) throw new Error('The host is stopping. Reconnect before opening this session.');
          const current = store.getSession(sessionId);
          if (!current) throw new Error("Session does not exist on this host.");
          const model = handle.model;
          if (current.model?.provider !== model?.provider || current.model?.id !== model?.id) {
            // The journal is insufficient to identify a resumed worker's current
            // model. Publish the native runtime value before exposing the handle,
            // while retaining the session's conversation-activity timestamp.
            store.upsertSession({ ...current, model });
            publishState();
          }
          notificationEvents.reconcileDetached(sessionId, await handle.listQuestions());
          return handle;
        } catch (error) {
          await handle.dispose();
          throw error;
        }
      });
      handles.set(sessionId, pending);
      pending.catch(() => { if (handles.get(sessionId) === pending) handles.delete(sessionId); });
    }
    return pending;
  }
  function refreshDetachedNotifications(sessionId: string): void {
    const pending = handles.get(sessionId);
    if (!pending) return;
    void pending.then(async handle => {
      const questions = await handle.listQuestions();
      if (!stopping && await handles.get(sessionId)?.catch(() => undefined) === handle) notificationEvents.reconcileDetached(sessionId, questions);
    }).catch(() => {});
  }
  async function applySessionApproval(sessionId: string, mode: OmpApprovalMode | undefined, expectedRevision?: string): Promise<OmpSessionControls> {
    const handle = await getHandle(sessionId);
    if (executions.has(sessionId) || handle.isStreaming || handle.hasPostPromptWork) throw new OmpSettingsError("conflict", "Stop the current turn before changing its native permission mode.");
    const current = await handle.getControls();
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new OmpSettingsError("conflict", "Native session controls changed; reload before editing");
    if (mode !== undefined) approvalMode(mode);
    const saved = store.getSession(sessionId)!;
    if (mode === undefined && saved.approvalOverride === undefined) throw new OmpSettingsError("unsupported", "No app-owned permission override exists for this session.");
    // SQLite commits this intent and its rollback version gate together. A
    // rejected write cannot start native work or clear the submitted draft.
    store.upsertSession({ ...saved, approvalOverride: mode, updatedAt: Date.now() });
    try {
      const applied = await handle.setApprovalOverride(mode, current.revision);
      if (applied.durableApprovalOverride !== mode) throw new Error("Native permission apply was not acknowledged");
      publishState();
      return applied;
    } catch (error) {
      const failed = handles.get(sessionId);
      // The saved choice remains authoritative even if this command failed.
      // Only proven disposal allows a fresh worker to restore it on next use.
      let retired = false;
      try {
        await approvalRecovery.retire(sessionId, () => handle.dispose(), () => {
          if (handles.get(sessionId) === failed) handles.delete(sessionId);
        });
        retired = true;
      } finally {
        // Settings mutations do not pass through command-dispatch's final
        // snapshot. Publish saved intent and recovery status on this path too.
        updateSession(sessionId, { status: "error", error: retired
          ? "The permission choice was saved; native application was not confirmed. Reload this session before sending."
          : "The permission choice was saved, but worker cleanup is unverified. This session is blocked until host recovery." });
        publish({ type: "settings", sessionId });
      }
      throw new Error(`The permission choice was saved, but native application was not confirmed. Reload this session before sending. ${errorMessage(error)}`);
    }
  }
  function fail(id: string, code: string, message: string): CommandResult {
    return { ok: false, commandId: id, error: { code, message } };
  }

  async function execute(envelope: CommandEnvelope, commandVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 22 | 23 | 24): Promise<CommandResult> {
    const command = envelope.command;
    if ((command.type === "session.tree.mutate" || command.type === "session.prompt" && command.treeTicket !== undefined) && commandVersion !== 23)
      return fail(envelope.id, "TREE_PROTOCOL_REQUIRED", "Native history requires version 23.");
    if (command.type === "session.todos.mutate" && commandVersion !== 22)
      return fail(envelope.id, "TODOS_REJECTED", "Native Todos require the revision-bound version 22 protocol.");
    if (commandVersion < 20 && command.type === "session.plan.mutate" && command.mutation.action === "document")
      return fail(envelope.id, "PLAN_DOCUMENT_PROTOCOL_REQUIRED", "Native Plan document changes require the current client protocol.");
    const remoteError = remoteWorktreeProtocolError(command, commandVersion, id => store.getDraft(id), id => store.environmentPreparations.get(id));
    if (remoteError) return fail(envelope.id, remoteError.code, remoteError.message);
    if (commandVersion < 18 && (command.type === "session.force.cancel" || command.type === "session.prompt" && (command.forceTool || command.forceRecovery)))
      return fail(envelope.id, "FORCE_TOOL_PROTOCOL_REQUIRED", "Force-tool commands require the current client protocol.");
    if (commandVersion < 16 && hasSessionForkIntent(command)) return fail(envelope.id, "FORK_PROTOCOL_REQUIRED", "Fork requires the current client protocol.");
    if (commandVersion < 11 && command.type === "preferences.keymap.mutate") return fail(envelope.id, "KEYBINDINGS_PROTOCOL_REQUIRED", "Keyboard shortcut changes require the current client protocol.");
    if (commandVersion < 13 && command.type === "session.follow-up") return fail(envelope.id, "FOLLOW_UP_PROTOCOL_REQUIRED", "Queued follow-ups require the current client protocol.");
    if (commandVersion < 15 && command.type === "session.create" && command.browserContinuation) return fail(envelope.id,"BROWSER_CONTINUATION_PROTOCOL_REQUIRED","Browser continuation requires the current client protocol.");
    if (commandVersion < 14 && (command.type === "session.location.move" || command.type === "session.location.resume")) return fail(envelope.id,"TASK_LOCATION_PROTOCOL_REQUIRED","Task location changes require the current client protocol.");
    if (commandVersion < 10 && command.type === "workspace.mutate" && command.action.type.startsWith("git.submit")) return fail(envelope.id, "GIT_SUBMISSION_PROTOCOL_REQUIRED", "Git submissions require the current client protocol.");
    if(commandVersion<9 && requiresRepeatedWholeFileProtocol(command,id=>store.getDraft(id)))return fail(envelope.id,"REPEATED_WHOLE_FILE_PROTOCOL_REQUIRED","This draft repeats an inline file mention. Update the client; its content was preserved.");
    if(commandVersion<8 && requiresInlineFileProtocol(command,id=>store.getDraft(id)))return fail(envelope.id,"INLINE_FILE_PROTOCOL_REQUIRED","This draft contains inline file positions. Update the client; its content was preserved.");
    if (commandVersion < 7 && requiresWholeFileProtocol(command, id => store.getDraft(id))) return fail(envelope.id, "WHOLE_FILE_PROTOCOL_REQUIRED", "This draft requires the whole-file protocol. Its content was preserved.");
    if (commandVersion < 6 && requiresSelectedTextProtocol(command, id => store.getDraft(id))) return fail(envelope.id, "SELECTED_TEXT_PROTOCOL_REQUIRED", "This draft requires the selected-text protocol. Its content was preserved.");
    if (commandVersion < 5 && requiresEnvironmentProtocol(command, id => store.getDraft(id))) return fail(envelope.id, "ENVIRONMENT_PROTOCOL_REQUIRED", "This draft requires the environment protocol. Its selection was preserved.");
    if (commandVersion < 4 && requiresNewChatProtocol(command, id => store.getDraft(id))) return fail(envelope.id, "NEW_CHAT_PROTOCOL_REQUIRED", "This draft requires the new-chat execution protocol. Its choices were preserved.");
    if (commandVersion < 3 && requiresAttachmentProtocol(command, id => store.getDraft(id))) return fail(envelope.id, "ATTACHMENT_PROTOCOL_REQUIRED", "This draft requires the image attachment protocol. Its content was preserved.");
    if ((command.type === "session.prompt" || command.type === "session.steer") && command.draft) {
      const draft = store.getDraft(command.draft.id);
      if (draft?.goal !== undefined && (draft.goal !== null || command.type === "session.prompt") && commandVersion !== 24) return fail(envelope.id, "GOAL_COMPOSER_PROTOCOL_REQUIRED", "Send this draft with the Goal composer protocol. Its intent was preserved.");
      if (draft?.revision === command.draft.revision && (draft.goal || command.type === "session.prompt" && (draft.goal !== undefined || command.goal !== undefined))) {
        const expected = goalPromptFromDraft(draft);
        const actual = command.type === "session.prompt" ? command.goal : undefined;
        if (command.type !== "session.prompt" || draft.text !== command.text || expected?.objective !== actual?.objective || expected?.tokenBudget !== actual?.tokenBudget)
          return fail(envelope.id, "DRAFT_CONTENT_MISMATCH", "The Goal intent does not match this draft revision. Reload its preserved content before sending.");
      }
      if (draft?.wholeFileAttachments !== undefined && command.wholeFileAttachments === undefined) return fail(envelope.id, "WHOLE_FILE_PROTOCOL_REQUIRED", "Send the whole files with this draft. Its content was preserved.");
      if (draft?.revision === command.draft.revision && (draft.wholeFileAttachments !== undefined || command.wholeFileAttachments !== undefined)
        && (draft.text !== command.text || !sameWholeFileAttachments(draft.wholeFileAttachments, command.wholeFileAttachments))) return fail(envelope.id, "DRAFT_CONTENT_MISMATCH", "The submitted files do not match this draft revision. Reload its preserved content before sending.");
      if (draft?.selectedTextAttachments !== undefined && command.selectedTextAttachments === undefined) return fail(envelope.id, "SELECTED_TEXT_PROTOCOL_REQUIRED", "Send the captured selections with this draft. Its content was preserved.");
      if (draft?.revision === command.draft.revision && (draft.selectedTextAttachments !== undefined || command.selectedTextAttachments !== undefined)
        && (draft.text !== command.text || !sameSelectedTextAttachments(draft.selectedTextAttachments, command.selectedTextAttachments))) return fail(envelope.id, "DRAFT_CONTENT_MISMATCH", "The submitted selections do not match this draft revision. Reload its preserved content before sending.");
      if (draft?.attachments !== undefined && command.attachments === undefined) return fail(envelope.id, "ATTACHMENT_PROTOCOL_REQUIRED", "Send the captured image manifest with this draft. Its content was preserved.");
      if (draft?.revision === command.draft.revision && (draft.attachments !== undefined || command.attachments !== undefined)
        && (draft.text !== command.text || !sameImageAttachments(draft.attachments, command.attachments))) return fail(envelope.id, "DRAFT_CONTENT_MISMATCH", "The submitted content does not match this draft revision. Reload its preserved content before sending.");
    }
    const ok = (value?: Extract<CommandResult, { ok: true }>["value"], admission?: Extract<CommandResult, { ok: true }>["admission"]): CommandResult =>
      ({ ok: true, commandId: envelope.id, value, ...(admission ? { admission } : {}) });
    switch (command.type) {
      case "session.export": return sessionExports.export(envelope.id, command.sessionId, command.theme, await getHandle(command.sessionId));
      case "session.fork": return sessionForks.fork(envelope.id, command.sessionId, command.expectedRevision, command.execution);
      case "session.fork.resume": return sessionForks.resume(envelope.id, command.sessionId, command.operationId);
      case "session.location.move": try { return ok(await taskLocations.move(envelope.id,command.sessionId,command.expectedRevision,command.target)); } catch(error) { if(error instanceof TaskLocationError) return fail(envelope.id,error.code,error.message); throw error; }
      case "session.location.resume": try { return ok(await taskLocations.resume(command.sessionId,command.operationId,command.expectedRevision)); } catch(error) { if(error instanceof TaskLocationError) return fail(envelope.id,error.code,error.message); throw error; }
      case "session.follow-up": return fail(envelope.id, "FOLLOW_UP_DISPATCH_REQUIRED", "Queued follow-ups require their durable admission dispatcher.");
      case "skill.file.write": {
        const value = await skillFiles.write(command.ref, command);
        return ok(value);
      }
      case "skill.file.open": return ok(await skillFiles.open(command.ref, command.targetId));
      case "skill.file.reveal": {
        await skillFiles.reveal(command.ref);
        return ok({ type: "skill.file.reveal" });
      }
      case "session.environment.cancel": {
        const record = store.environmentPreparations.get(command.preparationId);
        const project = store.getProject(command.projectId);
        if (!record || !project || record.projectId !== project.id || record.sourceRoot !== project.path) throw new Error('Preparation does not belong to this project.');
        environmentRuns.cancel(record.id, command.runRevision);
        return { ok: true, commandId: envelope.id };
      }
      case "session.environment.resume": return environmentSessions.resume(envelope.id, command.preparationId, command.expectedRevision);
      case "session.btw.start": {
        if (!command.question.trim() || command.question.length > 32 * 1024) return fail(envelope.id, "INVALID_BTW_REQUEST", "The btw question is empty or too large.");
        let checkedHandle: WorkerSession | undefined;
        if (command.draft) {
          const draft = store.getDraft(command.draft.id);
          if (!draft || draft.revision !== command.draft.revision) return fail(envelope.id, "DRAFT_CONFLICT", "The side-question draft changed elsewhere. Its content was preserved.");
          if (draft.attachments?.length || draft.selectedTextAttachments?.length || draft.wholeFileAttachments?.length) return fail(envelope.id, "DRAFT_CONTENT_MISMATCH", "Native side questions do not accept attachments yet. The draft was preserved.");
          if (command.nativeCommand === "btw") {
            if (draft.id !== `session:${command.sessionId}` || nativeBtwQuestion(draft.text) !== command.question)
              return fail(envelope.id, "DRAFT_CONTENT_MISMATCH", "The submitted /btw question does not match this main composer draft. Reload its preserved content before sending.");
            checkedHandle = await getHandle(command.sessionId);
            const catalog = await checkedHandle.getComposerActions();
            if (!hasNativeBtwComposerWinner(catalog)) return fail(envelope.id, "NATIVE_COMMAND_SHADOWED", "Native /btw is shadowed by another loaded composer command. The draft was preserved.");
          } else if (draft.id !== `btw:${command.sessionId}` || draft.text.trim() !== command.question) {
            return fail(envelope.id, "DRAFT_CONTENT_MISMATCH", "The submitted side question does not match its saved draft. Reload its preserved content before sending.");
          }
        }
        const snapshot = await btw.start(command.sessionId, { runId: envelope.id, question: command.question }, checkedHandle);
        return ok({ type: "session.btw", snapshot });
      }
      case "session.mcp.authorize": {
        if (command.hostId !== store.host.id) return fail(envelope.id,"OWNER_MISMATCH","The selected authorization belongs to another host.");
        if (!store.getSession(command.sessionId)) return fail(envelope.id,"STALE_TARGET","The selected session no longer exists.");
        if (executions.has(command.sessionId)) return fail(envelope.id,"SESSION_BUSY","Wait for the native turn before authorizing an MCP server.");
        const handle = await handles.get(command.sessionId)?.catch(() => undefined);
        if (!handle) return fail(envelope.id,"MCP_NOT_LOADED","This session has no loaded native runtime. No authorization started a worker.");
        const snapshot = await handle.startSessionMcpAuthorization({commandId:envelope.id,epoch:command.epoch,expectedRevision:command.expectedRevision,serverName:command.serverName});
        if (snapshot.commandId !== envelope.id) return fail(envelope.id,"OUTCOME_UNKNOWN","The worker did not confirm this authorization identity. Inspect its current state before starting another.");
        // Persist the start receipt only. Live callback URLs/prompts/answers
        // belong exclusively to the private authorization route.
        return ok({type:"session.mcp.authorization",authorizationId:snapshot.authorizationId});
      }
      case "session.mcp.reload":
      case "session.mcp.reconnect":
      case "session.mcp.unauth": {
        if (!store.getSession(command.sessionId)) return fail(envelope.id,"STALE_TARGET","The selected session no longer exists.");
        if (executions.has(command.sessionId)) return fail(envelope.id,"SESSION_BUSY","Wait for the native turn to finish before changing MCP connections.");
        const handle = await handles.get(command.sessionId)?.catch(()=>undefined);
        if (!handle) return fail(envelope.id,"MCP_NOT_LOADED","This session has no loaded native runtime. No MCP operation started a worker.");
        const snapshot = command.type === "session.mcp.unauth"
          ? await handle.unauthorizeSessionMcp({epoch:command.epoch,expectedRevision:command.expectedRevision,serverName:command.serverName})
          : command.type === "session.mcp.reconnect"
          ? await handle.reconnectSessionMcp({epoch:command.epoch,expectedRevision:command.expectedRevision,serverName:command.serverName})
          : await handle.reloadSessionMcp({epoch:command.epoch,expectedRevision:command.expectedRevision});
        return ok({type:"session.mcp",snapshot});
      }
      case "session.tree.mutate": {
        const { type: _type, ...request } = command;
        try {
          const result = await mutateSessionTree(todosOwners, envelope.id, request);
          publish({ type: "runtime", sessionId: command.sessionId, event: { type: "tree_changed" } });
          return ok({ type: "session.tree.mutate", result });
        } catch (error) {
          const rejected = error instanceof Error && "code" in error && error.code === "TREE_REJECTED";
          return fail(envelope.id, rejected ? "TREE_REJECTED" : "OUTCOME_UNKNOWN", errorMessage(error));
        }
      }
      case "session.todos.mutate": {
        const { type: _type, ...request } = command;
        try {
          const result = await mutateSessionTodos(todosOwners, envelope.id, request);
          publish({ type: "runtime", sessionId: command.sessionId, event: { type: "todos_changed" } });
          return ok({ type: "session.todos.mutate", result });
        } catch (error) {
          const rejected = error instanceof Error && "code" in error && error.code === "TODOS_REJECTED";
          return fail(envelope.id, rejected ? "TODOS_REJECTED" : "OUTCOME_UNKNOWN", errorMessage(error));
        }
      }
      case "session.plan.mutate": {
        const { type: _type, ...request } = command;
        const result = await planDecisions.decide(envelope.id, request);
        publish({ type: "runtime", sessionId: command.sessionId, event: { type: "plan_changed" } });
        return result;
      }
      case "session.plan.execution.retry": {
        const { type: _type, ...request } = command;
        const result = await planDecisions.retry(envelope.id, request);
        publish({ type: "runtime", sessionId: command.sessionId, event: { type: "plan_changed" } });
        return result;
      }
      case "session.usage.reset.prepare": {
        try { return { ok: true, commandId: envelope.id, value: { type: "session.usage.reset", receipt: await sessionUsage.prepare(envelope.id, command) } }; }
        catch { return fail(envelope.id, "USAGE_REJECTED", "Reset preparation could not be confirmed. Inspect the original saved-reset state before trying again."); }
      }
      case "session.usage.reset.respond": {
        try { return { ok: true, commandId: envelope.id, value: { type: "session.usage.reset", receipt: await sessionUsage.answer(envelope.id, command) } }; }
        catch { return fail(envelope.id, "OUTCOME_UNKNOWN", "The original reset answer could not be confirmed. Inspect it without sending another answer."); }
      }
      case "session.plan.control": {
        const owner = await handles.get(command.sessionId)?.catch(() => undefined);
        if (!owner) return fail(envelope.id, "PLAN_NOT_LOADED", "The original Plan worker is unavailable. Reopen and inspect before choosing an action.");
        const { type: _type, ...request } = command;
        let result;
        try { result = await owner.controlPlan(request); }
        catch (error) {
          const rejected = error instanceof Error && "code" in error && error.code === "PLAN_REJECTED";
          return fail(envelope.id, rejected ? "PLAN_REJECTED" : "OUTCOME_UNKNOWN", rejected ? errorMessage(error)
            : `The native Plan control outcome could not be confirmed. ${errorMessage(error)}`);
        }
        if (stopping || await handles.get(command.sessionId)?.catch(() => undefined) !== owner)
          return fail(envelope.id, "OUTCOME_UNKNOWN", "The original Plan control outcome could not be confirmed. Inspect its native state before retrying.");
        publish({ type: "runtime", sessionId: command.sessionId, event: { type: "plan_changed" } });
        return ok({ type: "session.plan.control", ...result });
      }
      case "session.btw.promote": return btwPromotion.promote(envelope.id, command.sessionId, command.runId);
      case "session.btw.cancel": {
        const snapshot = await btw.cancel(command.sessionId, command.runId);
        return ok({ type: "session.btw", snapshot });
      }
      case "preferences.keymap.mutate": return ok({ type: command.type, preference: preferences!.mutateCommandKeymap(command.mutation, target => applicationKeybindingAdmissionDefinitions({ primaryNumberShortcutTarget: target })) });
      case "preferences.put": return ok({ type: command.type, preference: preferences!.put(command.change) });
      case "workspace.mutate": {
        try { return ok(await workspaces.mutate(command.target, command.action, envelope.id)); }
        finally { publish({ type: "workspace", target: command.target }); }
      }
      case "project.add": return ok(store.addProject(command));
      case "project.rename": return ok(store.renameProject(command.projectId, command.name));
      case "project.remove": return ok(store.removeProject(command.projectId));
      case "draft.put": {
        const save = async () => {
          const result = store.putDraft(command.draft, command.expectedRevision);
          if (result.ok && command.draft.id.startsWith('session:')) goalContinuations?.request(command.draft.id.slice('session:'.length));
          if (result.ok && command.draft.id.startsWith('session:')) questionDeliveries?.request(command.draft.id.slice('session:'.length));
          return result.ok ? ok(result.draft) : { ...fail(envelope.id, "DRAFT_CONFLICT", "The draft changed elsewhere. Both versions were preserved."), currentDraft: result.currentDraft } as CommandResult;
        };
        return command.draft.attachments === undefined ? save() : attachments.withPrepared(command.draft.attachments, save);
      }
      case "session.create": {
        if (command.worktree && command.draft && store.getDraft(command.draft.id)?.environment !== undefined && command.environment === undefined)
          return fail(envelope.id, "ENVIRONMENT_PROTOCOL_REQUIRED", "Send the captured environment selection with this worktree draft. Its choices were preserved.");
        if (command.environment !== undefined) return environmentSessions.create({ ...envelope, command });
        const project = command.projectId ? store.getCataloguedProject(command.projectId) : undefined;
        if (command.projectId && !project) throw new Error("The selected project is not on this host.");
        if (command.worktree && (!project || command.cwd !== undefined)) throw new Error("A worktree must belong to the selected project.");
        const createdWorktree = command.worktree && project
          ? await workspaces.createSessionWorktree(project.id, `chat-${createHash("sha256").update(envelope.id).digest("hex")}`, command.worktree)
          : undefined;
        const cwd = createdWorktree?.path ?? project?.path ?? command.cwd ?? join(dataDirectory, "workspaces", crypto.randomUUID());
        try {
          assertWorkspaceAvailable(cwd);
          if (!project && !command.cwd) await mkdir(cwd, { recursive: true, mode: 0o700 });
          let sessionId: string | undefined;
          const handle = await runtime.create({ cwd, model: command.model, approvalOverride: command.approvalMode, interactions: true, onEvent: event => { if (sessionId) onRuntimeEvent(sessionId, event); } });
          sessionId = handle.id;
          handles.set(handle.id, Promise.resolve(handle));
          let browserReceipt;
          try { browserReceipt = await browserFirstSend.attach(envelope.id, command.draft, command.browserContinuation, handle); }
          catch (error) {
            if (isBrowserContinuationOutcomeUnknown(error)) {
              const now = Date.now();
              store.upsertSession({ id: handle.id, hostId: store.host.id, projectId: project?.id ?? null, cwd:handle.cwd, title:handle.title||"New conversation", status:"error", sessionFile:handle.sessionFile, model:handle.model, createdAt:Number.isFinite(handle.createdAt)?handle.createdAt:now, updatedAt:now, archived:false, error:errorMessage(error), approvalOverride:command.approvalMode });
              throw error;
            }
            handles.delete(handle.id); await handle.dispose(); throw error;
          }
          const now = Date.now();
          try {
            const session=store.upsertSession({ id: handle.id, hostId: store.host.id, projectId: project?.id ?? null,
            cwd: handle.cwd, title: handle.title || "New conversation", status: "idle", sessionFile: handle.sessionFile,
            model: handle.model, createdAt: Number.isFinite(handle.createdAt) ? handle.createdAt : now, updatedAt: now,
            archived: false, error: handle.modelFallbackMessage, approvalOverride: command.approvalMode });
            if(browserReceipt) store.recordBrowserContinuation({commandId:envelope.id,...browserReceipt});
            return ok(session);
          } catch (error) {
            await handle.dispose(); handles.delete(handle.id);
            if(browserReceipt) {
              const current=store.getSession(handle.id);
              if(current) store.upsertSession({...current,status:"error",error:"The browser handoff completed, but its durable receipt was not confirmed. Inspect this conversation and the original browser before retrying.",updatedAt:Date.now()});
              throw Object.assign(new Error(`The browser was handed to the new session, but its durable receipt was not confirmed. Inspect the original command before retrying. ${errorMessage(error)}`),{code:"OUTCOME_UNKNOWN"});
            }
            throw error;
          }
        } catch (error) {
          if (createdWorktree) throw Object.assign(new Error(`The worktree exists at ${createdWorktree.path}, but conversation creation did not return a receipt. Inspect it before creating another. ${errorMessage(error)}`), { code: 'OUTCOME_UNKNOWN' });
          throw error;
        }
      }
      case "session.rename": return ok(updateSession(command.sessionId, { title: command.title.trim() || "New conversation" }));
      case "session.archive": {
        goalContinuations?.cancel(command.sessionId);
        questionDeliveries?.cancel(command.sessionId);
        const session = updateSession(command.sessionId, { archived: command.archived });
        if (!command.archived) goalContinuations?.request(command.sessionId);
        if (!command.archived) questionDeliveries?.request(command.sessionId);
        return ok(session);
      }
      case "session.interrupt": {
        goalContinuations?.cancel(command.sessionId);
        questionDeliveries?.cancel(command.sessionId);
        const handle = await getHandle(command.sessionId);
        await handle.abort();
        return ok(updateSession(command.sessionId, { status: "interrupted", error: undefined }));
      }
      case 'session.question.answer': {
        const saved = store.getDraft(command.draft.id);
        if (command.draft.id !== `question:${command.sessionId}:${command.questionId}` || !saved || saved.revision !== command.draft.revision
          || saved.text !== detachedAnswerDraft(command.answers) || saved.attachments?.length || saved.selectedTextAttachments?.length || saved.wholeFileAttachments?.length) {
          return fail(envelope.id, 'DRAFT_CONFLICT', 'The question draft changed. Reload its preserved answers before submitting.');
        }
        const current = store.getSession(command.sessionId);
        if (!current || current.archived || !['idle', 'running'].includes(current.status)) return fail(envelope.id, 'QUESTION_NOT_AVAILABLE', 'The question is no longer available for this conversation.');
        questionDeliveries?.cancel(command.sessionId);
        const handle = await getHandle(command.sessionId);
        // Set the restart wake-up hint before native acceptance. OMP remains
        // authoritative if acceptance succeeds but our command receipt is lost.
        updateSession(command.sessionId, { questionDeliveryPending: true });
        let receipt;
        try { receipt = await handle.resolveQuestion({ questionId: command.questionId, questionEntryId: command.questionEntryId, commandId: envelope.id, answers: command.answers }); }
        finally { questionDeliveries?.request(command.sessionId); }
        notificationEvents.reconcileDetached(command.sessionId, await handle.listQuestions());
        publish({ type: 'interactions', sessionId: command.sessionId });
        return ok({ type: command.type, receipt });
      }
      case "session.steer": {
        if (command.wholeFileAttachments?.length) return fail(envelope.id, "WHOLE_FILE_STEER_UNSUPPORTED", "Whole-file steering is not connected yet. The draft was retained; wait for the turn to finish.");
        if (command.selectedTextAttachments?.length) return fail(envelope.id, "SELECTED_TEXT_STEER_UNSUPPORTED", "Selected-text steering is not connected yet. The draft was retained; stop the turn before sending its selections.");
        if (command.attachments?.length) return fail(envelope.id, "IMAGE_STEER_UNSUPPORTED", "Image steering is not supported yet. The draft was retained; stop the turn before sending its images.");
        const handle = await getHandle(command.sessionId);
        if (!executions.has(command.sessionId) || !handle.isStreaming) throw new Error("There is no running turn to steer.");
        if (command.approvalMode !== undefined) {
          const controls = await handle.getControls();
          const effective = controls.settings.find(setting => setting.path === "tools.approvalMode")?.effective;
          if (effective !== command.approvalMode) return fail(envelope.id, "PERMISSION_CHANGED", "The running turn uses a different native permission mode. Stop it before changing permissions; the draft was retained.");
        }
        let receipt;
        try { receipt = await handle.steer(command.text, command.approvalMode); }
        catch (error) {
          // A lost worker/RPC response cannot prove the native queue was never
          // consumed. Keep this command identity and its draft for reconciliation.
          return fail(envelope.id, "OUTCOME_UNKNOWN", `Steer admission could not be verified: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (receipt.kind === "not-recorded") return fail(envelope.id, "STEER_NOT_RECORDED", receipt.reason);
        if (receipt.kind === "outcome-unknown") return fail(envelope.id, "OUTCOME_UNKNOWN", receipt.reason);
        return ok(undefined, receipt);
      }
      case "session.force.cancel": {
        // Inspect/cancel only the original loaded worker; never load a replacement
        // session to recreate an already lost volatile directive.
        const handle = await handles.get(command.sessionId)?.catch(() => undefined);
        if (!handle || stopping) return fail(envelope.id, "FORCE_TOOL_UNAVAILABLE", "The original native worker is unavailable; its queue was not recreated.");
        return ok({ type: "session.force.cancel", ...await handle.cancelForceTool({ ticket: command.ticket, directiveId: command.directiveId }) });
      }
      case "session.prompt": {
        if (command.wholeFileAttachments?.some(file => file.source.hostId !== store.host.id)) return fail(envelope.id, "WHOLE_FILE_OWNER_MISMATCH", "Whole files must belong to this conversation’s host. Their references were preserved.");
        if (command.wholeFileAttachments?.length && (command.text.trimStart().startsWith("/") || command.text.includes("/skill:"))) return fail(envelope.id, "WHOLE_FILE_COMMAND_UNSUPPORTED", "Whole files are not connected to native commands or skills yet. No command was executed.");
        if (command.selectedTextAttachments?.length && command.text.trimStart().startsWith("/")) return fail(envelope.id, "SELECTED_TEXT_COMMAND_UNSUPPORTED", "Selected text is not connected to slash commands yet. No command was executed.");
        if (command.attachments?.length && command.text.trimStart().startsWith("/")) return fail(envelope.id, "IMAGE_COMMAND_UNSUPPORTED", "Image attachments are not supported on slash commands yet. No command was executed.");
        const prompt = async (images?: PreparedPromptImage[]) => {
        if (executions.has(command.sessionId)) throw new Error("This session is running. Steer or stop its current turn first.");
        // Recovery may inspect an existing volatile owner, never create a new
        // worker or authorize replacement text from a renderer-only receipt.
        const recoveryOwner = command.forceRecovery ? handles.get(command.sessionId) : undefined;
        const recoveryHandle = recoveryOwner ? await recoveryOwner : undefined;
        if (command.forceRecovery) {
          if (!recoveryHandle || stopping) throw new Error("The original force worker is unavailable; recovery did not recreate it.");
          const state = await recoveryHandle.getForceTool();
          if (handles.get(command.sessionId) !== recoveryOwner || stopping) throw new Error("The original force worker changed before recovery.");
          assertForceToolRecoveryCommand(command, state, id => store.getCommand(id));
        }
        if (command.approvalMode !== undefined) await applySessionApproval(command.sessionId, command.approvalMode);
        const treeOwner = command.treeTicket ? handles.get(command.sessionId) : undefined;
        const treeHandle = treeOwner ? await treeOwner : undefined;
        if (command.treeTicket && (!treeHandle || stopping || handles.get(command.sessionId) !== treeOwner))
          return fail(envelope.id, "TREE_REJECTED", "The original history owner is unavailable; the edit was retained.");
        const handle = treeHandle ?? recoveryHandle ?? await getHandle(command.sessionId);
        if (recoveryOwner && (handles.get(command.sessionId) !== recoveryOwner || stopping)) throw new Error("The original force worker changed during recovery setup.");
        if (command.text.startsWith("/")) {
          const intent = await handle.getExportIntent(command.text);
          if (intent) {
            if (command.forceTool || command.forceRecovery) throw new Error("The prepared command changed before export.");
            if (intent.guidance) return fail(envelope.id, "EXPORT_GUIDANCE", intent.guidance);
            const result = await sessionExports.export(envelope.id, command.sessionId, intent.theme, handle, command.text);
            return result.ok ? { ...result, admission: { kind: "native-command" as const, command: "export" } } : result;
          }
        }
        runtimeErrors.delete(command.sessionId);
        assertWorkspaceAvailable(handle.cwd);
        goalContinuations?.cancel(command.sessionId);
        const nativeTitleBefore = handle.title;
        updateSession(command.sessionId, { status: "running", error: undefined });
        const turn = handle.startPrompt(command.text, { commandId: envelope.id, commandVersion, goal: command.goal, treeTicket: command.treeTicket, forceTool: command.forceTool, forceRecovery: command.forceRecovery, model: command.model, thinkingLevel: command.thinkingLevel, ...(command.wholeFileAttachments === undefined ? {} : { wholeFiles: { submissionId: envelope.id, attachments: command.wholeFileAttachments } }), ...(command.selectedTextAttachments === undefined ? {} : { selectedText: { submissionId: envelope.id, attachments: command.selectedTextAttachments } }), ...(images === undefined ? {} : { images }) });
        let notificationOutcome: 'completed' | 'failed' | 'stopped' = 'failed';
        const completion = turn.completion.then(agentInvoked => {
          const error = runtimeErrors.get(command.sessionId);
          const current = store.getSession(command.sessionId);
          notificationOutcome = current?.status === 'interrupted' ? 'stopped' : error || !agentInvoked ? 'failed' : 'completed';
          if (current && !stopping) updateSession(command.sessionId, {
            model: handle.model, status: error ? "error" : current.status === "interrupted" ? "interrupted" : "idle", error,
          });
        }).catch(error => {
          notificationOutcome = store.getSession(command.sessionId)?.status === 'interrupted' ? 'stopped' : 'failed';
          if (!stopping) updateSession(command.sessionId, { status: "error", error: errorMessage(error) });
        }).finally(() => { if (executions.get(command.sessionId) === completion) executions.delete(command.sessionId); questionDeliveries?.request(command.sessionId); goalContinuations?.request(command.sessionId); });
        executions.set(command.sessionId, completion);
        const accepted = await turn.accepted;
        const forceToolReceipt = turn.forceToolReceipt === undefined ? undefined : parseForceToolReceipt(turn.forceToolReceipt, envelope.id);
        if (!accepted) { automationPromptCompletions.delete(envelope.id); return { ...fail(envelope.id, "PROMPT_NOT_RECORDED", "OMP neither recorded a user message nor completed a native command. The draft was retained; inspect its outcome before retrying."), ...(forceToolReceipt ? { forceToolReceipt } : {}) }; }
        if (automationCommands.has(envelope)) automationPromptCompletions.set(envelope.id,
          accepted.kind === "native-command" ? Promise.resolve("completed") : completion.then(() => notificationOutcome));
        const automationOwned = automationCommands.has(envelope);
        if (accepted.kind !== 'native-command') void completion.then(() => {
          if (!stopping && !automationOwned) notificationEvents.completion(command.sessionId, `completion:${command.sessionId}:command:${envelope.id}`, notificationOutcome);
        }).catch(() => {});
        goalContinuations?.explicitWork(command.sessionId);
        questionDeliveries?.request(command.sessionId);
        const current = store.getSession(command.sessionId)!;
        if (handle.title && handle.title !== nativeTitleBefore) updateSession(command.sessionId, { title: handle.title });
        else if (accepted.kind === "user-message" && current.title === "New conversation") updateSession(command.sessionId, { title: (command.text.trim().split("\n")[0] || command.attachments?.map(image => image.name).join(", ") || command.wholeFileAttachments?.map(file => file.source.path.split("/").at(-1)).join(", ") || (command.selectedTextAttachments?.length ? "Selected text conversation" : "Image conversation")).slice(0, 90) });
        return { ...ok(store.getSession(command.sessionId), accepted), ...(forceToolReceipt ? { forceToolReceipt } : {}) };
        };
        return command.attachments === undefined ? prompt() : attachments.withPrepared(command.attachments, prompt);
      }
    }
  }

  const followUpResult = (commandId: string, receipt: import("@agent-desktop/shared").QueuedSubmissionReceipt): CommandResult =>
    ({ ok: true, commandId, value: { type: "session.follow-up", receipt } });

  async function dispatchFollowUp(envelope: CommandEnvelope, requestHash: string): Promise<CommandResult> {
    const command = envelope.command;
    if (command.type !== "session.follow-up") throw new Error("Queued-submission dispatcher received another command.");
    const begun = store.beginQueuedSubmission(envelope.id, requestHash);
    if (begun.phase !== "admitting") return followUpResult(envelope.id, begun);
    const previous = followUpAdmissionTails.get(command.sessionId);
    const operation = (previous ?? Promise.resolve()).catch(() => {}).then(async (): Promise<CommandResult> => {
      const current = store.getQueuedSubmission(envelope.id);
      if (!current || current.phase !== "admitting") return followUpResult(envelope.id, current ?? begun);
      const settle = (update: Parameters<HostStore["advanceQueuedSubmission"]>[2]) => {
        const receipt = store.advanceQueuedSubmission(envelope.id, requestHash, update);
        publishState();
        return followUpResult(envelope.id, receipt);
      };
      const draft = store.getDraft(command.draft.id);
      if (!draft || draft.revision !== command.draft.revision || draft.text !== command.text
        || !sameImageAttachments(draft.attachments ?? [], command.attachments ?? []) || draft.wholeFileAttachments?.length || draft.selectedTextAttachments?.length)
        return settle({ phase: "settled", outcome: "not-recorded", message: "The captured follow-up draft changed before native admission." });
      const session = store.getSession(command.sessionId);
      if (!session || session.archived || session.status !== "running")
        return settle({ phase: "settled", outcome: "not-recorded", message: "There is no running conversation accepting this follow-up." });
      const admit = async (images?: import("./omp/images").PreparedPromptImage[]): Promise<CommandResult> => {
        let run: ReturnType<WorkerSession["startFollowUp"]>;
        try {
          const handle = await getHandle(command.sessionId);
          if (!executions.has(command.sessionId) || !handle.isStreaming)
            return settle({ phase: "settled", outcome: "not-recorded", message: "There is no running native turn accepting this follow-up." });
          run = handle.startFollowUp(command.text, command.delivery, command.approvalMode, images);
        } catch (error) {
          const unknown = error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN";
          return settle({ phase: "settled", outcome: unknown ? "unknown" : "not-recorded", message: errorMessage(error) });
        }
        const completion = run.completion.then(receipt => {
          if (receipt.kind === "user-message") return settle({ phase: "settled", outcome: "succeeded", entryId: receipt.entryId });
          return settle({ phase: "settled", outcome: receipt.kind === "not-recorded" ? "not-recorded" : "unknown", message: receipt.reason });
        }, error => settle({ phase: "settled", outcome: "unknown", message: `Native follow-up settlement could not be verified: ${errorMessage(error)}` }));
        void completion.catch(() => {});
        try {
          const accepted = await run.accepted;
          if (accepted.delivery !== command.delivery) return settle({ phase: "settled", outcome: "unknown", message: "Native follow-up acknowledged a different delivery lane." });
          const queued = store.advanceQueuedSubmission(envelope.id, requestHash, { phase: "queued" });
          publishState();
          return followUpResult(envelope.id, queued);
        } catch (error) {
          try { return await completion; }
          catch { return settle({ phase: "settled", outcome: "unknown", message: `Native follow-up admission could not be verified: ${errorMessage(error)}` }); }
        }
      };
      try { return await (command.attachments === undefined ? admit() : attachments.withPrepared(command.attachments, admit)); }
      catch (error) { return settle({ phase: "settled", outcome: "not-recorded", message: errorMessage(error) }); }
    });
    followUpAdmissionTails.set(command.sessionId, operation);
    const finish = () => { if (followUpAdmissionTails.get(command.sessionId) === operation) followUpAdmissionTails.delete(command.sessionId); };
    void operation.then(finish, finish);
    return operation;
  }

  async function dispatch(envelope: CommandEnvelope, commandVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 22 | 23 | 24 = 2): Promise<CommandResult> {
    if (stopping) return fail(envelope.id, "HOST_STOPPING", "The host is stopping; reconnect before sending.");
    const hash = createHash("sha256").update(JSON.stringify(envelope.command)).digest("hex");
    // Workspace contents are already owned by their files. Persist the receipt/hash,
    // not another full copy of each submitted editor buffer in the pending journal.
    const workspaceAction = envelope.command.type === "workspace.mutate" ? envelope.command.action : undefined;
    // Action references contain no script bodies. Retain their version gate and owner
    // so an older artifact cannot adopt a terminal with newer restart semantics.
    const durableFileOperation = workspaceAction && ["file.create", "directory.create", "path.rename", "path.delete"].includes(workspaceAction.type);
    const journalCommand = envelope.command.type === "skill.file.write" ? undefined : workspaceAction && !durableFileOperation && workspaceAction.type !== "environment.action" && workspaceAction.type !== "environment.select" && !workspaceAction.type.startsWith("git.submit") ? undefined : envelope.command;
    const claim = store.claimCommand(envelope.id, hash, journalCommand);
    if (claim.kind === "conflict") return fail(envelope.id, "COMMAND_ID_REUSED", "This command ID belongs to a different request.");
    if (claim.kind === "done") return claim.record.result!;
    if (claim.kind === "pending") {
      const active=commands.get(envelope.id);if(active)return active;
      const recovery=store.listBrowserRecoveries().find(record=>record.commandId===envelope.id);
      if(recovery&&envelope.command.type==="session.create"&&envelope.command.browserContinuation){
        const pending=recoverPendingBrowserCreation(recovery).catch(error=>fail(envelope.id,"OUTCOME_UNKNOWN",
          `The original browser session could not be reacquired. Inspect its retained recovery state before retrying. ${errorMessage(error)}`));
        commands.set(envelope.id,pending);void pending.finally(()=>{if(commands.get(envelope.id)===pending)commands.delete(envelope.id);});return pending;
      }
      return fail(envelope.id, "OUTCOME_UNKNOWN", "The original command has no confirmed durable receipt. Inspect its outcome before issuing a new command.");
    }
    const command = envelope.command;
    if ((command.type === "session.follow-up" || command.type === "session.steer" || command.type === "session.btw.start" || command.type === "session.question.answer")
      && command.draft && store.getDraft(command.draft.id)?.goal) {
      return store.finishCommand(envelope.id, hash, fail(envelope.id, "GOAL_COMPOSER_PROTOCOL_REQUIRED",
        "Clear Goal intent explicitly before queuing, steering, or sending it to a side conversation. The draft was retained.")).result!;
    }
    if (command.type === "session.follow-up") return dispatchFollowUp(envelope, hash);
    if (command.type === "workspace.mutate" && command.action.type === "git.submit") {
      // Publish the original receipt before waiting on the owner's command tail,
      // so queued work can be inspected and cancelled without starting Git.
      try { store.beginGitSubmission(envelope.id, hash); publish({ type: "workspace", target: command.target }); }
      catch (error) {
        const result = fail(envelope.id, "GIT_SUBMISSION_NOT_ADMITTED", errorMessage(error));
        return store.finishCommand(envelope.id, hash, result).result!;
      }
    }
    const key = command.type === "workspace.mutate" ? `workspace:${JSON.stringify(command.target)}` : command.type === "skill.file.write" || command.type === "skill.file.reveal" || command.type === "skill.file.open" ? `skill-file:${command.ref.sourcePath}` : "sessionId" in command ? command.sessionId : "$catalog";
    const interrupt = command.type === "session.interrupt" || command.type === "session.environment.cancel" || command.type === "workspace.mutate" && (command.action.type === "git.submit.cancel" || command.action.type === "git.submit.acknowledge");
    const previous = interrupt ? undefined : sessionTails.get(key);
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
      let result: CommandResult;
      try { result = await execute(envelope, commandVersion); }
      catch (error) { result = checkoutRefusalResult(envelope.id, command, error) ?? fail(envelope.id, error instanceof AttachmentRequestError || error instanceof AttachmentImageError ? error.code
        : command.type === "preferences.keymap.mutate" && (error instanceof PreferenceError || error instanceof KeybindingError) ? error.code
        : error instanceof SessionForkError ? error.code
        : error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "COMMAND_FAILED", errorMessage(error));
        const forceToolReceipt = command.type === "session.prompt" ? forceToolReceiptFromError(error, envelope.id) : undefined;
        if (forceToolReceipt) result = { ...result, forceToolReceipt };
      }
      let completed;
      try { completed = store.finishCommand(envelope.id, hash, result); }
      catch (error) {
        return { ...fail(envelope.id, "OUTCOME_UNKNOWN", `The command completed but its durable receipt could not be recorded. Inspect the original command before retrying. ${errorMessage(error)}`),
          ...(result.forceToolReceipt ? { forceToolReceipt: result.forceToolReceipt } : {}) };
      }
      publishState();
      // A handler can atomically commit its successful receipt with native binding.
      // A later notification error cannot replace that already-durable outcome.
      return completed.result!;
    });
    commands.set(envelope.id, pending);
    if (!interrupt) sessionTails.set(key, pending);
    const finish = () => {
      commands.delete(envelope.id);
      if (sessionTails.get(key) === pending) sessionTails.delete(key);
    };
    void pending.then(finish, finish);
    return pending;
  }

  function authorized(request: Request, websocket = false): boolean {
    if (request.headers.has("origin")) return false; // Only the privileged desktop process calls this local endpoint.
    const candidate = websocket ? request.headers.get("sec-websocket-protocol")?.split(",").map(part => part.trim())[1]
      : (/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1]);
    if (!candidate || !/^[a-f0-9]{64}$/.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
  }

  function createServer(hostname: string, port: number, remote = false) {
  return Bun.serve<SocketData>({
    hostname, port, maxRequestBodySize: 24 * 1024 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      const websocket = url.pathname === "/v1/events";
      const remoteAddress = remote ? server.requestIP(request)?.address : undefined;
      const nodeId = remote && !request.headers.has("origin") && remoteAddress
        ? await network!.authenticate(remoteAddress).catch(() => undefined) : undefined;
      const verified = remote ? nodeId !== undefined : authorized(request, websocket);
      if (!verified) return Response.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const deviceAccessResponse = await deviceAccess.route(request, remote);
        if (deviceAccessResponse) return deviceAccessResponse;
        if (remote && (!nodeId || !network!.allows(nodeId))) return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (request.method === "GET" && url.pathname === "/v1/health") return Response.json({ hostId: store.host.id, host: store.host, protocolVersion: 1, preferencesSyncVersion: 3 });
        if (websocket) {
          const after = Number(url.searchParams.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid event cursor.");
          return server.upgrade(request, { data: { after, remoteAddress, nodeId }, headers: { "Sec-WebSocket-Protocol": "agent-desktop" } })
            ? undefined : Response.json({ error: "WebSocket upgrade required" }, { status: 400 });
        }
        if (!remote && request.method === "GET" && url.pathname === "/v1/peers") {
          if (network) await refreshNetwork();
          return Response.json(network ? network.state : { status: "unavailable", error: "Tailscale discovery is disabled for this host.", hosts: [], checkedAt: Date.now() });
        }
        if (url.pathname === "/v1/sessions/search") {
          const headers = { "Cache-Control": "no-store", [SESSION_SEARCH_OWNER_HEADER]: store.host.id };
          if (request.headers.get(SESSION_SEARCH_OWNER_HEADER) !== store.host.id) return Response.json({ error: { code: "OWNER_MISMATCH", message: "The chat search owner changed." } }, { status: 409, headers });
          if (request.method !== "GET") return Response.json({ error: { code: "INVALID_REQUEST", message: "Chat search is read-only." } }, { status: 405, headers });
          try {
            const content = url.searchParams.get("content");
            const result = await sessionSearch.search({ query: url.searchParams.get("query"), includeContent: content === "true" ? true : content === "false" ? false : undefined, limit: Number(url.searchParams.get("limit")) }, request.signal);
            return Response.json(result, { headers });
          } catch (cause) {
            return Response.json({ error: { code: cause instanceof SessionSearchError ? cause.code : "INVALID_REQUEST", message: cause instanceof Error ? cause.message : "Chat search failed." } }, { status: cause instanceof SessionSearchError && cause.code === "SEARCH_BUSY" ? 429 : 400, headers });
          }
        }
        if (request.method === "GET" && url.pathname === "/v1/state") return Response.json(snapshot());
        if (request.method === "GET" && url.pathname === "/v1/preferences") return Response.json(preferences!.snapshot(), { headers: { "Cache-Control": "no-store" } });
        if (request.method === "GET" && url.pathname === "/v2/preferences") return Response.json(preferences!.snapshotV2(), { headers: { "Cache-Control": "no-store" } });
        if (url.pathname === "/v1/theme") {
          if (request.method === "GET") return Response.json(await theme!.refresh(), { headers: { "Cache-Control": "no-store" } });
          if (request.method === "POST") {
            const raw = await request.text();
            if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("The theme document exceeds 256 KiB.");
            const input = JSON.parse(raw) as { document: unknown; expectedRevision: string };
            if (!input || typeof input !== "object" || Object.keys(input).some(key => !["document", "expectedRevision"].includes(key))) throw new Error("Invalid theme update.");
            try { return Response.json(await theme!.set(input.document, input.expectedRevision), { headers: { "Cache-Control": "no-store" } }); }
            catch (error) { if (error instanceof ThemeConflictError) return Response.json({ error: error.message }, { status: 409 }); throw error; }
          }
        }
        if (request.method === "POST" && url.pathname === "/v1/preferences/merge") return Response.json(preferences!.merge(await request.json()), { headers: { "Cache-Control": "no-store" } });
        if (request.method === "POST" && (url.pathname === "/v2/preferences/merge" || url.pathname === "/v3/preferences/merge")) return Response.json(preferences!.mergeV2(await request.json()), { headers: { "Cache-Control": "no-store" } });
        const themeAssetResponse = await themeAssets!.handle(request);
        if (themeAssetResponse) return themeAssetResponse;
        const attachmentResponse = await attachments.handle(request);
        if (attachmentResponse) return attachmentResponse;
        const accountResponse = await accounts!.route(request, url);
        if (accountResponse) return accountResponse;
        const composerResponse = await composerActions.route(request, url);
        if (composerResponse) return composerResponse;
        const extensionUiResponse = await extensionUi.route(request, url);
        if (extensionUiResponse) return extensionUiResponse;
        const activityResponse = await sessionActivity.route(request, url);
        if (activityResponse) return activityResponse;
        const processesResponse = await sessionProcesses!.route(request, url);
        if (processesResponse) return processesResponse;
        const jobsResponse = await sessionJobs.route(request, url);
        if (jobsResponse) return jobsResponse;
        const subagentsResponse = await sessionSubagents.route(request, url);
        if (subagentsResponse) return subagentsResponse;
        const queuedMessagesResponse = await queuedMessages.route(request, url);
        if (queuedMessagesResponse) return queuedMessagesResponse;
        const pullRequestsResponse = await pullRequestsHttp.route(request, url);
        if (pullRequestsResponse) return pullRequestsResponse;
        const automationsResponse = await automationsHttp.route(request, url);
        if (automationsResponse) return automationsResponse;
        const mcpAuthorizationResponse = await sessionMcpAuthorization.route(request, url);
        if (mcpAuthorizationResponse) return mcpAuthorizationResponse;
        const mcpOwnerResponse = await mcpOwners!.route(request, url);
        if (mcpOwnerResponse) return mcpOwnerResponse;
        const mcpAppResponse = await sessionMcpApps.route(request, url);
        if (mcpAppResponse) return mcpAppResponse;
        const mcpResourceResponse = await sessionMcpResources.route(request, url);
        if (mcpResourceResponse) return mcpResourceResponse;
        const htmlResponse = await htmlPreviews.route(request, url);
        if (htmlResponse) return htmlResponse;
        const outputsResponse = await sessionOutputs.route(request, url);
        if (outputsResponse) return outputsResponse;
        const turnReviewResponse = await turnReview.route(request, url);
        if (turnReviewResponse) return turnReviewResponse;
        const editorRoute = /^\/v1\/sessions\/([^/]+)\/plan\/editor\/(capabilities|list|start|status|cancel|recovery)$/.exec(url.pathname);
        if (editorRoute) {
          if (!planExternalEditorHttp) return Response.json({ error: { code: "NATIVE_TERMINAL_BUNDLE_MISSING",
            message: "The owning host needs its pinned native terminal bundle to run the configured editor." } },
            { status: 503, headers: { "Cache-Control": "no-store", [SESSION_PLAN_OWNER_HEADER]: store.host.id } });
          return planExternalEditorHttp.route(request, editorRoute[1]!, editorRoute[2] as PlanExternalEditorHttpAction);
        }
        const todoEditorRoute = /^\/v1\/sessions\/([^/]+)\/todos\/editor\/(capabilities|list|start|status|cancel|recovery)$/.exec(url.pathname);
        if (todoEditorRoute) {
          if (!todoExternalEditorHttp) return Response.json({ error: { code: "NATIVE_TERMINAL_BUNDLE_MISSING",
            message: "The owning host needs its pinned native terminal bundle to run the configured editor." } },
            { status: 503, headers: { "Cache-Control": "no-store", [SESSION_TODOS_OWNER_HEADER]: store.host.id } });
          return todoExternalEditorHttp.route(request, todoEditorRoute[1]!, todoEditorRoute[2] as TodoExternalEditorHttpAction);
        }
        const treeResponse = await sessionTreeHttp.route(request, url);
        if (treeResponse) return treeResponse;
        const todosResponse = await sessionTodosHttp.route(request, url);
        if (todosResponse) return todosResponse;
        const usageResponse = await sessionUsageHttp.route(request, url);
        if (usageResponse) return usageResponse;
        const planResponse = await sessionPlanHttp.route(request, url);
        if (planResponse) return planResponse;
        const exportResponse = await sessionExportHttp.route(request, url);
        if (exportResponse) return exportResponse;
        const forceToolResponse = await forceToolHttp.route(request, url);
        if (forceToolResponse) return forceToolResponse;
        const mcpStateResponse = await sessionMcpHttp.route(request, url);
        if (mcpStateResponse) return mcpStateResponse;
        const btwResponse = await btwHttp.route(request, url);
        if (btwResponse) return btwResponse;
        const goalControlResponse = await goalControls.route(request, url);
        if (goalControlResponse) return goalControlResponse;
        const browserMetadataResponse = await browserMetadata.route(request, url);
        if (browserMetadataResponse) return browserMetadataResponse;
        const browserObservationResponse = await browserObservations!.route(request, url);
        if (browserObservationResponse) return browserObservationResponse;
        const browserCreateResponse = await browserCreate.route(request, url);
        if (browserCreateResponse) return browserCreateResponse;
        const draftBrowserResponse = await draftBrowsers!.route(request, url);
        if (draftBrowserResponse) return draftBrowserResponse;
        const browserCloseResponse = await browserClose.route(request, url);
        if (browserCloseResponse) return browserCloseResponse;
        const browserControlResponse = await browserControls.route(request, url);
        if (browserControlResponse) return browserControlResponse;
        const browserHistoryResponse = await browserHistory!.route(request, url);
        if (browserHistoryResponse) return browserHistoryResponse;
        const browserAutocompleteResponse = await browserAutocomplete!.route(request, url);
        if (browserAutocompleteResponse) return browserAutocompleteResponse;
        const browserFrameResponse = await browserFrames.route(request, url);
        if (browserFrameResponse) return browserFrameResponse;
        const acquisitionResponse = await acquisitions!.route(request,url);
        if(acquisitionResponse)return acquisitionResponse;
        const integrationsResponse = await integrations!.route(request, url);
        if (integrationsResponse) return integrationsResponse;
        const settingsResponse = await settings!.route(request, url);
        if (settingsResponse) return settingsResponse;
        const terminalResponse = await terminalsHttp!.handle(request);
        if (terminalResponse) { terminalResponse.headers.set("Cache-Control", "no-store"); return terminalResponse; }
        if (url.pathname.startsWith("/v2/terminals/")) {
          if (!nativeTerminalsHttp) return Response.json({ error: { code: "NATIVE_TERMINAL_BUNDLE_MISSING", message: "The pinned native terminal bundle is missing from this host. Build or reinstall its native runtime." } }, { status: 503, headers: { "Cache-Control": "no-store", [WORKSPACE_OWNER_HEADER]: store.host.id } });
          const creationResponse = await terminalCreationHttp?.handle(request);
          if (creationResponse) return creationResponse;
          const nativeResponse = await nativeTerminalsHttp.handle(request);
          if (nativeResponse) { nativeResponse.headers.set("Cache-Control", "no-store"); return nativeResponse; }
        }
        if (request.method === "POST" && url.pathname === "/v1/workspace/query") {
          const input = await request.json() as { target?: unknown; query?: unknown };
          const copyRequest = Boolean(input?.query && typeof input.query === "object" && !Array.isArray(input.query)
            && ["file.copy-info", "file.copy-chunk"].includes(String((input.query as { type?: unknown }).type)));
          if (copyRequest) {
            const headers = { "Cache-Control": "no-store", [WORKSPACE_OWNER_HEADER]: store.host.id };
            if (request.headers.get(WORKSPACE_OWNER_HEADER) !== store.host.id) return Response.json({ error: { code: "OWNER_MISMATCH", message: "The file owner no longer matches this host." } }, { status: 409, headers });
            try {
              const target = parseWorkspaceTarget(input?.target), query = parseWorkspaceQuery(input?.query);
              return Response.json(await workspaces.query(target, query), { headers });
            }
            catch (error) { return Response.json({ error: errorMessage(error) }, { status: 400, headers }); }
          }
          const target = parseWorkspaceTarget(input?.target), query = parseWorkspaceQuery(input?.query);
          return Response.json(await workspaces.query(target, query), { headers: { "Cache-Control": "no-store" } });
        }
        const questionsPath = /^\/v1\/sessions\/([^/]+)\/questions$/.exec(url.pathname);
        if (questionsPath) {
          const headers = { 'Cache-Control': 'no-store', [SESSION_ACTIVITY_OWNER_HEADER]: store.host.id };
          if (request.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== store.host.id) return Response.json({ error: { code: 'OWNER_MISMATCH', message: 'The question owner no longer matches this host.' } }, { status: 409, headers });
          if (request.method !== 'GET') return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Use the ordered command endpoint to answer questions.' } }, { status: 405, headers });
          const id = decodeURIComponent(questionsPath[1]!);
          if (!id || id.length > 200 || id.includes('\0') || !store.getSession(id)) return Response.json({ error: { code: 'SESSION_NOT_FOUND', message: 'This conversation is not on this host.' } }, { status: 404, headers });
          const questions = await (async () => {
            const handle = await getHandle(id), questions = await handle.listQuestions();
            if (!stopping && await handles.get(id)?.catch(() => undefined) === handle) {
              let changed = false;
              for (const question of questions) if (question.acceptance && !commands.has(question.acceptance.commandId)) changed = store.reconcileQuestionAcceptance(id, question) || changed;
              if (changed) publishState();
            }
            notificationEvents.reconcileDetached(id, questions);
            return questions;
          })();
          return Response.json({ protocolVersion: 1, hostId: store.host.id, sessionId: id, questions }, { headers });
        }
        const interactionPath = /^\/v1\/sessions\/([^/]+)\/interactions$/.exec(url.pathname);
        if (interactionPath) {
          const handle = await getHandle(decodeURIComponent(interactionPath[1]!));
          if (request.method === "GET") return Response.json(await handle.listInteractions(), { headers: { "Cache-Control": "no-store" } });
          if (request.method === "POST") {
            const answer = parseInteractionAnswer(await request.json());
            try { await handle.respondInteraction(answer.interactionId, answer.response); }
            catch { return Response.json({ error: "The interaction is no longer pending or the response is not valid. Refresh its current state before retrying." }, { status: 409 }); }
            return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
          }
        }
        const forkPath = /^\/v1\/sessions\/([^/]+)\/fork-destinations$/.exec(url.pathname);
        if (forkPath) {
          if (request.method !== "GET") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use the ordered Fork command endpoint." } }, { status: 405 });
          return Response.json(await sessionForks.get(decodeURIComponent(forkPath[1]!)), { headers: { "Cache-Control": "no-store" } });
        }
        const taskLocationPath = /^\/v1\/sessions\/([^/]+)\/task-location$/.exec(url.pathname);
        if (taskLocationPath) {
          if (request.method !== "GET") return Response.json({error:{code:"METHOD_NOT_ALLOWED",message:"Use the ordered command endpoint to move a task."}},{status:405,headers:{"Cache-Control":"no-store"}});
          return Response.json(await taskLocations.get(decodeURIComponent(taskLocationPath[1]!)),{headers:{"Cache-Control":"no-store"}});
        }
        const preparationPath = /^\/v5\/environment-preparations\/([^/]+)$/.exec(url.pathname);
        if (request.method === 'GET' && preparationPath) {
          const record = store.environmentPreparations.get(decodeURIComponent(preparationPath[1]!));
          if (!record) return Response.json({ error: 'Preparation not found' }, { status: 404 });
          return Response.json(store.environmentPreparations.public(record), { headers: { 'Cache-Control': 'no-store' } });
        }
        if (request.method === "POST" && url.pathname === "/v24/commands") {
          const value = await request.json();
          return Response.json(await dispatch(parseCommandEnvelope(value, 24), 24));
        }
        if (request.method === "POST" && url.pathname === "/v23/commands") {
          const value = await request.json();
          return Response.json(await dispatch(parseCommandEnvelope(value, 23), 23));
        }
        if (request.method === "POST" && url.pathname === "/v22/commands") {
          const value = await request.json();
          return Response.json(await dispatch(parseCommandEnvelope(value, 22), 22));
        }
        if (request.method === "POST" && ["/v1/commands", "/v2/commands", "/v3/commands", "/v4/commands", "/v5/commands", "/v6/commands", "/v7/commands", "/v8/commands", "/v9/commands", "/v10/commands", "/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands", "/v20/commands"].includes(url.pathname)) {
          const value = await request.json();
          const usageHeaders = usageCommandHeaders(request, url.pathname, value, store.host.id);
          if (usageHeaders instanceof Response) return usageHeaders;
          const documentMutation = value?.command?.type === "session.plan.mutate" && value?.command?.mutation?.action === "document";
          if (documentMutation && (value?.commandVersion !== 20 || url.pathname !== "/v20/commands"))
            return Response.json({ code: "PLAN_DOCUMENT_PROTOCOL_REQUIRED", error: "Native Plan document changes require command version 20 and /v20/commands. This request was not accepted." }, { status: 422 });
          if (url.pathname !== "/v20/commands") {
          if (url.pathname !== "/v19/commands" && (value?.commandVersion === 19
            || value?.command?.type === "session.plan.control" || value?.command?.type === "session.plan.mutate"
            || value?.command?.type === "session.plan.execution.retry"))
            return Response.json({ code: "PLAN_PROTOCOL_REQUIRED", error: "Plan decisions require /v19/commands. This request was not accepted." }, { status: 422 });
          if (url.pathname !== "/v18/commands" && (value?.commandVersion === 18 || value?.command?.type === "session.force.cancel"
            || Object.hasOwn(value?.command ?? {}, "forceTool") || Object.hasOwn(value?.command ?? {}, "forceRecovery")))
            return Response.json({ code: "FORCE_TOOL_PROTOCOL_REQUIRED", error: "Force-tool intent requires /v18/commands. This request was not accepted." }, { status: 422 });
          if (!["/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 16 || hasSessionForkIntent(value?.command)))
            return Response.json({ code: "FORK_PROTOCOL_REQUIRED", error: "Fork requires /v16/commands. This request was not accepted." }, { status: 422 });
          if (!["/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 17 || value?.command?.type === "session.follow-up" && Object.hasOwn(value.command,"attachments"))) return Response.json({code:"FOLLOW_UP_IMAGES_PROTOCOL_REQUIRED",error:"Active-turn images require /v17/commands. This request was not accepted."},{status:422});
          if (!["/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 15 || value?.command?.browserContinuation !== undefined)) return Response.json({code:"BROWSER_CONTINUATION_PROTOCOL_REQUIRED",error:"Browser continuation requires /v15/commands. This request was not accepted."},{status:422});
          if (!["/v14/commands","/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 14 || value?.command?.type === "session.location.move" || value?.command?.type === "session.location.resume")) return Response.json({code:"TASK_LOCATION_PROTOCOL_REQUIRED",error:"Task location changes require /v14/commands. This request was not accepted."},{status:422});
          if (!["/v13/commands","/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 13 || value?.command?.type === "session.follow-up")) return Response.json({ code: "FOLLOW_UP_PROTOCOL_REQUIRED", error: "Active-turn follow-ups require /v13/commands. This request was not accepted." }, { status: 422 });
          if (!["/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 12 || hasRemoteWorktreeIntent(value?.command))) return Response.json({ code: "REMOTE_WORKTREE_PROTOCOL_REQUIRED", error: "Remote worktree starting refs require /v12/commands. This request was not accepted." }, { status: 422 });
          if (!["/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 11 || value?.command?.type === "preferences.keymap.mutate")) return Response.json({ code: "KEYBINDINGS_PROTOCOL_REQUIRED", error: "Keyboard shortcut changes require /v11/commands. This request was not accepted." }, { status: 422 });
          if (!["/v10/commands", "/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 10 || value?.command?.type === "workspace.mutate" && String(value?.command?.action?.type).startsWith("git.submit"))) return Response.json({ code: "GIT_SUBMISSION_PROTOCOL_REQUIRED", error: "Git submissions require /v10/commands. This request was not accepted." }, { status: 422 });
          if(!["/v9/commands", "/v10/commands", "/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname)&&(value?.commandVersion===9||hasRepeatedWholeFileIntent(value?.command)))return Response.json({code:"REPEATED_WHOLE_FILE_PROTOCOL_REQUIRED",error:"Repeated inline file mentions require /v9/commands. This request was not accepted."},{status:422});
          if(!["/v8/commands","/v9/commands", "/v10/commands", "/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname)&&(value?.commandVersion===8||hasInlineFileIntent(value?.command)))return Response.json({code:"INLINE_FILE_PROTOCOL_REQUIRED",error:"Inline file positions require /v8/commands. This request was not accepted."},{status:422});
          if (!["/v7/commands","/v8/commands","/v9/commands", "/v10/commands", "/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 7 || hasWholeFileIntent(value?.command))) return Response.json({ code: "WHOLE_FILE_PROTOCOL_REQUIRED", error: "Whole files require /v7/commands. This request was not accepted." }, { status: 422 });
          if (!["/v6/commands", "/v7/commands", "/v8/commands", "/v9/commands", "/v10/commands", "/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 6 || hasSelectedTextIntent(value?.command))) return Response.json({ code: "SELECTED_TEXT_PROTOCOL_REQUIRED", error: "Selected text requires /v6/commands. This request was not accepted." }, { status: 422 });
          if (!["/v5/commands", "/v6/commands", "/v7/commands", "/v8/commands", "/v9/commands", "/v10/commands", "/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 5 || hasEnvironmentIntent(value?.command))) return Response.json({ code: "ENVIRONMENT_PROTOCOL_REQUIRED", error: "Environment intent requires /v5/commands. This request was not accepted." }, { status: 422 });
          if (!["/v4/commands", "/v5/commands", "/v6/commands", "/v7/commands", "/v8/commands", "/v9/commands", "/v10/commands", "/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && (value?.commandVersion === 4 || hasNewChatIntent(value?.command))) return Response.json({ code: "NEW_CHAT_PROTOCOL_REQUIRED", error: "Worktree intent requires /v4/commands. This request was not accepted." }, { status: 422 });
          if (!["/v3/commands", "/v4/commands", "/v5/commands", "/v6/commands", "/v7/commands", "/v8/commands", "/v9/commands", "/v10/commands", "/v11/commands", "/v12/commands", "/v13/commands", "/v14/commands", "/v15/commands", "/v16/commands", "/v17/commands", "/v18/commands", "/v19/commands"].includes(url.pathname) && hasAttachmentIntent(value?.command)) return Response.json({ code: "ATTACHMENT_PROTOCOL_REQUIRED", error: "Image attachment intent requires /v3/commands. This request was not accepted." }, { status: 422 });
          }
          if (url.pathname === "/v1/commands" && hasApprovalIntent(value?.command)) return Response.json({ code: "PERMISSION_PROTOCOL_REQUIRED", error: "Native permission intent requires /v2/commands." }, { status: 422 });
          const commandVersion = url.pathname === "/v20/commands" ? 20 : url.pathname === "/v19/commands" ? 19 : url.pathname === "/v18/commands" ? 18 : url.pathname === "/v17/commands" ? 17 : url.pathname === "/v16/commands" ? 16 : url.pathname === "/v15/commands" ? 15 : url.pathname === "/v14/commands" ? 14 : url.pathname === "/v13/commands" ? 13 : url.pathname === "/v12/commands" ? 12 : url.pathname === "/v11/commands" ? 11 : url.pathname === "/v10/commands" ? 10 : url.pathname === "/v9/commands" ? 9 : url.pathname === "/v8/commands" ? 8 : url.pathname === "/v7/commands" ? 7 : url.pathname === "/v6/commands" ? 6 : url.pathname === "/v5/commands" ? 5 : url.pathname === "/v4/commands" ? 4 : url.pathname === "/v3/commands" ? 3 : url.pathname === "/v2/commands" ? 2 : 1;
          return Response.json(await dispatch(parseCommandEnvelope(value, commandVersion), commandVersion), { headers: usageHeaders });
        }
        const messagePath = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
        if (request.method === "GET" && messagePath) return Response.json(await (await getHandle(decodeURIComponent(messagePath[1]!))).getMessages());
        return Response.json({ error: "Not found" }, { status: 404 });
      } catch (error) { return Response.json({ error: errorMessage(error) }, { status: 400 }); }
    },
    websocket: {
      open(peer) {
        // Upgrade and open can straddle a policy update. Do not send a replay to a revoked device.
        if (peer.data.remoteAddress && (!peer.data.nodeId || !network!.allows(peer.data.nodeId))) { peer.close(1008, "Device authorization changed"); return; }
        let cursor = peer.data.after;
        // Large gaps resume from the fresh catalog + native transcript, keeping reconnect buffers bounded.
        if (store.lastEventSequence - cursor <= 500) {
          for (const event of store.eventsAfter(cursor, 500)) {
            const payload = JSON.stringify(event);
            if (peer.getBufferedAmount() + Buffer.byteLength(payload) > 8 * 1024 * 1024) break;
            peer.send(payload);
          }
        }
        peers.add(peer);
        const watches = new RepositoryWatchPeer({
          hostId: store.host.id,
          isCurrent: () => !stopping && peers.has(peer) && (!peer.data.remoteAddress || Boolean(peer.data.nodeId && network!.allows(peer.data.nodeId))),
          retain: (target, signal) => workspaces.retainRepositoryWatch(target, signal),
          send: status => {
            const payload = JSON.stringify(status);
            if (peer.getBufferedAmount() + Buffer.byteLength(payload) > 8 * 1024 * 1024) throw new Error("Repository watch event buffer is full.");
            if (peer.send(payload) === 0) throw new Error("Repository watch socket is closed.");
          },
          close: reason => closePeer(peer, 1008, reason),
        });
        peer.data.repositoryWatches = watches; repositoryWatchPeers.add(watches);
        const queries = new BranchQueryPeer({
          hostId: store.host.id,
          isCurrent: () => !stopping && peers.has(peer) && (!peer.data.remoteAddress || Boolean(peer.data.nodeId && network!.allows(peer.data.nodeId))),
          subscribe: (target, query, signal, emit) => workspaces.subscribeBranchQuery(target, query, signal, emit, !peer.data.remoteAddress),
          send: update => {
            const payload = JSON.stringify(update);
            if (Buffer.byteLength(payload) > 512 * 1024 || peer.getBufferedAmount() + Buffer.byteLength(payload) > 8 * 1024 * 1024) throw new Error("Branch query result buffer is full.");
            if (peer.send(payload) === 0) throw new Error("Branch query socket is closed.");
          },
          close: reason => closePeer(peer, 1008, reason),
        });
        peer.data.branchQueries = queries; repositoryWatchPeers.add(queries);
        peer.send(JSON.stringify({ sequence: store.lastEventSequence, type: "state", state: snapshot(), replayComplete: true } satisfies HostEvent));
      },
      message(peer, data) {
        if (typeof data !== "string" || Buffer.byteLength(data) > 1024) { closePeer(peer, 1008, "Subscription messages must be bounded text."); return; }
        let type: unknown;
        try { type = JSON.parse(data)?.type; } catch { closePeer(peer, 1008, "Invalid subscription message."); return; }
        if (type === "repository-watch" && peer.data.repositoryWatches) peer.data.repositoryWatches.receive(data);
        else if (type === "branch-query" && peer.data.branchQueries) peer.data.branchQueries.receive(data);
        else closePeer(peer, 1008, "Unsupported subscription message.");
      },
      close(peer) { peers.delete(peer); retireRepositoryWatchPeer(peer); },
      maxPayloadLength: 1024,
    },
  });
  }
  await workspaces.reconcileWorktreeRemovals();
  server = createServer("127.0.0.1", options.port ?? 0);
  function refreshNetwork(): Promise<void> {
    if (!network || stopping) return Promise.resolve();
    if (networkCall) return networkCall;
    networkCall = (async () => {
      const state = await network.refresh();
      if (stopping) return;
      if (!state.listenAddress || tailServer?.hostname !== state.listenAddress) {
        tailServer?.stop(true); tailServer = undefined;
        if (state.listenAddress) {
          try { tailServer = createServer(state.listenAddress, TAILNET_PORT, true); }
          catch (error) { network.state = { ...state, status: "unavailable", error: `Cannot listen on Tailscale: ${errorMessage(error)}` }; }
        }
      }
      for (const peer of peers) {
        if (peer.data.remoteAddress && !await network.verify(peer.data.remoteAddress).catch(() => false)) closePeer(peer, 1008, "Device authorization changed");
      }
      preferencePeers = state.hosts.flatMap(peer => peer.availability === "available" && peer.host && peer.origin && peer.host.id !== store.host.id
        ? [{ hostId: peer.host.id, origin: peer.origin, ...(peer.preferencesSyncVersion === 2 || peer.preferencesSyncVersion === 3 ? { preferencesSyncVersion: peer.preferencesSyncVersion } : {}) }] : []);
      void preferences!.sync(preferencePeers);
      syncThemeAsset();
    })().finally(() => { networkCall = undefined; });
    return networkCall;
  }
  if (network) {
    void refreshNetwork();
    networkTimer = setInterval(() => { void refreshNetwork(); }, 15_000);
  }
  // Reopen only sessions with a previously durable unanswered question. The
  // native journal confirms whether each notice is still open before clients
  // can observe it in the startup snapshot.
  await Promise.allSettled(notificationEvents.recoverySessionIds().map(async id => {
    const session = store.getSession(id);
    if (!session || session.archived) notificationEvents.reconcileDetached(id, []);
    else await getHandle(id);
  }));
  const connection: LocalConnection = { origin: `http://127.0.0.1:${server.port}`, token, pid: process.pid, hostId: store.host.id, protocolVersion: 1 };
  await Bun.write(temporary, JSON.stringify(connection));
  await chmod(temporary, 0o600);
  await rename(temporary, join(dataDirectory, "connection.json"));
  publishedConnection = true;
  for (const session of store.listSessions()) if (session.goalContinuation && !session.goalContinuation.blocked && session.status === 'idle' && !session.archived) goalContinuations.request(session.id);
  for (const session of store.listSessions()) if (session.questionDeliveryPending) questionDeliveries.request(session.id);
  const discovery = runtime.listModels(options.discoveryDirectory ?? homedir()).then(value => { models = value; }).catch(error => { modelsError = errorMessage(error); })
    .finally(() => { modelsLoading = false; if (!stopping) publishState(); });

  let stopCall: Promise<void> | undefined;
  let stopPreparation: Promise<{
    configurationErrors: unknown[];
    processDrain?: Promise<void>;
    pullRequestsDrain?: Promise<void>; terminalCreationDrain?: Promise<void>; mcpOwnerDrain: Promise<void>;
    browserCloseDrain?: Promise<void>; browserObservationDrain?: Promise<void>; browserHistoryDrain?: Promise<void>;
    browserAutocompleteDrain?: Promise<void>; draftBrowserDrain?: Promise<void>;
    planEditorDrain?: Promise<void>; todoEditorDrain?: Promise<void>;
  }> | undefined;
  let stopCleanup: Promise<unknown[]> | undefined;
  let stopCompleted = false;
  let finalExitRequested = false;
  function stop(options: { finalExit?: boolean } = {}): Promise<void> {
    if (options.finalExit) finalExitRequested = true;
    if (stopCall) return stopCall;
    if (stopCompleted) return Promise.resolve();
    const attempt = Promise.withResolvers<void>();
    stopCall = attempt.promise;
    void (async () => {
      if (!stopPreparation) stopPreparation = (async () => {
        stopping = true;
        nativeResetPolicy!.beginDispose();
        environmentAbort.abort();
        goalContinuations?.stop();
        questionDeliveries?.stop();
        clearInterval(networkTimer);
        server!.stop(true); tailServer?.stop(true);
        terminalsHttp!.dispose();
        nativeTerminalsHttp?.dispose();
        const processDrain = sessionProcesses?.dispose();
        void processDrain?.catch(() => {});
        const planEditorDrain = planExternalEditors?.dispose();
        const todoEditorDrain = todoExternalEditors?.dispose();
        void todoEditorDrain?.catch(() => {});
        void planEditorDrain?.catch(() => {});
        const pullRequestsDrain = pullRequests?.dispose();
        void pullRequestsDrain?.catch(() => {});
        const terminalCreationDrain = terminalCreationHttp?.dispose();
        const mcpOwnerDrain = mcpOwners!.dispose();
        void mcpOwnerDrain.catch(() => {});
        const browserCloseDrain = browserCloseRequests?.dispose();
        void browserCloseDrain?.catch(() => {});
        const browserObservationDrain = browserObservations?.dispose();
        void browserObservationDrain?.catch(() => {});
        const browserHistoryDrain = browserHistory?.dispose();
        void browserHistoryDrain?.catch(() => {});
        const browserAutocompleteDrain = browserAutocomplete?.dispose();
        void browserAutocompleteDrain?.catch(() => {});
        const draftBrowserDrain = draftBrowsers?.dispose();
        void draftBrowserDrain?.catch(() => {}); // Retain failure for the aggregate after configuration drains.
        // Configuration writes are bounded, local operations. Drain them before
        // retiring their discovery worker so a graceful stop cannot interrupt
        // a native registry write midway through serialization.
        // Native acquisition has no abort API; graceful shutdown drains it.
        const configurationOutcomes = await Promise.allSettled([acquisitions!.dispose(),integrations!.dispose(), workspaces.shutdownSubmissions(), drainRepositoryWatchPeers(), workspaces.shutdownRepositoryWatches()]);
        return { configurationErrors: configurationOutcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []),
          processDrain, pullRequestsDrain, terminalCreationDrain, mcpOwnerDrain, browserCloseDrain, browserObservationDrain, browserHistoryDrain,
          browserAutocompleteDrain, draftBrowserDrain, planEditorDrain, todoEditorDrain };
      })();
      const prepared = await stopPreparation;
      // Start worker cancellation alongside drains that may themselves depend
      // on discovery or session workers. The configuration writes above have
      // already reached their terminal outcome.
      const safeCall = (async () => {
        const errors: unknown[] = [];
        try { await runtime.dispose({preserveReconnect:true}); }
        catch (error) { errors.push(error); }
        // A refused worker handoff can still leave policy callbacks settling
        // against the Store. Drain them before either retry or final release,
        // and retain this failure independently from the handoff failure.
        try { await nativeResetPolicy!.drain(); }
        catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Native worker handoff and reset-policy drain failed.");
      })();
      stopCleanup ??= (async () => {
        const outcomes = await Promise.allSettled([prepared.processDrain, prepared.pullRequestsDrain, automations?.dispose(), prepared.mcpOwnerDrain, networkCall, discovery, modelsRefresh, prepared.terminalCreationDrain, prepared.draftBrowserDrain, prepared.browserCloseDrain, prepared.browserObservationDrain, prepared.browserHistoryDrain, prepared.browserAutocompleteDrain,
          accounts!.dispose(), terminals!.shutdown(), (async () => {
            const editorOutcome = await Promise.allSettled([prepared.planEditorDrain, prepared.todoEditorDrain]);
            const terminalOutcome = await Promise.allSettled([nativeTerminals?.shutdown()]);
            const errors = [...editorOutcome, ...terminalOutcome].flatMap(value => value.status === "rejected" ? [value.reason] : []);
            if (errors.length) throw new AggregateError(errors, "Plan editor and terminal cleanup failed.");
          })(), settings!.dispose(), themeAssets!.dispose(), theme!.dispose().finally(() => preferences!.dispose())]);
        await Promise.allSettled([...commands.values(), ...executions.values()]);
        return [...prepared.configurationErrors, ...outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : [])];
      })();
      const [safe, cleanupErrors] = await Promise.all([Promise.allSettled([safeCall]), stopCleanup]);
      const safeErrors = safe.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
      // An ordinary failed handoff retains the Store and lease for an explicit
      // retry. A process-exit cleanup has no retry opportunity, so it must
      // remove the stale locator and release local ownership before reporting
      // the same native failure to the postmortem runner.
      if (safeErrors.length && !finalExitRequested)
        throw new AggregateError([...safeErrors, ...cleanupErrors], "Native worker handoff did not finish safely.");
      // Remove our locator while still owning the lease, so a successor's locator survives.
      try { await rm(join(dataDirectory, "connection.json"), { force: true }); }
      finally { store.close(); lease.release(); stopCompleted = true; }
      if (safeErrors.length)
        throw new AggregateError([...safeErrors, ...cleanupErrors], "Native worker handoff did not finish safely.");
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Some host resources did not finish cleanup.");
    })().then(attempt.resolve, error => {
      if (!stopCompleted && stopCall === attempt.promise) stopCall = undefined;
      attempt.reject(error);
    });
    return attempt.promise;
  }
  return { connection, store, snapshot, dispatch, stop };
  } catch (error) {
    nativeResetPolicy?.beginDispose();
    environmentAbort.abort();
    goalContinuations?.stop();
    questionDeliveries?.stop();
    clearInterval(networkTimer);
    server?.stop(true); tailServer?.stop(true);
    const cleanupErrors: unknown[] = [];
    try {
      terminalsHttp?.dispose(); nativeTerminalsHttp?.dispose();
      // Failed startup can already have admitted session reads. Begin their
      // worker retirement alongside the read drain, rather than waiting for
      // reads that may themselves need the worker to finish stopping.
      const first = await Promise.allSettled([sessionProcesses?.dispose(), todoExternalEditors?.dispose(), planExternalEditors?.dispose(), mcpOwners?.dispose(), pullRequests?.dispose(), automations?.dispose(), browserObservations?.dispose(), browserHistory?.dispose(), browserAutocomplete?.dispose(), (async () => {
        const nativeErrors: unknown[] = [];
        try { await runtime?.dispose(); } catch (failure) { nativeErrors.push(failure); }
        try { await nativeResetPolicy?.drain(); } catch (failure) { nativeErrors.push(failure); }
        if (nativeErrors.length) throw new AggregateError(nativeErrors, "Native reset startup rollback did not drain cleanly.");
      })(), browserCloseRequests?.dispose(), draftBrowsers?.dispose(), terminalCreationHttp?.dispose(), terminals?.shutdown(), nativeTerminals?.shutdown(), drainRepositoryWatchPeers(), workspaces?.shutdownRepositoryWatches()]);
      cleanupErrors.push(...first.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []));
      const second = await Promise.allSettled([themeAssets?.dispose(), theme?.dispose(), accounts?.dispose(), preferences?.dispose(), settings?.dispose(), acquisitions?.dispose(), integrations?.dispose()]);
      cleanupErrors.push(...second.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []));
    }
    catch (failure) { cleanupErrors.push(failure); }
    finally {
      try {
        store?.close();
        await rm(temporary, { force: true });
        if (publishedConnection) await rm(join(dataDirectory, "connection.json"), { force: true });
      } finally { lease.release(); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Host startup failed and cleanup did not finish cleanly.", { cause: error });
    throw error;
  }
}

export async function runHostMain(): Promise<void> {
  const host = await startHost({ tailscale: true });
  // OMP owns the process signal exit and waits for registered cleanup. A second
  // SIGTERM listener races its native hard exit and can leave our locator behind.
  registerExitCleanup("agent-desktop-host", () => host.stop({ finalExit: true }), { exitOnly: true });
  process.stdout.write(`Agent Desktop host ready on ${host.connection.origin}\n`);
}

if (import.meta.main) await runHostMain();
