import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { discoverAuthStorage, getAgentDir, loadSessionExtensions, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { ExtensionRunner, emitSessionShutdownEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { initThemeSync } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { NativeMcpAppRequest, NativeMcpAppResponse, NativeSessionMcpSnapshot, OmpBridgeEvent, OmpInteractionResponse } from "@agent-desktop/shared";
import { parseNativeSessionMcpSnapshot } from "@agent-desktop/shared";
import { NativeMcpApps } from "./mcp-apps";
import { executeMcpAppTool } from "./mcp-app-tool";
import { McpFileResources } from "./mcp-file-resource";
import { collectMcpServers } from "./mcp-session";
import { nativeApprovalInteractionClassification, OmpInteractionBridge } from "./interactions";

export interface McpOwnerOptions {
  id: string;
  /** Host-admitted directory; no conversation is created for this owner. */
  cwd: string;
  agentDir?: string;
}
/** Loaded only in an isolated child. Native settings and extensions use the
 * admitted directory, while the in-memory extension context never runs a model
 * or creates a durable conversation. */
export class NativeMcpOwner {
  readonly #options: Readonly<McpOwnerOptions>;
  readonly #abort = new AbortController();
  readonly #manager: MCPManager;
  readonly #ui: OmpInteractionBridge;
  readonly #epoch = crypto.randomUUID();
  readonly #failedServers = new Set<string>();
  readonly #ready: Promise<void>;
  #directory?: { device: bigint; inode: bigint };
  #runner?: ExtensionRunner;
  #apps?: NativeMcpApps;
  #revision = 0;
  #fingerprint = "";
  #disposal?: Promise<void>;
  #extensionFailures: Error[] = [];
  #initializationFailure?: unknown;
  #unsubscribeNotifications?: () => void;
  #notifications = new Set<Promise<void>>();
  #notificationFailures: unknown[] = [];

  constructor(options: McpOwnerOptions, emit: (event: OmpBridgeEvent) => void) {
    if (!/^[a-zA-Z0-9-]{1,200}$/.test(options.id) || !path.isAbsolute(options.cwd)) throw new Error("Invalid MCP owner identity.");
    this.#options = Object.freeze({ ...options });
    this.#manager = new MCPManager(options.cwd);
    this.#ui = new OmpInteractionBridge(options.id, emit);
    this.#ready = Promise.resolve().then(() => this.#initialize());
    void this.#ready.catch(error => { this.#initializationFailure = error; });
  }
  get id(): string { return this.#options.id; }
  get cwd(): string { return this.#options.cwd; }
  #current(): void {
    this.#abort.signal.throwIfAborted();
    if (this.#directory) {
      try {
        const now = statSync(this.cwd, { bigint: true });
        if (realpathSync(this.cwd) !== this.cwd || !now.isDirectory() || now.dev !== this.#directory.device || now.ino !== this.#directory.inode) throw new Error("The original MCP owner directory changed.");
      } catch (error) { this.#abort.abort(error); throw error; }
    }
  }
  async #initialize(): Promise<void> {
    const { cwd } = this.#options, agentDir = this.#options.agentDir ?? getAgentDir();
    if (await realpath(cwd) !== cwd) throw new Error("MCP owner directory changed before initialization.");
    const directory = await stat(cwd, { bigint: true });
    if (!directory.isDirectory()) throw new Error("MCP owner directory is not a directory.");
    this.#directory = { device: directory.dev, inode: directory.ino };
    this.#current();
    const settings = await Settings.loadReadOnly({ cwd, agentDir });
    this.#current(); initThemeSync();
    const auth = await discoverAuthStorage(agentDir);
    this.#current();
    const eventBus = new EventBus(), loaded = await loadSessionExtensions({}, cwd, settings, eventBus);
    this.#current();
    if (loaded.errors.length) throw new AggregateError(loaded.errors.map(value => new Error(`${value.path}: ${value.error}`)), "Native MCP owner extensions could not load.");
    loaded.extensions.push(await loadExtensionFromFactory(nativeApprovalInteractionClassification(() => this.#ui), cwd, eventBus, loaded.runtime, "<desktop-mcp-owner-approvals>"));
    const sessionManager = SessionManager.inMemory(cwd), registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
    for (const { name, config, sourceId } of loaded.runtime.pendingProviderRegistrations) registry.registerProvider(name, config, sourceId);
    loaded.runtime.pendingProviderRegistrations = [];
    const runner = this.#runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, registry, undefined, settings);
    const unsupported = (action: string): never => this.#ui.unsupported(`MCP owner ${action}: no conversation is running`);
    runner.initialize({
      sendMessage: () => unsupported("sendMessage"), sendUserMessage: () => unsupported("sendUserMessage"),
      appendEntry: (type, data) => { sessionManager.appendCustomEntry(type, data); },
      setLabel: (id, label) => { sessionManager.appendLabelChange(id, label); },
      getActiveTools: () => this.#manager.getTools().map(tool => tool.name),
      getAllTools: () => this.#manager.getTools().map(tool => {
        const source = tool.mcpServerName ? this.#manager.getSource(tool.mcpServerName) : undefined;
        return { name: tool.name, description: tool.description, parameters: tool.parameters, sourceInfo: {
          path: source?.path ?? `<mcp:${tool.mcpServerName ?? tool.name}>`, source: "mcp",
          scope: source?.level === "project" ? "project" as const : source?.level === "user" ? "user" as const : "temporary" as const,
          origin: "top-level" as const,
        } };
      }),
      setActiveTools: async () => unsupported("setActiveTools"), getCommands: () => [],
      setModel: async () => unsupported("setModel"), getThinkingLevel: () => undefined,
      setThinkingLevel: () => unsupported("setThinkingLevel"), getSessionName: () => undefined,
      setSessionName: async () => unsupported("setSessionName"),
    }, {
      getModel: () => undefined, isIdle: () => !this.#apps?.pending,
      abort: () => this.#abort.abort(new Error("The native MCP owner was aborted by an extension.")),
      hasPendingMessages: () => false, shutdown: () => this.#abort.abort(new Error("The native MCP owner was stopped by an extension.")),
      getContextUsage: () => undefined, compact: async () => unsupported("compact"), getSystemPrompt: () => [],
    }, undefined, this.#ui, "rpc");
    runner.onError(error => {
      const failure = new Error(`Native extension ${error.event}: ${error.error}`);
      if (this.#extensionFailures.length < 128) this.#extensionFailures.push(failure); this.#ui.notify(failure.message, "error");
    });
    await runner.emit({ type: "session_start" }); this.#current();
    if (this.#extensionFailures.length) throw new AggregateError(this.#extensionFailures, "Native MCP owner extension startup failed.");
    this.#unsubscribeNotifications = this.#manager.addNotificationListener((server, method, params) => {
      if (this.#abort.signal.aborted) return;
      const pending = runner.emitMcpNotification({ server, method, params });
      this.#notifications.add(pending);
      void pending.then(() => this.#notifications.delete(pending), error => {
        this.#notifications.delete(pending);
        if (this.#notificationFailures.length < 128) this.#notificationFailures.push(error);
      });
    });
    this.#manager.setAuthStorage(auth);
    if (settings.get("mcp.notifications")) this.#manager.setNotificationsEnabled(true);
    const discovery = await this.#manager.discoverAndConnect({ enableApps: true, awaitInitialCatalogue: true,
      enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
      // This owner has no replacement Exa/browser tools; retain configured servers.
      filterExa: false, filterBrowser: false,
      extensionRoots: { mode: "merge", explicit: [], configured: settings.get("extensions") ?? [], configuredLevel: settings.extensionsSourceLevel() },
      onStatus: event => { if (event.type === "failed") this.#failedServers.add(event.serverName); },
    });
    this.#current();
    for (const [serverName] of discovery.errors) this.#failedServers.add(serverName);
    const files = new McpFileResources(cwd);
    this.#apps = new NativeMcpApps({ manager: this.#manager, snapshot: () => this.read(), assertOwner: () => this.#current(),
      filePath: source => path.join(cwd, source.path), fileResource: (...args) => files.request(...args), watchFile: (...args) => files.watch(...args),
      executeTool: (...args) => executeMcpAppTool({ extensionRunner: runner, sessionManager, settings }, this.#ui, ...args),
    });
  }
  async ready(): Promise<void> { await this.#ready; this.#current(); }
  read(): NativeSessionMcpSnapshot {
    this.#current();
    if (this.#initializationFailure !== undefined) throw this.#initializationFailure;
    if (!this.#apps) return { epoch: this.#epoch, revision: this.#revision, available: false, reason: "Connecting native apps…", servers: [] };
    for (const name of this.#failedServers) if (this.#manager.getConnectionStatus(name) === "connected") this.#failedServers.delete(name);
    const value = { available: true, canOpenApps: true, canReadResources: true, servers: collectMcpServers(this.#manager, this.#failedServers, true) };
    const fingerprint = JSON.stringify(value);
    if (Buffer.byteLength(fingerprint) > 2 * 1024 * 1024) throw new Error("Native MCP owner catalogue exceeds its limit.");
    if (fingerprint !== this.#fingerprint) { this.#fingerprint = fingerprint; this.#revision++; }
    return parseNativeSessionMcpSnapshot({ ...value, epoch: this.#epoch, revision: this.#revision });
  }
  async request(request: NativeMcpAppRequest): Promise<NativeMcpAppResponse> { await this.ready(); return this.#apps!.request(request); }
  interactions() { this.#current(); return this.#ui.list(); }
  respond(id: string, response: OmpInteractionResponse): void { this.#current(); this.#ui.respond(id, response); }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#abort.abort(new Error("The native MCP owner is retired."));
    this.#ui.dispose();
    this.#unsubscribeNotifications?.();
    this.#disposal = Promise.resolve().then(async () => {
      // Discovery may still own subprocess acquisition. Join it before disconnect.
      const errors: unknown[] = [];
      try { await this.#ready; } catch (error) { if (error !== this.#abort.signal.reason) errors.push(error); }
      await Promise.allSettled(this.#notifications);
      errors.push(...this.#notificationFailures);
      try { await this.#apps?.dispose(); } catch (error) { errors.push(error); }
      try { await emitSessionShutdownEvent(this.#runner); } catch (error) { errors.push(error); }
      try { await this.#manager.disconnectAll(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Native MCP owner cleanup failed.");
    });
    return this.#disposal;
  }
}
