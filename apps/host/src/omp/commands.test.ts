import { expect, test } from "bun:test";
import { SessionManager, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { NativeMcpAuthorizationSnapshot, NativeSessionMcpSnapshot } from "@agent-desktop/shared";
import { builtinAvailability } from "./composer-actions";
import { dispatchNativePrompt, type NativeCommandBridges } from "./commands";
import { beginNativePrompt, OmpPromptAdmissionError } from "./prompt";
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

test("plugin reload builtins require the reload owner while list and extension precedence stay local", async () => {
  const value = fixture(mcp("succeeded"));
  let reloads = 0;
  const bridges = { ...value.bridges, reloadPlugins: async () => { reloads++; } };
  const reloaded = await dispatchNativePrompt(value.session, "/reload-plugins", undefined, undefined, bridges);
  expect(reloaded).toMatchObject({ agentInvoked: false, handledCommand: "reload-plugins", output: "Plugins reloaded." });
  expect(reloads).toBe(1);
  await expect(dispatchNativePrompt(value.session, "/reload-plugins", undefined, undefined, value.bridges)).rejects.toThrow("bridge is unavailable");

  const listed = await dispatchNativePrompt(value.session, "/plugins list", undefined, undefined, value.bridges);
  expect(listed).toMatchObject({ agentInvoked: false, handledCommand: "plugins" });
  expect(listed.output).toBeTruthy();
  expect(reloads).toBe(1);

  const shadow = fixture(mcp("succeeded"), { extension: true });
  Object.assign(shadow.session.extensionRunner!, { getCommand: (name: string) => name === "reload-plugins" ? { handler: async () => {} } : undefined });
  await dispatchNativePrompt(shadow.session, "/reload-plugins", undefined, undefined, bridges);
  expect(reloads).toBe(1);
});

test("retry and fresh route only through the owning recovery bridge after exact extension precedence", async () => {
  expect(builtinAvailability("retry").availability).toBe("executable");
  expect(builtinAvailability("fresh").availability).toBe("executable");
  const value = fixture(mcp("succeeded"));
  const calls: unknown[] = [];
  const recovery = async (command: "retry" | "fresh", args: string) => {
    calls.push([command, args]);
    return { agentInvoked: command === "retry", handledCommand: command, output: command };
  };
  expect(await dispatchNativePrompt(value.session, "/retry", undefined, undefined, { ...value.bridges, recovery })).toMatchObject({ handledCommand: "retry", agentInvoked: true });
  expect(await dispatchNativePrompt(value.session, "/fresh", undefined, undefined, { ...value.bridges, recovery })).toMatchObject({ handledCommand: "fresh", agentInvoked: false });
  expect(calls).toEqual([["retry", ""], ["fresh", ""]]);
  await expect(dispatchNativePrompt(value.session, "/retry extra", undefined, undefined, { ...value.bridges, recovery })).resolves.toMatchObject({ handledCommand: "retry" });
  expect(calls.at(-1)).toEqual(["retry", "extra"]);

  const shadow = fixture(mcp("succeeded"), { extension: true });
  Object.assign(shadow.session.extensionRunner!, { getCommand: (name: string) => name === "retry" ? { handler: async () => {} } : undefined });
  await dispatchNativePrompt(shadow.session, "/retry", undefined, undefined, { ...shadow.bridges, recovery });
  expect(calls).toHaveLength(3);
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

// The registry/parser/headless handler, admission receipt and in-memory journal
// are real. Only AgentSession.handoff is controlled: these are not provider or
// native compaction proofs, and do not replace the owning App/worker acceptance.
function handoffFixture(perform: AgentSession["handoff"]) {
  const manager = SessionManager.inMemory("/fixture");
  manager.appendMessage({ role: "user", content: "Original session history", timestamp: 1 });
  let calls = 0;
  const session = {
    customCommands: [], slashCommands: [], promptTemplates: [],
    isStreaming: false, isGeneratingHandoff: false, isCompacting: false, isAborting: false,
    settings: {}, sessionManager: manager,
    prompt: async () => { throw new Error("Builtin handoff must not enter the ordinary model prompt"); },
    handoff: async (...args: Parameters<AgentSession["handoff"]>) => { calls++; return perform(...args); },
  } as unknown as AgentSession;
  return { session, manager, calls: () => calls };
}

test("handoff awaits the pinned headless handler and persistence before acknowledging the original session", async () => {
  const started = Promise.withResolvers<void>(), generated = Promise.withResolvers<Awaited<ReturnType<AgentSession["handoff"]>>>();
  const persisting = Promise.withResolvers<void>(), persisted = Promise.withResolvers<void>();
  const value = handoffFixture(async focus => {
    expect(focus).toBe("Keep the unresolved migration\nand ownership constraints");
    started.resolve(); return generated.promise;
  });
  const originalId = value.manager.getSessionId(), originalLeaf = value.manager.getBranch()[0]!.id;
  const run = beginNativePrompt(value.manager,
    () => dispatchNativePrompt(value.session, "/handoff Keep the unresolved migration\nand ownership constraints"),
    async () => { persisting.resolve(); await persisted.promise; });
  let accepted = false;
  void run.accepted.then(() => { accepted = true; });
  await started.promise;
  expect(accepted).toBe(false);
  generated.resolve({ document: "Controlled handoff boundary", savedPath: "/must-not-be-advertised.md" });
  await persisting.promise;
  expect(accepted).toBe(false);
  persisted.resolve();
  const receipt = await run.accepted;
  expect(receipt).toMatchObject({ kind: "native-command", command: "handoff", output: expect.stringMatching(/compacted in place/i) });
  expect(await run.completion).toBe(false);
  expect(value.calls()).toBe(1);
  expect(value.manager.getSessionId()).toBe(originalId);
  const branch = value.manager.getBranch();
  expect(branch[0]?.id).toEqual(originalLeaf);
  const output = branch.at(-1);
  expect(output).toMatchObject({ type: "custom", customType: "agent-desktop.command-output", data: { command: "handoff" } });
  expect(JSON.stringify(output)).not.toContain("must-not-be-advertised");
  expect(receipt && "entryId" in receipt ? receipt.entryId : undefined).toBe(output?.id);
});

test("handoff retains native streaming and duplicate-generation refusal without entering generation", async () => {
  for (const [flag, reason] of [
    ["isStreaming", /current response/i],
    ["isGeneratingHandoff", /already in progress/i],
  ] as const) {
    const value = handoffFixture(async () => { throw new Error("Refusal must precede generation"); });
    Object.assign(value.session, { [flag]: true });
    const result = await dispatchNativePrompt(value.session, "/handoff");
    expect(result).toMatchObject({ handledCommand: "handoff", agentInvoked: false, output: expect.stringMatching(reason) });
    expect(value.calls()).toBe(0);
    expect(value.manager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
  }
});

test("handoff cannot cross settling maintenance, abort or slash-image admission fences", async () => {
  const value = handoffFixture(async () => { throw new Error("Admission fence must precede generation"); });
  const before = value.manager.getBranch();
  for (const flag of ["isCompacting", "isAborting"]) {
    Object.assign(value.session, { [flag]: true });
    await expect(dispatchNativePrompt(value.session, "/handoff")).rejects.toThrow("maintenance");
    Object.assign(value.session, { [flag]: false });
  }
  await expect(dispatchNativePrompt(value.session, "/handoff", [{ type: "image", data: "AA==", mimeType: "image/png" }])).rejects.toThrow("Image attachments");
  expect(value.calls()).toBe(0);
  expect(value.manager.getBranch()).toEqual(before);
});

test("handoff preserves exact extension then custom ownership before the native builtin", async () => {
  const value = handoffFixture(async () => { throw new Error("Shadowed builtin must not run"); });
  const owners: string[] = [];
  let extensionLoaded = true;
  const extension = { handler: async () => { owners.push("extension"); } };
  Object.assign(value.session, {
    extensionRunner: {
      getCommand: (name: string) => extensionLoaded && name === "handoff" ? extension : undefined,
      createCommandContext: () => ({}), runScoped: async (run: () => Promise<void>) => run(),
      emitError: () => { throw new Error("Unexpected extension failure"); },
    },
    customCommands: [{ command: { name: "handoff", execute: async () => { owners.push("custom"); } } }],
  });
  const before = value.manager.getBranch();
  await dispatchNativePrompt(value.session, "/handoff focus");
  expect(owners).toEqual(["extension"]);
  extensionLoaded = false;
  await dispatchNativePrompt(value.session, "/handoff focus");
  expect(owners).toEqual(["extension", "custom"]);
  expect(value.calls()).toBe(0);
  expect(value.manager.getBranch()).toEqual(before);
});

test("handoff reports native failure and cancellation without claiming successful compaction", async () => {
  for (const [perform, outcome] of [
    [async () => { throw new Error("Controlled provider failure"); }, /failed: Controlled provider failure/i],
    [async () => { throw new Error("Handoff cancelled"); }, /cancelled/i],
    [async () => undefined, /cancelled/i],
  ] satisfies Array<[AgentSession["handoff"], RegExp]>) {
    const value = handoffFixture(perform);
    const result = await dispatchNativePrompt(value.session, "/handoff");
    expect(result).toMatchObject({ handledCommand: "handoff", agentInvoked: false });
    expect(result.output).toMatch(outcome);
    expect(result.output).not.toMatch(/compacted in place/i);
    expect(value.manager.getBranch().at(-1)).toMatchObject({
      type: "custom", customType: "agent-desktop.command-output", data: { output: expect.stringMatching(outcome) },
    });
    expect(value.manager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
  }
});

test("handoff awaits an interrupted generation and honors the native silent user-interrupt label", async () => {
  const started = Promise.withResolvers<void>(), interrupted = Promise.withResolvers<never>();
  const value = handoffFixture(async () => { started.resolve(); return interrupted.promise; });
  const before = value.manager.getBranch();
  const pending = dispatchNativePrompt(value.session, "/handoff");
  await started.promise;
  interrupted.reject(new Error(USER_INTERRUPT_LABEL));
  expect(await pending).toEqual({ agentInvoked: false, handledCommand: "handoff" });
  expect(value.calls()).toBe(1);
  expect(value.manager.getBranch()).toEqual(before);
});

test("handoff persistence failure is unknown admission and never re-invokes generation", async () => {
  const value = handoffFixture(async () => ({ document: "Controlled handoff boundary" }));
  const originalId = value.manager.getSessionId();
  const run = beginNativePrompt(value.manager, () => dispatchNativePrompt(value.session, "/handoff"), async () => {
    throw new Error("Controlled persistence failure after handler completion");
  });
  await expect(run.accepted).rejects.toBeInstanceOf(OmpPromptAdmissionError);
  await expect(run.completion).rejects.toThrow("Controlled persistence failure");
  expect(value.calls()).toBe(1);
  expect(value.manager.getSessionId()).toBe(originalId);
  expect(value.manager.getBranch().at(-1)).toMatchObject({ type: "custom", customType: "agent-desktop.command-output" });
});
