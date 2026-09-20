import { expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { NativeMcpAuthorizationSnapshot, NativeSessionMcpSnapshot } from "@agent-desktop/shared";
import { builtinAvailability } from "./composer-actions";
import { dispatchNativePrompt, type NativeCommandBridges } from "./commands";
import { OmpPromptAdmissionError } from "./prompt";
import type { SessionTodos, TodoMutationResult } from "../../../../packages/shared/src/session-todos";

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

// These controls exercise the actual native parser and app dispatch precedence;
// the injected admission port does not count as native queue/provider proof.
function forceRouting(shadow?: string, prepared = false) {
  const value = fixture(mcp("succeeded"));
  let nativeCalls = 0, shadowCalls = 0;
  if (shadow) Object.assign(value.session, { extensionRunner: {
    getCommand: (name: string) => name === shadow ? { handler: async () => { shadowCalls++; } } : undefined,
    createCommandContext: () => ({}), runScoped: async (run: () => Promise<void>) => run(), emitError() {},
  } });
  const bridges: NativeCommandBridges = { ...value.bridges, forceTool: {
    options: prepared ? { forceTool: { epoch: "original", expectedRevision: 1, toolName: "read" } } : {},
    async dispatch(parsed, builtin) {
      nativeCalls++;
      expect(builtin.name).toBe("force");
      expect(parsed.args).toBe("read inspect");
      return { agentInvoked: false, handledCommand: "force" };
    },
  } };
  return { ...value, bridges, nativeCalls: () => nativeCalls, shadowCalls: () => shadowCalls };
}

test("native force aliases retain exact extension token ownership", async () => {
  const canonicalShadow = forceRouting("force");
  expect(await dispatchNativePrompt(canonicalShadow.session, "/force read inspect", undefined, undefined, canonicalShadow.bridges)).toMatchObject({ handledCommand: "force" });
  expect(canonicalShadow.nativeCalls()).toBe(0);
  expect(canonicalShadow.shadowCalls()).toBe(1);
  await dispatchNativePrompt(canonicalShadow.session, "/force:read inspect", undefined, undefined, canonicalShadow.bridges);
  expect(canonicalShadow.nativeCalls()).toBe(1);
  const aliasShadow = forceRouting("force:read");
  await dispatchNativePrompt(aliasShadow.session, "/force:read inspect", undefined, undefined, aliasShadow.bridges);
  expect(aliasShadow.nativeCalls()).toBe(0);
  expect(aliasShadow.shadowCalls()).toBe(1);
  await dispatchNativePrompt(aliasShadow.session, "/force read inspect", undefined, undefined, aliasShadow.bridges);
  expect(aliasShadow.nativeCalls()).toBe(1);
});

test("prepared force guard refuses changed text and a newly shadowing handler before effects", async () => {
  const plain = forceRouting(undefined, true);
  await expect(dispatchNativePrompt(plain.session, "edited ordinary text", undefined, undefined, plain.bridges)).rejects.toThrow("prepared force command changed");
  expect(plain.nativeCalls()).toBe(0);
  const shadow = forceRouting("force", true);
  await expect(dispatchNativePrompt(shadow.session, "/force read inspect", undefined, undefined, shadow.bridges)).rejects.toThrow("no longer owns");
  expect(shadow.nativeCalls()).toBe(0);
  expect(shadow.shadowCalls()).toBe(0);
});

test("resolved force alias scope survives canonical shadowing but refuses a new exact winner after output", async () => {
  for (const replacement of ["unchanged", "extension", "custom"] as const) {
    const value = forceRouting("force");
    const entered = Promise.withResolvers<void>(), output = Promise.withResolvers<void>();
    let scopeDepth = 0, promptEntries = 0, synchronousSections = 0;
    value.bridges.withNativeForceInvocation = operation => {
      scopeDepth++;
      try { return operation(); } finally { scopeDepth--; }
    };
    value.bridges.forceTool!.dispatch = async (_parsed, _builtin, _invoke, _readOutput, scope) => {
      if (!scope) throw new Error("Original invocation scope was not supplied");
      scope(() => { expect(scopeDepth).toBe(1); synchronousSections++; });
      entered.resolve();
      await output.promise;
      scope(() => { expect(scopeDepth).toBe(1); synchronousSections++; promptEntries++; });
      return { agentInvoked: true };
    };
    const pending = dispatchNativePrompt(value.session, "/force:read inspect", undefined, undefined, value.bridges);
    void pending.catch(() => {});
    await entered.promise;
    expect(scopeDepth).toBe(0);
    if (replacement === "extension") Object.assign(value.session.extensionRunner!, {
      getCommand: (name: string) => name === "force" || name === "force:read" ? { handler: async () => {} } : undefined,
    });
    if (replacement === "custom") Object.assign(value.session, {
      customCommands: [{ command: { name: "force:read", execute: async () => "unexpected" } }],
    });
    output.resolve();
    if (replacement === "unchanged") {
      expect(await pending).toEqual({ agentInvoked: true });
      expect(promptEntries).toBe(1);
      expect(synchronousSections).toBe(2);
    } else {
      await expect(pending).rejects.toThrow("original native force invocation changed");
      expect(promptEntries).toBe(0);
      expect(synchronousSections).toBe(1);
    }
    expect(scopeDepth).toBe(0);
  }
});

test("Plan dispatch preserves the exact winning native token and does not reinterpret a shadowed command", async () => {
  const value = fixture(mcp("succeeded"));
  const received: string[] = []; let shadows = 0;
  Object.assign(value.session, { extensionRunner: {
    getCommand: (name: string) => name === "plan" ? { handler: async () => { shadows++; } } : undefined,
    createCommandContext: () => ({}), runScoped: async (run: () => Promise<void>) => run(), emitError() {},
  } });
  const bridges: NativeCommandBridges = { ...value.bridges, plan: async text => {
    received.push(text); return { agentInvoked: false, handledCommand: "plan" };
  } };
  await dispatchNativePrompt(value.session, "/plan inspect", undefined, undefined, bridges);
  expect(shadows).toBe(1); expect(received).toEqual([]);
  await dispatchNativePrompt(value.session, "/plan:inspect original text", undefined, undefined, bridges);
  expect(received).toEqual(["/plan:inspect original text"]);
  await expect(dispatchNativePrompt(value.session, "/plan-review")).rejects.toThrow("Plan owner is unavailable");
  expect(received).toHaveLength(1);
});

const todosState: SessionTodos = { ticket: { nativeSessionId: "session", epoch: "epoch", revision: "3" }, phases: [], markdown: "", nativeCommandAvailable: true, reconciliationRequired: false };
const todoResult = (output: string, desktopAction?: TodoMutationResult["desktopAction"]): TodoMutationResult => ({ commandId: "cmd", state: todosState, output, ...(desktopAction ? { desktopAction } : {}) });

test("/todo keeps extension precedence and routes only the native winner through the owning controller", async () => {
  const value = fixture(mcp("succeeded"));
  const received: string[] = []; let shadows = 0;
  Object.assign(value.session, { extensionRunner: {
    getCommand: (name: string) => name === "todo" ? { handler: async () => { shadows++; } } : undefined,
    createCommandContext: () => ({}), runScoped: async (run: () => Promise<void>) => run(), emitError() {},
  } });
  const bridges: NativeCommandBridges = { ...value.bridges, todo: async text => { received.push(text); return todoResult("- [ ] fixture"); } };
  await dispatchNativePrompt(value.session, "/todo append fixture", undefined, undefined, bridges);
  expect(shadows).toBe(1); expect(received).toEqual([]); expect(value.entries).toEqual([]);
  Object.assign(value.session, { extensionRunner: undefined });
  const result = await dispatchNativePrompt(value.session, "/todo append fixture", undefined, undefined, bridges);
  expect(received).toEqual(["/todo append fixture"]);
  expect(result).toEqual({ agentInvoked: false, handledCommand: "todo", commandEntryId: "entry-1", output: "- [ ] fixture" });
  expect(value.entries).toEqual([{ type: "agent-desktop.command-output", value: { command: "todo", output: "- [ ] fixture" } }]);
  await expect(dispatchNativePrompt(value.session, "/todo", undefined, undefined, value.bridges)).rejects.toThrow("Todos owner is unavailable");
  expect(received).toHaveLength(1);
});

test("/todo TUI-only verbs surface the native usage text and desktop applicability without claiming the controller ran", async () => {
  const value = fixture(mcp("succeeded"));
  const usage = "/todo edit requires the TUI editor; use /todo export then /todo import for non-interactive edits.";
  const bridges: NativeCommandBridges = { ...value.bridges, todo: async () => todoResult(usage, "edit") };
  const result = await dispatchNativePrompt(value.session, "/todo edit", undefined, undefined, bridges);
  expect(result).toMatchObject({ agentInvoked: false, handledCommand: "todo", output: usage });
  expect(builtinAvailability("todo", "edit").availability).toBe("partial");
  expect(builtinAvailability("todo", "collapse").availability).toBe("partial");
  expect(builtinAvailability("todo", "append").availability).toBe("executable");
  expect(builtinAvailability("todo").availability).toBe("executable");
});

test("/todo rejection executes nothing while a post-admission failure retains the unknown outcome", async () => {
  const value = fixture(mcp("succeeded"));
  const rejected = Object.assign(new Error("The native Todos changed. Refresh before trying again."), { code: "TODOS_REJECTED" });
  await expect(dispatchNativePrompt(value.session, "/todo done fixture", undefined, undefined, { ...value.bridges, todo: async () => { throw rejected; } })).rejects.toBe(rejected);
  const unknown = Object.assign(new Error("flush failed"), { code: "OUTCOME_UNKNOWN" });
  const failure = await dispatchNativePrompt(value.session, "/todo done fixture", undefined, undefined, { ...value.bridges, todo: async () => { throw unknown; } }).catch(error => error);
  expect(failure).toBeInstanceOf(OmpPromptAdmissionError);
  expect(failure.code).toBe("OUTCOME_UNKNOWN");
  expect(failure.message).toContain("flush failed");
  expect(value.entries).toEqual([]);
});

test("native /usage show uses the pinned report handler while every reset spelling is fenced before consume", async () => {
  const value = fixture(mcp("succeeded")); let reportCalls = 0, resetCalls = 0;
  Object.assign(value.session, {
    fetchUsageReports: async () => { reportCalls++; return null; },
    listResetCredits: async () => { resetCalls++; return []; },
    redeemResetCredit: async () => { resetCalls++; return { code: "reset" }; },
    sessionManager: { ...value.session.sessionManager, getUsageStatistics: () => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, orchestrationInput: 0, orchestrationOutput: 0, orchestrationCacheRead: 0, premiumRequests: 0, cost: 0 }) },
  });
  for (const command of ["/usage", "/usage show"]) {
    const result = await dispatchNativePrompt(value.session, command, undefined, undefined, value.bridges);
    expect(result).toMatchObject({ agentInvoked: false, handledCommand: "usage", output: expect.stringContaining("Input tokens: 1") });
  }
  expect(reportCalls).toBe(2);
  for (const command of ["/usage reset", "/usage:reset active", "/usage\tReSeT same@fixture.invalid"]) {
    await expect(dispatchNativePrompt(value.session, command, undefined, undefined, value.bridges)).rejects.toThrow("explicitly confirm");
  }
  expect(resetCalls).toBe(0);
});

test("usage extension ownership precedes the reset fence and malformed native syntax retains exact handler output", async () => {
  const shadow = fixture(mcp("succeeded")); let shadowCalls = 0;
  Object.assign(shadow.session, { extensionRunner: {
    getCommand: (name: string) => name === "usage" ? { handler: async () => { shadowCalls++; } } : undefined,
    createCommandContext: () => ({}), runScoped: async (run: () => Promise<void>) => run(), emitError() {},
  } });
  await dispatchNativePrompt(shadow.session, "/usage reset active", undefined, undefined, shadow.bridges);
  expect(shadowCalls).toBe(1);
  const value = fixture(mcp("succeeded"));
  Object.assign(value.session, { fetchUsageReports: async () => null,
    sessionManager: { ...value.session.sessionManager, getUsageStatistics: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, orchestrationInput: 0, orchestrationOutput: 0, orchestrationCacheRead: 0, premiumRequests: 0, cost: 0 }) } });
  const invalid = await dispatchNativePrompt(value.session, "/usage show extra", undefined, undefined, value.bridges);
  expect(invalid.output).toBe("Usage: /usage [show|reset [account|active]]");
});
