import { createBrowserCloseBridge } from "./browser-close-preload";
import { createAutomationsBridge } from './automations-preload';
import { createBrowserObservationBridge } from "./browser-observation-preload";
import { createDraftBrowserBridge } from "./draft-browser-preload";
import { createProjectRevealBridge } from "./project-reveal-preload";
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopEvent, DesktopTerminalEvent, NativeTerminalInvalidation } from "@agent-desktop/shared";

let lastNotificationNavigation: string | undefined;
// This cache belongs to one isolated preload/document, never a successor navigation.
let repositoryWatchWindow: Promise<string> | undefined;
let branchQueryWindow: Promise<string> | undefined;
const bridge: DesktopBridge = {
  automations: createAutomationsBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  draftBrowser: createDraftBrowserBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  browserClose: createBrowserCloseBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  browserObservation: createBrowserObservationBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  watchModifierRelease: (modifier, id) => ipcRenderer.invoke("desktop:modifier-release", id, modifier),
  cancelModifierRelease: id => ipcRenderer.invoke("desktop:modifier-release-cancel", id),
  // This desktop implements native translucent backing only through Darwin vibrancy.
  windowBackdropSupported: process.platform === "darwin",
  showContextMenu: items=>ipcRenderer.invoke("desktop:context-menu",items),
  getNotificationStatus: () => ipcRenderer.invoke("desktop:notification-status"),
  subscribeNotificationStatus: listener => {
    const callback = () => listener(); ipcRenderer.on("desktop:notification-status", callback);
    return () => ipcRenderer.removeListener("desktop:notification-status", callback);
  },
  subscribeNotificationNavigation: listener => {
    let active = true;
    const callback = (_event: Electron.IpcRendererEvent, message: {id:string;target:{hostId:string;sessionId:string}}) => {
      if (!active) return;
      if (lastNotificationNavigation !== message.id) { listener(message.target); lastNotificationNavigation = message.id; }
      ipcRenderer.send("desktop:notification-ack", message.id);
    };
    ipcRenderer.on("desktop:notification-navigate", callback);
    void ipcRenderer.invoke("desktop:notification-ready").catch(() => {});
    return () => { active = false; ipcRenderer.removeListener("desktop:notification-navigate", callback); ipcRenderer.send("desktop:notification-unready"); };
  },
  inspectImageAttachment: data => ipcRenderer.invoke("desktop:image-inspect", data),
  getImageAttachmentCapabilities: hostId => ipcRenderer.invoke("host:image-capabilities", hostId),
  uploadImageAttachment: (sha256, data, hostId) => ipcRenderer.invoke("host:image-upload", sha256, data, hostId),
  getImageAttachment: (sha256, hostId) => ipcRenderer.invoke("host:image-read", sha256, hostId),
  getTranscriptImage: (sessionId, nativeEntryId, blockIndex, hostId) => ipcRenderer.invoke("host:transcript-image", sessionId, nativeEntryId, blockIndex, hostId),
  getState: hostId => ipcRenderer.invoke("host:state", hostId),
  getHosts: () => ipcRenderer.invoke("host:peers"),
  getKeepAwakeStatus: () => ipcRenderer.invoke("desktop:keep-awake-status"),
  subscribeKeepAwakeStatus: listener => {
    const changed = () => listener(); ipcRenderer.on("desktop:keep-awake-status", changed);
    return () => ipcRenderer.removeListener("desktop:keep-awake-status", changed);
  },
  getDeviceAccess: () => ipcRenderer.invoke("host:device-access"),
  updateDeviceAccess: update => ipcRenderer.invoke("host:device-access-update", update),
  subscribeDeviceAccess: listener => {
    const changed = () => listener(); ipcRenderer.on("host:device-access-changed", changed);
    return () => ipcRenderer.removeListener("host:device-access-changed", changed);
  },
  getProviders: hostId => ipcRenderer.invoke("host:providers", hostId),
  getAccounts: (providerId, hostId) => ipcRenderer.invoke("host:accounts", providerId, hostId),
  getSessionAccounts: (sessionId, hostId) => ipcRenderer.invoke("host:session-accounts", sessionId, hostId),
  getInteractions: (sessionId, hostId) => ipcRenderer.invoke("host:interactions", sessionId, hostId),
  getDetachedQuestions: (sessionId, hostId) => ipcRenderer.invoke('host:detached-questions', sessionId, hostId),
  workspaceQuery: (target, query, hostId) => ipcRenderer.invoke("host:workspace-query", target, query, hostId),
  repositoryWatch: async request => {
    repositoryWatchWindow ??= ipcRenderer.invoke("host:repository-watch-window").catch(error => { repositoryWatchWindow = undefined; throw error; });
    const token = await repositoryWatchWindow;
    return ipcRenderer.invoke("host:repository-watch", token, request);
  },
  subscribeRepositoryWatch: listener => {
    const callback = (_event: Electron.IpcRendererEvent, status: import("@agent-desktop/shared").RepositoryWatchObserverStatus) => listener(status);
    ipcRenderer.on("host:repository-watch-status", callback);
    return () => ipcRenderer.removeListener("host:repository-watch-status", callback);
  },
  branchQuery: async request => {
    branchQueryWindow ??= ipcRenderer.invoke("host:branch-query-window").catch(error => { branchQueryWindow = undefined; throw error; });
    const token = await branchQueryWindow;
    return ipcRenderer.invoke("host:branch-query", token, request);
  },
  subscribeBranchQuery: listener => {
    const callback = (_event: Electron.IpcRendererEvent, status: import("@agent-desktop/shared").BranchQueryObserverStatus) => listener(status);
    ipcRenderer.on("host:branch-query-status", callback);
    return () => ipcRenderer.removeListener("host:branch-query-status", callback);
  },
  saveSkillFileCopy: async (ref, hostId) => {
    const outcome = await ipcRenderer.invoke("desktop:skill-save-copy", ref, hostId);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  },
  saveWorkspaceCopy: async (target, path, hostId) => {
    const result: import("./workspace-save-copy").WorkspaceCopyOutcome = await ipcRenderer.invoke("desktop:workspace-save-copy", target, path, hostId);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  acquireSkillImage: (ref, path, hostId) => ipcRenderer.invoke("desktop:skill-image-acquire", ref, path, hostId),
  acquireWorkspaceImage: (target, path, hostId) => ipcRenderer.invoke("desktop:workspace-image-acquire", target, path, hostId),
  releaseWorkspaceImage: id => ipcRenderer.invoke("desktop:workspace-image-release", id),
  subscribeWindowClose: listener => {
    const callback = (_event: Electron.IpcRendererEvent, request: {id:string;cancelled?:boolean}) => listener(request);
    ipcRenderer.on("desktop:window-close-request", callback);
    ipcRenderer.send("desktop:window-close-ready");
    return () => {
      ipcRenderer.send("desktop:window-close-unready");
      ipcRenderer.removeListener("desktop:window-close-request", callback);
    };
  },
  answerWindowClose: (id, allowed) => ipcRenderer.invoke("desktop:window-close-answer", id, allowed),
  getPreferences: () => ipcRenderer.invoke("host:preferences"),
  getPreferencesV2: () => ipcRenderer.invoke("host:preferences-v2"),
  getTheme: () => ipcRenderer.invoke("host:theme"),
  setTheme: (document, expectedRevision) => ipcRenderer.invoke("host:theme-set", document, expectedRevision),
  getLocalFonts: () => ipcRenderer.invoke("desktop:fonts"),
  getLocalFontFaces: () => ipcRenderer.invoke("desktop:font-faces"),
  openThemeFile: () => ipcRenderer.invoke("desktop:open-theme"),
  applyWindowTheme: effects => ipcRenderer.invoke("desktop:window-theme", effects),
  subscribeWindowTheme: listener => {
    const callback = (_event: unknown, opaqueWindows: unknown) => { if (typeof opaqueWindows === "boolean") listener(opaqueWindows); };
    ipcRenderer.on("desktop:window-theme-state", callback);
    return () => ipcRenderer.removeListener("desktop:window-theme-state", callback);
  },
  importThemeBackground: () => ipcRenderer.invoke("desktop:theme-background-import"),
  getThemeBackground: sha256 => ipcRenderer.invoke("desktop:theme-background", sha256),
  getTerminals: (target, hostId) => ipcRenderer.invoke("host:terminals", target, hostId),
  getTerminalReplay: (terminalId, afterSequence, hostId) => ipcRenderer.invoke("host:terminal-replay", terminalId, afterSequence, hostId),
  terminalAction: (action, hostId) => ipcRenderer.invoke("host:terminal-action", action, hostId),
  writeTerminal: (input, hostId) => ipcRenderer.invoke("host:terminal-input", input, hostId),
  subscribeTerminals: listener => {
    const callback = (_event: Electron.IpcRendererEvent, message: DesktopTerminalEvent) => listener(message);
    ipcRenderer.on("host:terminal-event", callback);
    return () => ipcRenderer.removeListener("host:terminal-event", callback);
  },
  getNativeTerminalCapabilities: hostId => ipcRenderer.invoke("host:native-terminal-capabilities", hostId),
  nativeTerminalQuery: (query, hostId) => ipcRenderer.invoke("host:native-terminal-query", query, hostId),
  getTerminalCreationCapabilities: hostId => ipcRenderer.invoke("host:terminal-creation-capabilities", hostId),
  createNativeTerminal: (request, hostId) => ipcRenderer.invoke("host:terminal-create", request, hostId),
  observeTerminalCreation: (request, hostId) => ipcRenderer.invoke("host:terminal-creation-status", request, hostId),
  nativeTerminalAction: (action, hostId) => ipcRenderer.invoke("host:native-terminal-action", action, hostId),
  writeNativeTerminal: (input, hostId) => ipcRenderer.invoke("host:native-terminal-input", input, hostId),
  subscribeNativeTerminals: listener => {
    const callback = (_event: Electron.IpcRendererEvent, message: NativeTerminalInvalidation & { hostId: string }) => listener(message);
    ipcRenderer.on("host:native-terminal-event", callback);
    return () => ipcRenderer.removeListener("host:native-terminal-event", callback);
  },
  getPlugins: (target, hostId) => ipcRenderer.invoke("host:plugins-read", target, hostId),
  mutatePlugin: (target, mutation, hostId) => ipcRenderer.invoke("host:plugins-mutate", target, mutation, hostId),
  getMarketplaceCatalog: (target, hostId) => ipcRenderer.invoke("host:plugin-acquisition-catalog", target, hostId),
  startPluginAcquisition: (target, request, hostId) => ipcRenderer.invoke("host:plugin-acquisition-start", target, request, hostId),
  getPluginAcquisitionOperations: hostId => ipcRenderer.invoke("host:plugin-acquisition-operations", hostId),
  reviewPluginAcquisition: (target, id, expectedRevision, hostId) => ipcRenderer.invoke("host:plugin-acquisition-review", target, id, expectedRevision, hostId),
  closePluginAcquisitionRequest: (target, request, hostId) => ipcRenderer.invoke("host:plugin-acquisition-close", target, request, hostId),
  getSshHosts: (target, hostId) => ipcRenderer.invoke("host:ssh-read", target, hostId),
  getSshHostDetail: (target, request, hostId) => ipcRenderer.invoke("host:ssh-detail", target, request, hostId),
  mutateSshHost: (target, mutation, hostId) => ipcRenderer.invoke("host:ssh-mutate", target, mutation, hostId),
  getMcpServers: (target, hostId) => ipcRenderer.invoke("host:mcp-read", target, hostId),
  getMcpServerDetail: (target, request, hostId) => ipcRenderer.invoke("host:mcp-detail", target, request, hostId),
  mutateMcpServer: (target, mutation, hostId) => ipcRenderer.invoke("host:mcp-mutate", target, mutation, hostId),
  getSettingsCatalog: hostId => ipcRenderer.invoke("host:settings-catalog", hostId),
  getSettings: (target, hostId) => ipcRenderer.invoke("host:settings-read", target, hostId),
  setSetting: (mutation, target, hostId) => ipcRenderer.invoke("host:settings-mutate", mutation, target, hostId),
  getSettingOptions: (path, target, hostId) => ipcRenderer.invoke("host:settings-options", path, target, hostId),
  getModelCapabilities: (target, refresh, hostId) => ipcRenderer.invoke("host:model-capabilities", target, refresh, hostId),
  getComposerActions: (target, refresh, hostId) => ipcRenderer.invoke("host:composer-actions", target, refresh, hostId),
  getSkillInventory: (target, refresh, hostId) => ipcRenderer.invoke("host:skill-inventory", target, refresh, hostId),
  getComposerCompletions: (query, hostId) => ipcRenderer.invoke("host:composer-completions", query, hostId),
  getSkillFileOpenOptions: (ref, hostId) => ipcRenderer.invoke("host:skill-file-open-options", ref, hostId),
  getSkillFile: (ref, hostId) => ipcRenderer.invoke("host:skill-file", ref, hostId),
  getSkillDetail: (target, skillId, catalogRevision, hostId, inventory) => ipcRenderer.invoke("host:skill-detail", target, skillId, catalogRevision, hostId, inventory),
  getComposerCatalog: (target, refresh, hostId) => ipcRenderer.invoke("host:composer-catalog", target, refresh, hostId),
  getModelDefinitions: hostId => ipcRenderer.invoke("host:model-definitions", hostId),
  setModelDefinitions: (mutation, hostId) => ipcRenderer.invoke("host:model-definitions-set", mutation, hostId),
  getSessionControls: (sessionId, hostId) => ipcRenderer.invoke("host:session-controls", sessionId, hostId),
  setSessionControl: (sessionId, mutation, hostId) => ipcRenderer.invoke("host:session-controls-mutate", sessionId, mutation, hostId),
  respondInteraction: (sessionId, interactionId, response, hostId) => ipcRenderer.invoke("host:interaction-response", sessionId, interactionId, response, hostId),
  getLogins: hostId => ipcRenderer.invoke("host:logins", hostId),
  accountAction: (action, hostId) => ipcRenderer.invoke("host:account-action", action, hostId),
  openExternal: url => ipcRenderer.invoke("desktop:open-external", url),
  command: (envelope, hostId) => ipcRenderer.invoke("host:command", envelope, hostId),
  searchSessions: (input, hostId, requestId) => ipcRenderer.invoke("host:session-search", input, hostId, requestId),
  cancelSessionSearch: (requestId, hostId) => ipcRenderer.invoke("host:session-search-cancel", requestId, hostId),
  getMessages: (sessionId, hostId) => ipcRenderer.invoke("host:messages", sessionId, hostId),
  getTaskLocation: (sessionId, hostId) => ipcRenderer.invoke("host:task-location", sessionId, hostId),
  getQueuedMessages: (sessionId, hostId) => ipcRenderer.invoke("host:queued-messages", sessionId, hostId),
  mutateQueuedMessages: (sessionId, mutation, hostId) => ipcRenderer.invoke("host:queued-messages-mutate", sessionId, mutation, hostId),
  subscribeQueuedMessages: listener => {
    const callback = (_event: Electron.IpcRendererEvent, value: { hostId: string; sessionId: string }) => listener(value);
    ipcRenderer.on("host:queued-messages-changed", callback);
    return () => ipcRenderer.removeListener("host:queued-messages-changed", callback);
  },
  mutateGoal: (sessionId, request, hostId) => ipcRenderer.invoke("host:goal-control", sessionId, request, hostId),
  getSessionActivity: (sessionId, hostId) => ipcRenderer.invoke("host:session-activity", sessionId, hostId),
  sessionMcpApp: (sessionId, request, hostId) => ipcRenderer.invoke("host:mcp-app", sessionId, request, hostId),
  readSessionMcpResource: (sessionId, request, hostId) => ipcRenderer.invoke("host:mcp-resource", sessionId, request, hostId),
  getSessionMcp: (sessionId, hostId, commandId) => ipcRenderer.invoke("host:session-mcp", sessionId, hostId, commandId),
  getSessionMcpAuthorization: (sessionId, hostId, commandId) => ipcRenderer.invoke("host:session-mcp-authorization", sessionId, hostId, commandId),
  respondSessionMcpAuthorization: (sessionId, reply, hostId) => ipcRenderer.invoke("host:session-mcp-authorization-respond", sessionId, reply, hostId),
  cancelSessionMcpAuthorization: (sessionId, authorizationId, hostId) => ipcRenderer.invoke("host:session-mcp-authorization-cancel", sessionId, authorizationId, hostId),
  getBtw: (sessionId, hostId) => ipcRenderer.invoke("host:btw", sessionId, hostId),
  getBrowserMetadata: (sessionId, hostId) => ipcRenderer.invoke("host:browser-metadata", sessionId, hostId),
  getBrowserHistory: (sessionId, request, hostId) => ipcRenderer.invoke("host:browser-history", sessionId, request, hostId),
  createBrowserTab: (sessionId, request, hostId) => ipcRenderer.invoke("host:browser-create", sessionId, request, hostId),
  getBrowserCreationStatus: (sessionId, request, hostId) => ipcRenderer.invoke("host:browser-creation-status", sessionId, request, hostId),
  controlBrowser: (sessionId, request, hostId) => ipcRenderer.invoke("host:browser-control", sessionId, request, hostId),
  getBrowserFrame: (sessionId, target, hostId) => ipcRenderer.invoke("host:browser-frame", sessionId, target, hostId),
  chooseDirectory: () => ipcRenderer.invoke("desktop:directory"),
  revealProjectDirectory: createProjectRevealBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  subscribe: listener => {
    const callback = (_event: Electron.IpcRendererEvent, message: DesktopEvent) => listener(message);
    ipcRenderer.on("host:event", callback);
    return () => ipcRenderer.removeListener("host:event", callback);
  },
};
contextBridge.exposeInMainWorld("agentDesktop", bridge);

// A distinct bridge keeps this presentation state out of every host API/cache.
contextBridge.exposeInMainWorld("agentDesktopWindow", {
  initial: ipcRenderer.sendSync("desktop:window-state:read"),
  save: (state: unknown) => ipcRenderer.sendSync("desktop:window-state:save", state),
  subscribe: (listener: (status: { error?: string }) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, status: { error?: string }) => listener(status);
    ipcRenderer.on("desktop:window-state:status", receive);
    return () => ipcRenderer.removeListener("desktop:window-state:status", receive);
  },
});
