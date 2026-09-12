export * from "./branch-query-transport";
export * from "./browser-observation";
import type { GitRepositoryChange } from "./repository-changes";
export * from "./repository-changes";
import type { SessionSearchRequest, SessionSearchResult } from "./session-search";
import type { GitCheckoutRefusalError } from "./checkout-refusal";
export * from "./session-search";
export * from "./repository-watch-transport";
export * from "./ssh-settings";
import type { DeviceAccessState, DeviceAccessUpdate } from "./device-access";
export * from "./device-access";
import type { SelectedTextAttachment } from "./selected-text";
import type { WholeFileAttachment } from "./whole-file";
export * from "./selected-text";
export * from "./whole-file";
export * from "./session-mcp-authorization";
export * from "./session-mcp-resource";
export * from "./session-mcp";
export * from "./notifications";
export * from "./queued-messages";
export * from "./queued-submissions";
export * from "./task-location";
import type { NativePluginCatalog, NativePluginMutation, NativeMcpCatalog, NativeMcpDetail, NativeMcpDetailRequest, NativeMcpMutation } from './integrations';
import type { NativeMarketplaceCatalog, NativePluginAcquisition, NativePluginAcquisitionReceipt, NativePluginAcquisitionRequest } from './plugin-acquisition';
export type { NativePluginCatalog, NativePluginMutation, NativePlugin, PluginSetting, NativeMcpCatalog, NativeMcpDetail, NativeMcpDetailRequest, NativeMcpMutation, NativeMcpServer } from './integrations';
export type { NativeMarketplaceCatalog, NativePluginAcquisition, NativePluginAcquisitionReceipt, NativePluginAcquisitionRequest } from './plugin-acquisition';
export * from "./local-environments";
export * from "./environment-selection";
export * from "./environment-preparations";
import type { LocalEnvironmentSelection } from "./environment-selection";
import type { LocalEnvironmentPreparationReceipt } from "./environment-preparations";
import type { BrowserControlRequest, BrowserControlReceipt } from './browser-control';
import type { NewChatExecution } from './new-chat';
import type { WorktreeStartingState } from './workspace';
export * from './new-chat';
import type { BrowserCreateRequest, BrowserCreateReceipt, BrowserCreateObservation } from "./browser-create";
import type { AccountInfo, LoginResponse, LoginSnapshot, ProviderCatalog, SessionAccountList } from "./accounts";
import type { OmpInteraction, OmpInteractionResponse } from "./interactions";
import type { WorkspaceMutation, WorkspaceMutationResult, WorkspaceQuery, WorkspaceQueryResult, WorkspaceTarget } from "./workspace-protocol";
import type { PreferenceChange, PreferenceRecord, PreferencesSnapshot } from "./preferences";
import type { CommandKeymapMutation, CommandKeymapPreferenceRecord, PreferencesSnapshotV2 } from "./preferences-v2";
import type { ThemeAsset, ThemeDocument, ThemeState, WindowThemeEffects } from "./theme";
import type { TerminalBridge, NativeTerminalBridge } from "./terminals";
import type { TerminalCreationBridge } from "./terminal-creation";
import type { OmpApprovalMode, OmpModelDefinitions, OmpModelDefinitionsMutation, OmpModelDefinitionsSnapshot } from "./settings";
import type { OmpComposerCatalog, OmpModelCapabilities, OmpSessionControlMutation, OmpSessionControls, OmpSettingOptions, OmpSettingsCatalog, OmpSettingsMutation, OmpSettingsSnapshot } from "./settings";
import type { DraftConsumption, ImageAttachmentRef, ImageAttachmentCapabilities, UploadedImageMetadata, RecordedImageBytes } from "./attachments";
import type { ComposerActionsCatalog, ComposerCompletionQuery, ComposerCompletions, ComposerSkillDetail, NativeSkillFileDocument, NativeSkillFileRef, NativeSkillFileRevealResult, NativeSkillFileWriteResult, NativeSkillInventory } from "./composer-actions";
import type { SessionActivitySnapshot } from "./session-activity";
import type { BrowserMetadataSnapshot, BrowserFrameTarget, BrowserFrameSnapshot } from "./browser";
import type { HostNotification } from "./notifications";
export * from "./attachments";
export * from "./composer-actions";
export * from "./session-activity";
export * from "./browser";
export * from "./browser-frame";
export * from "./browser-control";
export * from "./browser-create";
export * from "./draft-browser";
export * from "./goal-control";
export * from "./detached-questions";
export * from "./btw";
export type * from "./preferences";
export * from "./workspace-protocol";
export { parseStandaloneFilePath } from "./workspace";
export type * from "./workspace";
export type * from "./accounts";
export type * from "./interactions";
export type * from "./settings";
export type * from "./theme";
export type * from "./terminals";
export * from "./terminal-creation";
export const PROTOCOL_VERSION = 1 as const;

export interface HostIdentity {
  id: string;
  name: string;
  platform: string;
  architecture: string;
}

export interface Project {
  id: string;
  hostId: string;
  name: string;
  path: string;
  createdAt: number;
  /** Retained privately for existing sessions and drafts after catalog removal. */
  removedAt?: number;
}

export interface ModelChoice {
  provider: string;
  id: string;
}

export interface ModelInfo extends ModelChoice {
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number | null;
  maxTokens: number | null;
  thinkingLevels?: string[];
  authenticated: boolean;
  /** Native getAvailable membership; may differ from resolvable credentials. */
  available?: boolean;
  disabledInSettings?: boolean;
}

export type SessionStatus = "idle" | "running" | "interrupted" | "error";

export interface SessionSummary {
  id: string;
  hostId: string;
  projectId: string | null;
  cwd: string;
  title: string;
  status: SessionStatus;
  sessionFile: string;
  model: ModelChoice | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** Host-owned native permission override; absent follows native configuration. */
  approvalOverride?: OmpApprovalMode;
  /** Host scheduler checkpoint. Native OMP remains authoritative for the goal. */
  goalContinuation?: { goalId: string; blocked?: 'no-tools' | 'unknown' | 'in-flight' };
  /** Wake-up hint only; accepted answers and delivery receipts live in OMP's journal. */
  questionDeliveryPending?: boolean;
  error?: string;
}

export interface Draft {
  id: string;
  revision: number;
  text: string;
  projectId: string | null;
  model: ModelChoice | null;
  thinkingLevel?: string;
  /** Absent follows the native default/new session or existing session policy. */
  approvalMode?: OmpApprovalMode;
  execution?: NewChatExecution;
  /** Sticky format: null clears selection; absence is an older writer. */
  environment?: LocalEnvironmentSelection;
  /** Presence persists after clearing the last chip; older command writers must refuse. */
  attachments?: ImageAttachmentRef[];
  /** Sticky snapshot format, including after the last selection is removed. */
  selectedTextAttachments?: SelectedTextAttachment[];
  /** Sticky literal file-reference format, including after the last file is removed. */
  wholeFileAttachments?: WholeFileAttachment[];
  /** Owning-host receipt, never editable draft input. */
  lastConsumption?: DraftConsumption;
  updatedAt: number;
}
export type DraftInput = Omit<Draft, "revision" | "updatedAt" | "lastConsumption">;

export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; intent?: string }
  | { type: "image"; nativeType: "image"; blockIndex: number; mimeType: string; bytes?: number; sha256?: string }
  | { type: "unsupported"; nativeType: string; mimeType?: string };
export interface TranscriptAssistantMetadata {
  provider?: string; model?: string; upstreamProvider?: string; upstreamModel?: string;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; errorMessage?: string;
  durationMs?: number; completedAt?: number;
  usage?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens", number>> & { cost?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "total", number>> };
}
/** Native auto-read context. Image indexes refer to the native files array. */
export interface TranscriptFileReference {
  path: string;
  content: string;
  lineCount?: number;
  byteSize?: number;
  skippedReason?: "tooLarge" | "binary";
  image?: { blockIndex: number; mimeType: string; bytes?: number; sha256?: string; error?: string };
}
export interface TranscriptMessage {
  /** Stable display identity; native entry identity remains separate. */
  id: string;
  nativeId?: string;
  role: string;
  text: string;
  timestamp?: number;
  content?: TranscriptBlock[];
  lifecycle?: "streaming" | "complete";
  tool?: { callId: string; name?: string; status?: "running" | "completed"; isError?: boolean; arguments?: Record<string, unknown>; intent?: string };
  assistant?: TranscriptAssistantMetadata;
  /** App-owned native command output entry. This is never a model message. */
  commandOutput?: { entryId: string; command: string; output: string };
  /** Captured context, linked only by explicit persisted native metadata. */
  selectedText?: { contextEntryId: string; submissionId: string; attachments: SelectedTextAttachment[]; bindingEntryId?: string };
  /** Verified native binding; text/content still contain the actual model-visible Markdown. */
  wholeFiles?: { bindingEntryId: string; submissionId: string; fileEntryIds: string[]; authoredText: string; attachments: WholeFileAttachment[] };
  /** Files actually recorded by OMP auto-read, never inferred from prompt text. */
  fileReferences?: readonly TranscriptFileReference[];
  /** Bounded native goal-completed entry attached to its preceding assistant. */
  goalCompletion?: { entryId: string; objective: string; tokensUsed: number; tokenBudget?: number; timeUsedSeconds: number };
  blocks?: unknown[];
}

export interface HostState {
  protocolVersion: typeof PROTOCOL_VERSION;
  host: HostIdentity;
  projects: Project[];
  sessions: SessionSummary[];
  drafts: Draft[];
  models: ModelInfo[];
  lastEventSequence: number;
  /** Current native questions and permissions, after live-source reconciliation. */
  notifications?: HostNotification[];
  modelsLoading?: boolean;
  imageAttachments?: ImageAttachmentCapabilities;
  selectedText?: { commandVersion: 6; maxSerializedChars: number; ordinaryPrompt: true };
  wholeFiles?: { commandVersion: 7; ordinaryPrompt: true; maxFiles: number; inlineMentions?: { commandVersion: 8; repeatedSources?: { commandVersion: 9 } } };
  gitSubmissions?: { commandVersion: 10 };
  sessionSearch?: { version: 1 };
  queuedMessages?: { version: 1; submissions?: { version: 1; commandVersion: 13 } };
  taskLocations?: { version: 1; commandVersion: 14 };
  repositoryWatches?: { version: 1 };
  branchQueries?: { version: 1 };
  commandKeybindings?: { commandVersion: 11; snapshotVersion: 2; numberTargetVersion?: 1 };
  newChatExecution?: { commandVersion: 4; worktrees: true; startingRefs?: { commandVersion: 12; remote: true } };
  localEnvironments?: { configuration: true; actions?: true; execution?: { commandVersion: 5; scriptOutput?: true; scriptCancellation?: true } };
  diagnostics?: { models?: string; preferences?: string };
}

export type HostCommand =
  | { type: "session.location.move"; sessionId: string; expectedRevision: string; target: import("./task-location").TaskLocationMoveTarget }
  | { type: "session.location.resume"; sessionId: string; operationId: string; expectedRevision: string }
  | { type: "preferences.put"; change: PreferenceChange }
  | { type: "preferences.keymap.mutate"; mutation: CommandKeymapMutation }
  | { type: "workspace.mutate"; target: WorkspaceTarget; action: WorkspaceMutation }
  | { type: "skill.file.write"; ref: NativeSkillFileRef; expectedRevision: string; text: string; bom?: boolean }
  | { type: "skill.file.reveal"; ref: NativeSkillFileRef }
  | { type: "skill.file.open"; ref: NativeSkillFileRef; targetId: string }
  | { type: "project.add"; path: string; name?: string }
  | { type: "project.rename"; projectId: string; name: string }
  | { type: "project.remove"; projectId: string }
  | { type: "session.create"; projectId: string | null; cwd?: string; model?: ModelChoice; approvalMode?: OmpApprovalMode; worktree?: WorktreeStartingState; environment?: LocalEnvironmentSelection; draft?: { id: string; revision: number } }
  | { type: "session.environment.cancel"; preparationId: string; projectId: string; runRevision: number }
  | { type: "session.environment.resume"; preparationId: string; expectedRevision: number }
  | { type: "session.prompt"; sessionId: string; text: string; model?: ModelChoice; thinkingLevel?: string; approvalMode?: OmpApprovalMode; attachments?: ImageAttachmentRef[]; selectedTextAttachments?: SelectedTextAttachment[]; wholeFileAttachments?: WholeFileAttachment[]; draft?: { id: string; revision: number } }
  | { type: "session.steer"; sessionId: string; text: string; approvalMode?: OmpApprovalMode; attachments?: ImageAttachmentRef[]; selectedTextAttachments?: SelectedTextAttachment[]; wholeFileAttachments?: WholeFileAttachment[]; draft?: { id: string; revision: number } }
  | { type: "session.follow-up"; sessionId: string; text: string; delivery: import("./queued-submissions").FollowUpDelivery; approvalMode?: OmpApprovalMode; draft: { id: string; revision: number } }
  | { type: "session.question.answer"; sessionId: string; questionId: string; questionEntryId: string; answers: import('./detached-questions').DetachedQuestionAnswer[]; draft: { id: string; revision: number } }
  | { type: "session.btw.start"; sessionId: string; question: string; draft?: { id: string; revision: number }; nativeCommand?: "btw" }
  | { type: "session.mcp.authorize"; hostId: string; sessionId: string; epoch: string; expectedRevision: number; serverName: string }
  | { type: "session.mcp.reload"; sessionId: string; epoch: string; expectedRevision: number }
  | { type: "session.mcp.reconnect"; sessionId: string; epoch: string; expectedRevision: number; serverName: string }
  | { type: "session.btw.cancel"; sessionId: string; runId: string }
  | { type: "session.btw.promote"; sessionId: string; runId: string }
  | { type: "session.interrupt"; sessionId: string }
  | { type: "session.rename"; sessionId: string; title: string }
  | { type: "session.archive"; sessionId: string; archived: boolean }
  | { type: "draft.put"; draft: DraftInput; expectedRevision: number };

export interface CommandEnvelope {
  id: string;
  command: HostCommand;
  /** Required for consumption of a draft carrying new-chat execution state. */
  commandVersion?: 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
}

export interface ImageAdmission {
  attachmentId: string;
  blockIndex: number;
  sourceSha256: string;
  nativeSha256: string;
  mimeType: string;
  bytes: number;
}
export type PromptAdmission =
  | { kind: "user-message"; entryId: string; images?: ImageAdmission[] }
  | { kind: "skill-message"; entryId: string; name: string }
  | { kind: "native-command"; command: string; entryId?: string; output?: string };
export type CommandResult =
  | { ok: true; commandId: string; admission?: PromptAdmission; value?: Project | SessionSummary | Draft | WorkspaceMutationResult | LocalEnvironmentPreparationReceipt | NativeSkillFileWriteResult | NativeSkillFileRevealResult | {type:"skill.file.open";targetId:string} | { type: "preferences.put"; preference: PreferenceRecord } | { type: "preferences.keymap.mutate"; preference: CommandKeymapPreferenceRecord } | { type: 'session.question.answer'; receipt: import('./detached-questions').ResolveDetachedQuestionReceipt } | { type: "session.mcp.authorization"; authorizationId: string } | { type: "session.mcp"; snapshot: import("./session-mcp").NativeSessionMcpSnapshot } | { type: 'session.btw'; snapshot: import('./btw').NativeBtwSnapshot | null } | { type: 'session.btw.promote'; cancelled: boolean; session: SessionSummary } | import("./queued-submissions").QueuedSubmissionResult | import("./task-location").TaskLocationMoveReceipt }
  | { ok: false; commandId: string; error: { code: string; message: string; checkoutConflict?: GitCheckoutRefusalError["checkoutConflict"] }; currentDraft?: Draft };

export type HostEvent =
  | { sequence: number; type: "state"; state: HostState; /** Direct websocket replay barrier; absent on durable state events. */ replayComplete?: true }
  | { sequence: number; type: "runtime"; sessionId: string; event: unknown }
  | { sequence: number; type: "accounts" }
  | { sequence: number; type: "interactions"; sessionId: string }
  | { sequence: number; type: "notification"; notification: HostNotification }
  | { sequence: number; type: "workspace"; target: WorkspaceTarget; repositoryChange?: GitRepositoryChange }
  | { sequence: number; type: "preferences" }
  | { sequence: number; type: "device-access" }
  | { sequence: number; type: "task-location"; sessionId: string }
  | { sequence: number; type: "settings"; target?: WorkspaceTarget; sessionId?: string; scope?: "global" | "project" }
  | { sequence: number; type: "connection"; connected: boolean; error?: string };

export interface DiscoveredHost {
  nodeId: string;
  name: string;
  platform: string;
  online: boolean;
  availability: "available" | "unavailable" | "offline";
  host?: HostIdentity;
  origin?: string;
  /** Explicit authenticated health capability; absence retains the legacy preference exchange. */
  preferencesSyncVersion?: 2 | 3;
  error?: string;
}
export interface NetworkState {
  status: "connecting" | "connected" | "unavailable";
  ownNodeId?: string;
  ownName?: string;
  listenAddress?: string;
  error?: string;
  hosts: DiscoveredHost[];
  checkedAt: number;
}
export type DesktopEvent = HostEvent & { hostId?: string };


export type AccountAction =
  | { type: "login.start"; providerId: string }
  | { type: "login.respond"; loginId: string; requestId: string; response: LoginResponse }
  | { type: "login.cancel"; loginId: string }
  | { type: "key.set"; providerId: string; key: string }
  | { type: "credential.remove"; providerId: string; credentialId: number }
  | { type: "session.pin"; sessionId: string; credentialId: number }
  | { type: "session.release"; sessionId: string };
export interface AccountActionResult { login?: LoginSnapshot; accounts?: AccountInfo[]; selection?: SessionAccountList }

export type NativeModifier = "meta" | "control" | "alt";
export type ModifierReleaseResult = "released" | "unavailable" | "cancelled";

export interface DesktopBridge extends TerminalBridge, Partial<NativeTerminalBridge>, Partial<TerminalCreationBridge> {
  watchModifierRelease?(modifier: NativeModifier, requestId: string): Promise<ModifierReleaseResult>;
  cancelModifierRelease?(requestId: string): Promise<void>;
  showContextMenu?(items:import("./context-menu").DesktopMenuItem[]):Promise<string|null>;
  subscribeWindowClose?(listener: (request: {id: string; cancelled?: boolean}) => void): () => void;
  answerWindowClose?(id: string, allowed: boolean): Promise<void>;
  getNotificationStatus?(): Promise<{supported:boolean; error?:string}>;
  subscribeNotificationStatus?(listener:()=>void):()=>void;
  subscribeNotificationNavigation?(listener:(target:{hostId:string;sessionId:string})=>void):()=>void;
  getComposerActions?(target?: WorkspaceTarget, refresh?: boolean, hostId?: string): Promise<ComposerActionsCatalog | null>;
  getSkillInventory?(target?: WorkspaceTarget, refresh?: boolean, hostId?: string): Promise<NativeSkillInventory | null>;
  getSkillDetail?(target: WorkspaceTarget | undefined, skillId: string, catalogRevision: string, hostId?: string, inventory?: boolean): Promise<ComposerSkillDetail>;
  getSkillFileOpenOptions?(ref: NativeSkillFileRef, hostId?: string): Promise<import("./composer-actions").NativeSkillFileOpenOptions>;
  getSkillFile?(ref: NativeSkillFileRef, hostId?: string): Promise<NativeSkillFileDocument>;
  getComposerCompletions?(query: ComposerCompletionQuery, hostId?: string): Promise<ComposerCompletions>;
  inspectImageAttachment?(data: Uint8Array): Promise<UploadedImageMetadata>;
  getImageAttachmentCapabilities?(hostId: string): Promise<ImageAttachmentCapabilities | null>;
  uploadImageAttachment?(sha256: string, data: Uint8Array, hostId: string): Promise<UploadedImageMetadata>;
  getImageAttachment?(sha256: string, hostId: string): Promise<RecordedImageBytes>;
  getTranscriptImage?(sessionId: string, nativeEntryId: string, blockIndex: number, hostId: string): Promise<RecordedImageBytes>;
  getState(hostId?: string): Promise<HostState>;
  getHosts(): Promise<NetworkState>;
  /** Local machine only; these calls intentionally accept no remote host selector. */
  getKeepAwakeStatus?(): Promise<{ supported: boolean; active: boolean; onBattery?: boolean; error?: string }>;
  subscribeKeepAwakeStatus?(listener: () => void): () => void;
  getDeviceAccess?(): Promise<DeviceAccessState>;
  updateDeviceAccess?(update: DeviceAccessUpdate): Promise<DeviceAccessState>;
  subscribeDeviceAccess?(listener: () => void): () => void;
  getProviders(hostId?: string): Promise<ProviderCatalog>;
  getAccounts(providerId: string, hostId?: string): Promise<AccountInfo[]>;
  getSessionAccounts(sessionId: string, hostId?: string): Promise<SessionAccountList>;
  getInteractions(sessionId: string, hostId?: string): Promise<OmpInteraction[]>;
  getDetachedQuestions?(sessionId: string, hostId?: string): Promise<import('./detached-questions').DetachedQuestionsSnapshot | null>;
  workspaceQuery(target: WorkspaceTarget, query: WorkspaceQuery, hostId?: string): Promise<WorkspaceQueryResult>;
  repositoryWatch?(request: import("./repository-watch-transport").RepositoryWatchRequest): Promise<void>;
  subscribeRepositoryWatch?(listener: (status: import("./repository-watch-transport").RepositoryWatchObserverStatus) => void): () => void;
  branchQuery?(request: import("./branch-query-transport").BranchQueryRequest): Promise<void>;
  subscribeBranchQuery?(listener: (status: import("./branch-query-transport").BranchQueryObserverStatus) => void): () => void;
  saveSkillFileCopy?(ref: NativeSkillFileRef, hostId: string): Promise<{path:string|null}>;
  saveWorkspaceCopy?(target: WorkspaceTarget, path: string, hostId: string): Promise<{path: string | null}>;
  acquireSkillImage?(ref: NativeSkillFileRef, path: string, hostId: string): Promise<{url: string; id: string}>;
  acquireWorkspaceImage?(target: WorkspaceTarget, path: string, hostId: string): Promise<{url: string; id: string}>;
  releaseWorkspaceImage?(id: string): Promise<void>;
  getPreferences(): Promise<PreferencesSnapshot>;
  getPreferencesV2?(): Promise<PreferencesSnapshotV2>;
  getTheme(): Promise<ThemeState>;
  setTheme(document: ThemeDocument, expectedRevision: string): Promise<ThemeState>;
  getLocalFonts(): Promise<string[]>;
  openThemeFile(): Promise<void>;
  /** Local desktop backing support, independent of temporary focus/size fallback. */
  readonly windowBackdropSupported?: boolean;
  applyWindowTheme(effects: WindowThemeEffects): Promise<void>;
  subscribeWindowTheme?(listener: (opaqueWindows: boolean) => void): () => void;
  importThemeBackground(): Promise<ThemeAsset | null>;
  getThemeBackground(sha256: string): Promise<{ asset: ThemeAsset; dataUrl: string } | null>;
  getPlugins(target?: WorkspaceTarget, hostId?: string): Promise<NativePluginCatalog>;
  mutatePlugin(target: WorkspaceTarget | undefined, mutation: NativePluginMutation, hostId?: string): Promise<NativePluginCatalog>;
  getMarketplaceCatalog(target?: WorkspaceTarget, hostId?: string): Promise<NativeMarketplaceCatalog>;
  startPluginAcquisition(target: WorkspaceTarget | undefined, request: NativePluginAcquisitionRequest, hostId?: string): Promise<NativePluginAcquisitionReceipt>;
  getPluginAcquisitionOperations(hostId?: string): Promise<NativePluginAcquisitionReceipt[]>;
  reviewPluginAcquisition(target: WorkspaceTarget | undefined, id: string, expectedRevision: string, hostId?: string): Promise<NativePluginAcquisitionReceipt>;
  closePluginAcquisitionRequest(target: WorkspaceTarget | undefined, request: { id: string; operation: NativePluginAcquisition['operation'] }, hostId?: string): Promise<NativePluginAcquisitionReceipt>;
  getSshHosts(target?: WorkspaceTarget, hostId?: string): Promise<import("./ssh-settings").NativeSshCatalog>;
  getSshHostDetail(target: WorkspaceTarget | undefined, request: import("./ssh-settings").NativeSshDetailRequest, hostId?: string): Promise<import("./ssh-settings").NativeSshDetail>;
  mutateSshHost(target: WorkspaceTarget | undefined, mutation: import("./ssh-settings").NativeSshMutation, hostId?: string): Promise<import("./ssh-settings").NativeSshCatalog>;
  getMcpServers(target?: WorkspaceTarget, hostId?: string): Promise<NativeMcpCatalog>;
  getMcpServerDetail(target: WorkspaceTarget | undefined, request: NativeMcpDetailRequest, hostId?: string): Promise<NativeMcpDetail>;
  mutateMcpServer(target: WorkspaceTarget | undefined, mutation: NativeMcpMutation, hostId?: string): Promise<NativeMcpCatalog>;
  getSettingsCatalog(hostId?: string): Promise<OmpSettingsCatalog>;
  getSettings(target?: WorkspaceTarget, hostId?: string): Promise<OmpSettingsSnapshot>;
  setSetting(mutation: OmpSettingsMutation, target?: WorkspaceTarget, hostId?: string): Promise<OmpSettingsSnapshot>;
  getSettingOptions(path: string, target?: WorkspaceTarget, hostId?: string): Promise<OmpSettingOptions>;
  getModelCapabilities(target?: WorkspaceTarget, refresh?: boolean, hostId?: string): Promise<OmpModelCapabilities[]>;
  getComposerCatalog?(target?: WorkspaceTarget, refresh?: boolean, hostId?: string): Promise<OmpComposerCatalog>;
  getModelDefinitions(hostId?: string): Promise<OmpModelDefinitions>;
  setModelDefinitions(mutation: OmpModelDefinitionsMutation, hostId?: string): Promise<OmpModelDefinitionsSnapshot>;
  getSessionControls(sessionId: string, hostId?: string): Promise<OmpSessionControls>;
  setSessionControl(sessionId: string, mutation: OmpSessionControlMutation, hostId?: string): Promise<OmpSessionControls>;
  respondInteraction(sessionId: string, interactionId: string, response: OmpInteractionResponse, hostId?: string): Promise<void>;
  getLogins(hostId?: string): Promise<LoginSnapshot[]>;
  accountAction(action: AccountAction, hostId?: string): Promise<AccountActionResult>;
  openExternal(url: string): Promise<void>;
  command(envelope: CommandEnvelope, hostId?: string): Promise<CommandResult>;
  searchSessions?(input: SessionSearchRequest, hostId: string, requestId?: string): Promise<SessionSearchResult>;
  cancelSessionSearch?(requestId: string, hostId: string): Promise<void>;
  getMessages(sessionId: string, hostId?: string): Promise<TranscriptMessage[]>;
  getQueuedMessages?(sessionId: string, hostId: string): Promise<import("./queued-messages").NativeQueuedMessagesResponse>;
  getTaskLocation?(sessionId: string, hostId?: string): Promise<import("./task-location").TaskLocationSnapshot>;
  mutateQueuedMessages?(sessionId: string, mutation: import("./queued-messages").NativeQueuedMessageMutation, hostId: string): Promise<import("./queued-messages").NativeQueuedMessageMutationReceipt>;
  subscribeQueuedMessages?(listener: (event: { hostId: string; sessionId: string }) => void): () => void;
  mutateGoal?(sessionId: string, request: import('./goal-control').GoalMutationRequest, hostId?: string): Promise<import('./goal-control').GoalMutationReceipt>;
  getSessionActivity?(sessionId: string, hostId?: string): Promise<SessionActivitySnapshot | null>;
  readSessionMcpResource?(sessionId: string, request: import("./session-mcp-resource").NativeSessionMcpResourceRequest, hostId?: string): Promise<import("./session-mcp-resource").NativeSessionMcpResourceResult>;
  getSessionMcp?(sessionId: string, hostId?: string, commandId?: string): Promise<import("./session-mcp").NativeSessionMcpResponse>;
  getSessionMcpAuthorization?(sessionId: string, hostId: string, commandId?: string): Promise<import("./session-mcp-authorization").NativeMcpAuthorizationResponse>;
  respondSessionMcpAuthorization?(sessionId: string, reply: import("./session-mcp-authorization").NativeMcpAuthorizationReply, hostId: string): Promise<import("./session-mcp-authorization").NativeMcpAuthorizationResponse>;
  cancelSessionMcpAuthorization?(sessionId: string, authorizationId: string, hostId: string): Promise<import("./session-mcp-authorization").NativeMcpAuthorizationResponse>;
  getBtw?(sessionId: string, hostId?: string): Promise<import('./btw').NativeBtwResponse>;
  draftBrowser?: import("./draft-browser").DraftBrowserBridge;
  browserClose?: import("./browser-close").BrowserCloseBridge;
  browserObservation?: import("./browser-observation").BrowserObservationBridge;
  getBrowserMetadata?(sessionId: string, hostId?: string): Promise<BrowserMetadataSnapshot | null>;
  createBrowserTab?(sessionId: string, request: BrowserCreateRequest, hostId?: string): Promise<BrowserCreateReceipt>;
  getBrowserCreationStatus?(sessionId: string, request: BrowserCreateRequest, hostId?: string): Promise<BrowserCreateObservation>;
  controlBrowser?(sessionId: string, request: BrowserControlRequest, hostId?: string): Promise<BrowserControlReceipt>;
  getBrowserFrame?(sessionId: string, target: BrowserFrameTarget, hostId?: string): Promise<BrowserFrameSnapshot>;
  chooseDirectory(): Promise<string | null>;
  /** Opens only a project owned by the local desktop host. */
  revealProjectDirectory?(projectId: string, hostId: string): Promise<void>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}

declare global {
  interface Window {
    agentDesktop: DesktopBridge;
  }
}
