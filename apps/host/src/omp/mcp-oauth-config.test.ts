import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getMCPConfigPath, refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { MCP_CONFIG_SCHEMA_URL } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { captureNativeMcpOAuthConfig } from "./mcp-oauth-config";

let root = "";
let cwd = "";
let originalAgentDir: string | undefined;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const realFile = async (file: string) => path.join(await realpath(path.dirname(file)), path.basename(file));
const emptyManager = {
  getServerConfig: () => undefined,
  getSource: () => undefined,
} as Pick<MCPManager, "getServerConfig" | "getSource">;

beforeEach(async () => {
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  root = await mkdtemp(path.join(tmpdir(), "agent-desktop-mcp-oauth-config-"));
  cwd = path.join(root, "project");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  refreshDirsFromEnv();
  await mkdir(cwd, { recursive: true });
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
});

afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  refreshDirsFromEnv();
  await rm(root, { recursive: true, force: true });
});

describe("native MCP OAuth configuration ownership", () => {
  test("uses native precedence and preserves raw placeholders and unrelated fields", async () => {
    const user = getMCPConfigPath("user", cwd);
    const project = getMCPConfigPath("project", cwd);
    await mkdir(path.dirname(project), { recursive: true });
    await writeFile(user, json({ preserved: "user", mcpServers: { shared: {
      type: "http", url: "https://user.invalid/mcp", headers: { Authorization: "Bearer ${MCP_TOKEN}" },
    } } }));
    await writeFile(project, json({ preserved: "project", mcpServers: { shared: { type: "http", url: "https://project.invalid/mcp" } } }));
    await writeFile(path.join(cwd, "mcp.json"), json({ mcpServers: { shared: { type: "http", url: "https://standalone.invalid/mcp" } } }));

    const target = await captureNativeMcpOAuthConfig({ cwd, serverName: "shared", manager: emptyManager });
    expect(target.source).toEqual({ filePath: await realFile(user), scope: "user", discovered: false });
    expect(target.config).toMatchObject({ url: "https://user.invalid/mcp", headers: { Authorization: "Bearer ${MCP_TOKEN}" } });
    await target.assertCurrent();
    await target.commit({ ...target.config, auth: { type: "oauth", credentialId: "private-credential-id" } });
    const saved = JSON.parse(await readFile(user, "utf8"));
    expect(saved).toMatchObject({ preserved: "user", mcpServers: { shared: {
      headers: { Authorization: "Bearer ${MCP_TOKEN}" }, auth: { credentialId: "private-credential-id" },
    } } });
    expect(JSON.parse(await readFile(project, "utf8"))).toMatchObject({ preserved: "project" });
    await expect(target.commit(target.config)).rejects.toThrow("already committed");
  });

  test("preserves standalone precedence and refuses a change in any higher-priority source", async () => {
    const project = getMCPConfigPath("project", cwd);
    await writeFile(path.join(cwd, "mcp.json"), json({ marker: "first", mcpServers: { server: { type: "http", url: "https://first.invalid" } } }));
    await writeFile(path.join(cwd, ".mcp.json"), json({ marker: "second", mcpServers: { server: { type: "http", url: "https://second.invalid" } } }));
    const target = await captureNativeMcpOAuthConfig({ cwd, serverName: "server", manager: emptyManager });
    expect(target.source.filePath).toBe(await realFile(path.join(cwd, "mcp.json")));
    expect(target.config).toMatchObject({ url: "https://first.invalid" });
    await mkdir(path.dirname(project), { recursive: true });
    await writeFile(project, json({ mcpServers: { unrelated: { command: "/bin/false" } } }));
    await expect(target.commit({ ...target.config, auth: { type: "oauth" } })).rejects.toThrow("changed");
    expect(JSON.parse(await readFile(path.join(cwd, "mcp.json"), "utf8"))).toMatchObject({ marker: "first" });
  });

  test("writes a discovered server only to a user override and fences manager source changes", async () => {
    let config: MCPServerConfig = { type: "http", url: "https://plugin.invalid/mcp", headers: { "X-Key": "${PLUGIN_KEY}" } };
    let source = { provider: "fixture", providerName: "Fixture", path: "/fixture/plugin", level: "project" as const };
    const manager = {
      getServerConfig: () => config,
      getSource: () => source,
    } as Pick<MCPManager, "getServerConfig" | "getSource">;
    const target = await captureNativeMcpOAuthConfig({ cwd, serverName: "plugin:server", manager });
    expect(target.source).toEqual({ filePath: await realFile(getMCPConfigPath("user", cwd)), scope: "user", discovered: true });
    source = { ...source, path: "/fixture/replaced" };
    await expect(target.assertCurrent()).rejects.toThrow("source changed");
    source = { ...source, path: "/fixture/plugin" };
    await target.commit({ ...config, auth: { type: "oauth", credentialId: "private-id" } });
    const user = JSON.parse(await readFile(getMCPConfigPath("user", cwd), "utf8"));
    expect(user.mcpServers["plugin:server"]).toMatchObject({ headers: { "X-Key": "${PLUGIN_KEY}" }, auth: { credentialId: "private-id" } });
    expect(await readFile(path.join(root, "agent", "mcp.json"), "utf8")).not.toContain("resolved-secret");
    config = { ...config, url: "https://later.invalid" };
  });

  test("serializes canonical writers and rejects the stale capture", async () => {
    const project = getMCPConfigPath("project", cwd);
    await mkdir(path.dirname(project), { recursive: true });
    await writeFile(project, json({ mcpServers: { server: { type: "http", url: "https://server.invalid" } } }));
    const [first, second] = await Promise.all([
      captureNativeMcpOAuthConfig({ cwd, serverName: "server", manager: emptyManager }),
      captureNativeMcpOAuthConfig({ cwd, serverName: "server", manager: emptyManager }),
    ]);
    const outcomes = await Promise.allSettled([
      first.commit({ ...first.config, auth: { type: "oauth", credentialId: "first" } }),
      second.commit({ ...second.config, auth: { type: "oauth", credentialId: "second" } }),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    const stored = JSON.parse(await readFile(project, "utf8")).mcpServers.server.auth.credentialId;
    expect(["first", "second"]).toContain(stored);
  });

  test("one captured target cannot commit twice when the first write leaves identical bytes", async () => {
    const project = getMCPConfigPath("project", cwd);
    await mkdir(path.dirname(project), { recursive: true });
    const nativeFormatted = JSON.stringify({
      $schema: MCP_CONFIG_SCHEMA_URL,
      mcpServers: { server: { type: "http", url: "https://server.invalid" } },
    }, null, 2);
    await writeFile(project, nativeFormatted);
    const target = await captureNativeMcpOAuthConfig({ cwd, serverName: "server", manager: emptyManager });
    const outcomes = await Promise.allSettled([target.commit(target.config), target.commit(target.config)]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await readFile(project, "utf8")).toBe(nativeFormatted);
  });

  test("an abort while waiting for the native file lock preserves the captured bytes", async () => {
    const project = getMCPConfigPath("project", cwd);
    await mkdir(path.dirname(project), { recursive: true });
    const original = json({ mcpServers: { server: { type: "http", url: "https://server.invalid" } } });
    await writeFile(project, original);
    const target = await captureNativeMcpOAuthConfig({ cwd, serverName: "server", manager: emptyManager });
    const lockHeld = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const blocker = withFileLock(target.source.filePath, async () => {
      lockHeld.resolve();
      await releaseLock.promise;
    });
    await lockHeld.promise;
    const abort = new AbortController();
    let settled = false;
    const commit = target.commit({ ...target.config, auth: { type: "oauth" } }, abort.signal)
      .finally(() => { settled = true; });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    abort.abort(new Error("fixture cancelled while locked"));
    releaseLock.resolve();
    await blocker;
    await expect(commit).rejects.toThrow("cancelled while locked");
    expect(await readFile(project, "utf8")).toBe(original);
  });

  test("uses native server-name validation while accepting namespaced names", async () => {
    const project = getMCPConfigPath("project", cwd);
    await mkdir(path.dirname(project), { recursive: true });
    await writeFile(project, json({ mcpServers: {
      "plugin:server": { type: "http", url: "https://server.invalid" },
      "invalid name!": { type: "http", url: "https://invalid.invalid" },
    } }));
    const namespaced = await captureNativeMcpOAuthConfig({ cwd, serverName: "plugin:server", manager: emptyManager });
    expect(namespaced.serverName).toBe("plugin:server");
    await expect(captureNativeMcpOAuthConfig({ cwd, serverName: "invalid name!", manager: emptyManager }))
      .rejects.toThrow("letters, numbers");
  });

  test("rejects malformed files, FIFOs, and configuration symlinks without overwriting them", async () => {
    const user = getMCPConfigPath("user", cwd);
    const project = getMCPConfigPath("project", cwd);
    await writeFile(user, "{ private-invalid-json");
    await expect(captureNativeMcpOAuthConfig({ cwd, serverName: "server", manager: emptyManager })).rejects.toThrow("not valid JSON");
    expect(await readFile(user, "utf8")).toBe("{ private-invalid-json");

    await rm(user);
    const fifo = Bun.spawnSync(["/usr/bin/mkfifo", user]);
    expect(fifo.exitCode).toBe(0);
    await expect(captureNativeMcpOAuthConfig({ cwd, serverName: "server", manager: emptyManager })).rejects.toThrow("regular file");
    await rm(user);

    const outside = path.join(root, "outside.json");
    const bytes = json({ mcpServers: { server: { type: "http", url: "https://outside.invalid" } } });
    await writeFile(outside, bytes);
    await symlink(outside, user);
    await expect(captureNativeMcpOAuthConfig({ cwd, serverName: "server", manager: emptyManager })).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe(bytes);
    await rm(user);
    await writeFile(user, bytes);
    const captured = await captureNativeMcpOAuthConfig({ cwd, serverName: "server", manager: emptyManager });
    await rm(user);
    await symlink(outside, user);
    await expect(captured.commit({ ...captured.config, auth: { type: "oauth" } })).rejects.toThrow("changed");
    expect(await readFile(outside, "utf8")).toBe(bytes);
  });
});
