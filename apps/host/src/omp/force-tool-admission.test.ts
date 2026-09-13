import { expect, test } from "bun:test";
import { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeForceToolController } from "./force-tool";
import { NativeForceToolAdmission, assertForceToolRecoveryAndEnter, type ForceToolPromptOptions, type NativeForceInvocationScope } from "./force-tool-admission";
import { beginNativePrompt } from "./prompt";

async function fixture(shadowCanonicalForce = false) {
  const root = await mkdtemp(join(tmpdir(), "native-force-admission-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(join(agentDir, "config.yml"), "extensions: []\n");
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  let remainingCommandEffects = 0;
  let canonicalCommandEffects = 0, aliasCommandEffects = 0;
  let registerAlias!: (name: string) => void;
  const settings = await Settings.loadReadOnly({ cwd, agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), { settings });
  const catalogModel = modelRegistry.getAll().find(model => model.api === "openai-completions");
  if (!catalogModel) throw new Error("Pinned native catalog must expose an openai-completions model");
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager,
    authStorage, modelRegistry, model: catalogModel,
    agentRegistry: new AgentRegistry(), settings, hasUI: false,
    extensions: [pi => {
      pi.registerCommand("force-remaining-effect", { description: "Native remaining-prompt side effect", handler: async () => { remainingCommandEffects++; } });
      if (shadowCanonicalForce) pi.registerCommand("force", { description: "Canonical extension winner", handler: async () => { canonicalCommandEffects++; } });
      registerAlias = name => pi.registerCommand(name, { description: "Changed exact alias winner", handler: async () => { aliasCommandEffects++; } });
    }] });
  session.agent.setModel({ ...catalogModel, provider: "force-fixture", id: "controlled", api: "openai-completions",
    compat: { supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice: true },
  } as Model<"openai-completions">);
  const tool = session.getActiveToolNames()[0]!;
  if (!tool) throw new Error("Native fixture must expose an active tool");
  let busy = false, owner = true, outputFailure = false, promptFailure = "", promptCalls = 0;
  let dialect: Dialect | undefined;
  let nativeDispatchDepth = 0, ownershipRevision = 0, previousOwner = owner;
  let canonicalHandler = session.extensionRunner?.getCommand("force")?.handler;
  let aliasHandler = session.extensionRunner?.getCommand(`force:${tool}`)?.handler;
  const controller = new NativeForceToolController(session, { getDialect: () => dialect,
    getOwnershipReason: () => !owner ? "Original native owner changed"
      : nativeDispatchDepth === 0 && session.extensionRunner?.getCommand("force") ? "Canonical force is extension-owned" : undefined,
    getOwnershipRevision: () => {
      // Real registry handler identities/retirement, never presentation scope.
      const currentCanonical = session.extensionRunner?.getCommand("force")?.handler;
      const currentAlias = session.extensionRunner?.getCommand(`force:${tool}`)?.handler;
      if (previousOwner !== owner || canonicalHandler !== currentCanonical || aliasHandler !== currentAlias) {
        previousOwner = owner; canonicalHandler = currentCanonical; aliasHandler = currentAlias; ownershipRevision++;
      }
      return ownershipRevision;
    },
    getBusyReason: () => busy ? "Admission is busy" : undefined });
  const originalPrompt = session.prompt.bind(session);
  const postEntryFailure = Promise.withResolvers<void>();
  // Fault-inject only the provider-facing prompt boundary. Original force
  // handler, setter, queue, manager append/flush and beginNativePrompt are real.
  session.prompt = async text => {
    promptCalls++;
    if (promptFailure === "before") throw new Error("pre-entry failure");
    manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
    if (promptFailure === "after") { await postEntryFailure.promise; throw new Error("post-entry failure"); }
    return true;
  };
  const start = (text: string, options: ForceToolPromptOptions = {}) => {
    const admission = new NativeForceToolAdmission(controller, session, { commandId: "original", commandVersion: 18, ...options }, () => {
      if (!owner || busy) throw new Error("Existing admission owner changed");
    });
    const parsed = parseSlashCommand(text)!;
    const builtin = lookupBuiltinSlashCommand(parsed.name)!;
    const originalHandler = builtin.handle;
    const withResolvedNativeInvocation: NativeForceInvocationScope = operation => {
      // Use the same exact raw-name precedence as AgentSession/Root, distinct
      // from the native parser's canonical builtin name for an inline alias.
      const space = parsed.text.indexOf(" ");
      const rawName = space === -1 ? parsed.text.slice(1) : parsed.text.slice(1, space);
      if (session.extensionRunner?.getCommand(rawName) || session.customCommands.some(command => command.command.name === rawName)
        || lookupBuiltinSlashCommand(parsed.name) !== builtin || builtin.handle !== originalHandler)
        throw new Error("The original raw native alias winner changed");
      nativeDispatchDepth++;
      try { return operation(); } finally { nativeDispatchDepth--; }
    };
    const chunks: string[] = [];
    const run = beginNativePrompt(manager, () => admission.dispatch(parsed, builtin, () => builtin.handle!(parsed, {
      session, sessionManager: manager, settings: session.settings, cwd,
      output: async value => { chunks.push(value); if (outputFailure) throw new Error("async output failure"); },
      refreshCommands: () => {}, reloadPlugins: async () => {},
    }), () => chunks.join("\n"), withResolvedNativeInvocation), async () => {}, undefined, undefined, undefined, undefined, admission);
    return admission.wrapRun(run);
  };
  return { session, manager, controller, tool, start, setBusy(value: boolean) { busy = value; }, setOwner(value: boolean) { owner = value; },
    failOutput() { outputFailure = true; }, failPrompt(value: string) { promptFailure = value; }, get promptCalls() { return promptCalls; },
    setDialect(value: Dialect) { dialect = value; },
    releasePostEntryFailure: postEntryFailure.resolve,
    useOriginalPrompt() { session.prompt = originalPrompt; }, get remainingCommandEffects() { return remainingCommandEffects; },
    runOriginalPrompt: originalPrompt, shadowAlias() { registerAlias(`force:${tool}`); },
    get canonicalCommandEffects() { return canonicalCommandEffects; }, get aliasCommandEffects() { return aliasCommandEffects; },
    async close() { postEntryFailure.resolve(); controller.dispose(); session.prompt = originalPrompt; await session.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test("original native force alias arms once, flushes history and never invokes a prompt for no-prompt usage", async () => {
  const f = await fixture();
  try {
    const run = f.start(`/force:${f.tool}`);
    expect(await run.accepted).toMatchObject({ kind: "native-command", command: "force" });
    expect(await run.completion).toBe(false);
    expect(run.forceToolReceipt).toMatchObject({ arm: "armed", prompt: "not-requested" });
    const directives = f.controller.getState().directives;
    expect(directives.map(item => item.id)).toEqual([run.forceToolReceipt!.directiveId!]);
    expect(f.promptCalls).toBe(0);
    expect(f.manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "agent-desktop.force-tool").map(entry => entry.type)).toEqual(["custom"]);
  } finally { await f.close(); }
}, 20_000);

test("native usage output does not count as an arm or successful admission", async () => {
  const f = await fixture();
  try {
    const run = f.start("/force");
    await expect(run.accepted).rejects.toMatchObject({ code: "FORCE_TOOL_NOT_ARMED", forceToolReceipt: {
      commandId: "original", epoch: f.controller.getState().epoch, toolName: "", arm: "not-armed", prompt: "not-requested",
    } });
    await expect(run.completion).rejects.toThrow();
    expect(f.controller.getState().directives).toEqual([]);
    expect(run.forceToolReceipt).toMatchObject({ toolName: "", arm: "not-armed", prompt: "not-requested" }); expect(f.promptCalls).toBe(0);
  } finally { await f.close(); }
}, 20_000);

test("original async output rejection retains synchronous armed evidence without replay", async () => {
  const f = await fixture();
  try {
    f.failOutput(); const run = f.start(`/force ${f.tool} remaining`);
    // Project real fields so a failed native receipt is not hidden by Error's
    // prettyprinter. The Root prompt hook and wrapRun both observe this failure.
    const failure = await run.accepted.catch(error => error);
    expect({ code: failure?.code, forceToolReceipt: failure?.forceToolReceipt }).toMatchObject({
      code: "OUTCOME_UNKNOWN", forceToolReceipt: { arm: "armed", prompt: "unknown" },
    });
    await expect(run.completion).rejects.toMatchObject({ forceToolReceipt: { arm: "armed", prompt: "unknown" } });
    expect(run.forceToolReceipt?.prompt).toBe("unknown");
    expect(f.controller.getState().directives.map(item => item.id)).toEqual([run.forceToolReceipt!.directiveId!]);
    expect(f.promptCalls).toBe(0);
  } finally { await f.close(); }
}, 20_000);

test("errors after entering native prompt remain unknown without a user entry; flushed entry errors retain recorded admission", async () => {
  for (const phase of ["before", "after"]) {
    const f = await fixture();
    try {
      f.failPrompt(phase); const run = f.start(`/force ${f.tool} original remaining prompt`);
      if (phase === "before") await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", forceToolReceipt: { arm: "armed", prompt: "unknown" } });
      else {
        const accepted = await run.accepted;
        expect(accepted).toMatchObject({ kind: "user-message" });
        f.releasePostEntryFailure();
        await expect(run.completion).rejects.toMatchObject({ code: "FORCE_TOOL_POST_ENTRY_FAILED",
          forceToolReceipt: { prompt: "recorded", promptEntryId: accepted?.kind === "user-message" ? accepted.entryId : undefined } });
      }
      await expect(run.completion).rejects.toThrow();
      expect(run.forceToolReceipt?.prompt).toBe(phase === "before" ? "unknown" : "recorded");
      expect(f.promptCalls).toBe(1);
      expect(f.controller.getState().directives.map(item => item.id)).toEqual([run.forceToolReceipt!.directiveId!]);
    } finally { await f.close(); }
  }
}, 40_000);

test("history flush failure reports unknown without dispatch; user flush failure never invents recorded admission", async () => {
  for (const failAt of [1, 2]) {
    const f = await fixture();
    const originalFlush = f.manager.flush.bind(f.manager); let flushes = 0;
    f.manager.flush = async () => { if (++flushes >= failAt) throw new Error("latched persistence fault"); await originalFlush(); };
    try {
      const run = f.start(`/force ${f.tool} remaining`);
      const failure = await run.accepted.catch(error => error);
      expect({ code: failure?.code, forceToolReceipt: failure?.forceToolReceipt }).toMatchObject({
        code: "OUTCOME_UNKNOWN", forceToolReceipt: { arm: "armed", prompt: "unknown" },
      });
      await expect(run.completion).rejects.toThrow();
      expect(run.forceToolReceipt?.prompt).toBe("unknown");
      expect(f.promptCalls).toBe(failAt === 1 ? 0 : 1);
      expect(f.controller.getState().directives).toHaveLength(1);
      const userEntry = f.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
      expect(run.forceToolReceipt?.promptEntryId).toBe(userEntry?.id);
      if (failAt === 2) expect(userEntry?.id).toBeDefined();
    } finally { f.manager.flush = originalFlush; await f.close(); }
  }
}, 40_000);

test("stale model/tool/guard and old command protocol stop before original arm", async () => {
  const f = await fixture();
  try {
    const ticket = f.controller.getState();
    f.session.setThinkingLevel("off", false);
    const badGuards = [{ epoch: "other", expectedRevision: ticket.revision, toolName: f.tool },
      { epoch: ticket.epoch, expectedRevision: ticket.revision, toolName: "different-tool" }];
    for (const forceTool of badGuards) {
      const run = f.start(`/force ${f.tool}`, { forceTool });
      await expect(run.accepted).rejects.toMatchObject({ forceToolReceipt: {
        commandId: "original", epoch: ticket.epoch, toolName: f.tool, arm: "not-armed", prompt: "not-requested",
      } }); await expect(run.completion).rejects.toThrow();
    }
    const old = f.start(`/force ${f.tool}`, { commandVersion: 17 });
    await expect(old.accepted).rejects.toMatchObject({ code: "FORCE_TOOL_PROTOCOL_REQUIRED" }); await expect(old.completion).rejects.toThrow();
    const removed = f.start("/force never-active");
    await expect(removed.accepted).rejects.toMatchObject({ forceToolReceipt: { commandId: "original", epoch: ticket.epoch,
      toolName: "never-active", arm: "not-armed", prompt: "not-requested" } }); await expect(removed.completion).rejects.toThrow();
    expect(f.controller.getState().directives).toEqual([]);
  } finally { await f.close(); }
}, 20_000);

test("atomic recovery checks current reservation and exact pending identity, never re-arms or imposes a force-head restriction", async () => {
  const f = await fixture();
  try {
    const first = f.start(`/force ${f.tool}`); await first.accepted; await first.completion;
    const state = f.controller.getState();
    const recovery = { epoch: state.epoch, expectedRevision: state.revision, directiveId: first.forceToolReceipt!.directiveId! };
    let entered = 0;
    f.setBusy(true);
    expect(() => assertForceToolRecoveryAndEnter(f.controller, recovery, () => {}, () => ++entered)).toThrow();
    f.setBusy(false);
    const refreshed = f.controller.getState();
    expect(() => assertForceToolRecoveryAndEnter(f.controller, { ...recovery, expectedRevision: refreshed.revision, directiveId: "other" }, () => {}, () => ++entered)).toThrow();
    expect(entered).toBe(0);
    const before = f.controller.getState();
    expect(assertForceToolRecoveryAndEnter(f.controller, { ...recovery, expectedRevision: before.revision }, () => {}, () => ++entered)).toBe(1);
    expect(f.controller.getState().directives.map(item => item.id)).toEqual(before.directives.map(item => item.id));
  } finally { await f.close(); }
}, 20_000);

test("a concurrent busy-state read during the owning preflight does not invalidate an unchanged force ticket", async () => {
  const f = await fixture();
  try {
    const ticket = f.controller.getState();
    f.setBusy(true);
    expect(f.controller.getState().canArm).toBe(false);
    f.setBusy(false);
    const run = f.start(`/force ${f.tool}`, { forceTool: { epoch: ticket.epoch, expectedRevision: ticket.revision, toolName: f.tool } });
    expect(await run.accepted).toMatchObject({ kind: "native-command", command: "force" });
    await run.completion;
    expect(run.forceToolReceipt?.arm).toBe("armed");
  } finally { await f.close(); }
}, 20_000);

test("policy changes during armed-history persistence retain the directive but refuse the unsent remaining prompt", async () => {
  for (const changed of ["model", "tool", "dialect"]) {
    const f = await fixture();
    const originalFlush = f.manager.flush.bind(f.manager);
    let firstFlush = true;
    f.manager.flush = async () => {
      await originalFlush();
      if (!firstFlush) return;
      firstFlush = false;
      if (changed === "model") f.session.agent.setModel({ ...f.session.model!, id: "changed-model" });
      else if (changed === "tool") await f.session.setActiveToolsByName([]);
      else f.setDialect("glm");
    };
    try {
      const run = f.start(`/force ${f.tool} remaining prompt`);
      await expect(run.accepted).rejects.toMatchObject({ forceToolReceipt: { arm: "armed", prompt: "not-recorded" } });
      await expect(run.completion).rejects.toThrow();
      expect(f.promptCalls).toBe(0);
      expect(f.controller.getState().directives.map(item => item.id)).toEqual([run.forceToolReceipt!.directiveId!]);
    } finally { f.manager.flush = originalFlush; await f.close(); }
  }
}, 60_000);

test("native owner and unsupported-setter refusals carry the actual requested tool and definite no-arm prompt outcome", async () => {
  const f = await fixture();
  try {
    const epoch = f.controller.getState().epoch;
    f.setOwner(false);
    const owner = f.start(`/force ${f.tool} remaining`);
    await expect(owner.accepted).rejects.toMatchObject({ forceToolReceipt: {
      commandId: "original", epoch, toolName: f.tool, arm: "not-armed", prompt: "not-recorded",
    } });
    await expect(owner.completion).rejects.toThrow();
    f.setOwner(true);
    f.session.agent.setModel({ ...f.session.model!, api: "google-generative-ai" } as Model<"google-generative-ai">);
    const unsupported = f.start(`/force ${f.tool} remaining`);
    await expect(unsupported.accepted).rejects.toMatchObject({ forceToolReceipt: {
      commandId: "original", epoch, toolName: f.tool, arm: "not-armed", prompt: "not-recorded",
    } });
    await expect(unsupported.completion).rejects.toThrow();
    expect(f.promptCalls).toBe(0);
    expect(f.controller.getState().directives).toEqual([]);
  } finally { await f.close(); }
}, 20_000);

test("unrelated reentrant native pushes replace the provisional no-arm receipt with unknown without undoing either directive", async () => {
  const f = await fixture();
  let inserted = false;
  const stop = f.session.toolChoiceQueue.subscribe(event => {
    if (event.type !== "push" || inserted) return;
    inserted = true;
    f.session.toolChoiceQueue.pushOnce("none", { label: "unrelated-native-work" });
  });
  try {
    const run = f.start(`/force ${f.tool} remaining`);
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", forceToolReceipt: {
      toolName: f.tool, arm: "unknown", prompt: "unknown",
    } });
    await expect(run.completion).rejects.toThrow();
    expect(f.promptCalls).toBe(0);
    expect(f.session.toolChoiceQueue.inspect()).toContain("unrelated-native-work");
    expect(f.controller.getState().directives).toHaveLength(1);
    expect(run.forceToolReceipt?.directiveId).toBeUndefined();
  } finally { stop(); await f.close(); }
}, 20_000);

test("an optional original native extension command runs once but cannot become recovery-safe from its absent user entry", async () => {
  const f = await fixture();
  try {
    f.useOriginalPrompt();
    const run = f.start(`/force ${f.tool} /force-remaining-effect`);
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", forceToolReceipt: {
      commandId: "original", toolName: f.tool, arm: "armed", prompt: "unknown",
    } });
    expect(await run.completion).toBe(false);
    expect(f.remainingCommandEffects).toBe(1);
    expect(f.manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user")).toEqual([]);
    expect(run.forceToolReceipt?.promptEntryId).toBeUndefined();
    expect(run.forceToolReceipt?.prompt).not.toBe("not-recorded");
    expect(f.controller.getState().directives.map(item => item.id)).toEqual([run.forceToolReceipt!.directiveId!]);
  } finally { await f.close(); }
}, 20_000);

test("a resolved native inline alias survives external canonical-owner reads between awaits without weakening standalone recovery", async () => {
  const f = await fixture(true);
  const originalFlush = f.manager.flush.bind(f.manager);
  let externalRead = false;
  f.manager.flush = async () => {
    await originalFlush();
    if (externalRead) return;
    externalRead = true;
    // This is outside the synchronous original-invocation scope. It must see
    // the canonical extension owner without changing the alias's policy ticket.
    expect(f.controller.getState()).toMatchObject({ availability: { state: "unsupported" }, canArm: false });
  };
  try {
    expect(await f.runOriginalPrompt("/force")).toBe(false);
    expect(f.canonicalCommandEffects).toBe(1);
    const run = f.start(`/force:${f.tool} remaining`);
    expect(await run.accepted).toMatchObject({ kind: "user-message" });
    expect(await run.completion).toBe(true);
    expect(externalRead).toBe(true);
    expect(run.forceToolReceipt).toMatchObject({ arm: "armed", prompt: "recorded" });
    expect(f.canonicalCommandEffects).toBe(1);
    const canonical = f.controller.getState();
    let recoveryEntries = 0;
    expect(() => assertForceToolRecoveryAndEnter(f.controller, { epoch: canonical.epoch, expectedRevision: canonical.revision,
      directiveId: run.forceToolReceipt!.directiveId! }, () => {}, () => ++recoveryEntries)).toThrow();
    expect(recoveryEntries).toBe(0);
    expect(canonical.availability.state).toBe("unsupported");
  } finally { f.manager.flush = originalFlush; await f.close(); }
}, 20_000);

test("an actual extension taking the exact raw alias during history flush stops the remaining prompt without replay or rollback", async () => {
  const f = await fixture(true);
  const originalFlush = f.manager.flush.bind(f.manager);
  let changed = false;
  f.manager.flush = async () => {
    await originalFlush();
    if (changed) return;
    changed = true;
    f.shadowAlias();
  };
  try {
    const run = f.start(`/force:${f.tool} remaining`);
    await expect(run.accepted).rejects.toMatchObject({ forceToolReceipt: { arm: "armed", prompt: "not-recorded" } });
    await expect(run.completion).rejects.toThrow();
    expect(f.promptCalls).toBe(0);
    expect(f.aliasCommandEffects).toBe(0);
    expect(f.controller.getState().directives.map(item => item.id)).toEqual([run.forceToolReceipt!.directiveId!]);
    expect(await f.runOriginalPrompt(`/force:${f.tool}`)).toBe(false);
    expect(f.aliasCommandEffects).toBe(1);
    expect(f.controller.getState().directives).toHaveLength(1);
  } finally { f.manager.flush = originalFlush; await f.close(); }
}, 20_000);
