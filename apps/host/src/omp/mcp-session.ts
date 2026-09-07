import { randomUUID } from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type {
	NativeSessionMcpReload,
	NativeSessionMcpReconnect,
	NativeSessionMcpServer,
	NativeSessionMcpSnapshot,
} from "../../../../packages/shared/src/session-mcp";

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

function collectServers(manager: MCPManager, failures: ReadonlySet<string>): NativeSessionMcpServer[] {
	const tools = manager.getTools();
	return limited(manager.getAllServerNames(), "servers")
		.slice()
		.sort((left, right) => left.localeCompare(right))
		.map(name => {
			const status = manager.getConnectionStatus(name);
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
				status,
				source: sourceLabel(manager, name),
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

	constructor(
		private readonly session: AgentSession,
		private readonly manager: MCPManager | undefined,
	) {}

	#value(): Omit<NativeSessionMcpSnapshot, "epoch" | "revision"> {
		if (this.manager) {
			for (const name of this.#failures) {
				if (this.manager.getConnectionStatus(name) === "connected") this.#failures.delete(name);
			}
		}
		const value = this.manager
			? { available: true, canReconnect: true, servers: collectServers(this.manager, this.#failures) }
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

	reload(request: NativeSessionMcpReload): Promise<NativeSessionMcpSnapshot> {
		const operation = this.#mutationTail.then(async () => {
			const before = this.read();
			if (request.epoch !== before.epoch || request.expectedRevision !== before.revision) {
				throw new Error("Native MCP state changed before reload.");
			}
			if (!this.manager) throw new Error(UNAVAILABLE);

			try {
				await this.manager.disconnectAll();
				this.#failures.clear();
				this.session.setMCPPromptCommands([]);
				clearFsCache();
				const result = await this.manager.discoverAndConnect({
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
			// Reload itself is observable even when the resulting catalog is byte
			// identical. Consuming the ticket prevents a duplicate native launch.
			this.#consumeRevision();
		});
		this.#mutationTail = operation.catch(() => undefined);
		return operation.then(() => this.read());
	}

	reconnect(request: NativeSessionMcpReconnect): Promise<NativeSessionMcpSnapshot> {
		const operation = this.#mutationTail.then(async () => {
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
}
