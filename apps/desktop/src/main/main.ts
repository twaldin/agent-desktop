import { requestGoalMutation } from "./goal-control-transport";
import { requestComposerActions, requestComposerCompletions } from "./composer-actions-transport";
import { requestSessionActivity } from "./session-activity-transport";
import { requestBrowserMetadata } from "./browser-metadata-transport";
import { requestBrowserFrame } from "./browser-frame-transport";
import { requestBrowserControl } from "./browser-control-transport";
import { requestBrowserCreate } from "./browser-create-transport";
import type { BrowserControlRequest, BrowserCreateRequest, BrowserFrameTarget } from "@agent-desktop/shared";
import type { ComposerCompletionQuery } from "@agent-desktop/shared";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen, shell } from "electron";
import { captureDesktop } from "./capture";
import { WindowStateStore, restoreWindowBounds, trackWindowGeometry } from "./window-state";
import { nativeTerminalResult, requestHost, type HostEndpoint } from "./host-transport";
import { inspectImageAttachment, requestImageAttachmentCapabilities, requestImageAttachment, requestTranscriptImage, uploadImageAttachment } from "./attachment-transport";
import { requestComposerCatalog } from "./composer-transport";
import { requestVersionedCommand, requestVersionedControl } from "./command-endpoints";
import { verifyKnownHost } from "./host-recovery";
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

app.setName("Agent Desktop");
const dataDirectory = getDataDirectory();
app.setPath("userData", process.env.AGENT_DESKTOP_PROFILE_DIR || dataDirectory);
// A capture profile is a separate, hidden process. Normal launches reuse this profile's window.
const primaryInstance = Boolean(process.env.AGENT_DESKTOP_CAPTURE) || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
const connectionPath = join(dataDirectory, "connection.json");
const windows = new Set<BrowserWindow>();
const windowStates = new Map<number, WindowStateStore>();
let connection: LocalConnection | null = null;
type HostStream = { endpoint: HostEndpoint; sequence: number; socket?: WebSocket; timer?: ReturnType<typeof setTimeout> };
const streams = new Map<string, HostStream>();
const remoteHosts = new Map<string, HostEndpoint>();
let shuttingDown = false;

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
  const root = process.env.AGENT_DESKTOP_PROJECT_ROOT;
  const packagedEntry = join(process.resourcesPath, "host/apps/host/src/server.ts");
  const bun = process.env.AGENT_DESKTOP_BUN || (existsSync(packagedEntry)
    ? join(process.resourcesPath, "runtime", "bun") : join(homedir(), ".bun", "bin", "bun"));
  const entry = root ? join(root, "apps/host/src/server.ts") : packagedEntry;
  if (!existsSync(bun) || !existsSync(entry)) throw new Error("The host runtime is missing. Build or reinstall Agent Desktop.");
  const output = openSync(join(dataDirectory, "host.log"), "a", 0o600);
  const child = spawn(bun, [entry], {
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
  if (!stream) { stream = { endpoint, sequence: 0 }; streams.set(endpoint.hostId, stream); }
  stream.endpoint = endpoint;
  clearTimeout(stream.timer);
  stream.socket?.close();
  const current = stream;
  const url = `${endpoint.origin.replace(/^http/, "ws")}/v1/events?after=${current.sequence}`;
  const next = new WebSocket(url, endpoint.token ? ["agent-desktop", endpoint.token] : ["agent-desktop"]);
  current.socket = next;
  const emitConnection = (connected: boolean, error?: string) => broadcast({ hostId: endpoint.hostId,
    sequence: current.sequence, type: "connection", connected, error });
  let disconnectReason: string | undefined;
  next.addEventListener("open", () => { if (current.socket === next && !shuttingDown) emitConnection(true); });
  next.addEventListener("message", ({ data }) => {
    if (current.socket !== next) return;
    try {
      const event = JSON.parse(String(data)) as HostEvent | { type: "terminal"; event: TerminalInvalidation }
        | { type: "native-terminal"; event: NativeTerminalInvalidation };
      if (event.type === "terminal" || event.type === "native-terminal") {
        const channel = event.type === "terminal" ? "host:terminal-event" : "host:native-terminal-event";
        for (const window of windows) if (!window.isDestroyed()) window.webContents.send(channel, { ...event.event, hostId: endpoint.hostId });
        return;
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) return;
      if (event.type === "state" && event.state.host.id !== endpoint.hostId) { disconnectReason = "The remote host identity changed."; next.close(1008, disconnectReason); return; }
      current.sequence = Math.max(current.sequence, event.sequence);
      broadcast({ ...event, hostId: endpoint.hostId });
    } catch { disconnectReason = "Invalid host event."; next.close(1002, disconnectReason); }
  });
  next.addEventListener("error", () => next.close());
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
    if (current.socket !== next || shuttingDown) return;
    emitConnection(false, disconnectReason);
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
ipcMain.handle("host:transcript-image", async (event, sessionId: string, nativeEntryId: string, blockIndex: number, hostId: string) => {
  assertTrustedSender(event); return requestTranscriptImage(await endpointFor(requireImageOwner(hostId)), sessionId, nativeEntryId, blockIndex);
});
ipcMain.handle("host:messages", (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event);
  if (typeof sessionId !== "string" || sessionId.length > 200) throw new Error("Invalid session ID.");
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, undefined, hostId);
});
ipcMain.handle("host:goal-control", async (event, sessionId: string, request: import("@agent-desktop/shared").GoalMutationRequest, hostId?: string) => {
  assertTrustedSender(event); return requestGoalMutation(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle("host:session-activity", async (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event); return requestSessionActivity(await endpointFor(hostId), sessionId);
});
ipcMain.handle("host:browser-metadata", async (event, sessionId: string, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserMetadata(await endpointFor(hostId), sessionId);
});
ipcMain.handle("host:browser-create", async (event, sessionId: string, request: BrowserCreateRequest, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserCreate(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle("host:browser-control", async (event, sessionId: string, request: BrowserControlRequest, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserControl(await endpointFor(hostId), sessionId, request);
});
ipcMain.handle("host:browser-frame", async (event, sessionId: string, target: BrowserFrameTarget, hostId?: string) => {
  assertTrustedSender(event); return requestBrowserFrame(await endpointFor(hostId), sessionId, target);
});
ipcMain.handle("host:peers", event => { assertTrustedSender(event); return discoverHosts(); });
ipcMain.handle("host:preferences", event => { assertTrustedSender(event); return request("/v1/preferences"); });
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
  if (!effects || !["none", "sidebar", "under-window", "hud"].includes(effects.material) || typeof effects.backgroundColor !== "string"
    || !/^(#[\da-f]{6}|#[\da-f]{8}|rgba?\([\d.,%\s]+\)|transparent)$/i.test(effects.backgroundColor)) throw new Error("Invalid native window theme.");
  // Convert CSS #RRGGBBAA to Electron's #AARRGGBB representation.
  const color = /^#[\da-f]{8}$/i.test(effects.backgroundColor) ? `#${effects.backgroundColor.slice(7)}${effects.backgroundColor.slice(1, 7)}` : effects.backgroundColor;
  for (const window of windows) if (!window.isDestroyed()) {
    window.setBackgroundColor(color);
    window.setVibrancy(effects.material === "none" ? null : effects.material);
  }
});
ipcMain.handle("host:settings-catalog", (event, hostId?: string) => { assertTrustedSender(event); return request("/v1/settings/catalog", undefined, hostId); });
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
ipcMain.handle("host:composer-completions", async (event, query: ComposerCompletionQuery, hostId?: string) => {
  assertTrustedSender(event); return requestComposerCompletions(await endpointFor(hostId), query);
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
  if (geometry.maximized && !process.env.AGENT_DESKTOP_CAPTURE) window.maximize();
  trackWindowGeometry(window, localState, status => { if (!window.webContents.isDestroyed()) window.webContents.send("desktop:window-state:status", status); });
  window.webContents.on("preload-error", (_event, _path, error) => console.error("Desktop preload failed:", error.message));
  window.webContents.on("render-process-gone", (_event, details) => console.error("Desktop renderer exited:", details.reason));
  window.on("closed", () => { windows.delete(window); windowStates.delete(windowContentsId); });
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

if (primaryInstance) app.whenReady().then(() => { app.setAccessibilitySupportEnabled(true); return createWindow(); }).catch(error => { dialog.showErrorBox("Agent Desktop", String(error)); app.quit(); });
app.on("second-instance", () => {
  const window = [...windows][0];
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  else if (app.isReady()) void createWindow();
});
app.on("activate", () => { if (windows.size === 0) void createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { shuttingDown = true; for (const stream of streams.values()) { clearTimeout(stream.timer); stream.socket?.close(); } });
