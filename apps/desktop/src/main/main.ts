import { parsePullRequestWriteRequest } from '../../../../packages/shared/src/pull-request-write';
import { requestPullRequestWrite } from './pull-request-write-transport';
import { parsePullRequestReadRequest } from '../../../../packages/shared/src/pull-requests';
import { readPullRequests } from './pull-requests-transport';
import { HtmlPreviewDocument } from './html-preview-document';
import { requestHtmlPreview } from './html-preview-transport';
import { McpOwnerMainChannels } from "./mcp-owner-main-channels";
import { requestMcpOwner } from "./mcp-owner-transport";
import { McpAppWindowChannels } from "./mcp-app-window-channels";
import { readLocalFontFaces } from "./local-fonts";
import { registerBrowserCloseHandlers } from "./browser-close-ipc";
import { registerBrowserObservationHandlers } from "./browser-observation-ipc";
import { registerDraftBrowserHandlers } from "./draft-browser-ipc";
import { registerProjectRevealHandler } from "./project-reveal-ipc";
import { BranchQueryConnection } from "./branch-query-connection";
import { BranchQueryWindows } from "./branch-query-windows";
import { attachWorkspaceQueryEvents } from "./workspace-query-events";
import { RepositoryWatchConnection } from "./repository-watch-connection";
import { RepositoryWatchWindows } from "./repository-watch-windows";
import type { BranchQueryMessage, RepositoryWatchStatus } from "@agent-desktop/shared";
import { ModifierReleaseWatches, resolveModifierMonitor, watchNativeModifier } from "./modifier-release";
import { SessionSearchRequests } from "./session-search-requests";
import { requestSessionSearch } from "./session-search-transport";
import { KeepAwake } from "./keep-awake";
import type { DeviceAccessState } from "@agent-desktop/shared";
import { parseDeviceAccessPolicy, parseDeviceAccessUpdate } from "../../../../packages/shared/src/device-access";
import {showDesktopContextMenu} from "./native-context-menu";
import { resolveWindowTheme } from "./window-theme";
import { parseNativeSkillFileRef } from "@agent-desktop/shared";
import { requestSessionMcpApp } from "./session-mcp-app-transport";
import { parseNativeMcpAppRequest } from "@agent-desktop/shared";
import { requestSessionMcpResource } from "./session-mcp-resource-transport";
import { closePluginAcquisitionRequest, requestMarketplaceCatalog, requestPluginAcquisitionOperations, reviewPluginAcquisition, startPluginAcquisition } from "./plugin-acquisition-transport";
import { requestSessionOutputs } from "./session-outputs-transport";
import { requestSessionMcp } from "./session-mcp-transport";
import { cancelSessionMcpAuthorization, requestSessionMcpAuthorization, respondSessionMcpAuthorization } from "./session-mcp-authorization-transport";
import type { NativePluginMutation, NativeMcpMutation, NativeMcpDetailRequest } from "@agent-desktop/shared";
import type { NativePluginAcquisition, NativePluginAcquisitionRequest } from "@agent-desktop/shared";
import { requestGoalMutation } from "./goal-control-transport";
import { listAutomations, mutateAutomation } from './automations-transport';
import { parseAutomationMutation, parseAutomationsQuery } from '../../../../packages/shared/src/automations';
import { requestComposerActions, requestComposerCompletions, requestSkillDetail, requestSkillInventory, requestSkillFile, requestSkillFileOpenOptions, requestSkillFileCopy, requestSkillImage } from "./composer-actions-transport";
import { requestSessionActivity } from "./session-activity-transport";
import { requestBtw } from "./btw-transport";
import { mutateQueuedMessages, requestQueuedMessages } from "./queued-messages-transport";
import { requestDetachedQuestions } from './detached-questions-transport';
import { requestBrowserMetadata } from "./browser-metadata-transport";
import { requestBrowserHistory } from "./browser-history-transport";
import { requestBrowserAutocomplete } from "./browser-autocomplete-transport";
import { requestBrowserFrame } from "./browser-frame-transport";
import { requestBrowserControl } from "./browser-control-transport";
import { requestBrowserCreate, requestBrowserCreationStatus } from "./browser-create-transport";
import { requestTerminalCreationCapabilities, requestTerminalCreate, requestTerminalCreationStatus } from "./terminal-create-transport";
import type { TerminalCreationRequest } from "@agent-desktop/shared";
import type { BrowserControlRequest, BrowserCreateRequest, BrowserFrameTarget } from "@agent-desktop/shared";
import type { ComposerCompletionQuery, NativeSkillFileRef } from "@agent-desktop/shared";
import { NotificationDelivery } from "./notification-delivery";
import { NotificationNavigation } from "./notification-navigation";
import { parsePreferencesSnapshot, type NotificationPreferences } from "../../../../packages/shared/src/preferences";
import { app, Notification, BrowserWindow, dialog, ipcMain, nativeImage, protocol, screen, shell, powerMonitor, powerSaveBlocker } from "electron";
import { captureDesktop } from "./capture";
import { WindowStateStore, restoreWindowBounds, trackWindowGeometry } from "./window-state";
import { nativeTerminalResult, requestHost, type HostEndpoint } from "./host-transport";
import { registerPreferencesV2Handler } from "./preferences-ipc";
import { inspectImageAttachment, requestImageAttachmentCapabilities, requestImageAttachment, requestTranscriptImage, uploadImageAttachment } from "./attachment-transport";
import { requestComposerCatalog } from "./composer-transport";
import { requestVersionedCommand, requestVersionedControl } from "./command-endpoints";
import { verifyKnownHost } from "./host-recovery";
import { resolveHostLaunch } from "./host-launch";
import { saveWorkspaceCopy, workspaceCopySource, workspaceCopyOutcome } from "./workspace-save-copy";
import { WorkspaceImageGrants } from "./workspace-image";
import { WindowCloseGate } from "./window-close";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountAction, CommandEnvelope, DesktopEvent, HostEvent, HostState, NetworkState, OmpInteractionResponse, OmpSessionControlMutation, OmpSettingsMutation, WorkspaceQuery, WorkspaceTarget } from "@agent-desktop/shared";
import { getDataDirectory, type LocalConnection } from "../../../host/src/paths";
import type { TerminalInvalidation, TerminalControlAction, TerminalInputRequest, TerminalQueryResult, ThemeAsset, ThemeState, ThemeDocument, WindowThemeEffects } from "@agent-desktop/shared";
import type { OmpModelDefinitionsMutation } from "@agent-desktop/shared";
import type { NativeTerminalAction, NativeTerminalInputRequest, NativeTerminalInvalidation, NativeTerminalQuery } from "@agent-desktop/shared";

protocol.registerSchemesAsPrivileged([{ scheme: "agent-workspace-image", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName("Agent Desktop");
const dataDirectory = getDataDirectory();
app.setPath("userData", process.env.AGENT_DESKTOP_PROFILE_DIR || dataDirectory);
// A capture profile is a separate, hidden process. Normal launches reuse this profile's window.
const primaryInstance = Boolean(process.env.AGENT_DESKTOP_CAPTURE) || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
const connectionPath = join(dataDirectory, "connection.json");
const windows = new Set<BrowserWindow>();
const modifierWatches = new ModifierReleaseWatches((modifier, signal) => {
  if (process.platform !== "darwin") return Promise.resolve("unavailable");
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "dist");
  return watchNativeModifier(resolveModifierMonitor(root), modifier, signal);
});
const windowThemeEffects = new Map<BrowserWindow, WindowThemeEffects>();
function applyNativeWindowTheme(window: BrowserWindow) {
  const effects = windowThemeEffects.get(window);
  if (!effects || window.isDestroyed()) return;
  const bounds = window.getBounds();
  const resolved = resolveWindowTheme(effects, { platform: process.platform, focused: window.isFocused(),
    width: bounds.width, height: bounds.height, scaleFactor: screen.getDisplayMatching(bounds).scaleFactor });
  window.setBackgroundColor(resolved.backgroundColor);
  if (process.platform === "darwin") window.setVibrancy(resolved.vibrancy);
  if (!window.webContents.isDestroyed()) window.webContents.send("desktop:window-theme-state", resolved.opaqueWindows);
}
const htmlPreviewDocuments = new Map<number, HtmlPreviewDocument>();
const htmlPreviewDrains = new Set<HtmlPreviewDocument>();
const mcpOwnerDocuments = new McpOwnerMainChannels({
  ipcMain,
  available: () => !shuttingDown,
  assertTrusted: assertTrustedSender,
  connect: endpointFor,
  request: requestMcpOwner,
  reportCleanupError: error => console.error("MCP directory owner cleanup failed:", error),
});
const mcpAppDocuments = new Map<number, McpAppWindowChannels>();
const mcpAppDocumentDrains = new Set<McpAppWindowChannels>();
function retireMcpAppDocument(senderId: number) {
  mcpOwnerDocuments.retireDocument(senderId);
  const html = htmlPreviewDocuments.get(senderId);
  if (html) { htmlPreviewDocuments.delete(senderId); htmlPreviewDrains.add(html); void html.retire().then(() => htmlPreviewDrains.delete(html), error => console.error("HTML preview cleanup failed:", error)); }
  const owner = mcpAppDocuments.get(senderId);
  if (!owner) return;
  mcpAppDocuments.delete(senderId);
  const drain = owner.retire();
  mcpAppDocumentDrains.add(owner);
  void drain.then(() => mcpAppDocumentDrains.delete(owner), error => console.error("MCP app document cleanup failed:", error));
}
const workspaceImages = new WorkspaceImageGrants();
const workspaceImageEpochs = new Map<number, number>();
const windowCloseGate = new WindowCloseGate({
  senderIds: () => [...windows].filter(window => !window.isDestroyed()).map(window => window.webContents.id),
  prepareQuit: async () => {
    const release = await modifierWatches.pauseAndDrain();
    try { await Promise.all([...mcpAppDocumentDrains, ...htmlPreviewDrains].map(owner => owner.retire()).concat(mcpOwnerDocuments.drain())); return release; }
    catch (error) { release(); throw error; }
  },
  send: (senderId, request) => {
    const window = [...windows].find(candidate => candidate.webContents.id === senderId && !candidate.isDestroyed());
    if (!window || window.webContents.isDestroyed()) throw new Error("The renderer is unavailable.");
    window.webContents.send("desktop:window-close-request", request);
  },
  unavailable: (senderId, reason) => {
    const window = [...windows].find(candidate => candidate.webContents.id === senderId && !candidate.isDestroyed());
    if (!window) return;
    void dialog.showMessageBox(window, { type: "error", title: "Agent Desktop", message: "Agent Desktop could not safely close this window.",
      detail: reason === "timeout" ? "Saving and recovery preparation did not finish in time. Keep the window open and try again." : "The window is not ready to confirm that its work can be recovered. Keep it open and try again.", buttons: ["OK"] });
  },
});
const windowStates = new Map<number, WindowStateStore>();
let connection: LocalConnection | null = null;
type HostStream = { endpoint: HostEndpoint; sequence: number; repositoryWatches: RepositoryWatchConnection; branchQueries: BranchQueryConnection; socket?: WebSocket; timer?: ReturnType<typeof setTimeout> };
const streams = new Map<string, HostStream>();
const remoteHosts = new Map<string, HostEndpoint>();
let shuttingDown = false;
const repositoryWatchWindows = new RepositoryWatchWindows({
  connect: async (hostId, isCurrent) => {
    const endpoint = await endpointFor(hostId);
    if (shuttingDown || !isCurrent()) throw new Error("The repository watch window ended during host lookup.");
    if (endpoint.hostId !== hostId) throw new Error("The repository watch host identity changed.");
    connectEvents(endpoint);
    const stream = streams.get(hostId);
    if (!stream) throw new Error("Repository watch event connection is unavailable.");
    return stream.repositoryWatches;
  },
  notify: (senderId, status) => {
    const window = [...windows].find(value => !value.isDestroyed() && value.webContents.id === senderId);
    if (!window || window.webContents.isDestroyed()) throw new Error("Repository watch renderer is unavailable.");
    window.webContents.send("host:repository-watch-status", status);
  },
});
const branchQueryWindows = new BranchQueryWindows({
  connect: async (hostId, isCurrent) => {
    const endpoint = await endpointFor(hostId);
    if (shuttingDown || !isCurrent()) throw new Error("The branch query window ended during host lookup.");
    if (endpoint.hostId !== hostId) throw new Error("The branch query host identity changed.");
    connectEvents(endpoint);
    const stream = streams.get(hostId);
    if (!stream) throw new Error("Branch query event connection is unavailable.");
    return stream.branchQueries;
  },
  notify: (senderId, status) => {
    const window = [...windows].find(value => !value.isDestroyed() && value.webContents.id === senderId);
    if (!window || window.webContents.isDestroyed()) throw new Error("Branch query renderer is unavailable.");
    window.webContents.send("host:branch-query-status", status);
  },
});
const keepAwake = new KeepAwake({
  supported: process.platform === "darwin" || process.platform === "win32",
  onBattery: () => powerMonitor.isOnBatteryPower(),
  start: type => powerSaveBlocker.start(type), stop: id => powerSaveBlocker.stop(id), isStarted: id => powerSaveBlocker.isStarted(id),
}, async () => {
  const endpoint = await endpointFor();
  const [rawPreferences, rawAccess] = await Promise.all([requestHost(endpoint, "/v1/preferences"), requestHost(endpoint, "/v1/device-access")]);
  const snapshot = parsePreferencesSnapshot(rawPreferences);
  const access = rawAccess as DeviceAccessState;
  if (access?.hostId !== endpoint.hostId || connection?.hostId !== endpoint.hostId || typeof access.supported !== "boolean") throw new Error("Keep-awake policy belongs to an unavailable local host.");
  const policy = parseDeviceAccessPolicy(access.policy);
  const record = snapshot.records.find(record => record.key === "connections.keepAwakeWhilePluggedIn");
  return { requested: Boolean(record && !record.deleted && record.value === true), remoteAccessEnabled: access.supported && policy.enabled };
}, () => {
  for (const window of windows) if (!window.isDestroyed()) window.webContents.send("desktop:keep-awake-status");
});
let keepAwakeRefresh: ReturnType<typeof setInterval> | undefined;
let notificationPrefs: NotificationPreferences | undefined;
let notificationPreferencesLoaded = false;
let notificationQueue = Promise.resolve();
const notificationNavigation = new NotificationNavigation();
const notificationDelivery = new NotificationDelivery(join(app.getPath("userData"), "notification-delivery-v1.json"), {
  preferences: () => notificationPrefs,
  focused: () => [...windows].some(window => !window.isDestroyed() && window.isFocused()),
  supported: () => Notification.isSupported(),
  show: (notice, options) => {
    const notification = new Notification({ title: notice.title, body: notice.body, silent: options.silent });
    notification.on("click", options.onClick); notification.on("failed", options.onFailed); notification.on("close", options.onClosed);
    notification.show(); return notification;
  },
  navigate: target => { void openNotificationTarget(target); },
  statusChanged: () => { for (const window of windows) if (!window.isDestroyed()) window.webContents.send("desktop:notification-status"); },
});
async function refreshNotificationPreferences() {
  const snapshot = parsePreferencesSnapshot(await request("/v1/preferences"));
  const record = snapshot.records.find(record => record.key === "general.notifications");
  notificationPrefs = record && !record.deleted ? record.value as NotificationPreferences : undefined;
  notificationPreferencesLoaded = true;
  notificationDelivery.preferenceStatus();
  notificationDelivery.preferencesChanged();
}
async function openNotificationTarget(target: import("@agent-desktop/shared").NotificationNavigationTarget) {
  let window = [...windows].find(window => !window.isDestroyed());
  notificationNavigation.open(target, window?.webContents.id);
  try {
    if (!window) { await createWindow(); window = [...windows].find(window => !window.isDestroyed()); }
    if (!window) return;
    if (window.isMinimized()) window.restore(); window.show(); window.focus();
  } catch { /* Retain the target for the next successfully opened window. */ }
}


function readConnection(): LocalConnection | null {
  try {
    const value = JSON.parse(readFileSync(connectionPath, "utf8")) as LocalConnection;
    if (new URL(value.origin).hostname !== "127.0.0.1" || !value.token) return null;
    return value;
  } catch { return null; }
}

async function probe(value: LocalConnection): Promise<boolean> {
  try {
    const response = await fetch(`${value.origin}/v1/health`, {
      headers: { Authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1000),
    });
    const health = await response.json() as { hostId?: string; protocolVersion?: number };
    return response.ok && health.hostId === value.hostId && health.protocolVersion === 1;
  } catch { return false; }
}

let startingHost: Promise<LocalConnection> | undefined;
function ensureHost(): Promise<LocalConnection> {
  if (!startingHost) {
    startingHost = startOrFindHost().finally(() => { startingHost = undefined; });
  }
  return startingHost;
}

async function startOrFindHost(): Promise<LocalConnection> {
  const current = readConnection();
  if (current && await probe(current)) return current;
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const { bun, entry } = resolveHostLaunch({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath,
    homeDirectory: homedir(), environment: { AGENT_DESKTOP_BUN: process.env.AGENT_DESKTOP_BUN,
      AGENT_DESKTOP_PROJECT_ROOT: process.env.AGENT_DESKTOP_PROJECT_ROOT } });
  const output = openSync(join(dataDirectory, "host.log"), "a", 0o600);
  const child = spawn(bun, [...(process.env.PI_DISABLE_DOTENV === "1" ? ["--no-env-file"] : []), entry], {
    detached: true, stdio: ["ignore", output, output],
    env: { ...process.env, AGENT_DESKTOP_DATA_DIR: dataDirectory },
  });
  closeSync(output);
  let launchError: Error | undefined;
  child.on("error", error => { launchError = error; });
  child.unref();
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const candidate = readConnection();
    if (candidate && await probe(candidate)) return candidate;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`The local host did not start. See ${join(dataDirectory, "host.log")}.`);
}

function broadcast(event: DesktopEvent): void {
  for (const window of windows) if (!window.isDestroyed()) window.webContents.send("host:event", event);
}

async function discoverHosts(): Promise<NetworkState> {
  const state = await request("/v1/peers") as NetworkState;
  const available = new Set<string>();
  for (const peer of state.hosts) {
    if (peer.availability === "available" && peer.host && peer.origin) {
      available.add(peer.host.id);
      remoteHosts.set(peer.host.id, { hostId: peer.host.id, origin: peer.origin });
    }
  }
  for (const [id] of remoteHosts) {
    if (!available.has(id)) remoteHosts.delete(id);
  }
  return state;
}

async function endpointFor(hostId?: string): Promise<HostEndpoint> {
  if (hostId !== undefined && (typeof hostId !== "string" || hostId.length > 200)) throw new Error("Invalid host ID.");
  if (!connection) connection = await ensureHost();
  if (!hostId || hostId === connection.hostId) return connection;
  const remote = remoteHosts.get(hostId);
  if (remote) return remote;
  const previous = streams.get(hostId)?.endpoint;
  let discoveryError: unknown;
  try { await discoverHosts(); } catch (error) { discoveryError = error; }
  const discovered = remoteHosts.get(hostId);
  if (discovered) return discovered;
  if (previous) {
    const verified = await verifyKnownHost(previous);
    remoteHosts.set(hostId, verified);
    return verified;
  }
  if (discoveryError) throw discoveryError;
  throw new Error("The project's host is unavailable. Its cached history and draft remain on this device.");
}

function connectEvents(endpoint: HostEndpoint): void {
  if (shuttingDown) return;
  let stream = streams.get(endpoint.hostId);
  if (stream?.socket && stream.socket.readyState <= 1 && stream.endpoint.origin === endpoint.origin && stream.endpoint.token === endpoint.token) return;
  if (!stream) { stream = { endpoint, sequence: notificationDelivery.cursor(endpoint.hostId), repositoryWatches: new RepositoryWatchConnection(endpoint.hostId), branchQueries: new BranchQueryConnection(endpoint.hostId) }; streams.set(endpoint.hostId, stream); }
  stream.endpoint = endpoint;
  clearTimeout(stream.timer);
  stream.socket?.close();
  const current = stream;
  notificationDelivery.begin(endpoint.hostId);
  if (endpoint.hostId === connection?.hostId) keepAwake.connection(false);
  const url = `${endpoint.origin.replace(/^http/, "ws")}/v1/events?after=${Math.min(current.sequence, notificationDelivery.cursor(endpoint.hostId))}`;
  const next = new WebSocket(url, endpoint.token ? ["agent-desktop", endpoint.token] : ["agent-desktop"]);
  current.socket = next;
  let disconnectReason: string | undefined;
  const queryEvents = attachWorkspaceQueryEvents(current.repositoryWatches, current.branchQueries, {
    isCurrent: () => !shuttingDown && current.socket === next,
    send: request => {
      if (shuttingDown || current.socket !== next || next.readyState !== WebSocket.OPEN) throw new Error("Workspace query socket is unavailable.");
      next.send(JSON.stringify(request));
    },
    close: reason => { if (current.socket === next) { disconnectReason = reason; next.close(1002, reason); } },
  });
  const emitConnection = (connected: boolean, error?: string) => broadcast({ hostId: endpoint.hostId,
    sequence: current.sequence, type: "connection", connected, error });
  next.addEventListener("open", () => { if (current.socket === next && !shuttingDown) { emitConnection(true); if (endpoint.hostId === connection?.hostId) keepAwake.connection(true); } });
  next.addEventListener("message", ({ data }) => {
    if (current.socket !== next) return;
    try {
      const event = JSON.parse(String(data)) as HostEvent | { type: "terminal"; event: TerminalInvalidation }
        | { type: "native-terminal"; event: NativeTerminalInvalidation } | { type: "queued-messages"; sessionId: string } | RepositoryWatchStatus | BranchQueryMessage;
      if (event.type === "state" && (!Number.isSafeInteger(event.sequence) || event.sequence < 0)) return;
      if (queryEvents.receive(event)) return;
      // The router consumes both connection-local protocols before cursor handling.
      if (event.type === "repository-watch" || event.type === "branch-query") return;
      if (event.type === "terminal" || event.type === "native-terminal") {
        const channel = event.type === "terminal" ? "host:terminal-event" : "host:native-terminal-event";
        for (const window of windows) if (!window.isDestroyed()) window.webContents.send(channel, { ...event.event, hostId: endpoint.hostId });
        return;
      }
      if (event.type === "queued-messages") {
        if (typeof event.sessionId !== "string" || !event.sessionId || event.sessionId.length > 200 || event.sessionId.includes("\0")) return;
        for (const window of windows) if (!window.isDestroyed()) window.webContents.send("host:queued-messages-changed",
          { hostId: endpoint.hostId, sessionId: event.sessionId });
        return;
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) return;
      if (event.type === "state" && event.state.host.id !== endpoint.hostId) { disconnectReason = "The remote host identity changed."; queryEvents.disconnected(disconnectReason); next.close(1008, disconnectReason); return; }
      current.sequence = Math.max(current.sequence, event.sequence);
      broadcast({ ...event, hostId: endpoint.hostId });
      if (endpoint.hostId === connection?.hostId && (event.type === "preferences" || event.type === "device-access")) {
        keepAwake.invalidate();
        if (event.type === "device-access") for (const window of windows) if (!window.isDestroyed()) window.webContents.send("host:device-access-changed");
      }
      if (event.type !== "notification" && event.type !== "state" && event.type !== "preferences") return;
      notificationQueue = notificationQueue.then(async () => {
        if (current.socket !== next || shuttingDown) return;
        let refresh = !notificationPreferencesLoaded || event.type === "preferences" && endpoint.hostId === connection?.hostId;
        while (refresh && current.socket === next && next.readyState === WebSocket.OPEN && !shuttingDown) {
          try { await refreshNotificationPreferences(); refresh = false; }
          catch {
            notificationDelivery.preferenceStatus("Notification preferences could not be refreshed. Delivery is waiting for the local host.");
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
        if (refresh || current.socket !== next || shuttingDown) return;
        if (event.type === "notification") notificationDelivery.event(endpoint.hostId, event.sequence, event.notification);
        else if (event.type === "state") notificationDelivery.snapshot(endpoint.hostId, event.sequence, event.state.notifications, event.replayComplete === true);
      }).catch(() => { notificationPreferencesLoaded = false; });
    } catch { disconnectReason = "Invalid host event."; queryEvents.disconnected(disconnectReason); next.close(1002, disconnectReason); }
  });
  next.addEventListener("error", () => { queryEvents.disconnected("Workspace query socket failed."); next.close(); });
  const reconnect = async () => {
    if (current.socket !== next || shuttingDown) return;
    try {
      if (connection?.hostId === endpoint.hostId) {
        const local = readConnection();
        if (local && await probe(local)) connection = local;
      } else {
        // Discovery and the selected peer have independent failure modes.
        // endpointFor can still verify a previously authenticated peer below.
        try { await discoverHosts(); } catch { /* Retain its actual endpoint for a direct check. */ }
      }
      const resolved = await endpointFor(endpoint.hostId);
      if (connection?.hostId !== endpoint.hostId) await verifyKnownHost(resolved);
      if (current.socket === next && !shuttingDown) connectEvents(resolved);
    } catch {
      // Retry resolution and identity verification, not an unchecked old URL.
      if (current.socket === next && !shuttingDown) current.timer = setTimeout(reconnect, 3000);
    }
  };
  next.addEventListener("close", () => {
    queryEvents.disconnected(disconnectReason);
    if (current.socket !== next || shuttingDown) return;
    emitConnection(false, disconnectReason);
    if (endpoint.hostId === connection?.hostId) keepAwake.connection(false);
    clearTimeout(current.timer);
    current.timer = setTimeout(reconnect, 1500);
  });
}

async function request(path: string, body?: unknown, hostId?: string): Promise<unknown> {
  return requestHost(await endpointFor(hostId), path, body);
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || ![...windows].some(window => window.webContents === event.sender)) {
    throw new Error("Only the app's main frame may call the host.");
  }
  const url = new URL(frame.url);
  const development = process.env.AGENT_DESKTOP_RENDERER_URL;
  if (development ? url.origin !== new URL(development).origin : url.protocol !== "file:") {
    throw new Error("Untrusted app origin.");
  }
}

ipcMain.handle("desktop:modifier-release", (event, id: unknown, modifier: unknown) => {
  assertTrustedSender(event);
  return modifierWatches.watch(event.sender.id, id, modifier);
});
ipcMain.handle("desktop:modifier-release-cancel", (event, id: unknown) => {
  assertTrustedSender(event);
  if (typeof id !== "string") throw new Error("Invalid modifier release cancellation.");
  modifierWatches.cancel(event.sender.id, id);
});
ipcMain.handle("desktop:context-menu",(event,items:unknown)=>{assertTrustedSender(event);const owner=BrowserWindow.fromWebContents(event.sender);if(!owner)throw new Error("The menu window is unavailable.");return showDesktopContextMenu(owner,items)});
ipcMain.handle("desktop:notification-status", event => { assertTrustedSender(event); return notificationDelivery.status(); });
ipcMain.handle("desktop:notification-ready", event => {
  assertTrustedSender(event);
  notificationNavigation.ready({ id: event.sender.id, send: request => event.sender.send("desktop:notification-navigate", request) });
});
ipcMain.on("desktop:notification-ack", (event, id: string) => {
  assertTrustedSender(event); notificationNavigation.acknowledge(event.sender.id, id);
});
ipcMain.on("desktop:notification-unready", event => { assertTrustedSender(event); notificationNavigation.unready(event.sender.id); });
ipcMain.on("desktop:window-close-ready", event => { assertTrustedSender(event); windowCloseGate.register(event.sender.id); });
ipcMain.on("desktop:window-close-unready", event => { assertTrustedSender(event); windowCloseGate.unregister(event.sender.id); });
ipcMain.handle("desktop:window-close-answer", (event, id: string, allowed: boolean) => {
  assertTrustedSender(event);
  if (typeof id !== "string" || id.length > 200 || typeof allowed !== "boolean") throw new Error("Invalid window close response.");
  if (!windowCloseGate.answer(event.sender.id, id, allowed)) throw new Error("The window close request is no longer active.");
});
ipcMain.handle("host:state", async (event, hostId?: string) => {
  assertTrustedSender(event);
  const state = await request("/v1/state", undefined, hostId) as HostState;
  if (hostId && state.host.id !== hostId) throw new Error("The remote host identity changed.");
  connectEvents(await endpointFor(hostId));
  return state;
});
ipcMain.handle("host:command", (event, envelope: CommandEnvelope, hostId?: string) => {
  assertTrustedSender(event); return requestVersionedCommand((path, body) => request(path, body, hostId), envelope);
});
function requireImageOwner(hostId: string): string {
  if (typeof hostId !== "string" || !hostId.length || hostId.length > 200 || hostId.includes("\0")) throw new Error("Choose the image's owning host.");
  return hostId;
}
ipcMain.handle("desktop:image-inspect", (event, data: Uint8Array) => {
  assertTrustedSender(event); return inspectImageAttachment(data);
});
ipcMain.handle("host:image-capabilities", async (event, hostId: string) => {
  assertTrustedSender(event); return requestImageAttachmentCapabilities(await endpointFor(requireImageOwner(hostId)));
});
ipcMain.handle("host:image-upload", async (event, sha256: string, data: Uint8Array, hostId: string) => {
  assertTrustedSender(event); return uploadImageAttachment(await endpointFor(requireImageOwner(hostId)), sha256, data);
});
ipcMain.handle("host:image-read", async (event, sha256: string, hostId: string) => {
  assertTrustedSender(event); return requestImageAttachment(await endpointFor(requireImageOwner(hostId)), sha256);
});
ipcMain.handle("host:transcript-image", async (event, sessionId: string, nativeEntryId: string, blockIndex: number, hostId: string, source?: "generated") => {
  assertTrustedSender(event); return requestTranscriptImage(await endpointFor(requireImageOwner(hostId)), sessionId, nativeEntryId, blockIndex, source);
});
const sessionSearchRequests = new SessionSearchRequests();
const searchOwners = new WeakSet<Electron.WebContents>();
ipcMain.handle("host:session-search", async (event, input: import("@agent-desktop/shared").SessionSearchRequest, hostId: string, requestId: string = crypto.randomUUID()) => {
  assertTrustedSender(event);
  if (typeof hostId !== "string" || !hostId || hostId.length > 200 || /[\x00-\x1f\x7f]/.test(hostId)) throw new Error("Choose the chat search owning host.");
  if (!searchOwners.has(event.sender)) {
    searchOwners.add(event.sender);
    const owner = event.sender.id; event.sender.once("destroyed", () => sessionSearchRequests.close(owner));
  }
  return sessionSearchRequests.run(event.sender.id, hostId, requestId, async signal => {
    const endpoint = await endpointFor(hostId); signal.throwIfAborted();
    return requestSessionSearch(endpoint, input, signal);
  });
});
ipcMain.handle("host:session-search-cancel", (event, requestId: string, hostId: string) => {
  assertTrustedSender(event);
  if (typeof requestId !== "string" || typeof hostId !== "string") throw new Error("Invalid chat search cancellation.");
  sessionSearchRequests.cancel(event.sender.id, hostId, requestId);
});
ipcMain.handle("host:messages", (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event);
  if (typeof sessionId !== "string" || sessionId.length > 200) throw new Error("Invalid session ID.");
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, undefined, hostId);
});
ipcMain.handle("host:task-location", (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event);
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Invalid task location owner.");
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/task-location`, undefined, hostId);
});
ipcMain.handle("host:queued-messages", async (event, sessionId: string, hostId: string) => {
  assertTrustedSender(event); return requestQueuedMessages(await endpointFor(hostId), sessionId);
});
ipcMain.handle("host:queued-messages-mutate", async (event, sessionId: string,
  mutation: import("@agent-desktop/shared").NativeQueuedMessageMutation, hostId: string) => {
  assertTrustedSender(event); return mutateQueuedMessages(await endpointFor(hostId), sessionId, mutation);
});
ipcMain.handle("host:goal-control", async (event, sessionId: string, request: import("@agent-desktop/shared").GoalMutationRequest, hostId?: string) => {
  assertTrustedSender(event); return requestGoalMutation(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle('host:pull-request-write', async (event, hostId: string, operation: unknown, value: unknown) => {
  assertTrustedSender(event);
  const input = parsePullRequestWriteRequest(value);
  if (operation !== 'submit' && operation !== 'status') throw new Error('Invalid pull request submission operation.');
  if (typeof hostId !== 'string' || !hostId || hostId.length > 200) throw new Error('Choose the pull request execution host.');
  const endpoint = await endpointFor(hostId);
  assertTrustedSender(event);
  if (endpoint.hostId !== hostId) throw new Error('The pull request execution host changed.');
  return requestPullRequestWrite(endpoint, operation, input);
});
ipcMain.handle('host:pull-requests', async (event, hostId: string, value: unknown) => {
  assertTrustedSender(event);
  const input = parsePullRequestReadRequest(value);
  if (typeof hostId !== 'string' || !hostId || hostId.length > 200) throw new Error('Choose the pull request execution host.');
  const endpoint = await endpointFor(hostId);
  assertTrustedSender(event);
  if (endpoint.hostId !== hostId) throw new Error('The pull request execution host changed.');
  return readPullRequests(endpoint, input);
});
ipcMain.handle('host:automations', async (event, hostId: string, query: unknown) => {
  assertTrustedSender(event);
  const input = parseAutomationsQuery(query);
  if (typeof hostId !== 'string' || !hostId || hostId.length > 256) throw new Error('Choose the scheduled task host.');
  const endpoint = await endpointFor(hostId);
  assertTrustedSender(event);
  if (endpoint.hostId !== hostId) throw new Error('The scheduled task host changed.');
  return listAutomations(endpoint, input);
});
ipcMain.handle('host:automation-mutate', async (event, hostId: string, value: unknown) => {
  assertTrustedSender(event);
  const input = parseAutomationMutation(value);
  if (typeof hostId !== 'string' || !hostId || hostId.length > 256) throw new Error('Choose the scheduled task host.');
  const endpoint = await endpointFor(hostId);
  assertTrustedSender(event);
  if (endpoint.hostId !== hostId) throw new Error('The scheduled task host changed.');
  return mutateAutomation(endpoint, input);
});
ipcMain.handle("host:session-activity", async (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event); return requestSessionActivity(await endpointFor(hostId), sessionId);
});
ipcMain.handle("host:mcp-app", (event, sessionId: string, input: import("@agent-desktop/shared").NativeMcpAppRequest, hostId: string) => {
  assertTrustedSender(event);
  const request = parseNativeMcpAppRequest(input), sender = event.sender, frame = event.senderFrame;
  let owner = mcpAppDocuments.get(sender.id);
  if (!owner) {
    owner = new McpAppWindowChannels({
      current: () => !shuttingDown && !sender.isDestroyed() && sender.mainFrame === frame && mcpAppDocuments.get(sender.id) === owner,
      connect: async host => { const endpoint = await endpointFor(host); assertTrustedSender(event); return endpoint; },
      request: requestSessionMcpApp,
      reportOperationErrors: count => console.error(`MCP app document retired with ${count} unconfirmed operation errors; no operations were replayed.`),
    });
    mcpAppDocuments.set(sender.id, owner);
  }
  return owner.dispatch(sessionId, hostId, request);
});
ipcMain.handle("host:mcp-resource", async (event, sessionId: string, request: import("@agent-desktop/shared").NativeSessionMcpResourceRequest, hostId?: string) => {
  assertTrustedSender(event); return requestSessionMcpResource(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle("host:html-preview", (event, sessionId: string, input: import("../../../../packages/shared/src/html-preview").HtmlPreviewRequest | { leaseId: string }, hostId: string) => {
  assertTrustedSender(event);
  const sender = event.sender, frame = event.senderFrame;
  let owner = htmlPreviewDocuments.get(sender.id);
  if (!owner) {
    owner = new HtmlPreviewDocument({
      current: () => !shuttingDown && !sender.isDestroyed() && sender.mainFrame === frame && htmlPreviewDocuments.get(sender.id) === owner,
      connect: async host => { const endpoint = await endpointFor(requireImageOwner(host)); assertTrustedSender(event); return endpoint; },
      request: requestHtmlPreview,
    });
    htmlPreviewDocuments.set(sender.id, owner);
  }
  return owner.dispatch(sessionId, input, hostId);
});
ipcMain.handle("host:session-outputs", async (event, sessionId: string, hostId: string) => {
  assertTrustedSender(event);
  const endpoint = await endpointFor(requireImageOwner(hostId));
  assertTrustedSender(event);
  return requestSessionOutputs(endpoint, sessionId);
});
ipcMain.handle("host:session-mcp", async (event, sessionId: string, hostId?: string, commandId?: string) => {
  assertTrustedSender(event); return requestSessionMcp(await endpointFor(hostId), sessionId, commandId);
});
function requireMcpAuthorizationOwner(hostId: string): string {
  if (typeof hostId !== "string" || !hostId.length || hostId.length > 200 || /[\0-\x1f\x7f]/.test(hostId)) throw new Error("Choose the MCP authorization owning host.");
  return hostId;
}
ipcMain.handle("host:session-mcp-authorization", async (event, sessionId: string, hostId: string, commandId?: string) => {
  assertTrustedSender(event); return requestSessionMcpAuthorization(await endpointFor(requireMcpAuthorizationOwner(hostId)), sessionId, commandId);
});
ipcMain.handle("host:session-mcp-authorization-respond", async (event, sessionId: string, reply: import("@agent-desktop/shared").NativeMcpAuthorizationReply, hostId: string) => {
  assertTrustedSender(event); return respondSessionMcpAuthorization(await endpointFor(requireMcpAuthorizationOwner(hostId)), sessionId, reply);
});
ipcMain.handle("host:session-mcp-authorization-cancel", async (event, sessionId: string, authorizationId: string, hostId: string) => {
  assertTrustedSender(event); return cancelSessionMcpAuthorization(await endpointFor(requireMcpAuthorizationOwner(hostId)), sessionId, authorizationId);
});
ipcMain.handle("host:btw", async (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event); return requestBtw(await endpointFor(hostId), sessionId);
});
ipcMain.handle('host:detached-questions', async (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event); return requestDetachedQuestions(await endpointFor(hostId), sessionId);
});
registerDraftBrowserHandlers(ipcMain, assertTrustedSender, endpointFor);
registerBrowserCloseHandlers(ipcMain, assertTrustedSender, endpointFor);
registerBrowserObservationHandlers(ipcMain, assertTrustedSender, endpointFor);

ipcMain.handle("host:browser-metadata", async (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserMetadata(await endpointFor(hostId), sessionId);
});
ipcMain.handle("host:browser-history", async (event, sessionId: string, request: import("@agent-desktop/shared").BrowserHistoryRequest, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserHistory(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle("host:browser-autocomplete", async (event, sessionId: string, request: import("@agent-desktop/shared").BrowserAutocompleteRequest, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserAutocomplete(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle("host:browser-create", async (event, sessionId: string, request: BrowserCreateRequest, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserCreate(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle("host:browser-creation-status", async (event, sessionId: string, request: BrowserCreateRequest, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserCreationStatus(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle("host:browser-control", async (event, sessionId: string, request: BrowserControlRequest, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserControl(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle("host:browser-frame", async (event, sessionId: string, target: BrowserFrameTarget, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserFrame(await endpointFor(hostId), sessionId, target);
});
ipcMain.handle("host:peers", event => { assertTrustedSender(event); return discoverHosts(); });
ipcMain.handle("desktop:keep-awake-status", event => { assertTrustedSender(event); return keepAwake.status(); });
ipcMain.handle("host:device-access", event => { assertTrustedSender(event); return request("/v1/device-access"); });
ipcMain.handle("host:device-access-update", async (event, input: unknown) => {
  assertTrustedSender(event);
  const update = parseDeviceAccessUpdate(input);
  const state = await request("/v1/device-access", update);
  for (const window of windows) if (!window.isDestroyed()) window.webContents.send("host:device-access-changed");
  return state;
});
ipcMain.handle("host:preferences", event => { assertTrustedSender(event); return request("/v1/preferences"); });
registerPreferencesV2Handler(ipcMain, assertTrustedSender, path => request(path));
ipcMain.handle("host:theme", event => { assertTrustedSender(event); return request("/v1/theme"); });
ipcMain.handle("host:theme-set", (event, document: ThemeDocument, expectedRevision: string) => {
  assertTrustedSender(event); return request("/v1/theme", { document, expectedRevision });
});
ipcMain.handle("host:terminals", async (event, target?: WorkspaceTarget, hostId?: string) => {
  assertTrustedSender(event);
  const result = await request("/v1/terminals/query", { type: "list", target }, hostId) as TerminalQueryResult;
  if (result.type !== "list") throw new Error("Invalid terminal catalog response.");
  connectEvents(await endpointFor(hostId));
  return result.terminals;
});
ipcMain.handle("host:terminal-replay", async (event, terminalId: string, afterSequence?: number, hostId?: string) => {
  assertTrustedSender(event);
  const result = await request("/v1/terminals/query", { type: "replay", terminalId, afterSequence }, hostId) as TerminalQueryResult;
  if (result.type !== "replay") throw new Error("Invalid terminal replay response.");
  return result.replay;
});
ipcMain.handle("host:terminal-action", (event, action: TerminalControlAction, hostId?: string) => {
  assertTrustedSender(event); return request("/v1/terminals/action", action, hostId);
});
ipcMain.handle("host:terminal-input", (event, input: TerminalInputRequest, hostId?: string) => {
  assertTrustedSender(event); return request("/v1/terminals/input", input, hostId);
});
async function terminalCreationEndpoint(hostId: string) {
  if (typeof hostId !== "string" || !hostId) throw new Error("An explicit terminal owner is required.");
  const endpoint = await endpointFor(hostId);
  if (endpoint.hostId !== hostId) throw new Error("The terminal host identity changed.");
  return endpoint;
}
ipcMain.handle("host:terminal-creation-capabilities", (event, hostId: string) => {
  assertTrustedSender(event); return nativeTerminalResult(async () => requestTerminalCreationCapabilities(await terminalCreationEndpoint(hostId)));
});
ipcMain.handle("host:terminal-create", (event, request: TerminalCreationRequest, hostId: string) => {
  assertTrustedSender(event); return nativeTerminalResult(async () => requestTerminalCreate(await terminalCreationEndpoint(hostId), request));
});
ipcMain.handle("host:terminal-creation-status", (event, request: TerminalCreationRequest, hostId: string) => {
  assertTrustedSender(event); return nativeTerminalResult(async () => requestTerminalCreationStatus(await terminalCreationEndpoint(hostId), request));
});
ipcMain.handle("host:native-terminal-capabilities", (event, hostId?: string) => {
  assertTrustedSender(event);
  return nativeTerminalResult(async () => {
    const capabilities = await request("/v2/terminals/capabilities", undefined, hostId);
    connectEvents(await endpointFor(hostId));
    return capabilities;
  });
});
ipcMain.handle("host:native-terminal-query", (event, query: NativeTerminalQuery, hostId?: string) => {
  assertTrustedSender(event); return nativeTerminalResult(() => request("/v2/terminals/query", query, hostId));
});
ipcMain.handle("host:native-terminal-action", (event, action: NativeTerminalAction, hostId?: string) => {
  assertTrustedSender(event); return nativeTerminalResult(() => request("/v2/terminals/action", action, hostId));
});
ipcMain.handle("host:native-terminal-input", (event, input: NativeTerminalInputRequest, hostId?: string) => {
  assertTrustedSender(event); return nativeTerminalResult(() => request("/v2/terminals/input", input, hostId));
});
ipcMain.handle("desktop:fonts", async event => {
  assertTrustedSender(event);
  const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies));'], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const families: unknown = JSON.parse(stdout);
  if (!Array.isArray(families) || families.some(item => typeof item !== "string")) throw new Error("The system font catalog could not be read.");
  return [...new Set(["system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "sans-serif", "serif", "monospace", ...families as string[]])].sort();
});
ipcMain.handle("desktop:font-faces", event => { assertTrustedSender(event); return readLocalFontFaces(); });
ipcMain.handle("desktop:open-theme", async event => {
  assertTrustedSender(event);
  await request("/v1/theme") as ThemeState;
  const error = await shell.openPath(join(dataDirectory, "theme.json"));
  if (error) throw new Error(error);
});
ipcMain.handle("desktop:theme-background-import", async event => {
  assertTrustedSender(event);
  const selection = await dialog.showOpenDialog({ title: "Choose a theme background", properties: ["openFile"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
  const path = selection.filePaths[0]; if (selection.canceled || !path) return null;
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 20 * 1024 * 1024) throw new Error("Choose a PNG, JPEG or WebP image smaller than 20 MiB.");
  const bytes = await readFile(path);
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("The selected image exceeds 20 MiB.");
  const decoded = nativeImage.createFromBuffer(bytes); const size = decoded.getSize();
  if (decoded.isEmpty() || size.width * size.height > 40_000_000) throw new Error("The image could not be decoded or exceeds 40 million pixels.");
  const endpoint = await endpointFor();
  const response = await fetch(`${endpoint.origin}/v1/theme/assets`, { method: "POST", headers: endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}, body: bytes, signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error("The selected image could not be saved on the local host.");
  return await response.json() as ThemeAsset;
});
ipcMain.handle("desktop:theme-background", async (event, sha256: string) => {
  assertTrustedSender(event);
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid theme image digest.");
  const endpoint = await endpointFor();
  const response = await fetch(`${endpoint.origin}/v1/theme/assets/${sha256}`, { headers: endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}, signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("The theme image could not be loaded.");
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get("content-type") as ThemeAsset["mimeType"];
  if (bytes.byteLength > 20 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) throw new Error("Invalid stored theme image.");
  return { asset: { sha256, mimeType, bytes: bytes.byteLength }, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
});
ipcMain.handle("desktop:window-theme", (event, effects: WindowThemeEffects) => {
  assertTrustedSender(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) throw new Error("The theme window is unavailable.");
  resolveWindowTheme(effects, { platform: process.platform, focused: window.isFocused(), ...window.getBounds(), scaleFactor: 1 });
  if (!windowThemeEffects.has(window)) {
    const refresh = () => applyNativeWindowTheme(window);
    window.on("focus", refresh); window.on("blur", refresh); window.on("show", refresh);
    window.on("resize", refresh); window.on("move", refresh);
    screen.on("display-metrics-changed", refresh);
    window.once("closed", () => { windowThemeEffects.delete(window); screen.removeListener("display-metrics-changed", refresh); });
  }
  windowThemeEffects.set(window, effects);
  applyNativeWindowTheme(window);
});
ipcMain.handle("host:settings-catalog", (event, hostId?: string) => { assertTrustedSender(event); return request("/v1/settings/catalog", undefined, hostId); });
ipcMain.handle("host:plugins-read", (event, target?: WorkspaceTarget, hostId?: string) => { assertTrustedSender(event); return request("/v1/integrations/plugins/read", { target }, hostId); });
ipcMain.handle("host:plugins-mutate", (event, target: WorkspaceTarget | undefined, mutation: NativePluginMutation, hostId?: string) => { assertTrustedSender(event); return request("/v1/integrations/plugins/mutate", { target, mutation }, hostId); });
ipcMain.handle("host:plugin-acquisition-catalog", async (event, target?: WorkspaceTarget, hostId?: string) => {
  assertTrustedSender(event); return requestMarketplaceCatalog(await endpointFor(hostId), target);
});
ipcMain.handle("host:plugin-acquisition-start", async (event, target: WorkspaceTarget | undefined, acquisition: NativePluginAcquisitionRequest, hostId?: string) => {
  assertTrustedSender(event); return startPluginAcquisition(await endpointFor(hostId), target, acquisition);
});
ipcMain.handle("host:plugin-acquisition-operations", async (event, hostId?: string) => {
  assertTrustedSender(event); return requestPluginAcquisitionOperations(await endpointFor(hostId));
});
ipcMain.handle("host:plugin-acquisition-review", async (event, target: WorkspaceTarget | undefined, id: string, expectedRevision: string, hostId?: string) => {
  assertTrustedSender(event); return reviewPluginAcquisition(await endpointFor(hostId), target, id, expectedRevision);
});
ipcMain.handle("host:plugin-acquisition-close", async (event, target: WorkspaceTarget | undefined, close: { id: string; operation: NativePluginAcquisition["operation"] }, hostId?: string) => {
  assertTrustedSender(event); return closePluginAcquisitionRequest(await endpointFor(hostId), target, close);
});
ipcMain.handle("host:ssh-read", (event, target?: WorkspaceTarget, hostId?: string) => { assertTrustedSender(event); return request("/v1/integrations/ssh/read", { target }, hostId); });
ipcMain.handle("host:ssh-detail", (event, target: WorkspaceTarget | undefined, detail: import("@agent-desktop/shared").NativeSshDetailRequest, hostId?: string) => { assertTrustedSender(event); return request("/v1/integrations/ssh/detail", { target, request: detail }, hostId); });
ipcMain.handle("host:ssh-mutate", (event, target: WorkspaceTarget | undefined, mutation: import("@agent-desktop/shared").NativeSshMutation, hostId?: string) => { assertTrustedSender(event); return request("/v1/integrations/ssh/mutate", { target, mutation }, hostId); });
ipcMain.handle("host:mcp-read", (event, target?: WorkspaceTarget, hostId?: string) => { assertTrustedSender(event); return request("/v1/integrations/mcp/read", { target }, hostId); });
ipcMain.handle("host:mcp-detail", (event, target: WorkspaceTarget | undefined, detail: NativeMcpDetailRequest, hostId?: string) => { assertTrustedSender(event); return request("/v1/integrations/mcp/detail", { target, request: detail }, hostId); });
ipcMain.handle("host:mcp-mutate", (event, target: WorkspaceTarget | undefined, mutation: NativeMcpMutation, hostId?: string) => { assertTrustedSender(event); return request("/v1/integrations/mcp/mutate", { target, mutation }, hostId); });
ipcMain.handle("host:settings-read", (event, target?: WorkspaceTarget, hostId?: string) => { assertTrustedSender(event); return request("/v1/settings/read", { target }, hostId); });
ipcMain.handle("host:settings-mutate", (event, mutation: OmpSettingsMutation, target?: WorkspaceTarget, hostId?: string) => {
  assertTrustedSender(event); return request("/v1/settings/mutate", { target, mutation }, hostId);
});
ipcMain.handle("host:settings-options", (event, path: string, target?: WorkspaceTarget, hostId?: string) => {
  assertTrustedSender(event); return request("/v1/settings/options", { target, path }, hostId);
});
ipcMain.handle("host:model-capabilities", (event, target?: WorkspaceTarget, refresh?: boolean, hostId?: string) => {
  assertTrustedSender(event); return request("/v1/models/capabilities", { target, refresh }, hostId);
});
ipcMain.handle("host:composer-actions", async (event, target?: WorkspaceTarget, refresh?: boolean, hostId?: string) => {
  assertTrustedSender(event); return requestComposerActions(await endpointFor(hostId), target, refresh);
});
ipcMain.handle("host:skill-inventory", async (event, target?: WorkspaceTarget, refresh?: boolean, hostId?: string) => {
  assertTrustedSender(event); return requestSkillInventory(await endpointFor(hostId), target, refresh);
});
ipcMain.handle("host:composer-completions", async (event, query: ComposerCompletionQuery, hostId?: string) => {
  assertTrustedSender(event); return requestComposerCompletions(await endpointFor(hostId), query);
});
ipcMain.handle("host:skill-detail", async (event, target: WorkspaceTarget | undefined, skillId: string, catalogRevision: string, hostId?: string, inventory?: boolean) => {
  assertTrustedSender(event); return requestSkillDetail(await endpointFor(hostId), target, skillId, catalogRevision, inventory);
});
ipcMain.handle("host:skill-file-open-options", async (event, ref: NativeSkillFileRef, hostId?: string) => {
  assertTrustedSender(event); return requestSkillFileOpenOptions(await endpointFor(hostId), ref);
});
ipcMain.handle("host:skill-file", async (event, ref: NativeSkillFileRef, hostId?: string) => {
  assertTrustedSender(event); return requestSkillFile(await endpointFor(hostId), ref);
});
ipcMain.handle("host:composer-catalog", async (event, target?: WorkspaceTarget, refresh?: boolean, hostId?: string) => {
  assertTrustedSender(event); return requestComposerCatalog(await endpointFor(hostId), target, refresh);
});
ipcMain.handle("host:model-definitions", (event, hostId?: string) => { assertTrustedSender(event); return request("/v1/models/definitions", undefined, hostId); });
ipcMain.handle("host:model-definitions-set", (event, mutation: OmpModelDefinitionsMutation, hostId?: string) => {
  assertTrustedSender(event); return request("/v1/models/definitions", mutation, hostId);
});
ipcMain.handle("host:session-controls", (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event);
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) throw new Error("Invalid session ID.");
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/controls`, undefined, hostId);
});
ipcMain.handle("host:session-controls-mutate", (event, sessionId: string, mutation: OmpSessionControlMutation, hostId?: string) => {
  assertTrustedSender(event);
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) throw new Error("Invalid session ID.");
  return requestVersionedControl((path, body) => request(path, body, hostId), sessionId, mutation);
});
ipcMain.handle("host:providers", (event, hostId?: string) => { assertTrustedSender(event); return request("/v1/accounts/providers", undefined, hostId); });
ipcMain.handle("host:logins", (event, hostId?: string) => { assertTrustedSender(event); return request("/v1/accounts/logins", undefined, hostId); });
ipcMain.handle("host:accounts", (event, providerId: string, hostId?: string) => {
  assertTrustedSender(event);
  if (typeof providerId !== "string" || !providerId || providerId.length > 200) throw new Error("Invalid provider ID.");
  return request(`/v1/accounts/credentials?provider=${encodeURIComponent(providerId)}`, undefined, hostId);
});
ipcMain.handle("host:session-accounts", (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event);
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) throw new Error("Invalid session ID.");
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/accounts`, undefined, hostId);
});
ipcMain.handle("host:account-action", (event, action: AccountAction, hostId?: string) => {
  assertTrustedSender(event); return request("/v1/accounts/actions", action, hostId);
});
ipcMain.handle("host:interactions", (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event);
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) throw new Error("Invalid session ID.");
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/interactions`, undefined, hostId);
});
ipcMain.handle("host:workspace-query", (event, target: WorkspaceTarget, query: WorkspaceQuery, hostId?: string) => {
  assertTrustedSender(event); return request("/v1/workspace/query", { target, query }, hostId);
});
function queryWindowToken(event: Electron.IpcMainInvokeEvent, owner: { token(senderId: number): string | undefined }): string | Promise<string> {
  assertTrustedSender(event);
  const sender = event.sender, existing = owner.token(sender.id);
  if (existing) return existing;
  // Waiting grants no observer. The old document cannot reuse its previous token,
  // and a response to its destroyed preload cannot create a follow-up request.
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sender.removeListener("did-finish-load", loaded);
      sender.removeListener("did-start-navigation", navigating);
      sender.removeListener("destroyed", ended);
      sender.removeListener("render-process-gone", ended);
      if (error) { reject(error); return; }
      try {
        assertTrustedSender(event);
        const token = owner.token(sender.id);
        if (!token) throw new Error("Workspace query document is not ready.");
        resolve(token);
      } catch (cause) { reject(cause); }
    };
    const loaded = () => finish();
    const ended = () => finish(new Error("Workspace query document ended before readiness."));
    const navigating = (_event: Electron.Event, _url: string, inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame && !inPlace) ended(); };
    const timer = setTimeout(() => finish(new Error("Workspace query document did not finish loading.")), 30_000);
    sender.once("did-finish-load", loaded);
    sender.on("did-start-navigation", navigating);
    sender.once("destroyed", ended);
    sender.once("render-process-gone", ended);
  });
}
ipcMain.handle("host:repository-watch-window", event => queryWindowToken(event, repositoryWatchWindows));
ipcMain.handle("host:branch-query-window", event => queryWindowToken(event, branchQueryWindows));
ipcMain.handle("host:repository-watch", (event, token: unknown, request: unknown) => {
  assertTrustedSender(event);
  const sender = event.sender, frame = event.senderFrame;
  return repositoryWatchWindows.dispatch(sender.id, request, () => !sender.isDestroyed() && sender.mainFrame === frame, token);
});
ipcMain.handle("host:branch-query", (event, token: unknown, request: unknown) => {
  assertTrustedSender(event);
  const sender = event.sender, frame = event.senderFrame;
  return branchQueryWindows.dispatch(sender.id, request, () => !sender.isDestroyed() && sender.mainFrame === frame, token);
});
const workspaceCopies = new Set<number>();
ipcMain.handle("desktop:skill-save-copy", async (event, input: NativeSkillFileRef, hostId: string) => workspaceCopyOutcome(async () => {
  assertTrustedSender(event);
  const ref = parseNativeSkillFileRef(input), sender = event.sender, id = sender.id;
  if (workspaceCopies.has(id)) throw new Error("A Save as operation is already open in this window.");
  workspaceCopies.add(id);
  const abort = new AbortController(), destroyed = () => abort.abort(new Error("The viewing window closed before its copy finished."));
  sender.once("destroyed", destroyed);
  try {
    return await saveWorkspaceCopy({skill:ref,path:ref.sourcePath.split("/").at(-1)!,hostId}, {
      signal: abort.signal,
      choose: async defaultPath => { const result = await dialog.showSaveDialog({defaultPath}); return result.canceled ? null : result.filePath ?? null; },
      source: async () => {
        const endpoint = await endpointFor(hostId);
        if(endpoint.hostId!==hostId)throw new Error("The selected skill host changed. Reconnect before copying.");
        return {local:endpoint.hostId===connection?.hostId,query:async query=>{
          if(query.type!=="file.copy-info"&&query.type!=="file.copy-chunk")throw new Error("Invalid skill copy query.");
          return requestSkillFileCopy(endpoint,ref,query.type==="file.copy-chunk"?{revision:query.revision,offset:query.offset}:undefined,abort.signal);
        }};
      },
    });
  } finally {sender.removeListener("destroyed",destroyed);workspaceCopies.delete(id);}
}));
ipcMain.handle("desktop:workspace-save-copy", async (event, target: WorkspaceTarget, path: string, hostId: string) => workspaceCopyOutcome(async () => {
  assertTrustedSender(event);
  const sender = event.sender, id = sender.id;
  if (workspaceCopies.has(id)) throw new Error("A Save as operation is already open in this window.");
  workspaceCopies.add(id);
  const abort = new AbortController(), destroyed = () => abort.abort(new Error("The viewing window closed before its copy finished."));
  sender.once("destroyed", destroyed);
  try {
    return await saveWorkspaceCopy({target, path, hostId}, {
      signal: abort.signal,
      choose: async defaultPath => {
        const result = await dialog.showSaveDialog({defaultPath});
        return result.canceled ? null : result.filePath ?? null;
      },
      source: async () => {
        const endpoint = await endpointFor(hostId);
        if (endpoint.hostId !== hostId) throw new Error("The selected file host changed. Reconnect before copying.");
        return workspaceCopySource(endpoint, target, endpoint.hostId === connection?.hostId, abort.signal);
      },
    });
  } finally { sender.removeListener("destroyed", destroyed); workspaceCopies.delete(id); }
}));
ipcMain.handle("desktop:workspace-image-acquire", async (event, target: WorkspaceTarget, path: string, hostId: string) => {
  assertTrustedSender(event);
  const sender = event.sender, senderId = sender.id, epoch = workspaceImageEpochs.get(senderId) ?? 0;
  const endpoint = await endpointFor(hostId);
  if (sender.isDestroyed() || (workspaceImageEpochs.get(senderId) ?? 0) !== epoch) throw new Error("The viewing page changed before its workspace image was ready.");
  if (endpoint.hostId !== hostId) throw new Error("The selected image host changed. Reconnect before loading it.");
  return workspaceImages.acquire({ senderId, target, path, hostId,
    source: signal => workspaceCopySource(endpoint, target, endpoint.hostId === connection?.hostId, signal) });
});
ipcMain.handle("desktop:skill-image-acquire", async (event, ref: NativeSkillFileRef, path: string, hostId: string) => {
  assertTrustedSender(event);
  const sender = event.sender, senderId = sender.id, epoch = workspaceImageEpochs.get(senderId) ?? 0;
  const endpoint = await endpointFor(hostId);
  if (sender.isDestroyed() || (workspaceImageEpochs.get(senderId) ?? 0) !== epoch) throw new Error("The viewing page changed before its skill image was ready.");
  if (endpoint.hostId !== hostId) throw new Error("The selected skill image host changed. Reconnect before loading it.");
  return workspaceImages.acquireSkill({senderId, ref, path, hostId, source: signal => ({local:false, query: query => {
    if (query.type !== "file.copy-info" && query.type !== "file.copy-chunk") throw new Error("Unsupported skill image query.");
    return requestSkillImage(endpoint, ref, query.path, query.type === "file.copy-chunk" ? {revision:query.revision,offset:query.offset} : undefined, signal);
  }})});
});
ipcMain.handle("desktop:workspace-image-release", (event, id: string) => {
  assertTrustedSender(event);
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid workspace image grant.");
  workspaceImages.release(id, event.sender.id);
});
ipcMain.handle("host:interaction-response", (event, sessionId: string, interactionId: string, response: OmpInteractionResponse, hostId?: string) => {
  assertTrustedSender(event);
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) throw new Error("Invalid session ID.");
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/interactions`, { interactionId, response }, hostId).then(() => undefined);
});
ipcMain.handle("desktop:open-external", (event, value: string) => {
  assertTrustedSender(event);
  if (typeof value !== "string" || value.length > 32_768) throw new Error("Invalid external URL.");
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Only HTTPS links or local authentication callbacks may open in the browser.");
  }
  return shell.openExternal(url.href);
});
ipcMain.handle("desktop:directory", async event => {
  assertTrustedSender(event);
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
registerProjectRevealHandler(ipcMain, assertTrustedSender, () => connection?.hostId, endpointFor,
  endpoint => requestHost(endpoint, "/v1/state") as Promise<HostState>, path => shell.openPath(path));

// Small, local-only synchronous IPC: preload restores presentation before React
// mounts, and a close cannot outrun the acknowledged atomic save.
ipcMain.on("desktop:window-state:read", event => {
  try { assertTrustedSender(event); event.returnValue = windowStates.get(event.sender.id)?.bootstrap() ?? { error: "Window layout storage is unavailable." }; }
  catch { event.returnValue = { error: "Window layout storage is unavailable." }; }
});
ipcMain.on("desktop:window-state:save", (event, value: unknown) => {
  try { assertTrustedSender(event); event.returnValue = windowStates.get(event.sender.id)?.saveView(value) ?? { error: "Window layout storage is unavailable." }; }
  catch { event.returnValue = { error: "Window layout could not be saved." }; }
});

async function createWindow(): Promise<void> {
  // The application has one primary window. An additional window never writes
  // that slot; its independent slot can be retained by a future window opener.
  const slot = windows.size === 0 ? "primary" : crypto.randomUUID();
  const localState = new WindowStateStore(app.getPath("userData"), slot);
  const geometry = localState.geometry();
  const restoredBounds = restoreWindowBounds(geometry.bounds, screen.getAllDisplays().map(display => display.workArea));
  const window = new BrowserWindow({
    width: 1200, height: 820, ...restoredBounds, minWidth: 720, minHeight: 480,
    show: !process.env.AGENT_DESKTOP_CAPTURE,
    title: "Agent Desktop", titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 }, backgroundColor: "#181818", transparent: true,
    webPreferences: { preload: join(app.getAppPath(), "dist/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  windows.add(window);
  windowStates.set(window.webContents.id, localState);
  const windowContentsId = window.webContents.id;
  window.webContents.on("did-finish-load", () => { if (!shuttingDown && !window.isDestroyed()) { repositoryWatchWindows.reset(windowContentsId); branchQueryWindows.reset(windowContentsId); } });
  workspaceImageEpochs.set(windowContentsId, 0);
  if (geometry.maximized && !process.env.AGENT_DESKTOP_CAPTURE) window.maximize();
  trackWindowGeometry(window, localState, status => { if (!window.webContents.isDestroyed()) window.webContents.send("desktop:window-state:status", status); });
  window.webContents.on("preload-error", (_event, _path, error) => console.error("Desktop preload failed:", error.message));
  window.webContents.on("did-start-loading", () => notificationNavigation.unready(windowContentsId));
  window.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    modifierWatches.cancel(windowContentsId);
    if (!_inPlace) { retireMcpAppDocument(windowContentsId); repositoryWatchWindows.releaseWindow(windowContentsId); branchQueryWindows.releaseWindow(windowContentsId); }
    windowCloseGate.unregister(windowContentsId);
    workspaceImageEpochs.set(windowContentsId, (workspaceImageEpochs.get(windowContentsId) ?? 0) + 1);
    workspaceImages.releaseSender(windowContentsId);
  });
  window.webContents.on("destroyed", () => { modifierWatches.cancel(windowContentsId); retireMcpAppDocument(windowContentsId); repositoryWatchWindows.releaseWindow(windowContentsId); branchQueryWindows.releaseWindow(windowContentsId); notificationNavigation.unready(windowContentsId); });
  window.webContents.on("render-process-gone", (_event, details) => { modifierWatches.cancel(windowContentsId); retireMcpAppDocument(windowContentsId); repositoryWatchWindows.releaseWindow(windowContentsId); branchQueryWindows.releaseWindow(windowContentsId); notificationNavigation.unready(windowContentsId); windowCloseGate.destroy(windowContentsId); workspaceImageEpochs.set(windowContentsId, (workspaceImageEpochs.get(windowContentsId) ?? 0) + 1); workspaceImages.releaseSender(windowContentsId); console.error("Desktop renderer exited:", details.reason); });
  window.on("close", event => { if (!windowCloseGate.handleWindowClose(windowContentsId, () => { if (!window.isDestroyed()) window.close(); })) event.preventDefault(); });
  window.on("closed", () => { modifierWatches.cancel(windowContentsId); retireMcpAppDocument(windowContentsId); repositoryWatchWindows.releaseWindow(windowContentsId); branchQueryWindows.releaseWindow(windowContentsId); windows.delete(window); windowStates.delete(windowContentsId); notificationNavigation.unready(windowContentsId); windowCloseGate.destroy(windowContentsId, true); workspaceImageEpochs.delete(windowContentsId); workspaceImages.releaseSender(windowContentsId); });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  const development = process.env.AGENT_DESKTOP_RENDERER_URL;
  if (development) await window.loadURL(development);
  else await window.loadFile(join(app.getAppPath(), "dist/renderer/index.html"));
  if (process.env.AGENT_DESKTOP_CAPTURE) {
    try { await captureDesktop(window, process.env.AGENT_DESKTOP_CAPTURE); }
    catch (error) { console.error(error); app.exit(1); return; }
    app.quit();
  }
}

if (primaryInstance) app.whenReady().then(() => {
  protocol.handle("agent-workspace-image", request => workspaceImages.response(request.url, request.signal));
  app.setAccessibilitySupportEnabled(true);
  powerMonitor.on("on-ac", () => keepAwake.powerChanged());
  powerMonitor.on("on-battery", () => keepAwake.powerChanged());
  powerMonitor.on("resume", () => keepAwake.invalidate());
  // Recover a failed policy read without waiting for another user action.
  keepAwakeRefresh = setInterval(() => { void keepAwake.refresh(); }, 15000);
  keepAwakeRefresh.unref();
  return createWindow();
}).catch(error => { dialog.showErrorBox("Agent Desktop", String(error)); app.quit(); });
app.on("second-instance", () => {
  const window = [...windows][0];
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  else if (app.isReady()) void createWindow();
});
app.on("activate", () => { if (windows.size === 0) void createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", event => {
  if (windowCloseGate.consumeQuitPermit()) return;
  event.preventDefault();
  windowCloseGate.requestQuit([...windows].filter(window => !window.isDestroyed()).map(window => window.webContents.id), () => app.quit());
});
app.on("will-quit", () => { void modifierWatches.dispose(); shuttingDown = true; repositoryWatchWindows.dispose(); branchQueryWindows.dispose(); clearInterval(keepAwakeRefresh); keepAwake.dispose(); notificationDelivery.dispose(); for (const stream of streams.values()) { stream.repositoryWatches.dispose(); stream.branchQueries.dispose(); clearTimeout(stream.timer); stream.socket?.close(); } });
