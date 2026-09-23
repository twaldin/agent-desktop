import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { NativeSessionImportDiscovery } from "../discovery";
const root = await realpath(process.argv[2]!);
const sessionsRoot = path.join(root, "profile-sessions"), project = path.join(root, "project");
await mkdir(project);
const missing = new NativeSessionImportDiscovery({ sessionsRoot });
assert.deepEqual(await missing.scan(), []);
await assert.rejects(stat(sessionsRoot), { code: "ENOENT" });
await mkdir(sessionsRoot);
async function create(directory: string, text: string) {
  const dir = path.join(sessionsRoot, directory); await mkdir(dir);
  const manager = SessionManager.create(project, dir);
  manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  await manager.ensureOnDisk(); const file = manager.getSessionFile()!, id = manager.getSessionId();
  await manager.close(); manager.seal(); return { file, id };
}
const legacy = await create("--legacy-project--", "Original legacy history");
const current = await create("-current-project", "Original current history");
const backup = legacy.file + ".old.bak"; await copyFile(legacy.file, backup);
const before = await Promise.all([readFile(legacy.file), readFile(current.file), readFile(backup)]);
const names = await readdir(sessionsRoot);
const options = { sessionsRoot }, discovery = new NativeSessionImportDiscovery(options);
options.sessionsRoot = path.join(root, "not-the-selected-profile");
const first = await discovery.scan(); assert.equal(first.length, 2);
const legacyRow = first.find(row => row.nativeId === legacy.id)!; assert(legacyRow);
const inspected = await discovery.inspect(legacyRow.candidateId);
assert.equal(inspected.originalFile, legacy.file); assert.equal(inspected.messages, 1); assert.equal(inspected.canonicalCwd, project);
const reviewed = await discovery.resolveReviewedSource(legacyRow.candidateId, inspected.revision);
assert.equal(reviewed.originalFile, legacy.file); assert.equal(reviewed.nativeId, legacy.id);
assert.equal(reviewed.contentSha256, createHash("sha256").update(before[0]!).digest("hex"));
const observedStat = await stat(legacy.file);
assert.deepEqual(reviewed.fileIdentity, { dev: observedStat.dev, ino: observedStat.ino, size: observedStat.size, mtimeMs: observedStat.mtimeMs, ctimeMs: observedStat.ctimeMs, birthtimeMs: observedStat.birthtimeMs });
reviewed.fileIdentity.ino = 0;
assert.equal((await discovery.resolveReviewedSource(legacyRow.candidateId, inspected.revision)).fileIdentity.ino, observedStat.ino);
assert.deepEqual(await discovery.checkAdmission(legacyRow.candidateId, inspected.revision), { allowed: false, reason: "ownership-unverified" });
assert.deepEqual(await readdir(sessionsRoot), names);
assert.deepEqual(await Promise.all([readFile(legacy.file), readFile(current.file), readFile(backup)]), before);
const again = await discovery.scan(); assert.equal(again.find(row => row.nativeId === legacy.id)!.candidateId, legacyRow.candidateId);
// Same-profile aliases collapse, while outside-profile aliases refuse the scan.
const alias = path.join(sessionsRoot, "alias"); await symlink(path.dirname(legacy.file), alias);
assert.equal((await discovery.scan()).length, 2); await unlink(alias);
const outside = path.join(root, "outside"); await mkdir(outside); await symlink(outside, alias);
await assert.rejects(discovery.scan(), /alias leaves/);
assert.throws(() => discovery.inspect(legacyRow.candidateId), /current native/);
await unlink(alias);
// Bounds fail visibly rather than yielding an apparently complete prefix.
await assert.rejects(new NativeSessionImportDiscovery({ sessionsRoot, maxDirectories: 1 }).scan(), /directory limit/);
await assert.rejects(new NativeSessionImportDiscovery({ sessionsRoot, maxCandidates: 1 }).scan(), /candidate limit/);
const aborted = new AbortController(); aborted.abort(new Error("discovery cancelled"));
await assert.rejects(discovery.scan(aborted.signal), /discovery cancelled/);
const pending = discovery.scan(); await assert.rejects(discovery.scan(), /already running/); await pending;
// Removing a directory retires its old opaque candidate; no historical read is rebound.
const oldRow = (await discovery.scan()).find(row => row.nativeId === current.id)!;
await rename(path.dirname(current.file), path.join(root, "removed-directory"));
assert.equal((await discovery.scan()).length, 1);
assert.throws(() => discovery.inspect(oldRow.candidateId), /current native/);
assert.deepEqual(await readFile(legacy.file), before[0]); assert.deepEqual(await readFile(backup), before[2]);
const retainedRow = (await discovery.scan())[0]!, retained = await discovery.inspect(retainedRow.candidateId);
const writer = await SessionManager.open(legacy.file, undefined, undefined, { suppressBreadcrumb: true });
writer.appendCustomEntry("changed-after-review", {}); await writer.flush(); await writer.close(); writer.seal();
await assert.rejects(discovery.resolveReviewedSource(retainedRow.candidateId, retained.revision), /changed since inspection/);
process.stdout.write(JSON.stringify({ missingRootNotCreated: true, originalHistoriesAndBackupPreserved: true, nativeInspection: true,
  ownershipStillRequired: true, exactReviewedSourceAndStaleRefusal: true, stableOpaqueIds: true, aliasesAndBounds: true, cancellationAndConcurrentRead: true, removedSourceRetired: true }) + "\n");
