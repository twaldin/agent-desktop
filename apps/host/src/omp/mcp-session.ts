import { mcpAppDescriptors, mcpFileViewers } from "./mcp-apps";
import { randomUUID } from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { NativeMcpAuthorization, type NativeMcpAuthorizationSnapshot } from "./mcp-oauth-session";
import type { MCPAuthChallenge, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPAuthContext, MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type {
	NativeSessionMcpReload,
	NativeSessionMcpReconnect,
	NativeSessionMcpServer,
	NativeSessionMcpSnapshot,
} from "../../../../packages/shared/src/session-mcp";
import {
	parseNativeSessionMcpResourceResult,
	type NativeSessionMcpResourceRequest,
	type NativeSessionMcpResourceResult,
} from "../../../../packages/shared/src/session-mcp-resource";

const UNAVAILABLE = "Native MCP manager is unavailable for this session.";
const CONNECTION_ERROR = "Native MCP server could not connect.";
const MAX_ITEMS = 4096;
const MAX_STATE_BYTES = 2 * 1024 * 1024;

function sourceLabel(manager: MCPManager, name: string): string {
	const source = manager.getSource(name);
	if (!source) return "Native MCP";
	return identity(`${source.providerName} (${source.level})`, 1024, "source label");
}

function identity(value: string, max: number, kind: string): string {
	if (!value || value.includes("\0") || Buffer.byteLength(value) > max) throw new Error(`Native MCP ${kind} is invalid or too large.`);
	return value;
}

function optional(value: string | undefined, max: number, kind: string): string | undefined {
	if (value === undefined) return undefined;
	if (value.includes("\0") || Buffer.byteLength(value) > max) throw new Error(`Native MCP ${kind} is invalid or too large.`);
	return value;
}

function limited<T>(values: readonly T[], kind: string, max = MAX_ITEMS): T[] {
	if (values.length > max) throw new Error(`Native MCP ${kind} exceeds its item limit.`);
	return [...values];
}

function collectServers(manager: MCPManager, failures: ReadonlySet<string>, apps: boolean): NativeSessionMcpServer[] {
	const tools = manager.getTools();
	return limited(manager.getAllServerNames(), "servers")
		.slice()
		.sort((left, right) => left.localeCompare(right))
		.map(name => {
			const status = manager.getConnectionStatus(name);
			// Older manager instances used by compatible hosts may not expose the
			// preserved config accessor; absence means authorization is unavailable.
			const config = typeof manager.getServerConfig === "function" ? manager.getServerConfig(name) : undefined;
			const canAuthorize = config?.enabled !== false && (config?.type === "http" || config?.type === "sse");
			const connection = status === "connected" ? manager.getConnection(name) : undefined;
			const resourceSupport = connection?.capabilities.resources !== undefined;
			const promptSupport = connection?.capabilities.prompts !== undefined;
			const notificationState = connection ? manager.getNotificationState() : undefined;
			const resources = !connection ? null : !resourceSupport ? [] : connection.resources === undefined ? null : limited(connection.resources, "resources").map(resource => ({
				uri: identity(resource.uri, 16 * 1024, "resource URI"), name: identity(resource.name, 1024, "resource name"),
				...(optional(resource.description, 4096, "resource description") === undefined ? {} : { description: resource.description }),
				...(optional(resource.mimeType, 1024, "resource MIME type") === undefined ? {} : { mimeType: resource.mimeType }),
			}));
			const resourceTemplates = !connection ? null : !resourceSupport ? [] : connection.resourceTemplates === undefined ? null : limited(connection.resourceTemplates, "resource templates").map(template => ({
				uriTemplate: identity(template.uriTemplate, 16 * 1024, "resource template URI"), name: identity(template.name, 1024, "resource template name"),
				...(optional(template.description, 4096, "resource template description") === undefined ? {} : { description: template.description }),
				...(optional(template.mimeType, 1024, "resource template MIME type") === undefined ? {} : { mimeType: template.mimeType }),
			}));
			const prompts = !connection ? null : !promptSupport ? [] : connection.prompts === undefined ? null : limited(connection.prompts, "prompts").map(prompt => ({
				name: identity(prompt.name, 1024, "prompt name"),
				...(optional(prompt.description, 4096, "prompt description") === undefined ? {} : { description: prompt.description }),
				...(prompt.arguments === undefined ? {} : { arguments: limited(prompt.arguments, "prompt arguments", 256).map(argument => ({
					name: identity(argument.name, 1024, "prompt argument name"),
					...(optional(argument.description, 4096, "prompt argument description") === undefined ? {} : { description: argument.description }), required: argument.required === true,
				})) }),
			}));
			const subscriptions = connection ? [...(notificationState?.subscriptions.get(name) ?? [])] : [];
			limited(subscriptions, "resource subscriptions");
			return {
				name: identity(name, 1024, "server name"),
				...(apps && connection ? { apps: mcpAppDescriptors(connection), fileViewers: mcpFileViewers(connection) } : {}),
				status,
				source: sourceLabel(manager, name),
				canAuthorize,
				tools: limited(tools
					.filter(tool => tool.mcpServerName === name)
					.map(tool => identity(tool.name, 1024, "tool name")), "tools", 16_384)
					.sort((left, right) => left.localeCompare(right)),
				resourceCount: connection
					? connection.capabilities.resources
						? connection.resources === undefined ? null : connection.resources.length
						: 0
					: null,
				promptCount: connection
					? connection.capabilities.prompts
						? connection.prompts === undefined ? null : connection.prompts.length
						: 0
					: null,
				resources,
				resourceTemplates,
				prompts,
				notifications: connection ? {
					enabled: notificationState?.enabled === true,
					toolsListChanged: connection.capabilities.tools?.listChanged === true,
					resourcesListChanged: connection.capabilities.resources?.listChanged === true,
					promptsListChanged: connection.capabilities.prompts?.listChanged === true,
					resourceSubscribe: connection.capabilities.resources?.subscribe === true,
					subscriptions: subscriptions.map(uri => identity(uri, 16 * 1024, "subscription URI")).sort((left, right) => left.localeCompare(right)),
				} : null,
				...(failures.has(name) && status !== "connected" ? { error: CONNECTION_ERROR } : {}),
			};
		});
}

/** A metadata-only view over the MCP manager owned by one live native session. */
export class NativeSessionMcp {
	readonly #epoch = randomUUID();
	#revision = 0;
	#fingerprint = "";
	#failures = new Set<string>();
	#mutationTail: Promise<void> = Promise.resolve();
	#authorization?: NativeMcpAuthorization;
	#disposed = false;

	constructor(
		private readonly session: AgentSession,
		private readonly manager: MCPManager | undefined,
		private readonly apps = false,
	) {}

	#value(): Omit<NativeSessionMcpSnapshot, "epoch" | "revision"> {
		if (this.manager) {
			for (const name of this.#failures) {
				if (this.manager.getConnectionStatus(name) === "connected") this.#failures.delete(name);
			}
		}
		const value = this.manager
			? { available: true, canReconnect: true, canReadResources: true, ...(this.apps ? { canOpenApps: true } : {}), servers: collectServers(this.manager, this.#failures, this.apps) }
			: { available: false, reason: UNAVAILABLE, servers: [] };
		if (Buffer.byteLength(JSON.stringify(value)) > MAX_STATE_BYTES) throw new Error("Native MCP catalog exceeds its 2 MiB response limit.");
		return value;
	}

	#consumeRevision(): void {
		const value = this.#value();
		this.#fingerprint = JSON.stringify(value);
		this.#revision++;
	}

	read(): NativeSessionMcpSnapshot {
		const value = this.#value();
		const fingerprint = JSON.stringify(value);
		if (fingerprint !== this.#fingerprint) {
			this.#fingerprint = fingerprint;
			this.#revision++;
		}
		return { epoch: this.#epoch, revision: this.#revision, ...value };
	}

	async #reload(): Promise<void> {
		if (!this.manager) throw new Error(UNAVAILABLE);
		try {
			await this.manager.disconnectAll();
			this.#failures.clear();
			this.session.setMCPPromptCommands([]);
			clearFsCache();
			const result = await this.manager.discoverAndConnect({
				enableApps: this.apps,
				enableProjectConfig: this.session.settings.get("mcp.enableProjectConfig") ?? true,
				filterExa: true,
				filterBrowser: this.session.getEvalPreludes().some(definition => definition.name === "browser"),
				extensionRoots: this.session.effectiveExtensionRoots,
			});
			this.#failures = new Set(result.errors.keys());
			await this.session.refreshMCPTools(this.manager.getTools());
		} catch {
			// A partial rediscovery must not leave native tools active in either
			// manager or session. Neither cleanup failure nor the original native
			// error crosses this metadata-only boundary.
			await this.manager.disconnectAll().catch(() => undefined);
			try { this.session.setMCPPromptCommands([]); } catch { /* Preserve the generic failure. */ }
			await this.session.refreshMCPTools([]).catch(() => undefined);
			this.#failures.clear();
			this.#consumeRevision();
			throw new Error("Native MCP reload failed.");
		}
	}

	reload(request: NativeSessionMcpReload): Promise<NativeSessionMcpSnapshot> {
		const operation = this.#mutationTail.then(async () => {
			if (this.#disposed) throw new Error("Native MCP session was disposed.");
			const before = this.read();
			if (request.epoch !== before.epoch || request.expectedRevision !== before.revision) {
				throw new Error("Native MCP state changed before reload.");
			}
			if (!this.manager) throw new Error(UNAVAILABLE);

			await this.#reload();
			// Reload itself is observable even when the resulting catalog is byte
			// identical. Consuming the ticket prevents a duplicate native launch.
			this.#consumeRevision();
		});
		this.#mutationTail = operation.catch(() => undefined);
		return operation.then(() => this.read());
	}

	reconnect(request: NativeSessionMcpReconnect): Promise<NativeSessionMcpSnapshot> {
		const operation = this.#mutationTail.then(async () => {
			if (this.#disposed) throw new Error("Native MCP session was disposed.");
			const before = this.read();
			if (request.epoch !== before.epoch || request.expectedRevision !== before.revision) {
				throw new Error("Native MCP state changed before reconnect.");
			}
			if (!this.manager) throw new Error(UNAVAILABLE);
			if (!before.servers.some(server => server.name === request.serverName)) {
				throw new Error("Native MCP server is not part of this session.");
			}

			let connected = false;
			try {
				connected = (await this.manager.reconnectServer(request.serverName, { manual: true })) !== null;
				if (!connected) throw new Error(CONNECTION_ERROR);
				await this.session.refreshMCPTools(this.manager.getTools());
				this.#failures.delete(request.serverName);
			} catch {
				this.#failures.add(request.serverName);
				// Rebind the session to the manager's actual post-attempt registry. The
				// native manager intentionally keeps the target's stale selected tools
				// on a failed reconnect; unrelated server tools remain untouched.
				await this.session.refreshMCPTools(this.manager.getTools()).catch(() => undefined);
				this.#consumeRevision();
				throw new Error("Native MCP reconnect failed.");
			}
			this.#consumeRevision();
		});
		this.#mutationTail = operation.catch(() => undefined);
		return operation.then(() => this.read());
	}

	/** The caller owns session-level admission; this queue additionally fences
	 * direct MCP reads/reloads and duplicate authorization across clients. */
	startAuthorization(request: NativeSessionMcpReconnect, options: {
		commandId?: string;
		cwd: string;
		authStorage: AuthStorage;
		assertOwner(): void;
		notify?(snapshot: NativeMcpAuthorizationSnapshot): void;
		/** Private handoff to the native tool reconnect; never a second reload. */
		challenge?: MCPAuthChallenge;
		reconnect?(config: MCPServerConfig): Promise<boolean>;
	}): NativeMcpAuthorization {
		if (this.#disposed) throw new Error("Native MCP session was disposed.");
		if (!this.manager) throw new Error(UNAVAILABLE);
		if (this.#authorization?.pending) throw new Error("Native MCP authorization is already pending.");
		const ready = this.#mutationTail.then(() => {
			options.assertOwner();
			if (this.#disposed) throw new Error("Native MCP session was disposed.");
			const before = this.read();
			if (request.epoch !== before.epoch || request.expectedRevision !== before.revision) {
				throw new Error("Native MCP state changed before authorization.");
			}
			if (!before.servers.some(server => server.name === request.serverName)) throw new Error("Native MCP server is not part of this session.");
			this.#consumeRevision();
		});
		const operation = new NativeMcpAuthorization({
			...options, manager: this.manager, serverName: request.serverName, ready,
			assertOwner: () => {
				if (this.#disposed) throw new Error("Native MCP session was disposed.");
				options.assertOwner();
			},
			reconnect: async config => {
				try {
					if (options.reconnect) return await options.reconnect(config);
					await this.#reload();
					await this.manager!.waitForConnection(request.serverName);
					await this.session.refreshMCPTools(this.manager!.getTools());
					return this.manager!.getConnectionStatus(request.serverName) === "connected";
				} finally { this.#consumeRevision(); }
			},
		});
		this.#authorization = operation;
		this.#mutationTail = operation.completion.then(() => undefined);
		return operation;
	}

	/** A running native tool owns this admission. Return its private refreshed
	 * config as soon as OAuth finishes, while keeping the UI/mutation pending
	 * until the manager acknowledges its own reconnect. Awaiting completion in
	 * the handler would deadlock the manager that must perform that reconnect. */
	startToolAuthorization(serverName: string, challenge: MCPAuthChallenge, context: MCPAuthContext, options: {
		cwd: string;
		authStorage: AuthStorage;
		assertOwner(): void;
	}): { operation: NativeMcpAuthorization; config: Promise<MCPServerConfig | undefined> } {
		if (!context || typeof context.onReconnect !== "function") throw new Error("Native MCP authorization lifecycle is unavailable.");
		context.signal?.throwIfAborted();
		const config = Promise.withResolvers<MCPServerConfig | undefined>();
		const reconnected = Promise.withResolvers<boolean>();
		context.onReconnect(connection => reconnected.resolve(connection !== null));
		const before = this.read();
		const operation = this.startAuthorization({ serverName, epoch: before.epoch, expectedRevision: before.revision }, {
			...options, challenge,
			reconnect: async updated => {
				config.resolve(updated);
				return reconnected.promise;
			},
		});
		const cancel = () => operation.cancel();
		context.signal?.addEventListener("abort", cancel, { once: true });
		if (context.signal?.aborted) cancel();
		void operation.completion.then(() => {
			// Failures before the config handoff must release the native handler.
			config.resolve(undefined);
			context.signal?.removeEventListener("abort", cancel);
		});
		return { operation, config: config.promise };
	}

	getAuthorization(): NativeMcpAuthorization | undefined { return this.#authorization; }
	cancelAuthorization(): void { this.#authorization?.cancel(); }
	async dispose(): Promise<void> {
		this.#disposed = true;
		this.cancelAuthorization();
		await this.#mutationTail;
	}

	readResource(request: NativeSessionMcpResourceRequest): Promise<NativeSessionMcpResourceResult> {
		const operation = this.#mutationTail.then(async () => {
			if (this.#disposed) throw new Error("Native MCP session was disposed.");
			const before = this.read();
			if (request.epoch !== before.epoch || request.expectedRevision !== before.revision) {
				throw new Error("Native MCP state changed before resource read.");
			}
			if (!this.manager) throw new Error(UNAVAILABLE);
			const server = before.servers.find(candidate => candidate.name === request.serverName);
			if (!server) throw new Error("Native MCP server is not part of this session.");
			if (server.status !== "connected") throw new Error("Native MCP server is not connected.");

			const abort = new AbortController();
			const timeout = setTimeout(() => abort.abort(), 30_000);
			try {
				const result = await this.manager.readServerResource(request.serverName, request.uri, { signal: abort.signal });
				if (!result) throw new Error("No native MCP resource result.");
				return parseNativeSessionMcpResourceResult(result);
			} catch {
				throw new Error("Native MCP resource read failed.");
			} finally {
				clearTimeout(timeout);
			}
		});
		this.#mutationTail = operation.then(() => undefined, () => undefined);
		return operation;
	}
}
