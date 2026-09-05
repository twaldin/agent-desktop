// Real pinned SDK/AgentSession forks. The subclass only gates/fails storage drain;
// native identity, history, file writes, FileLock and bash execution are real.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export async function agentForkChecks({ packageRoot, root, cwd, check, actor }: any) {
  const { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import(path.join(packageRoot, "src/index.ts"));
  const { FileSessionStorage } = await import(path.join(packageRoot, "src/session/session-storage.ts"));
  const agentDir = path.join(root, "fork-agent");
  await mkdir(agentDir, { recursive: true });
  const settings = await Settings.loadReadOnly({ cwd, agentDir }), auth = await discoverAuthStorage(agentDir);
  const models = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
  let sequence = 0;
  async function fresh(storage?: any) {
    const manager = SessionManager.create(cwd, path.join(root, `agent-fork-${++sequence}`), storage);
    const { session } = await createAgentSession({ cwd, agentDir, settings, authStorage: auth, modelRegistry: models, sessionManager: manager,
      enableMCP: false, enableIrc: false, enableLsp: false, toolNames: [], preloadedExtensionPaths: [], preloadedCustomToolPaths: [], hasUI: false });
    manager.appendMessage({ role: "user", content: "Isolated high-level native fork fixture; no provider", timestamp: sequence });
    await manager.ensureOnDisk(); await manager.flush(); return { session, manager };
  }
  async function busy(file: string) { const peer = actor(file); assert.equal((await peer.first).type, "rejected"); assert.equal(await peer.child.exited, 73); }
  async function available(file: string, id: string) { const peer = actor(file); const event = await peer.first; assert.equal(event.type, "ready"); assert.equal(event.id, id); peer.child.send({ type: "close" }); assert.equal(await peer.child.exited, 0); }
  // Timeout only prevents a broken fixture hanging. It never substitutes for an event.
  const bounded = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Native fork fixture event timed out")), 15000); timer.unref(); })]);
  class GatedStorage extends FileSessionStorage {
    session: any; oldFile?: string; oldId?: string; fail = false; rollbackFail = false; gateRollback = false; armed = false; stage = "idle";
    entered = Promise.withResolvers<void>(); release = Promise.withResolvers<void>();
    rollbackEntered = Promise.withResolvers<void>(); rollbackRelease = Promise.withResolvers<void>();
    override async drain() {
      if (this.armed && this.stage === "idle" && this.session.sessionManager.getSessionFile() !== this.oldFile && this.session.agent.sessionId === this.session.sessionManager.getSessionId()) {
        this.stage = "prepare-drain"; this.entered.resolve(); await this.release.promise;
        if (this.fail) { this.stage = "failed"; throw new Error("Controlled native storage drain failure after high-level fork preparation"); }
        this.stage = "committing";
      } else if (this.gateRollback && this.stage === "failed" && this.session.sessionManager.getSessionFile() === this.oldFile && this.session.agent.sessionId === this.oldId) {
        this.stage = "rollback-drain"; this.rollbackEntered.resolve(); await this.rollbackRelease.promise; this.stage = "rolled-back"; if (this.rollbackFail) throw new Error("Controlled native rollback drain failure");
      }
      await super.drain();
    }
    arm(session: any) { this.session = session; this.oldFile = session.sessionFile; this.oldId = session.sessionId; this.armed = true; }
  }
  try {
    await check("real AgentSession fork retains both leases through prepared drain and retires source only on commit", async () => {
      const storage = new GatedStorage(), { session, manager } = await fresh(storage), original = manager.getSessionFile()!, originalId = manager.getSessionId();
      const before = await readFile(original), artifactName = "owned-fork.txt";
      await mkdir(original.slice(0, -6), { recursive: true }); await writeFile(path.join(original.slice(0, -6), artifactName), "actual artifact copy");
      let notices = 0; session.registerSessionChangeCallback(() => notices++); storage.arm(session);
      const pending = session.fork();
      try {
        await bounded(storage.entered.promise); const destination = manager.getSessionFile()!, destinationId = manager.getSessionId();
        assert.notEqual(destination, original); assert.equal(session.agent.sessionId, destinationId); assert.equal(notices, 0);
        await busy(original); await busy(destination); assert.deepEqual(await readFile(original), before);
        assert.equal(await readFile(path.join(destination.slice(0, -6), artifactName), "utf8"), "actual artifact copy");
        storage.release.resolve(); assert.equal(await pending, true); assert.equal(notices, 1);
        await available(original, originalId); await busy(destination);
        assert.deepEqual(manager.getOwnership().heldFiles, [destination]);
        manager.appendCustomEntry("after-high-level-commit", {}); await manager.flush();
        assert((await readFile(destination, "utf8")).includes("after-high-level-commit")); assert.deepEqual(await readFile(original), before);
      } finally { storage.release.resolve(); storage.rollbackRelease.resolve(); await pending.catch(() => {}); await session.dispose(); }
    });
    await check("real AgentSession forced post-prepare failure restores source identity before rollback drain and keeps source writable", async () => {
      const storage = new GatedStorage(), { session, manager } = await fresh(storage), original = manager.getSessionFile()!, originalId = manager.getSessionId();
      const before = await readFile(original), priorEntries = manager.getEntries().map((entry: any) => entry.id), priorMessages = [...session.agent.state.messages];
      let notices = 0; session.registerSessionChangeCallback(() => notices++); storage.fail = true; storage.gateRollback = true; storage.arm(session);
      const pending = session.fork(), rejected = assert.rejects(pending, /Controlled native storage drain failure/);
      try {
        await bounded(storage.entered.promise); const destination = manager.getSessionFile()!, destinationId = manager.getSessionId();
        await busy(original); await busy(destination); storage.release.resolve(); await bounded(storage.rollbackEntered.promise);
        assert.equal(manager.getSessionId(), originalId); assert.equal(manager.getSessionFile(), original); assert.equal(manager.getCwd(), cwd);
        assert.equal(session.agent.sessionId, originalId); assert.equal(notices, 0); assert.deepEqual(session.agent.state.messages, priorMessages);
        assert.deepEqual(manager.getEntries().map((entry: any) => entry.id), priorEntries); assert.deepEqual(await readFile(original), before);
        await busy(original); await busy(destination);
        storage.rollbackRelease.resolve(); await rejected;
        await available(destination, destinationId); await busy(original);
        manager.appendCustomEntry("after-high-level-rollback", {}); await manager.flush();
        assert((await readFile(original, "utf8")).includes("after-high-level-rollback")); assert.equal(manager.getSessionId(), originalId);
        assert.deepEqual(manager.getOwnership().heldFiles, [original]);
      } finally { storage.release.resolve(); storage.rollbackRelease.resolve(); await rejected; await session.dispose(); }
    });
    await check("failed high-level rollback seals the manager and retains both native leases", async () => {
      const storage = new GatedStorage(), { session, manager } = await fresh(storage), original = manager.getSessionFile()!;
      storage.fail = true; storage.gateRollback = true; storage.rollbackFail = true; storage.arm(session);
      const pending = session.fork(), rejected = assert.rejects(pending, /indeterminate/i);
      try {
        await bounded(storage.entered.promise); const destination = manager.getSessionFile()!;
        storage.release.resolve(); await bounded(storage.rollbackEntered.promise);
        await busy(original); await busy(destination); storage.rollbackRelease.resolve(); await rejected;
        assert.equal(manager.getOwnership().sealed, true); await busy(original); await busy(destination);
        const before = await readFile(original); manager.appendCustomEntry("after-failed-rollback-must-drop", {});
        await assert.rejects(manager.close(), /indeterminate/i); assert.deepEqual(await readFile(original), before);
        await busy(original); await busy(destination);
      } finally { storage.release.resolve(); storage.rollbackRelease.resolve(); await rejected; await session.dispose().catch(() => {}); }
    });
    await check("terminal close during real high-level fork waits for rollback before releasing source", async () => {
      const storage = new GatedStorage(), { session, manager } = await fresh(storage), original = manager.getSessionFile()!, originalId = manager.getSessionId();
      const before = await readFile(original); storage.arm(session);
      const pending = session.fork(), rejected = assert.rejects(pending, /sealed during fork/);
      try {
        await bounded(storage.entered.promise); const destination = manager.getSessionFile()!, destinationId = manager.getSessionId();
        const closing = manager.close(); await busy(original); await busy(destination);
        storage.release.resolve(); await rejected; await closing;
        assert.equal(manager.getSessionId(), originalId); assert.equal(session.agent.sessionId, originalId); assert.deepEqual(await readFile(original), before);
        await available(original, originalId); await available(destination, destinationId);
      } finally { storage.release.resolve(); storage.rollbackRelease.resolve(); await rejected; await session.dispose(); }
    });
    await check("real in-flight bash receives original lease across committed AgentSession fork and releases after its append", async () => {
      const { session, manager } = await fresh(), original = manager.getSessionFile()!, originalId = manager.getSessionId();
      const marker = path.join(root, `bash-start-${sequence}`), releaseFile = path.join(root, `bash-release-${sequence}`);
      // Paths are generated under the isolated fixture root; shell quote explicitly.
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const started = Promise.withResolvers<void>();
      const running = session.executeBash(`printf started > ${quote(marker)}; printf 'ownership-bash-started\\n'; while [ ! -f ${quote(releaseFile)} ]; do sleep 0.05; done; printf 'ownership-bash-completed\\n'`, (chunk: string) => { if (chunk.includes("ownership-bash-started")) started.resolve(); });
      try {
        await bounded(started.promise); assert.equal(await session.fork(), true); const destination = manager.getSessionFile()!;
        await busy(original); await busy(destination); assert.deepEqual(manager.getOwnership().heldFiles, [destination]);
        await writeFile(releaseFile, "release"); const actual = await bounded(running); assert.equal(actual.exitCode, 0);
        await available(original, originalId); assert((await readFile(original, "utf8")).includes("ownership-bash-completed"));
        const destinationEntries = manager.getEntries(); assert(!destinationEntries.some((entry: any) => entry.type === "message" && entry.message.role === "bashExecution"));
      } finally { await writeFile(releaseFile, "release"); await bounded(running).catch(() => {}); await session.dispose(); }
    });
  } finally { auth.close(); }
}
