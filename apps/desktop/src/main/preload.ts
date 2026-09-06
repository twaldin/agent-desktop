import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopEvent, DesktopTerminalEvent, NativeTerminalInvalidation } from "@agent-desktop/shared";

const bridge: DesktopBridge = {
  inspectImageAttachment: data => ipcRenderer.invoke("desktop:image-inspect", data),
  getImageAttachmentCapabilities: hostId => ipcRenderer.invoke("host:image-capabilities", hostId),
  uploadImageAttachment: (sha256, data, hostId) => ipcRenderer.invoke("host:image-upload", sha256, data, hostId),
  getImageAttachment: (sha256, hostId) => ipcRenderer.invoke("host:image-read", sha256, hostId),
  getTranscriptImage: (sessionId, nativeEntryId, blockIndex, hostId) => ipcRenderer.invoke("host:transcript-image", sessionId, nativeEntryId, blockIndex, hostId),
  getState: hostId => ipcRenderer.invoke("host:state", hostId),
  getHosts: () => ipcRenderer.invoke("host:peers"),
  getProviders: hostId => ipcRenderer.invoke("host:providers", hostId),
  getAccounts: (providerId, hostId) => ipcRenderer.invoke("host:accounts", providerId, hostId),
  getSessionAccounts: (sessionId, hostId) => ipcRenderer.invoke("host:session-accounts", sessionId, hostId),
  getInteractions: (sessionId, hostId) => ipcRenderer.invoke("host:interactions", sessionId, hostId),
  workspaceQuery: (target, query, hostId) => ipcRenderer.invoke("host:workspace-query", target, query, hostId),
  getPreferences: () => ipcRenderer.invoke("host:preferences"),
  getTheme: () => ipcRenderer.invoke("host:theme"),
  setTheme: (document, expectedRevision) => ipcRenderer.invoke("host:theme-set", document, expectedRevision),
  getLocalFonts: () => ipcRenderer.invoke("desktop:fonts"),
  openThemeFile: () => ipcRenderer.invoke("desktop:open-theme"),
  applyWindowTheme: effects => ipcRenderer.invoke("desktop:window-theme", effects),
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
  nativeTerminalAction: (action, hostId) => ipcRenderer.invoke("host:native-terminal-action", action, hostId),
  writeNativeTerminal: (input, hostId) => ipcRenderer.invoke("host:native-terminal-input", input, hostId),
  subscribeNativeTerminals: listener => {
    const callback = (_event: Electron.IpcRendererEvent, message: NativeTerminalInvalidation & { hostId: string }) => listener(message);
    ipcRenderer.on("host:native-terminal-event", callback);
    return () => ipcRenderer.removeListener("host:native-terminal-event", callback);
  },
  getSettingsCatalog: hostId => ipcRenderer.invoke("host:settings-catalog", hostId),
  getSettings: (target, hostId) => ipcRenderer.invoke("host:settings-read", target, hostId),
  setSetting: (mutation, target, hostId) => ipcRenderer.invoke("host:settings-mutate", mutation, target, hostId),
  getSettingOptions: (path, target, hostId) => ipcRenderer.invoke("host:settings-options", path, target, hostId),
  getModelCapabilities: (target, refresh, hostId) => ipcRenderer.invoke("host:model-capabilities", target, refresh, hostId),
  getComposerActions: (target, refresh, hostId) => ipcRenderer.invoke("host:composer-actions", target, refresh, hostId),
  getComposerCompletions: (query, hostId) => ipcRenderer.invoke("host:composer-completions", query, hostId),
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
  getMessages: (sessionId, hostId) => ipcRenderer.invoke("host:messages", sessionId, hostId),
  getSessionActivity: (sessionId, hostId) => ipcRenderer.invoke("host:session-activity", sessionId, hostId),
  getBrowserMetadata: (sessionId, hostId) => ipcRenderer.invoke("host:browser-metadata", sessionId, hostId),
  createBrowserTab: (sessionId, request, hostId) => ipcRenderer.invoke("host:browser-create", sessionId, request, hostId),
  controlBrowser: (sessionId, request, hostId) => ipcRenderer.invoke("host:browser-control", sessionId, request, hostId),
  getBrowserFrame: (sessionId, target, hostId) => ipcRenderer.invoke("host:browser-frame", sessionId, target, hostId),
  chooseDirectory: () => ipcRenderer.invoke("desktop:directory"),
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
