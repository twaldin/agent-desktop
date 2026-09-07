import { expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { NativeMcpAuthorizationSnapshot, NativeSessionMcpSnapshot } from "@agent-desktop/shared";
import { builtinAvailability } from "./composer-actions";
import { dispatchNativePrompt, type NativeCommandBridges } from "./commands";

function mcp(status: NativeMcpAuthorizationSnapshot["status"], options: Partial<NativeMcpAuthorizationSnapshot> = {}): NativeMcpAuthorizationSnapshot {
  return {
    authorizationId: "authorization-1", serverName: "fixture", status, phase: "finished",
    credentialsStored: options.credentialWrite === "stored", credentialWrite: "not-started", configuration: "untouched", reconnected: false,
    login: { loginId: "authorization-1", providerId: "mcp:fixture", status: status === "cancelled" ? "cancelled" : status === "succeeded" ? "succeeded" : "failed",
      startedAt: 1, updatedAt: 2, cancellationRequested: status === "cancelled", prompts: [] },
    ...options,
  };
}
const live = (canAuthorize = true): NativeSessionMcpSnapshot => ({ epoch: "epoch", revision: 1, available: true, servers: [{
  name: "fixture", status: "disconnected", source: "fixture", canAuthorize, tools: [], resourceCount: null, promptCount: null,
}] });
function fixture(snapshot: NativeMcpAuthorizationSnapshot, options: { extension?: boolean; canAuthorize?: boolean } = {}) {
  const entries: Array<{ type: string; value: unknown }> = [];
  let calls = 0, extensionCalls = 0;
  const extension = options.extension ? { handler: async () => { extensionCalls++; }, description: "shadow" } : undefined;
  const session = {
    extensionRunner: options.extension ? { getCommand: (name: string) => name === "mcp" ? extension : undefined, createCommandContext: () => ({}), runScoped: async (run: () => Promise<void>) => run(), emitError: () => {} } : undefined,
    customCommands: [], slashCommands: [], promptTemplates: [], isCompacting: false, isAborting: false,
    sessionManager: { appendCustomEntry: (type: string, value: unknown) => { entries.push({ type, value }); return `entry-${entries.length}`; }, getCwd: () => "/fixture" },
    settings: {}, prompt: async () => { throw new Error("model must not run"); },
  } as unknown as AgentSession;
  const bridges: NativeCommandBridges = {
    reloadMcp: async () => {}, reconnectMcp: async () => live(), inspectMcp: () => live(options.canAuthorize),
    authorizeMcp: async serverName => { calls++; expect(serverName).toBe("fixture"); return snapshot; },
  };
  return { session, bridges, entries, calls: () => calls, extensionCalls: () => extensionCalls };
}

test("typed reauth is executable and records only a sanitized successful terminal summary", async () => {
  expect(builtinAvailability("mcp", "reauth").availability).toBe("executable");
  const value = fixture(mcp("succeeded", { credentialWrite: "stored", credentialsStored: true, configuration: "saved", reconnected: true,
    error: "private callback URL https://issuer.invalid?token=secret" }));
  const result = await dispatchNativePrompt(value.session, "/mcp reauth fixture ignored-native-token", undefined, undefined, value.bridges);
  expect(result).toMatchObject({ agentInvoked: false, handledCommand: "mcp", commandEntryId: "entry-1" });
  expect(result.output).toBe('Reauthorized "fixture"\nStatus: succeeded\nCredentials: stored\nConfiguration: saved\nServer: connected');
  expect(value.entries).toEqual([{ type: "agent-desktop.command-output", value: { command: "mcp", output: result.output } }]);
  expect(JSON.stringify(value.entries)).not.toContain("issuer.invalid");
  expect(JSON.stringify(value.entries)).not.toContain("secret");
});

test("failed and cancelled terminal outcomes retain their truthful partial effect summaries without invoking a model", async () => {
  for (const snapshot of [
    mcp("failed", { credentialWrite: "stored", credentialsStored: true, configuration: "unknown" }),
    mcp("cancelled", { credentialWrite: "not-started", configuration: "untouched" }),
  ]) {
    const value = fixture(snapshot);
    const result = await dispatchNativePrompt(value.session, "/mcp reauth fixture", undefined, undefined, value.bridges);
    expect(result.agentInvoked).toBe(false);
    expect(result.output).toContain(`Status: ${snapshot.status}`);
    expect(result.output).toContain(snapshot.status === "failed" ? "Credentials: stored" : "Credentials: unchanged");
    expect(result.output).toContain(`Configuration: ${snapshot.configuration}`);
    expect(value.calls()).toBe(1);
  }
});

test("reauth refuses unavailable servers and bridges while native extension precedence remains exact", async () => {
  const unavailable = fixture(mcp("succeeded"), { canAuthorize: false });
  await expect(dispatchNativePrompt(unavailable.session, "/mcp reauth fixture", undefined, undefined, unavailable.bridges)).rejects.toThrow("not available");
  expect(unavailable.calls()).toBe(0);
  await expect(dispatchNativePrompt(unavailable.session, "/mcp reauth fixture")).rejects.toThrow("bridge is unavailable");
  await expect(dispatchNativePrompt(unavailable.session, "/mcp reauth")).rejects.toThrow("Server name required");

  const shadow = fixture(mcp("succeeded"), { extension: true });
  expect(await dispatchNativePrompt(shadow.session, "/mcp reauth fixture", undefined, undefined, shadow.bridges)).toEqual({ agentInvoked: false, handledCommand: "mcp" });
  expect(shadow.extensionCalls()).toBe(1);
  expect(shadow.calls()).toBe(0);
  expect(shadow.entries).toEqual([]);
});
