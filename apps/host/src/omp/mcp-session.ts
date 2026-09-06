import { randomUUID } from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type {
	NativeSessionMcpReload,
	NativeSessionMcpServer,
	NativeSessionMcpSnapshot,
} from "../../../../packages/shared/src/session-mcp";

const UNAVAILABLE = "Native MCP manager is unavailable for this session.";
const CONNECTION_ERROR = "Native MCP server could not connect.";

function bounded(value: string, max = 1024): string {
	const clean = value.replaceAll("\0", "").trim();
	if (!clean) return "Unknown";
	return clean.length <= max ? clean : clean.slice(0, max);
}

function sourceLabel(manager: MCPManager, name: string): string {
	const source = manager.getSource(name);
	if (!source) return "Native MCP";
	return bounded(`${source.providerName} (${source.level})`);
}

function collectServers(manager: MCPManager, failures: ReadonlySet<string>): NativeSessionMcpServer[] {
	const tools = manager.getTools();
	return manager
		.getAllServerNames()
		.slice()
		.sort((left, right) => left.localeCompare(right))
		.map(name => {
			const status = manager.getConnectionStatus(name);
			const connection = status === "connected" ? manager.getConnection(name) : undefined;
			return {
				name: bounded(name),
				status,
				source: sourceLabel(manager, name),
				tools: tools
					.filter(tool => tool.mcpServerName === name)
					.map(tool => bounded(tool.name))
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
	#reloadTail: Promise<void> = Promise.resolve();

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
		return this.manager
			? { available: true, servers: collectServers(this.manager, this.#failures) }
			: { available: false, reason: UNAVAILABLE, servers: [] };
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
		const operation = this.#reloadTail.then(async () => {
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
		this.#reloadTail = operation.catch(() => undefined);
		return operation.then(() => this.read());
	}
}
