import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdir, readFile, writeFile, link, unlink, rename, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const packageRoot = process.env.OWNERSHIP_NATIVE_PACKAGE!, root = process.argv[2]!;
const { SessionManager } = await import(path.join(packageRoot, "src/session/session-manager.ts"));
const { FileSessionStorage } = await import(path.join(packageRoot, "src/session/session-storage.ts"));
const { SessionFileLease } = await import(path.join(packageRoot, "src/session/session-ownership.ts"));
const cwd = path.join(root, "project"); await mkdir(cwd, { recursive: true });
const result: any = { pinnedVersion: "18.1.10", providerCalls: false, packageRoot, checks: [], pending: [] };
const output = path.join(root, "result.json");
const save = () => writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
async function check(name: string, work: () => Promise<void>) {
  try { await work(); result.checks.push({ name, status: "passed" }); }
  catch (error) { result.checks.push({ name, status: "failed", message: String(error), stack: error instanceof Error ? error.stack : undefined }); }
  await save();
}
let sequence = 0;
async function fresh(storage?: any) {
  const manager = SessionManager.create(cwd, path.join(root, `sessions-${++sequence}`), storage);
  await manager.ensureOnDisk(); manager.appendMessage({ role: "user", content: `Isolated native ownership fixture ${sequence}`, timestamp: sequence }); await manager.flush();
  return manager;
}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function actor(file: string) {
  const first = Promise.withResolvers<any>(), events: any[] = [], waiters: Array<(event: any) => void> = [];
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "actor.ts"), file], { env: process.env, stdout: "pipe", stderr: "pipe",
    ipc(event) { events.push(event); first.resolve(event); waiters.shift()?.(events.shift()); } });
  return { child, first: first.promise, next: () => events.length ? Promise.resolve(events.shift()) : new Promise<any>(resolve => waiters.push(resolve)) };
}
await check("new destination lease exists before its first header", async () => {
  const manager = SessionManager.create(cwd, path.join(root, `sessions-${++sequence}`));
  const file = manager.getSessionFile()!; assert.equal(fs.existsSync(file), false);
  const competing = actor(file); assert.equal((await competing.first).type, "rejected"); assert.equal(await competing.child.exited, 73);
  assert.equal(fs.existsSync(file), false); await manager.ensureOnDisk(); await manager.close();
});
await check("existing writable open is exclusive in this process and another process", async () => {
  const owner = await fresh(), file = owner.getSessionFile()!, original = await readFile(file);
  await assert.rejects(SessionManager.open(file), /ownership is busy/);
  const competing = actor(file); assert.equal((await competing.first).type, "rejected"); assert.equal(await competing.child.exited, 73);
  assert.deepEqual(await readFile(file), original); await owner.close();
});
await check("independent sessions remain concurrently writable", async () => {
  const left = await fresh(), right = await fresh(); left.appendCustomEntry("left", {}); right.appendCustomEntry("right", {});
  await Promise.all([left.flush(), right.flush()]); assert.notEqual(left.getSessionId(), right.getSessionId()); await Promise.all([left.close(), right.close()]);
});
await check("inspected canonical path native ID cwd and revision verified under lease", async () => {
  const manager = await fresh(), file = manager.getSessionFile()!, id = manager.getSessionId(); await manager.close();
  const before = await readFile(file), expected = { canonicalFile: file, nativeId: id, recordedCwd: cwd, sha256: hash(before) };
  for (const change of [{ sha256: "0".repeat(64) }, { nativeId: "wrong" }, { recordedCwd: path.dirname(cwd) }, { canonicalFile: file + ".other" }]) {
    await assert.rejects(SessionManager.open(file, undefined, undefined, { expectedOwnership: { ...expected, ...change } }));
    assert.deepEqual(await readFile(file), before);
  }
  const opened = await SessionManager.open(file, undefined, undefined, { expectedOwnership: expected });
  assert.equal(opened.getSessionId(), id); assert.equal(opened.getCwd(), cwd); assert.equal(opened.getSessionFile(), file); await opened.close();
});
await check("hard links and final symlinks cannot alias another writable owner", async () => {
  const manager = await fresh(), file = manager.getSessionFile()!; await manager.close();
  await link(file, file + ".hard"); await assert.rejects(SessionManager.open(file), /hard-linked/); await unlink(file + ".hard");
  const owner = await SessionManager.open(file); await symlink(file, file + ".alias");
  await assert.rejects(SessionManager.open(file + ".alias"), /regular/); await owner.close();
});
await check("title and append reject a replaced path without modifying the other locked file", async () => {
  for (const operation of ["append", "title"]) {
    const manager = await fresh(), other = await fresh(), file = manager.getSessionFile()!, otherFile = other.getSessionFile()!, before = await readFile(otherFile);
    await rename(file, file + ".displaced"); await symlink(otherFile, file);
    if (operation === "append") { manager.appendCustomEntry("must-not-follow-symlink", {}); await assert.rejects(manager.flush()); }
    else await assert.rejects(manager.setSessionName("must-not-follow-symlink", "user"));
    assert.deepEqual(await readFile(otherFile), before); await assert.rejects(manager.close()); await other.close();
  }
});
await check("same-inode external revision change is detected before an append", async () => {
  const manager = await fresh(), file = manager.getSessionFile()!;
  fs.appendFileSync(file, JSON.stringify({ type: "custom", id: "external", customType: "isolated-external-edit", timestamp: new Date().toISOString(), data: {} }) + "\n");
  const revised = await readFile(file); manager.appendCustomEntry("must-not-overwrite", {}); await assert.rejects(manager.flush());
  assert.deepEqual(await readFile(file), revised); await assert.rejects(manager.close());
});
await check("fork and branch own their new destinations before publishing", async () => {
  const manager = await fresh(), originalId = manager.getSessionId();
  const fork = await manager.fork(); assert(fork); assert.notEqual(manager.getSessionId(), originalId);
  await assert.rejects(SessionManager.open(fork.newSessionFile), /ownership is busy/);
  const leaf = manager.getLeafId()!, branch = manager.createBranchedSession(leaf)!;
  await assert.rejects(SessionManager.open(branch), /ownership is busy/);
  assert.notEqual(branch, fork.newSessionFile); await manager.close();
  const reopened = await SessionManager.open(branch); assert.equal(reopened.getSessionFile(), branch); await reopened.close();
});
await check("explicit fork destination rejects a competing lease before any write", async () => {
  const source = await fresh(), target = await fresh(), file = target.getSessionFile()!, before = await readFile(file);
  await assert.rejects(SessionManager.forkFrom(source.getSessionFile()!, cwd, path.dirname(file), undefined, { sessionFile: file, copyArtifacts: false }), /ownership is busy/);
  assert.deepEqual(await readFile(file), before); await Promise.all([source.close(), target.close()]);
});
await check("close seals late writes and holds ownership until storage drain settles", async () => {
  const gate = Promise.withResolvers<void>();
  class DelayedStorage extends FileSessionStorage { hold = false; override drain() { return this.hold ? gate.promise : Promise.resolve(); } }
  const storage = new DelayedStorage(), manager = await fresh(storage), file = manager.getSessionFile()!;
  storage.hold = true; const closing = manager.close(); await Promise.resolve();
  await assert.rejects(SessionManager.open(file), /ownership is busy/);
  const before = await readFile(file); manager.appendCustomEntry("late-close-event", {}); await assert.rejects(manager.newSession(), /sealed/);
  gate.resolve(); await closing; assert.deepEqual(await readFile(file), before);
  const replacement = await SessionManager.open(file); await replacement.close();
});
await check("seal alone retains ownership until final close", async () => {
  const manager = await fresh(), file = manager.getSessionFile()!, before = await readFile(file);
  manager.seal(); manager.appendCustomEntry("late-sealed-event", {}); await assert.rejects(SessionManager.open(file), /ownership is busy/);
  await manager.close(); assert.deepEqual(await readFile(file), before); const reopened = await SessionManager.open(file); await reopened.close();
});
await check("OS exit releases a real competing-process lease", async () => {
  const manager = await fresh(), file = manager.getSessionFile()!; await manager.close();
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const owner = actor(file); assert.equal((await owner.first).type, "ready"); await assert.rejects(SessionManager.open(file), /ownership is busy/);
    owner.child.kill(signal); await owner.child.exited;
    const next = await SessionManager.open(file); await next.close();
  }
});
await check("basic native move remains functional and retains native ID", async () => {
  const manager = await fresh(), id = manager.getSessionId(), original = manager.getSessionFile()!;
  const movedCwd = path.join(root, "moved-project"); await mkdir(movedCwd);
  await manager.moveTo(movedCwd, path.join(root, "moved-sessions")); assert.equal(manager.getSessionId(), id); assert.equal(manager.getCwd(), movedCwd);
  assert.notEqual(manager.getSessionFile(), original); manager.appendCustomEntry("after-move", {}); await manager.flush(); await manager.close();
});
await check("committed fork retires its former-file lease without closing the new owner", async () => {
  const manager = await fresh(), original = manager.getSessionFile()!;
  try {
    await manager.fork();
    const independent = await SessionManager.open(original); await independent.close();
  } finally { await manager.close(); }
});
const { agentForkChecks } = await import("./agent-fork-contract");
await agentForkChecks({ packageRoot, root, cwd, check, actor });
const { revivalChecks } = await import("./revival-contract");
await revivalChecks({ packageRoot, root, cwd, check, actor });
result.pending = ["Fork source retirement and high-level rollback have dedicated checks. Other transitions and memory-backend/extension external side-effect rollback remain unaccepted.",
  "Move only has a basic functional smoke test. Outer command rollback, child-artifact namespace coordination, concurrent completed appends and failed relocation remain unproved. Cold persisted-factory revival/re-revival is checked; the executor-specific warm/advisor paths remain unaccepted.",
  "Atomic commit checks are synchronous user-space checks, not a kernel conditional rename. Parent-directory replacement and retarget at the final publication boundary remain unaccepted.",
  "Only local FileSessionStorage participates. Indexed/custom persistence backends remain unchanged and are not admitted by this protocol.",
  "No cooperating CLI bundle, app import integration, stock-writer handoff proof or user command installation is provided by this candidate."];
result.passed = result.checks.filter((check: any) => check.status === "passed").length; result.failed = result.checks.filter((check: any) => check.status === "failed").length;
await save(); console.log(JSON.stringify({ output, passed: result.passed, failed: result.failed, pending: result.pending }, null, 2));
process.exitCode = result.failed ? 1 : 0;
