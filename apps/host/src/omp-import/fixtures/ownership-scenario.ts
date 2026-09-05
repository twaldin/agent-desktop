// Isolated actual native file/OS-lock proof. No authentication or providers.
import assert from "node:assert/strict";
import { copyFile, link, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileLock } from "@oh-my-pi/pi-natives";
import { NativeSessionImports } from "../inspection";
const [root] = process.argv.slice(2);
const cwd = path.join(root!, "project"), sessions = path.join(root!, "sessions");
await mkdir(cwd); await mkdir(sessions);
const created = SessionManager.create(cwd, sessions);
created.appendMessage({ role: "user", content: [{ type: "text", text: "Isolated native original-history contract" }], timestamp: Date.now() });
await created.ensureOnDisk(); const originalFile = created.getSessionFile()!, originalId = created.getSessionId(); await created.close();
// Matches pi-utils withFileLock(originalFile)'s native advisory lock key.
const lockPath = originalFile + ".lock";
const importer = new NativeSessionImports({ sessionDirectories: [sessions] });
const children = new Set<Bun.Subprocess>();
async function owner(mode: "native" | "cooperative") {
  const messages: any[] = [], pending: Array<(value: any) => void> = [];
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./native-owner.ts", import.meta.url)), originalFile, mode, lockPath], { stdin: "ignore", stdout: "ignore", stderr: "ignore", ipc(value) { const waiter = pending.shift(); if (waiter) waiter(value); else messages.push(value); } });
  children.add(child);
  const next = () => messages.length ? Promise.resolve(messages.shift()) : Promise.race([new Promise<any>(resolve => pending.push(resolve)), Bun.sleep(5000).then(() => { throw new Error("Native ownership fixture timed out"); })]);
  const ready = await next(); assert.equal(ready.type, "ready"); assert.equal(ready.id, originalId); assert.equal(ready.file, originalFile); assert.equal(ready.cwd, cwd);
  return { child, async send(operation: "append" | "release") { child.send({ id: crypto.randomUUID(), operation }); const reply = await next(); assert.equal(reply.type, operation === "append" ? "appended" : "released"); if (operation === "release") { assert.equal(await child.exited, 0); children.delete(child); } } };
}
try {
  // Readonly native discovery must not repair a .bak or create title indexes.
  const orphan = path.join(sessions, "missing.jsonl.12345.bak"); await copyFile(originalFile, orphan);
  const bytes = await readFile(originalFile), names = await readdir(sessions);
  const candidates = await importer.scan(); assert.equal(candidates.length, 1); assert.equal(candidates[0]!.nativeId, originalId);
  const inspection = await importer.inspect(candidates[0]!.candidateId);
  assert.equal(inspection.nativeId, originalId); assert.equal(inspection.recordedCwd, cwd); assert.equal(inspection.originalFile, originalFile); assert.equal(inspection.messages, 1);
  assert.deepEqual(inspection.issues, []); assert.deepEqual(inspection.writeAdmission, { allowed: false, reason: "ownership-unverified" });
  assert.deepEqual(await readFile(originalFile), bytes); assert.deepEqual(await readdir(sessions), names);
  assert.equal((await importer.inspect(candidates[0]!.candidateId)).revision, inspection.revision);
  // Stock OMP opens and appends despite an already-held OS advisory lock. This
  // disproves the misleading upstream peek/open single-writer-lock comment.
  const offered = FileLock.tryAcquire(lockPath); assert(offered.acquired);
  const stock = await owner("native"); await stock.send("append");
  assert((await readFile(originalFile, "utf8")).includes("contract-external-append"));
  const concurrent = await SessionManager.open(originalFile, undefined, undefined, { suppressBreadcrumb: true });
  assert.equal(concurrent.getSessionId(), originalId); concurrent.appendCustomEntry("contract-second-native-writer", {}); await concurrent.flush();
  await stock.send("append"); await concurrent.close();
  // close() only closes today's append descriptor. It does not revoke this
  // manager: a later callback can reopen the same original and append again.
  concurrent.appendCustomEntry("contract-append-after-close", {}); await concurrent.flush(); await concurrent.close();
  assert((await readFile(originalFile, "utf8")).includes("contract-append-after-close"));
  await stock.send("release"); offered.release();
  await assert.rejects(importer.checkAdmission(candidates[0]!.candidateId, inspection.revision), /changed since inspection/);
  const changed = await importer.inspect(candidates[0]!.candidateId);
  assert.equal((await importer.checkAdmission(candidates[0]!.candidateId, changed.revision)).allowed, false);
  // A cooperative writer holds the same canonical sidecar in its own process.
  const participating = await owner("cooperative");
  const denied = FileLock.tryAcquire(lockPath); assert.equal(denied.acquired, false); denied.release();
  await participating.send("release");
  const admitted = FileLock.tryAcquire(lockPath); assert(admitted.acquired);
  try {
    const original = await SessionManager.open(originalFile, undefined, undefined, { suppressBreadcrumb: true });
    try {
      assert.equal(original.getSessionId(), originalId); assert.equal(original.getSessionFile(), originalFile); assert.equal(original.getCwd(), cwd);
      assert(original.getEntries().some(entry => entry.type === "message"));
      original.appendCustomEntry("contract-cooperative-handoff", {}); await original.flush();
    } finally { await original.close(); }
  } finally { admitted.release(); }
  assert((await readFile(originalFile, "utf8")).includes("contract-cooperative-handoff"));
  assert.equal((await importer.inspect(candidates[0]!.candidateId)).nativeId, originalId);
  // Kernel ownership survives a paused process and ends when that process dies.
  const crashed = await owner("cooperative");
  const busy = FileLock.tryAcquire(lockPath); assert.equal(busy.acquired, false); busy.release();
  crashed.child.kill("SIGKILL"); await crashed.child.exited; children.delete(crashed.child);
  const recovered = FileLock.tryAcquire(lockPath); assert(recovered.acquired); recovered.release();
  // Aliases cannot bypass canonical boundaries or silently switch cwd.
  const alias = path.join(sessions, "alias.jsonl"); await symlink(originalFile, alias);
  assert.equal((await importer.scan()).filter(candidate => candidate.nativeId === originalId).length, 1); await unlink(alias);
  const outside = path.join(root!, "outside.jsonl"); await copyFile(originalFile, outside); await symlink(outside, alias);
  assert((await importer.scan()).some(candidate => candidate.issue?.includes("leaves the selected"))); await unlink(alias);
  await link(originalFile, alias); assert((await importer.scan()).some(candidate => candidate.issue?.includes("Hard-linked"))); await unlink(alias);
  const missingCwd = path.join(sessions, "missing-cwd.jsonl");
  const raw = (await readFile(originalFile, "utf8")).replaceAll(JSON.stringify(cwd), JSON.stringify(path.join(root!, "not-there"))); await writeFile(missingCwd, raw);
  const invalid = (await importer.scan()).find(candidate => candidate.sourcePath === missingCwd)!;
  const invalidInspection = await importer.inspect(invalid.candidateId); assert.equal(invalidInspection.writeAdmission.reason, "source-invalid"); assert(invalidInspection.issues.some(issue => issue.includes("working directory")));
  const corrupt = path.join(sessions, "corrupt.jsonl"); await writeFile(corrupt, (await readFile(originalFile, "utf8")) + "{malformed\n");
  const corruptCandidate = (await importer.scan()).find(candidate => candidate.sourcePath === corrupt)!;
  assert.equal((await importer.inspect(corruptCandidate.candidateId)).malformedRecords, 1);
  assert.equal((await stat(orphan)).isFile(), true);
  process.stdout.write("native original-session ownership contracts passed\n");
} finally { for (const child of children) { child.kill("SIGKILL"); await child.exited; } }
