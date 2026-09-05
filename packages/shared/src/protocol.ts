import type { AccountInfo, LoginResponse, LoginSnapshot, ProviderCatalog, SessionAccountList } from "./accounts";
import type { OmpInteraction, OmpInteractionResponse } from "./interactions";
import type { WorkspaceMutation, WorkspaceMutationResult, WorkspaceQuery, WorkspaceQueryResult, WorkspaceTarget } from "./workspace-protocol";
import type { PreferenceChange, PreferenceRecord, PreferencesSnapshot } from "./preferences";
import type { ThemeAsset, ThemeDocument, ThemeState, WindowThemeEffects } from "./theme";
import type { TerminalBridge, NativeTerminalBridge } from "./terminals";
import type { OmpModelDefinitions, OmpModelDefinitionsMutation, OmpModelDefinitionsSnapshot } from "./settings";
import type { OmpComposerCatalog, OmpModelCapabilities, OmpSessionControlMutation, OmpSessionControls, OmpSettingOptions, OmpSettingsCatalog, OmpSettingsMutation, OmpSettingsSnapshot } from "./settings";
export type * from "./preferences";
export type * from "./workspace-protocol";
export type * from "./workspace";
export type * from "./accounts";
export type * from "./interactions";
export type * from "./settings";
export type * from "./theme";
export type * from "./terminals";
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
  error?: string;
}

export interface Draft {
  id: string;
  revision: number;
  text: string;
  projectId: string | null;
  model: ModelChoice | null;
  thinkingLevel?: string;
  updatedAt: number;
}

export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; intent?: string }
  | { type: "unsupported"; nativeType: string; mimeType?: string };
export interface TranscriptAssistantMetadata {
  provider?: string; model?: string; upstreamProvider?: string; upstreamModel?: string;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; errorMessage?: string;
  durationMs?: number; completedAt?: number;
  usage?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens", number>> & { cost?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "total", number>> };
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
  modelsLoading?: boolean;
  diagnostics?: { models?: string; preferences?: string };
}

export type HostCommand =
  | { type: "preferences.put"; change: PreferenceChange }
  | { type: "workspace.mutate"; target: WorkspaceTarget; action: WorkspaceMutation }
  | { type: "project.add"; path: string; name?: string }
  | { type: "session.create"; projectId: string | null; cwd?: string; model?: ModelChoice }
  | { type: "session.prompt"; sessionId: string; text: string; model?: ModelChoice; thinkingLevel?: string; draft?: { id: string; revision: number } }
  | { type: "session.steer"; sessionId: string; text: string; draft?: { id: string; revision: number } }
  | { type: "session.interrupt"; sessionId: string }
  | { type: "session.rename"; sessionId: string; title: string }
  | { type: "session.archive"; sessionId: string; archived: boolean }
  | { type: "draft.put"; draft: Omit<Draft, "revision" | "updatedAt">; expectedRevision: number };

export interface CommandEnvelope {
  id: string;
  command: HostCommand;
}

export type PromptAdmission =
  | { kind: "user-message"; entryId: string }
  | { kind: "native-command"; command: string };
export type CommandResult =
  | { ok: true; commandId: string; admission?: PromptAdmission; value?: Project | SessionSummary | Draft | WorkspaceMutationResult | { type: "preferences.put"; preference: PreferenceRecord } }
  | { ok: false; commandId: string; error: { code: string; message: string }; currentDraft?: Draft };

export type HostEvent =
  | { sequence: number; type: "state"; state: HostState }
  | { sequence: number; type: "runtime"; sessionId: string; event: unknown }
  | { sequence: number; type: "accounts" }
  | { sequence: number; type: "interactions"; sessionId: string }
  | { sequence: number; type: "workspace"; target: WorkspaceTarget }
  | { sequence: number; type: "preferences" }
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

export interface DesktopBridge extends TerminalBridge, Partial<NativeTerminalBridge> {
  getState(hostId?: string): Promise<HostState>;
  getHosts(): Promise<NetworkState>;
  getProviders(hostId?: string): Promise<ProviderCatalog>;
  getAccounts(providerId: string, hostId?: string): Promise<AccountInfo[]>;
  getSessionAccounts(sessionId: string, hostId?: string): Promise<SessionAccountList>;
  getInteractions(sessionId: string, hostId?: string): Promise<OmpInteraction[]>;
  workspaceQuery(target: WorkspaceTarget, query: WorkspaceQuery, hostId?: string): Promise<WorkspaceQueryResult>;
  getPreferences(): Promise<PreferencesSnapshot>;
  getTheme(): Promise<ThemeState>;
  setTheme(document: ThemeDocument, expectedRevision: string): Promise<ThemeState>;
  getLocalFonts(): Promise<string[]>;
  openThemeFile(): Promise<void>;
  applyWindowTheme(effects: WindowThemeEffects): Promise<void>;
  importThemeBackground(): Promise<ThemeAsset | null>;
  getThemeBackground(sha256: string): Promise<{ asset: ThemeAsset; dataUrl: string } | null>;
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
  getMessages(sessionId: string, hostId?: string): Promise<TranscriptMessage[]>;
  chooseDirectory(): Promise<string | null>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}

declare global {
  interface Window {
    agentDesktop: DesktopBridge;
  }
}
