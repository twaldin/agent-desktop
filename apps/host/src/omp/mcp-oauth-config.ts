import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { validateServerName, writeMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPConfigFile, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const MAX_CONFIG_BYTES = 1024 * 1024;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);

interface CapturedFile {
  logicalPath: string;
  path: string;
  raw: string | null;
  config: MCPConfigFile;
}

export interface NativeMcpOAuthConfigTarget {
  readonly serverName: string;
  readonly config: MCPServerConfig;
  readonly source: Readonly<{ filePath: string; scope: "user" | "project"; discovered: boolean }>;
  assertCurrent(): Promise<void>;
  commit(updated: MCPServerConfig, signal?: AbortSignal): Promise<void>;
}

export interface NativeMcpOAuthConfigInput {
  cwd: string;
  serverName: string;
  manager: Pick<MCPManager, "getServerConfig" | "getSource">;
  assertOwner?(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeTree(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (Array.isArray(value)) return value.every(item => safeTree(item, depth + 1));
  if (!isRecord(value)) return true;
  return Object.keys(value).every(key => !forbiddenKeys.has(key))
    && Object.values(value).every(item => safeTree(item, depth + 1));
}

function validServer(name: string, value: unknown): value is MCPServerConfig {
  if (!isRecord(value) || !safeTree(value)) return false;
  try {
    return validateServerConfig(name, value as unknown as MCPServerConfig).length === 0;
  } catch {
    return false;
  }
}

function parseConfig(raw: string | null): MCPConfigFile {
  if (raw === null) return { mcpServers: {} };
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("An existing native MCP configuration is not valid JSON. Repair it before authorizing."); }
  if (!isRecord(value) || !safeTree(value)) throw new Error("An existing native MCP configuration has an unsupported structure.");
  if (value.mcpServers !== undefined && (!isRecord(value.mcpServers)
    || Object.entries(value.mcpServers).some(([name, server]) => !validServer(name, server)))) {
    throw new Error("An existing native MCP server configuration is invalid. Repair it before authorizing.");
  }
  for (const key of ["enabledServers", "disabledServers"] as const) {
    const item = value[key];
    if (item !== undefined && (!Array.isArray(item) || item.some(name => typeof name !== "string"))) {
      throw new Error("An existing native MCP configuration has an unsupported structure.");
    }
  }
  return value as MCPConfigFile;
}

async function canonicalCandidate(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await canonicalCandidate(path.dirname(file)), path.basename(file));
  }
}

async function readRaw(file: string): Promise<string | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("The native MCP configuration is not an owned regular file.");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_CONFIG_BYTES) throw new Error("Native MCP configuration must be a regular file smaller than 1 MiB.");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    for (;;) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      size += result.bytesRead;
      if (size > MAX_CONFIG_BYTES) throw new Error("Native MCP configuration exceeds 1 MiB.");
      if (!result.bytesRead) break;
    }
    const after = await handle.stat();
    const current = await stat(file);
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Native MCP configuration changed during the read. Reload it.");
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function captureFile(file: string, projectRoot?: string): Promise<CapturedFile> {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error("Native MCP configuration symlinks are not writable owners.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const canonical = await canonicalCandidate(file);
  if (projectRoot) {
    const relative = path.relative(projectRoot, canonical);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Native MCP project configuration escaped its project.");
  }
  const raw = await readRaw(canonical);
  return { logicalPath: file, path: canonical, raw, config: parseConfig(raw) };
}

function managerFingerprint(manager: NativeMcpOAuthConfigInput["manager"], serverName: string): string | null {
  const config = manager.getServerConfig(serverName);
  const source = manager.getSource(serverName);
  return config && source ? JSON.stringify([config, source]) : null;
}

function cloneServer(config: MCPServerConfig): MCPServerConfig {
  return structuredClone(config);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("MCP authorization cancelled", "AbortError");
}

/** Capture the exact native config owner used by MCP's authorization command. */
export async function captureNativeMcpOAuthConfig(input: NativeMcpOAuthConfigInput): Promise<NativeMcpOAuthConfigTarget> {
  const serverNameError = validateServerName(input.serverName);
  if (serverNameError) throw new Error(serverNameError);
  const cwd = await realpath(input.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Native MCP authorization requires a project directory.");
  const userPath = getMCPConfigPath("user", cwd);
  const logicalProjectPaths = [getMCPConfigPath("project", cwd), path.join(cwd, "mcp.json"), path.join(cwd, ".mcp.json")];
  const user = await captureFile(userPath);
  const projectFiles = await Promise.all(logicalProjectPaths.map(file => captureFile(file, cwd)));
  const files = [user, ...projectFiles];

  let selected: CapturedFile | undefined;
  let scope: "user" | "project" = "project";
  if (user.config.mcpServers?.[input.serverName]) { selected = user; scope = "user"; }
  else selected = projectFiles.find(file => file.config.mcpServers?.[input.serverName]);

  const discoveredFingerprint = managerFingerprint(input.manager, input.serverName);
  const discovered = !selected;
  const selectedConfig = selected?.config.mcpServers?.[input.serverName]
    ?? input.manager.getServerConfig(input.serverName);
  if (!selectedConfig || (discovered && !input.manager.getSource(input.serverName))) {
    throw new Error("The native MCP server is no longer available.");
  }
  if (!validServer(input.serverName, selectedConfig)) throw new Error("The native MCP server configuration is invalid.");
  const target = selected ?? user;
  if (discovered) scope = "user";
  let committed = false;

  const assertCurrent = async (): Promise<void> => {
    for (const captured of files) {
      if (await canonicalCandidate(captured.logicalPath) !== captured.path || await readRaw(captured.logicalPath) !== captured.raw) {
        throw new Error("Native MCP configuration changed. Reload before authorizing.");
      }
    }
    if (discovered && managerFingerprint(input.manager, input.serverName) !== discoveredFingerprint) {
      throw new Error("The native MCP server source changed. Reload before authorizing.");
    }
  };

  const lockAll = async <T>(index: number, operation: () => Promise<T>): Promise<T> => {
    const paths = [...new Set(files.map(file => file.path))].sort();
    if (index === paths.length) return operation();
    const file = paths[index]!;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    return withFileLock(file, () => lockAll(index + 1, operation));
  };

  return {
    serverName: input.serverName,
    config: cloneServer(selectedConfig),
    source: Object.freeze({ filePath: target.path, scope, discovered }),
    assertCurrent,
    async commit(updated, signal) {
      throwIfAborted(signal);
      if (committed) throw new Error("This native MCP authorization target was already committed.");
      if (!validServer(input.serverName, updated)) throw new Error("The updated native MCP server configuration is invalid.");
      await lockAll(0, async () => {
        throwIfAborted(signal);
        if (committed) throw new Error("This native MCP authorization target was already committed.");
        await assertCurrent();
        const next = structuredClone(target.config);
        next.mcpServers = { ...next.mcpServers, [input.serverName]: cloneServer(updated) };
        throwIfAborted(signal);
        // Lock acquisition and the config reread can outlive the original
        // session. Check again in the final native write continuation.
        input.assertOwner?.();
        await writeMCPConfigFile(target.path, next);
        committed = true;
      });
    },
  };
}
