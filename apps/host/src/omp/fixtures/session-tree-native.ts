// Actual pinned native journal/session. Every profile, file and provider definition is disposable.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
let blockedFetches = 0;
globalThis.fetch = Object.assign(async () => { blockedFetches++; throw new Error("Network disabled in tree fixture"); }, { preconnect() { throw new Error("Network disabled"); } }) as typeof fetch;
const directory = process.argv[2]!, scenario = process.argv[3]!;
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const config = "extensions: []\ndefaultThinkingLevel: low\n";
await writeFile(path.join(agentDir, "config.yml"), config);
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "tree-fixture": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none",
  models: [{ id: "base", name: "Controlled non-executing model", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { initializeDesktopExtensions } = await import("../extensions");
const { OmpInteractionBridge } = await import("../interactions");
const auth = await discoverAuthStorage(agentDir), settings = await Settings.loadReadOnly({ agentDir, cwd });
const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
const manager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
let hookCalls = 0, guardCalls = 0, stopped = false;
const providerInputs: unknown[] = [];
let heldStream: { promise: Promise<void>; resolve: (value?: void) => void } | undefined;
let clearShadowCalls = 0;
let registerClearShadow: (() => void) | undefined;
const { AssistantMessageEventStream } = await import("@oh-my-pi/pi-ai/utils/event-stream");
const { initThemeSync } = await import("@oh-my-pi/pi-coding-agent/modes/theme/theme");
initThemeSync(settings.get("symbolPreset"), settings.get("colorBlindMode"), settings.get("theme.dark"), settings.get("theme.light"));
const result = await createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry: registry,
  agentRegistry: new AgentRegistry(), sessionManager: manager, model: registry.find("tree-fixture", "base"),
  extensions: [pi => {
    registerClearShadow = () => pi.registerCommand("clear", { description: "Controlled extension shadow of the native /clear command",
      handler: async () => { clearShadowCalls++; } });
    pi.on("session_before_tree", async () => {
      hookCalls++;
      if (["held-hook-stop", "held-controller-stop", "held-controller-dispose"].includes(scenario)) { entered.resolve(); await release.promise; }
      if (scenario === "cancelled-hook") return { cancel: true };
    });
    pi.on("session_tree", () => { if (scenario === "after-tree-hook") manager.appendCustomEntry("fixture-after-tree", { authoritative: true }); });
    pi.registerProvider("tree-controlled", { baseUrl: "https://controlled.invalid", apiKey: "isolated-inert-fixture-key", api: "tree-controlled-api" as never,
      models: [{ id: "base", name: "Controlled transport, no inference", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context) {
        providerInputs.push(JSON.parse(JSON.stringify(context)));
        const stream = new AssistantMessageEventStream();
        const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "Controlled native branch summary or ask continuation" }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        const finish = () => { stream.push({ type: "done", reason: "stop", message }); };
        // A held controlled stream keeps the native session streaming without inference.
        if (heldStream) void heldStream.promise.then(finish); else finish();
        return stream;
      },
    });
  }],
  hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true });
const session = result.session;
const uiEvents: unknown[] = [];
const ui = new OmpInteractionBridge(session.sessionId, event => uiEvents.push(event));
result.setToolUIContext(ui, true);
await initializeDesktopExtensions(session, ui);
if (scenario !== "held-hook-stop") await session.setModel(registry.find("tree-controlled", "base")!);
await manager.ensureOnDisk();
const user = manager.appendMessage({ role: "user", content: "Original question", timestamp: 1 });
const tail = manager.appendCustomEntry("fixture-tail", { preserved: true });
await manager.flush();
const before = await readFile(manager.getSessionFile()!, "utf8");
try {
  if (scenario === "held-hook-stop") {
    const operation = session.navigateTree(user, { summarize: false,
      // The old pinned implementation ignores this additive callback. That is the red proof.
      ...{ assertCurrent() { guardCalls++; if (stopped) throw new Error("Original owner stopped"); } },
    });
    await entered.promise;
    stopped = true; session.abortBranchSummary(); release.resolve();
    let failure: unknown; try { await operation; } catch (error) { failure = error; }
    assert.equal(hookCalls, 1, "real native hook must have held navigation");
    assert.equal(manager.getLeafId(), tail, "Stop during a held native before-tree hook must not move the leaf");
    assert.ok(failure instanceof Error && /stopped/.test(failure.message));
    assert.equal(await readFile(manager.getSessionFile()!, "utf8"), before);
    console.log(JSON.stringify({ scenario, hookCalls, guardCalls, sameLeaf: true, sameFile: true, blockedFetches }));
  } else {
    const { NativeSessionTree, TREE_NAVIGATION_ENTRY } = await import("../session-tree");
    let retired = false, busyReason: string | undefined, changed = 0, rebinds = 0;
    let holdPrepare: { promise: Promise<void>; resolve: (value?: void) => void } | undefined;
    let prepareHook: (() => void | Promise<void>) | undefined;
    const rebindTargets: Array<() => void> = [];
    const tree = new NativeSessionTree(session, manager, { assertOwner() { if (retired) throw new Error("Retired owner"); }, getBusyReason: () => busyReason,
      prepare: async () => { if (holdPrepare) await holdPrepare.promise; await prepareHook?.(); }, ui, onChanged: () => { changed++; },
      onProviderSessionChanged: () => { rebinds++; for (const rebind of rebindTargets) rebind(); } });
    const navigate = (targetId: string, summarize = false, customInstructions?: string) => tree.mutate(`tree-${crypto.randomUUID()}`, {
      sessionId: manager.getSessionId(), ticket: tree.read().ticket, mutation: { action: "navigate", targetId, summarize, ...(customInstructions === undefined ? {} : { customInstructions }) } });
    const reset = (origin?: "clear-command") => tree.mutate(`reset-${crypto.randomUUID()}`, {
      sessionId: manager.getSessionId(), ticket: tree.read().ticket, mutation: { action: "reset-context", ...(origin === undefined ? {} : { origin }) } });
    // The exact model-context rebuild the SDK performs on theme change, focus attach and resume.
    const seedLiveContext = () => { session.agent.replaceMessages(session.buildDisplaySessionContext().messages); return session.state.messages.length; };
    const boundaries = () => manager.getEntries().filter(entry => entry.type === "reset_boundary");
    const settle = async (ready: () => boolean, label: string) => {
      const until = Date.now() + 10_000;
      while (!ready() && Date.now() < until) await Bun.sleep(5);
      assert.ok(ready(), label);
    };
    const stableEntries = async () => {
      let size = -1;
      for (let attempt = 0; attempt < 200; attempt++) {
        const current = manager.getEntries().length;
        if (current === size) return;
        size = current; await Bun.sleep(5);
      }
      throw new Error("Native history never settled while the controlled stream was held");
    };
    if (scenario === "fresh-owner") {
      const initial = tree.read(), localId = manager.getSessionId(), originalFile = manager.getSessionFile();
      const reset = session.freshSession();
      assert.ok(reset); assert.notEqual(reset.sessionId, localId); assert.equal(manager.getSessionId(), localId); assert.equal(manager.getSessionFile(), originalFile);
      assert.equal(tree.read().ticket.nativeSessionId, localId); assert.notEqual(tree.read().ticket.revision, initial.ticket.revision);
      await assert.rejects(tree.mutate("pre-fresh", { sessionId: localId, ticket: initial.ticket, mutation: { action: "navigate", targetId: user, summarize: false } }), /history changed/);
      const result = await navigate(user); assert.equal(result.state.ticket.nativeSessionId, localId); assert.equal(result.draft?.text, "Original question");
      console.log(JSON.stringify({ scenario, localOwnerPreserved: true, providerRotated: true, oldTicketRejected: true, newTicketNavigates: true, blockedFetches }));
    } else if (scenario === "held-controller-stop" || scenario === "held-controller-dispose") {
      const originalLeaf = manager.getLeafId(), originalFile = manager.getSessionFile()!, original = await readFile(originalFile, "utf8"), operation = navigate(user);
      await entered.promise;
      const second = navigate(user); await assert.rejects(second, /settling/);
      const closing = scenario === "held-controller-dispose" ? session.dispose() : undefined;
      if (!closing) tree.abort();
      release.resolve(); await assert.rejects(operation, /stopped|retired|disposed/); await closing;
      if (!closing) assert.equal(manager.getLeafId(), originalLeaf);
      else { const reopened = await SessionManager.open(originalFile); assert.ok(reopened.getBranch().some(entry => entry.id === originalLeaf)); }
      const after = await readFile(originalFile, "utf8");
      assert.ok(!after.includes(TREE_NAVIGATION_ENTRY));
      if (!closing) assert.equal(after, original);
      console.log(JSON.stringify({ scenario, blockedSecondMutation: true, sameOriginalLeaf: true, noNavigationMarker: true, nativeDisposalMayAppendExit: !!closing, blockedFetches }));
    } else if (scenario === "after-tree-hook") {
      const result = await navigate(user); assert.equal(result.cancelled, false);
      assert.ok(result.state.entries.some(entry => entry.kind === "metadata: fixture-after-tree" && entry.active));
      const reopened = await SessionManager.open(manager.getSessionFile()!); assert.ok(reopened.getBranch().some(entry => entry.type === "custom" && entry.customType === "fixture-after-tree"));
      console.log(JSON.stringify({ scenario, nativeAfterTreeHookRetainedAndProjected: true, blockedFetches }));
    } else if (scenario === "flush-failure") {
      const flush = manager.flush.bind(manager);
      manager.flush = async () => { throw new Error("Controlled native flush failure after mutation"); };
      try {
        await assert.rejects(navigate(user), error => error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN");
        assert.equal(tree.read().reconciliationRequired, true); assert.ok(manager.getEntries().some(entry => entry.type === "custom" && entry.customType === TREE_NAVIGATION_ENTRY));
        const count = manager.getEntries().length;
        await assert.rejects(navigate(user), /reconciliation/); assert.equal(manager.getEntries().length, count);
      } finally { manager.flush = flush; await flush(); }
      console.log(JSON.stringify({ scenario, injectedNativeFlushFailure: true, possibleMutationReportedUnknown: true, retryRefused: true, blockedFetches }));
    } else if (scenario === "entry-kinds") {
      const custom = manager.appendCustomMessageEntry("fixture-message", "Custom editable message", true);
      const skill = manager.appendCustomMessageEntry("skill-prompt", "Original skill context", true);
      await manager.flush();
      assert.equal((await navigate(custom)).draft?.text, "Custom editable message");
      const selectedSkill = await navigate(skill); assert.equal(selectedSkill.draft, undefined); assert.ok(manager.getBranch().some(entry => entry.id === skill));
      const rootEntry = manager.getEntries()[0]!; const result = await navigate(rootEntry.id); assert.equal(result.cancelled, false);
      console.log(JSON.stringify({ scenario, customEditable: true, skillKeepsNativeContext: true, rootEntryNavigable: true, blockedFetches }));
    } else if (scenario === "lifecycle") {
      const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=" };
      const imageUser = manager.appendMessage({ role: "user", content: [{ type: "text", text: "Edit with image" }, image], timestamp: 3 });
      const oldTail = manager.appendCustomEntry("old-tail", {}); await manager.flush();
      const originalIds = manager.getEntries().map(entry => entry.id), originalFile = session.sessionFile, originalSession = session.sessionId;
      const initial = tree.read(); assert.equal(initial.entries.length, manager.getEntries().length);
      const result = await navigate(imageUser);
      assert.equal(result.cancelled, false); assert.ok(result.draft?.text.includes("Edit with image")); assert.deepEqual(result.draft?.images, [image]);
      assert.equal(manager.getBranch().some(entry => entry.id === imageUser), false);
      assert.ok(originalIds.every(id => manager.getEntry(id)), "all original branches retained");
      assert.equal(session.sessionFile, originalFile); assert.equal(session.sessionId, originalSession);
      assert.equal(manager.getBranch().at(-1)?.type, "custom");
      const reopened = await SessionManager.open(originalFile!);
      assert.equal(reopened.getLeafId(), manager.getLeafId());
      assert.deepEqual(reopened.getBranch().at(-1), manager.getBranch().at(-1));
      assert.deepEqual(tree.read().recoveredDraft?.draft, result.draft);
      const stale = tree.mutate("stale-tree", { sessionId: session.sessionId, ticket: initial.ticket, mutation: { action: "navigate", targetId: oldTail, summarize: false } });
      await assert.rejects(stale, /history changed/);
      busyReason = "Fixture queued prompt"; await assert.rejects(navigate(oldTail), /queued prompt/); busyReason = undefined;
      const label = await tree.mutate("label-tree", { sessionId: manager.getSessionId(), ticket: tree.read().ticket, mutation: { action: "label", targetId: oldTail, label: "Original alternative" } });
      assert.equal(label.state.entries.find(entry => entry.id === oldTail)?.label, "Original alternative");
      await navigate(oldTail); assert.equal(manager.getBranch().some(entry => entry.id === imageUser), true);
      await navigate(user); assert.equal(manager.getBranch().some(entry => entry.id === user), false);
      const editAnchor = manager.getLeafId();
      assert.equal(manager.getEntry(editAnchor!)?.parentId, manager.getEntry(user)?.parentId);
      const replacement = manager.appendMessage({ role: "user", content: "Edited question", timestamp: 5 }); await manager.flush();
      assert.equal(manager.getEntry(replacement)?.parentId, editAnchor);
      assert.ok(manager.getEntry(oldTail)); assert.equal(tree.read().recoveredDraft, undefined);
      retired = true; assert.throws(() => navigate(oldTail), /Retired owner/);
      console.log(JSON.stringify({ scenario, sameIdentity: true, allOriginalEntriesRetained: true, exactImage: true, durableLeafAndDraft: true, staleAndBusyRejected: true, label: true, changed, blockedFetches }));
    } else if (scenario === "cancelled-hook") {
      const initial = tree.read(); const result = await navigate(user);
      assert.equal(result.cancelled, true); assert.equal(tree.read().ticket.revision, initial.ticket.revision); assert.equal(changed, 0);
      console.log(JSON.stringify({ scenario, cancelled: true, sameHistory: true, blockedFetches }));
    } else if (scenario === "ask") {
      const questions = [{ id: "choice", question: "Which original choice?", options: [{ label: "First" }, { label: "Second" }] }];
      const assistant = manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "original-ask", name: "ask", arguments: { questions } }],
        api: session.model!.api, provider: session.model!.provider, model: session.model!.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 10 });
      const oldAnswer = manager.appendMessage({ role: "toolResult", toolCallId: "original-ask", toolName: "ask", content: [{ type: "text", text: "Original First answer" }], details: { original: true }, isError: false, timestamp: 11 });
      await manager.flush();
      async function waitQuestion() { const until = Date.now() + 3000; while (!ui.list().length && Date.now() < until) await Bun.sleep(5); assert.equal(ui.list().length, 1); return ui.list()[0]!; }
      const initial = tree.read(), cancelled = navigate(oldAnswer); const firstQuestion = await waitQuestion();
      assert.ok(firstQuestion.title.includes("Which original choice?")); ui.respond(firstQuestion.id, { cancel: true });
      assert.equal((await cancelled).cancelled, true); assert.equal(tree.read().ticket.revision, initial.ticket.revision);
      const answered = navigate(oldAnswer); const secondQuestion = await waitQuestion();
      const option = secondQuestion.options!.find(option => option.label.includes("Second")); assert.ok(option);
      ui.respond(secondQuestion.id, { value: option.label });
      const outcome = await answered; assert.equal(outcome.askReanswerCommitted, true);
      const sibling = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ask" && entry.id !== oldAnswer);
      assert.ok(sibling && sibling.type === "message" && sibling.message.role === "toolResult");
      assert.equal(sibling.parentId, assistant); assert.ok(JSON.stringify(sibling.message.details).includes("Second"));
      const originalAnswer = manager.getEntry(oldAnswer); assert.ok(originalAnswer?.type === "message" && originalAnswer.message.role === "toolResult");
      assert.deepEqual(originalAnswer.message.details, { original: true });
      const until = Date.now() + 3000; while ((session.hasPostPromptWork || session.isStreaming || !providerInputs.length) && Date.now() < until) await Bun.sleep(5);
      assert.equal(providerInputs.length, 1); assert.equal(changed, 1);
      assert.ok(JSON.stringify(providerInputs[0]).includes("Second"));
      await manager.flush(); const reopened = await SessionManager.open(session.sessionFile!);
      assert.ok(reopened.getEntry(oldAnswer)); assert.ok(reopened.getEntry(sibling.id));
      console.log(JSON.stringify({ scenario, originalQuestions: true, cancellationNoChange: true, nativeAnswerSibling: true, nativeContinuation: true, oldAnswerRetained: true, controlledTransportCalls: providerInputs.length, blockedFetches }));
    } else if (scenario === "summary") {
      manager.appendMessage({ role: "user", content: "Abandoned branch content requiring a summary", timestamp: 12 });
      await manager.flush();
      const result = await navigate(user, true, "Preserve the important custom instruction");
      assert.equal(result.cancelled, false); assert.equal(providerInputs.length, 1);
      assert.ok(JSON.stringify(providerInputs[0]).includes("Preserve the important custom instruction"));
      assert.ok(manager.getBranch().some(entry => entry.type === "branch_summary" && entry.summary.includes("Controlled native branch summary")));
      assert.equal(manager.getBranch().at(-1)?.type, "custom");
      console.log(JSON.stringify({ scenario, nativeSummarizer: true, controlledTransportCalls: providerInputs.length, customInstructionObserved: true, blockedFetches }));
    } else if (scenario === "reset-context") {
      const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=" };
      manager.appendMessage({ role: "user", content: [{ type: "text", text: "Original question with an image" }, image], timestamp: 20 });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Original answer" }],
        api: session.model!.api, provider: session.model!.provider, model: session.model!.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 21 });
      await manager.flush();
      assert.ok(seedLiveContext() >= 3, "the live native context must be seeded from the journal before the reset");
      const originalIds = manager.getEntries().map(entry => entry.id);
      const originalId = manager.getSessionId(), originalFile = manager.getSessionFile()!;
      const originalModel = { provider: session.model!.provider, id: session.model!.id };
      const originalThinking = session.configuredThinkingLevel(), originalSummaries = session.settings.get("branchSummary.enabled");
      const providerBefore = session.sessionId, beforeTree = tree.read();
      const outcome = await reset();
      assert.equal(outcome.cancelled, false);
      assert.equal(outcome.state.ticket.nativeSessionId, originalId);
      assert.notEqual(outcome.state.ticket.revision, beforeTree.ticket.revision);
      assert.equal(manager.getSessionId(), originalId); assert.equal(manager.getSessionFile(), originalFile); assert.equal(session.sessionFile, originalFile);
      assert.deepEqual({ provider: session.model!.provider, id: session.model!.id }, originalModel);
      assert.equal(session.configuredThinkingLevel(), originalThinking);
      assert.equal(session.settings.get("branchSummary.enabled"), originalSummaries);
      assert.ok(originalIds.every(id => manager.getEntry(id)), "an in-place reset retains every original entry");
      // Exactly one real native boundary, recorded as the branch leaf.
      assert.equal(boundaries().length, 1);
      assert.equal(manager.getBranch().filter(entry => entry.type === "reset_boundary").length, 1);
      assert.equal(manager.getBranch().at(-1)?.type, "reset_boundary");
      // The live conversation and every later rebuild start after that boundary.
      assert.equal(session.state.messages.length, 0);
      assert.equal(session.buildDisplaySessionContext().messages.length, 0);
      assert.notEqual(session.sessionId, providerBefore);
      assert.equal(rebinds, 1); assert.ok(changed >= 1);
      const reopened = await SessionManager.open(originalFile);
      assert.equal(reopened.getSessionId(), originalId);
      assert.equal(reopened.getLeafId(), manager.getLeafId());
      assert.ok(originalIds.every(id => reopened.getEntry(id)), "the reopened transcript keeps the full pre-reset history");
      assert.equal(reopened.getBranch().filter(entry => entry.type === "reset_boundary").length, 1);
      // A real native shake and a later rebuild never resurrect the pre-reset conversation.
      const shaken = await session.shake("images");
      assert.equal(boundaries().length, 1); assert.equal(session.state.messages.length, 0);
      const rebuilt = manager.appendMessage({ role: "user", content: "Question after the reset", timestamp: 22 });
      await manager.flush();
      const after = session.buildDisplaySessionContext();
      assert.equal(after.messages.length, 1);
      assert.ok(!JSON.stringify(after.messages).includes("Original question"));
      assert.ok(!JSON.stringify(after.messages).includes("Original answer"));
      assert.ok(manager.getEntry(rebuilt)); assert.equal(seedLiveContext(), 1);
      console.log(JSON.stringify({ scenario, sameManagerIdentity: true, modelThinkingAndSettingsPreserved: true, singleResetBoundary: true,
        emptyLiveAndRebuiltContext: true, providerIdentityRotated: true, rebinds, durableReopen: true, shakeImagesDropped: shaken.imagesDropped, blockedFetches }));
    } else if (scenario === "reset-controllers") {
      // Deferred like ../session-tree above: every host module must load after this
      // fixture has pinned HOME, the agent directory and the disposable provider files.
      const { NativeSessionJobs } = await import("../session-jobs");
      const { NativeSessionTodos } = await import("../session-todos");
      const { NativePlanController } = await import("../plan-controller");
      const { NativeSessionUsage } = await import("../session-usage");
      const assertOwner = () => { if (retired) throw new Error("Retired owner"); };
      const controllerPorts = { assertOwner, getBusyReason: () => busyReason, onChanged: () => {} };
      const planPorts = { assertOwner, confirmExit: async () => false };
      const jobs = new NativeSessionJobs(session, assertOwner, manager.getSessionId());
      const staleJobs = new NativeSessionJobs(session, assertOwner, manager.getSessionId());
      const todos = new NativeSessionTodos(session, manager, controllerPorts), staleTodos = new NativeSessionTodos(session, manager, controllerPorts);
      const plan = new NativePlanController(session, manager, planPorts), stalePlan = new NativePlanController(session, manager, planPorts);
      const usage = new NativeSessionUsage(session, assertOwner, assertOwner), staleUsage = new NativeSessionUsage(session, assertOwner, assertOwner);
      // Only these owners rebind; their unwired twins prove the rotation was real.
      rebindTargets.push(() => jobs.rebindProviderSession(), () => todos.rebindProviderSession(), () => plan.rebindProviderSession(), () => usage.rebindProviderSession());
      try {
        assert.ok(seedLiveContext() > 0);
        const jobsOwner = jobs.owner, todoTicket = todos.read().ticket, providerBefore = session.sessionId;
        assert.equal(jobs.request({ action: "read" }).action, "read");
        assert.equal(staleJobs.request({ action: "read" }).action, "read");
        assert.equal(staleTodos.read().ticket.nativeSessionId, manager.getSessionId());
        assert.equal(stalePlan.snapshot().nativeSessionId, manager.getSessionId());
        const outcome = await reset();
        assert.equal(outcome.cancelled, false); assert.equal(rebinds, 1);
        assert.equal(session.state.messages.length, 0); assert.equal(boundaries().length, 1);
        // Rebound owners keep serving the same loaded session under a new epoch.
        assert.equal(jobs.request({ action: "read" }).action, "read");
        assert.equal(jobs.owner.nativeSessionId, jobsOwner.nativeSessionId);
        assert.notEqual(jobs.owner.epoch, jobsOwner.epoch);
        assert.notEqual(todos.read().ticket.epoch, todoTicket.epoch);
        assert.equal(plan.snapshot().nativeSessionId, manager.getSessionId());
        // An invalid revision reaches local admission on the rebound owner, without
        // fetching usage or credits from any provider.
        await assert.rejects(usage.prepare({ sessionId: session.sessionId, epoch: usage.epoch,
          revision: "stale-revision", accountRef: "unused" }), /Refresh this original session/);
        // Tickets minted before the new epoch are refused, never silently accepted.
        assert.throws(() => jobs.request({ action: "read", owner: jobsOwner }), /another native owner generation/);
        await assert.rejects(todos.mutate("reset-stale-todo", { sessionId: manager.getSessionId(), ticket: todoTicket,
          mutation: { action: "command", text: "/todo" } }), /another native owner/);
        // Owners that never rebound are hard-retired by the actual provider rotation.
        assert.throws(() => staleJobs.request({ action: "read" }), /retired/);
        assert.throws(() => staleTodos.read(), /retired/);
        assert.throws(() => stalePlan.snapshot(), /retired/);
        await assert.rejects(staleUsage.prepare({ sessionId: providerBefore, epoch: staleUsage.epoch,
          revision: "stale-revision", accountRef: "unused" }), /Original usage session changed/);
        console.log(JSON.stringify({ scenario, jobsRebound: true, todosRebound: true, planRebound: true,
          unreboundOwnersRetired: true, staleTicketsRefused: true, rebinds, blockedFetches }));
      } finally { usage.dispose(); staleUsage.dispose(); }
    } else if (scenario === "reset-clear-origin") {
      assert.ok(registerClearShadow, "the fixture extension must expose the controlled /clear shadow");
      assert.ok(seedLiveContext() > 0);
      // The builtin is the exact loaded winner, so the clear-command origin is admitted.
      assert.equal((await reset("clear-command")).cancelled, false);
      assert.equal(boundaries().length, 1); assert.equal(session.state.messages.length, 0); assert.equal(rebinds, 1);
      manager.appendMessage({ role: "user", content: "Second question", timestamp: 30 }); await manager.flush();
      assert.equal(seedLiveContext(), 1);
      // The shadow lands inside prepare: the winner is re-resolved after it.
      prepareHook = () => { if (!session.extensionRunner?.getCommand("clear")) registerClearShadow!(); };
      const refused = await reset("clear-command").then(() => undefined, (error: unknown) => error);
      prepareHook = undefined;
      assert.ok(refused instanceof Error && "code" in refused && refused.code === "TREE_REJECTED", String(refused));
      assert.match(refused.message, /\/clear command no longer owns/);
      assert.ok(session.extensionRunner?.getCommand("clear"), "prepare installed the actual extension shadow");
      assert.equal(boundaries().length, 1); assert.equal(session.state.messages.length, 1); assert.equal(rebinds, 1);
      assert.equal(tree.read().reconciliationRequired, false);
      // An explicit History reset never consults the /clear dispatch winner.
      assert.equal((await reset()).cancelled, false);
      assert.equal(boundaries().length, 2); assert.equal(session.state.messages.length, 0); assert.equal(rebinds, 2);
      assert.equal(clearShadowCalls, 0, "no native /clear command may execute for a History reset");
      console.log(JSON.stringify({ scenario, builtinWinnerAdmitted: true, shadowedOriginRefusedAfterPrepare: true,
        explicitResetBypassesShadow: true, clearShadowCalls, rebinds, blockedFetches }));
    } else if (scenario === "reset-refusals") {
      const live = seedLiveContext(); assert.ok(live > 0);
      const entriesBefore = manager.getEntries().length;
      const bare = new NativeSessionTree(session, manager, { assertOwner() {}, getBusyReason: () => undefined, prepare: async () => {}, ui, onChanged: () => {} });
      const missing = await bare.mutate("reset-missing-port", { sessionId: manager.getSessionId(), ticket: bare.read().ticket,
        mutation: { action: "reset-context" } }).then(() => undefined, (error: unknown) => error);
      assert.ok(missing instanceof Error && "code" in missing && missing.code === "TREE_REJECTED", String(missing));
      assert.match(missing.message, /context-reset owner is unavailable/);
      assert.equal(bare.read().reconciliationRequired, false);
      assert.equal(session.state.messages.length, live, "a missing rebind port must refuse before the native entry");
      busyReason = "Fixture queued prompt";
      await assert.rejects(reset(), /queued prompt/);
      busyReason = undefined;
      prepareHook = () => { busyReason = "Fixture work admitted during prepare"; };
      await assert.rejects(reset(), /admitted during prepare/);
      prepareHook = undefined; busyReason = undefined;
      const stale = tree.read().ticket;
      manager.appendCustomEntry("fixture-drift", { drifted: true }); await manager.flush();
      await assert.rejects(tree.mutate("reset-stale", { sessionId: manager.getSessionId(), ticket: stale, mutation: { action: "reset-context" } }), /history changed/);
      const held = Promise.withResolvers<void>(); holdPrepare = held;
      const stopping = reset();
      await Bun.sleep(10); tree.abort(); held.resolve(); holdPrepare = undefined;
      await assert.rejects(stopping, /stopped|changed/);
      retired = true;
      assert.throws(() => reset(), /Retired owner/);
      retired = false;
      assert.equal(boundaries().length, 0); assert.equal(session.state.messages.length, live); assert.equal(rebinds, 0);
      assert.equal(tree.read().reconciliationRequired, false);
      assert.equal(manager.getEntries().length, entriesBefore + 1);
      console.log(JSON.stringify({ scenario, missingRebindPortRefused: true, busyRefusedBeforeAndAfterPrepare: true,
        staleTicketRefused: true, stopDuringPrepareRefused: true, retiredOwnerRefused: true, rebinds, blockedFetches }));
    } else if (scenario === "reset-native-busy") {
      const live = seedLiveContext(); assert.ok(live > 0);
      const refusal = async (label: string) => {
        const failure = await reset().then(() => undefined, (error: unknown) => error);
        assert.ok(failure instanceof Error && "code" in failure && failure.code === "TREE_REJECTED", `${label}: ${String(failure)}`);
        assert.match(failure.message, /foreground execution/);
        assert.equal(boundaries().length, 0, label);
        assert.equal(rebinds, 0, label);
        assert.equal(tree.read().reconciliationRequired, false, label);
      };
      const evalDone = Promise.withResolvers<void>(), evalAbort = new AbortController();
      const tracked = session.trackEvalExecution(evalDone.promise, evalAbort);
      assert.equal(session.isEvalRunning, true);
      try { await refusal("eval"); assert.equal(session.state.messages.length, live); }
      finally { evalDone.resolve(); await tracked; }
      await settle(() => !session.isEvalRunning, "the tracked native eval execution must settle");
      const bash = session.executeBash("sleep 0.35");
      try {
        await settle(() => session.isBashRunning, "the native bash execution must start");
        await refusal("bash"); assert.equal(session.state.messages.length, live);
      } finally { await bash; }
      await settle(() => !session.isBashRunning, "the native bash execution must settle");
      heldStream = Promise.withResolvers<void>();
      const prompt = session.prompt("Controlled streaming prompt");
      try {
        await settle(() => session.isStreaming, "the controlled native stream must start");
        await stableEntries();
        await refusal("streaming");
      } finally { heldStream.resolve(); heldStream = undefined; await prompt; }
      await settle(() => !session.isStreaming && !session.hasPostPromptWork, "the controlled native turn must settle");
      const outcome = await reset();
      assert.equal(outcome.cancelled, false);
      assert.equal(boundaries().length, 1); assert.equal(session.state.messages.length, 0); assert.equal(rebinds, 1);
      console.log(JSON.stringify({ scenario, evalRefused: true, bashRefused: true, streamingRefused: true,
        resetAdmittedOnceSettled: true, controlledTransportCalls: providerInputs.length, rebinds, blockedFetches }));
    } else if (scenario === "reset-boundary-failure") {
      assert.ok(seedLiveContext() > 0);
      const entriesBefore = manager.getEntries().map(entry => entry.id), providerBefore = session.sessionId;
      const append = manager.appendResetBoundary.bind(manager);
      let injected = 0;
      // Controlled injection BEFORE the record: the real native reset has already
      // dropped the live conversation when the durable boundary refuses.
      manager.appendResetBoundary = () => { injected++; throw new Error("Controlled native reset boundary failure before record"); };
      let failure: unknown;
      try { failure = await reset().then(() => undefined, (error: unknown) => error); }
      finally { manager.appendResetBoundary = append; }
      assert.equal(injected, 1);
      assert.ok(failure instanceof Error && "code" in failure && failure.code === "OUTCOME_UNKNOWN", String(failure));
      assert.equal(session.state.messages.length, 0, "the actual native reset already happened");
      assert.equal(boundaries().length, 0, "no boundary was recorded");
      assert.deepEqual(manager.getEntries().map(entry => entry.id), entriesBefore);
      assert.notEqual(session.sessionId, providerBefore);
      assert.equal(rebinds, 1, "the rebind port runs on a partial failure too");
      assert.equal(tree.read().reconciliationRequired, true);
      await assert.rejects(reset(), (error: unknown) => error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN" && /reconciliation/.test(error.message));
      assert.equal(injected, 1, "an unknown outcome is never replayed");
      assert.equal(boundaries().length, 0);
      assert.deepEqual(manager.getEntries().map(entry => entry.id), entriesBefore);
      console.log(JSON.stringify({ scenario, injectedBoundaryFailureBeforeRecord: true, liveContextActuallyReset: true,
        historyUnchanged: true, reportedUnknown: true, retryRefused: true, rebinds, blockedFetches }));
    } else if (scenario === "reset-flush-failure") {
      assert.ok(seedLiveContext() > 0);
      const flush = manager.flush.bind(manager);
      let injected = 0;
      // Controlled injection AFTER the actual boundary is appended: the reset and its
      // record both happened; only their durability could not be confirmed.
      manager.flush = async () => {
        if (manager.getEntries().some(entry => entry.type === "reset_boundary")) { injected++; throw new Error("Controlled native flush failure after the reset boundary"); }
        return flush();
      };
      try {
        const failure = await reset().then(() => undefined, (error: unknown) => error);
        assert.ok(failure instanceof Error && "code" in failure && failure.code === "OUTCOME_UNKNOWN", String(failure));
        assert.equal(injected, 1);
        assert.equal(boundaries().length, 1); assert.equal(session.state.messages.length, 0); assert.equal(rebinds, 1);
        assert.equal(tree.read().reconciliationRequired, true);
        const count = manager.getEntries().length;
        await assert.rejects(reset(), (error: unknown) => error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN" && /reconciliation/.test(error.message));
        assert.equal(manager.getEntries().length, count); assert.equal(boundaries().length, 1); assert.equal(injected, 1);
      } finally { manager.flush = flush; await flush(); }
      const reopened = await SessionManager.open(manager.getSessionFile()!);
      assert.equal(reopened.getBranch().filter(entry => entry.type === "reset_boundary").length, 1);
      console.log(JSON.stringify({ scenario, injectedFlushFailureAfterAppend: true, boundaryAppended: true,
        reportedUnknown: true, retryRefused: true, reconciledBoundaryDurable: true, rebinds, blockedFetches }));
    } else if (scenario === "reset-recovered-edit") {
      const target = manager.appendMessage({ role: "user", content: "Recoverable edit", timestamp: 40 });
      manager.appendCustomEntry("fixture-second-tail", {}); await manager.flush();
      seedLiveContext();
      assert.equal((await navigate(target)).draft?.text, "Recoverable edit");
      const recovered = tree.read().recoveredDraft;
      assert.ok(recovered, "a real native edit recovery must exist before the reset");
      assert.equal(recovered.targetId, target);
      seedLiveContext();
      const outcome = await reset();
      assert.equal(outcome.cancelled, false);
      assert.equal(outcome.state.recoveredDraft, undefined);
      assert.equal(tree.read().recoveredDraft, undefined);
      // The navigation marker itself is retained; only its recovery claim retires.
      assert.ok(manager.getBranch().some(entry => entry.type === "custom" && entry.customType === TREE_NAVIGATION_ENTRY));
      assert.equal(boundaries().length, 1); assert.equal(rebinds, 1);
      const reopened = await SessionManager.open(manager.getSessionFile()!);
      assert.ok(reopened.getBranch().some(entry => entry.type === "custom" && entry.customType === TREE_NAVIGATION_ENTRY));
      assert.equal(reopened.getBranch().filter(entry => entry.type === "reset_boundary").length, 1);
      console.log(JSON.stringify({ scenario, recoveredEditBeforeReset: true, clearedAtBoundary: true,
        navigationMarkerRetained: true, rebinds, blockedFetches }));
    } else throw new Error(`Unknown scenario ${scenario}`);
  }
} finally { heldStream?.resolve(); release.resolve(); await session.dispose(); auth.close(); }
