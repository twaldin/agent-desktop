import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { MCP_CONFIG_SCHEMA_URL, type MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getMCPConfigPath, refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import { clearNativeMcpAuthorization } from "./mcp-unauth";
import { captureNativeMcpOAuthConfig } from "./mcp-oauth-config";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

let root: string, cwd: string, file: string, database: Database, auth: AuthStorage;
let savedAgentDir: string | undefined, savedUrl: string | undefined;
const credential = { type: "oauth" as const, access: "fixture-access", refresh: "fixture-refresh", expires: 0 };
const emptyManager: Pick<MCPManager, "getServerConfig" | "getSource"> = { getServerConfig: () => undefined, getSource: () => undefined };
beforeEach(async () => {
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  savedUrl = process.env.DESKTOP_MCP_TEST_URL;
  root = await mkdtemp(path.join(tmpdir(), "desktop-mcp-unauth-"));
  cwd = path.join(root, "project");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  refreshDirsFromEnv();
  await mkdir(cwd, { recursive: true });
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  file = getMCPConfigPath("user", cwd);
  database = new Database(path.join(root, "auth.db"));
  auth = new AuthStorage(new SqliteAuthCredentialStore(database));
});
afterEach(async () => {
  await auth.close();
  database.close();
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedUrl === undefined) delete process.env.DESKTOP_MCP_TEST_URL; else process.env.DESKTOP_MCP_TEST_URL = savedUrl;
  refreshDirsFromEnv();
  await rm(root, { recursive: true, force: true });
});
const save = (config: MCPServerConfig) => writeFile(file, JSON.stringify({ preserved: "original", mcpServers: { selected: config, unrelated: { command: "unchanged" } } }));
const clear = (options: Partial<Parameters<typeof clearNativeMcpAuthorization>[0]> = {}) => clearNativeMcpAuthorization({
  cwd, serverName: "selected", manager: emptyManager, authStorage: auth, assertOwner() {}, reload: async () => {}, ...options,
});

test("clears native explicit and raw/expanded URL rows, preserving provider accounts and configured headers", async () => {
  process.env.DESKTOP_MCP_TEST_URL = "https://fixture.invalid/mcp";
  const rawUrl = "${DESKTOP_MCP_TEST_URL}";
  const explicit = "mcp_oauth:legacy-explicit";
  const ids = [explicit, mcpOAuthCredentialId(rawUrl), mcpOAuthCredentialId(process.env.DESKTOP_MCP_TEST_URL)];
  for (const id of [...ids, "anthropic"]) await auth.set(id, credential);
  const config = { type: "http" as const, url: rawUrl, headers: { Authorization: "Bearer ${UNTOUCHED}" }, auth: { type: "oauth" as const, credentialId: explicit } };
  await save(config);
  let reloads = 0;
  expect(await clear({ reload: async () => { reloads++; } })).toEqual({ changed: true });
  for (const id of ids) expect(auth.get(id)).toBeUndefined();
  expect(auth.get("anthropic")).toEqual(credential);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  expect(persisted.preserved).toBe("original");
  expect(persisted.mcpServers.unrelated).toEqual({ command: "unchanged" });
  expect(persisted.mcpServers.selected).toEqual({ type: "http", url: rawUrl, headers: config.headers });
  expect(reloads).toBe(1);
});

test("native guard retains foreign-profile and unmanaged explicit credentials", async () => {
  for (const explicit of ["anthropic", mcpOAuthCredentialId("https://foreign.invalid", "other-fixture-profile")]) {
    await auth.set(explicit, credential);
    await save({ type: "sse", url: "https://no-row.invalid", auth: { type: "oauth", credentialId: explicit } });
    await clear();
    expect(auth.get(explicit)).toEqual(credential);
    expect(JSON.parse(await readFile(file, "utf8")).mcpServers.selected.auth).toBeUndefined();
  }
});

test("discovered no-auth source is not copied; URL credential clearing reloads without a config override", async () => {
  const config = { type: "http" as const, url: "https://discovered.invalid/mcp" };
  const manager: Pick<MCPManager, "getServerConfig" | "getSource"> = { getServerConfig: () => config, getSource: () => ({ provider: "fixture", providerName: "Fixture", level: "project", path: path.join(cwd, "plugin.json") }) };
  let reloads = 0;
  const options = { manager, reload: async () => { reloads++; } };
  expect(await clear(options)).toEqual({ changed: false });
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(reloads).toBe(0);
  const id = mcpOAuthCredentialId(config.url);
  await auth.set(id, credential);
  expect(await clear(options)).toEqual({ changed: true });
  expect(auth.get(id)).toBeUndefined();
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(reloads).toBe(1);
});

test("late reload failure preserves completed clearing and reports its partial outcome", async () => {
  const id = mcpOAuthCredentialId("https://fixture.invalid");
  await auth.set(id, credential);
  await save({ type: "http", url: "https://fixture.invalid", auth: { type: "oauth", credentialId: id } });
  await expect(clear({ reload: async () => { throw new Error("private-native-detail"); } })).rejects.toThrow("may already have changed");
  expect(auth.get(id)).toBeUndefined();
  expect(JSON.parse(await readFile(file, "utf8")).mcpServers.selected.auth).toBeUndefined();
});

test("retirement during native removal prevents subsequent configuration writes and reload", async () => {
  const id = "mcp_oauth:held-original";
  await auth.set(id, credential);
  await save({ type: "http", url: "https://fixture.invalid", auth: { type: "oauth", credentialId: id } });
  const before = await readFile(file, "utf8");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const remove = auth.remove.bind(auth);
  auth.remove = async name => { await remove(name); entered.resolve(); await release.promise; };
  let retired = false, reloads = 0;
  const operation = clear({ assertOwner: () => { if (retired) throw new Error("Retired"); }, reload: async () => { reloads++; } });
  const result = operation.then(() => null, error => error);
  await entered.promise;
  retired = true;
  release.resolve();
  expect((await result).message).toContain("may already have changed");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(auth.get(id)).toBeUndefined();
  expect(reloads).toBe(0);
});


test("project authorization clearing preserves the user file and discovered OAuth sources create only a native user override", async () => {
  const projectFile = path.join(cwd, ".mcp.json");
  const id = "mcp_oauth:project";
  const config = { command: "original", env: { KEEP: "${ORIGINAL}" }, auth: { type: "oauth" as const, credentialId: id } };
  await auth.set(id, credential);
  await writeFile(file, JSON.stringify({ preserved: "user", mcpServers: { unrelated: { command: "unchanged" } } }));
  const userBefore = await readFile(file, "utf8");
  await writeFile(projectFile, JSON.stringify({ preserved: "project", mcpServers: { selected: config } }));
  await clear();
  expect(auth.get(id)).toBeUndefined();
  expect(await readFile(file, "utf8")).toBe(userBefore);
  expect(JSON.parse(await readFile(projectFile, "utf8"))).toEqual({ $schema: MCP_CONFIG_SCHEMA_URL, preserved: "project", mcpServers: { selected: { command: "original", env: config.env } } });
  await rm(projectFile);
  await auth.set(id, credential);
  const manager: Pick<MCPManager, "getServerConfig" | "getSource"> = { getServerConfig: () => config, getSource: () => ({ provider: "fixture", providerName: "Fixture", level: "project", path: path.join(cwd, "plugin.json") }) };
  await clear({ manager });
  expect(auth.get(id)).toBeUndefined();
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ $schema: MCP_CONFIG_SCHEMA_URL, preserved: "user", mcpServers: { unrelated: { command: "unchanged" }, selected: { command: "original", env: config.env } } });
  expect(manager.getServerConfig("selected")).toEqual(config);
});

test("a config edit during credential removal is preserved and prevents reload", async () => {
  const id = "mcp_oauth:original-config";
  await auth.set(id, credential);
  await save({ command: "original", auth: { type: "oauth", credentialId: id } });
  const changed = JSON.stringify({ mcpServers: { selected: { command: "replacement" } } });
  const remove = auth.remove.bind(auth);
  auth.remove = async name => { await remove(name); await writeFile(file, changed); };
  let reloads = 0;
  await expect(clear({ reload: async () => { reloads++; } })).rejects.toThrow("may already have changed");
  expect(await readFile(file, "utf8")).toBe(changed);
  expect(auth.get(id)).toBeUndefined();
  expect(reloads).toBe(0);
});

test("configuration commit checks the original owner after asynchronous lock acquisition", async () => {
  await save({ command: "original" });
  const before = await readFile(file, "utf8");
  let retired = false;
  const target = await captureNativeMcpOAuthConfig({ cwd, serverName: "selected", manager: emptyManager, assertOwner() { if (retired) throw new Error("Original owner retired"); } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = withFileLock(file, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const result = target.commit({ command: "must-not-write" }).then(() => null, error => error);
  retired = true;
  release.resolve();
  await holding;
  expect(await result).toMatchObject({ message: "Original owner retired" });
  expect(await readFile(file, "utf8")).toBe(before);
});
