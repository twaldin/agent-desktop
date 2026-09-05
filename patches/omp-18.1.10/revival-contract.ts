// Real native lifecycle + persisted-child SDK revival, with real competing Bun
// owners. No provider calls, extension injection, fake manager or in-memory lock.
import assert from "node:assert/strict";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
export async function revivalChecks({ packageRoot, root, cwd, check, actor }: any) {
  const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import(path.join(packageRoot, "src/index.ts"));
  const { AgentLifecycleManager } = await import(path.join(packageRoot, "src/registry/agent-lifecycle.ts"));
  const { createPersistedSubagentReviverFactory } = await import(path.join(packageRoot, "src/task/persisted-revive.ts"));
  const agentDir = path.join(root, "revival-agent"); await mkdir(agentDir, { recursive: true });
  const settings = await Settings.loadReadOnly({ cwd, agentDir }), auth = await discoverAuthStorage(agentDir);
  const models = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
  const registry = AgentRegistry.global();
  const parentManager = SessionManager.create(cwd, path.join(root, "revival-parent"));
  const { session: parent } = await createAgentSession({ cwd, agentDir, settings, authStorage: auth, modelRegistry: models, sessionManager: parentManager,
    enableMCP: false, enableIrc: false, enableLsp: false, toolNames: [], preloadedExtensionPaths: [], preloadedCustomToolPaths: [], hasUI: false });
  await parentManager.ensureOnDisk();
  const lifecycle = new AgentLifecycleManager(registry);
  const factory = createPersistedSubagentReviverFactory({ session: parent, authStorage: auth, modelRegistry: models, settings, enableLsp: false });
  lifecycle.setPersistedSubagentReviverFactory(factory, 0);
  let sequence = 0;
  const init = (label: string) => ({ systemPrompt: `Persisted contract ${label}`, task: "Do not invoke a provider", tools: [], restrictToolNames: true, spawns: "" });
  async function child(label: string) {
    const manager = SessionManager.create(cwd, path.join(parentManager.getSessionFile()!.slice(0, -6), `children-${++sequence}`));
    manager.appendSessionInit(init(label));
    const messageId = manager.appendMessage({ role: "user", content: `Original native child message ${label}`, timestamp: sequence });
    await manager.ensureOnDisk(); await manager.flush(); const file = manager.getSessionFile()!, nativeId = manager.getSessionId(); await manager.close();
    const id = `isolated-revival-${sequence}`;
    const ref = registry.register({ id, kind: "sub", displayName: id, parentId: "Main", session: null, sessionFile: file, status: "parked" });
    return { id, ref, file, nativeId, messageId };
  }
  async function busy(file: string) { const peer = actor(file); assert.equal((await peer.first).type, "rejected"); assert.equal(await peer.child.exited, 73); }
  async function take(file: string, id: string) { const peer = actor(file); const first = await peer.first; assert.equal(first.type, "ready"); assert.equal(first.id, id); return peer; }
  async function close(peer: any) { peer.child.send({ type: "close" }); assert.equal(await peer.child.exited, 0); }
  const originalMessage = (session: any, value: any) => {
    assert.equal(session.sessionManager.getSessionId(), value.nativeId); assert.equal(session.sessionManager.getSessionFile(), value.file);
    assert.equal(session.sessionManager.getCwd(), cwd);
    assert(session.sessionManager.getEntries().some((entry: any) => entry.id === value.messageId && entry.type === "message" && entry.message.content.includes("Original native child message")));
    assert(session.agent.state.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("Original native child message")));
  };
  try {
    await check("actual cold lifecycle revival rejects a competing process before writes then admits the same native child after release", async () => {
      const value = await child("busy-freed"), before = await readFile(value.file); const owner = await take(value.file, value.nativeId);
      try {
        const outcomes = await Promise.allSettled([lifecycle.ensureLive(value.id), lifecycle.ensureLive(value.id)]);
        assert(outcomes.every(item => item.status === "rejected" && /ownership is busy/.test(String(item.reason))));
        assert.deepEqual(await readFile(value.file), before); assert.equal(registry.get(value.id)?.session, null); assert.equal(registry.get(value.id)?.status, "parked");
      } finally { await close(owner); }
      const [live, same] = await Promise.all([lifecycle.ensureLive(value.id), lifecycle.ensureLive(value.id)]); assert.equal(live, same); originalMessage(live, value);
      assert.deepEqual(live.sessionManager.getOwnership().heldFiles, [value.file]); await busy(value.file);
      live.sessionManager.appendCustomEntry("accepted-native-cold-revival", {}); await live.sessionManager.flush();
      assert((await readFile(value.file, "utf8")).includes("accepted-native-cold-revival"));
      await lifecycle.park(value.id); assert.equal(registry.get(value.id)?.status, "parked"); const nextOwner = await take(value.file, value.nativeId); await close(nextOwner);
      const revived = await lifecycle.ensureLive(value.id); assert.notEqual(revived, live); originalMessage(revived, value); await busy(value.file);
      const reopenedBytes = await readFile(value.file); live.sessionManager.appendCustomEntry("stale-parked-manager-must-not-write", {}); assert.deepEqual(await readFile(value.file), reopenedBytes);
      await lifecycle.release(value.id);
    });
    await check("prepared cold reviver rejects replacement native identity at the same path before modifying it", async () => {
      const value = await child("identity-old"), replacement = await child("identity-replacement"); const revive = await factory(value.ref); assert(revive);
      await rename(value.file, value.file + ".original"); await rename(replacement.file, value.file); const replaced = await readFile(value.file);
      let unexpected: any;
      try {
        await assert.rejects(revive(value.ref).then((session: any) => { unexpected = session; return session; }), /native session identity changed/);
        assert.deepEqual(await readFile(value.file), replaced);
        const available = await take(value.file, replacement.nativeId); await close(available); assert.equal(registry.get(value.id)?.session, null);
      } finally { await unexpected?.dispose(); registry.unregister(value.id); registry.unregister(replacement.id); }
    });
    await check("prepared cold reviver uses the latest persisted contract under ownership while preserving original history", async () => {
      const value = await child("contract-old"), revive = await factory(value.ref); assert(revive);
      const editor = await SessionManager.open(value.file); editor.appendSessionInit(init("contract-updated-under-native-owner")); editor.appendCustomEntry("history-added-before-revival", {}); await editor.flush(); await editor.close();
      const live = await revive(value.ref);
      try {
        originalMessage(live, value); await busy(value.file);
        assert(JSON.stringify(live.agent.state.systemPrompt).includes("contract-updated-under-native-owner"));
        assert(live.sessionManager.getEntries().some((entry: any) => entry.type === "custom" && entry.customType === "history-added-before-revival"));
      } finally { await live.dispose(); registry.unregister(value.id); }
    });
    await check("native SDK refusal during cold revival drains the reopened manager and does not strand writable ownership", async () => {
      const value = await child("stale-ref"), revive = await factory(value.ref); assert(revive);
      registry.unregister(value.id); const newer = registry.register({ id: value.id, kind: "sub", displayName: value.id, parentId: "Main", session: null, sessionFile: value.file, status: "aborted" });
      await assert.rejects(revive(value.ref), /changed|available|registered|replaced|claim|reviv/i);
      assert.equal(registry.get(value.id), newer); assert.equal(newer.status, "aborted"); assert.equal(newer.session, null);
      const available = await take(value.file, value.nativeId); await close(available);
      const reopened = await SessionManager.open(value.file); assert(reopened.getEntries().some((entry: any) => entry.id === value.messageId)); await reopened.close(); registry.unregister(value.id);
    });
  } finally { await lifecycle.dispose(); await parent.dispose(); auth.close(); }
}
