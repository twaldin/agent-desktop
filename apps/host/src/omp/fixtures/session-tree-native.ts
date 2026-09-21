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
const { AssistantMessageEventStream } = await import("@oh-my-pi/pi-ai/utils/event-stream");
const { initThemeSync } = await import("@oh-my-pi/pi-coding-agent/modes/theme/theme");
initThemeSync(settings.get("symbolPreset"), settings.get("colorBlindMode"), settings.get("theme.dark"), settings.get("theme.light"));
const result = await createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry: registry,
  agentRegistry: new AgentRegistry(), sessionManager: manager, model: registry.find("tree-fixture", "base"),
  extensions: [pi => {
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
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); return stream;
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
    let retired = false, busyReason: string | undefined, changed = 0;
    const tree = new NativeSessionTree(session, manager, { assertOwner() { if (retired) throw new Error("Retired owner"); }, getBusyReason: () => busyReason,
      prepare: async () => {}, ui, onChanged: () => { changed++; } });
    const navigate = (targetId: string, summarize = false, customInstructions?: string) => tree.mutate(`tree-${crypto.randomUUID()}`, {
      sessionId: manager.getSessionId(), ticket: tree.read().ticket, mutation: { action: "navigate", targetId, summarize, ...(customInstructions === undefined ? {} : { customInstructions }) } });
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
    } else throw new Error(`Unknown scenario ${scenario}`);
  }
} finally { release.resolve(); await session.dispose(); auth.close(); }
