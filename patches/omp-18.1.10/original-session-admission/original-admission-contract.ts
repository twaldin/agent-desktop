// Bounded acceptance for the cooperating original-session admission slice.
//
// Everything here runs the actual patched native SDK: real SessionManager,
// real FileSessionStorage, real @oh-my-pi/pi-natives FileLock, real filesystem
// state and real competing Bun processes. Nothing is mocked — no fake lock, no
// stub manager or provider turn. Configuration is disposable; the high-level
// scenario uses only an empty in-memory credential store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const packageRoot = process.env.ORIGINAL_ADMISSION_PACKAGE!;
const root = process.argv[2]!;
const selectedCheck = process.argv[3];
const kernelNamedLocks = process.platform === "linux" || process.platform === "win32";

const networkAttempts: string[] = [];
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
	networkAttempts.push(String(input instanceof Request ? input.url : input));
	throw new Error("Native original admission contract blocks network before transport");
}, { preconnect(input: string | URL) { networkAttempts.push(String(input)); } }) as typeof fetch;
// Runtime-selected: the module under test lives in a freshly patched copy whose
// path only exists once the runner has staged it.
const ownership = await import(path.join(packageRoot, "src/session/original-session-ownership.ts"));
const { SessionManager } = await import(path.join(packageRoot, "src/session/session-manager.ts"));
const {
	createCooperativeOriginal,
	inspectOriginalParticipation,
	observeEnrolledOriginal,
	openAdmittedOriginal,
	ORIGINAL_SESSION_OWNERSHIP_PROTOCOL,
} = ownership;

interface CheckResult {
	name: string;
	status: "passed" | "failed" | "skipped";
	detail?: string;
}

const result = {
	pinnedVersion: "18.1.10",
	providerCalls: false,
	retainedCredentialAccess: false,
	networkAttempts,
	packageRoot,
	platform: process.platform,
	arch: process.arch,
	selectedCheck: selectedCheck ?? null,
	protocol: ORIGINAL_SESSION_OWNERSHIP_PROTOCOL,
	checks: [] as CheckResult[],
	knownLimitations: [] as string[],
	passed: 0,
	failed: 0,
	skipped: 0,
};
const output = path.join(root, "result.json");
const save = () => writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

async function check(name: string, work: () => Promise<void>, skipReason?: string): Promise<void> {
	if (selectedCheck && selectedCheck !== name) return;
	if (skipReason) {
		result.checks.push({ name, status: "skipped", detail: skipReason });
		await save();
		return;
	}
	try {
		await work();
		result.checks.push({ name, status: "passed" });
	} catch (error) {
		result.checks.push({ name, status: "failed", detail: String((error as Error)?.stack ?? error) });
	}
	await save();
}

/** Assert a refusal is the proven-no-effect kind, with the expected reason. */
function assertNotSubmitted(error: unknown, reasons: string[], context: string): void {
	const failure = error as { code?: string; reason?: string; message?: string };
	assert.equal(failure?.code, "ORIGINAL_SESSION_NOT_SUBMITTED", `${context}: ${failure?.message ?? error}`);
	assert.ok(reasons.includes(failure.reason ?? ""), `${context}: unexpected reason ${failure.reason}`);
}

async function expectRefusal(work: () => Promise<unknown>, reasons: string[], context: string): Promise<void> {
	try {
		await work();
	} catch (error) {
		assertNotSubmitted(error, reasons, context);
		return;
	}
	assert.fail(`${context}: expected a refusal`);
}

const digestOf = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const identityOf = (file: string) => {
	const stats = lstatSync(file);
	return {
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		birthtimeMs: stats.birthtimeMs,
	};
};

let sequence = 0;
/** A disposable ownership root + project + session dir per scenario. */
function arena(): { ownershipDirectory: string; cwd: string; sessionDirectory: string } {
	const base = path.join(root, `arena-${++sequence}`);
	const cwd = path.join(base, "project");
	const sessionDirectory = path.join(base, "sessions");
	mkdirSync(cwd, { recursive: true, mode: 0o700 });
	mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
	return { ownershipDirectory: path.join(base, "ownership"), cwd, sessionDirectory };
}

/** Create an original, publish one entry, and hand ownership back. */
async function seedOriginal(place = arena()) {
	const { manager, binding } = await createCooperativeOriginal(place);
	manager.appendCustomEntry("seed", { note: "authored by the cooperating writer" });
	await manager.flush();
	manager.seal();
	await manager.close();
	const source = await observeEnrolledOriginal(place.ownershipDirectory, binding);
	return { place, binding, source };
}

interface ActorHandle {
	send: (command: Record<string, unknown>) => void;
	next: () => Promise<Record<string, unknown>>;
	exited: Promise<number>;
	kill: () => void;
}

function spawnActor(requestFile: string): ActorHandle {
	const queue: Array<Record<string, unknown>> = [];
	const waiters: Array<(message: Record<string, unknown>) => void> = [];
	const deliver = (message: Record<string, unknown>) => {
		const waiting = waiters.shift();
		if (waiting) waiting(message);
		else queue.push(message);
	};
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "actor.ts"), requestFile], {
		cwd: root,
		env: { ...process.env, ORIGINAL_ADMISSION_PACKAGE: packageRoot },
		ipc: message => deliver(message as Record<string, unknown>),
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		send: command => child.send(command),
		next: () => {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			waiters.push(resolve);
			return promise;
		},
		exited: child.exited,
		kill: () => child.kill("SIGKILL"),
	};
}

async function admissionRequestFile(name: string, request: unknown): Promise<string> {
	const file = path.join(root, `${name}.json`);
	await writeFile(file, `${JSON.stringify(request)}\n`, { mode: 0o600 });
	return file;
}

// ---------------------------------------------------------------------------
// Enrollment provenance
// ---------------------------------------------------------------------------

await check("an unknown stock original is never enrolled, locked or unlocked", async () => {
	const place = arena();
	const stock = SessionManager.create(place.cwd, place.sessionDirectory);
	stock.appendCustomEntry("stock", {});
	await stock.ensureOnDisk();
	await stock.close();
	const file = stock.getSessionFile()!;

	const participation = await inspectOriginalParticipation(place.ownershipDirectory, {
		originalFile: file,
		nativeId: stock.getSessionId(),
		recordedCwd: place.cwd,
		canonicalCwd: place.cwd,
		contentSha256: digestOf(file),
		fileIdentity: identityOf(file),
	});
	assert.equal(participation.ok, false);
	assert.equal(participation.reason, "not-enrolled");
	assert.ok(!existsSync(place.ownershipDirectory), "inspection must not create the ownership directory");
});

await check("a free sidecar does not confer participation on a stock original", async () => {
	const place = arena();
	const stock = SessionManager.create(place.cwd, place.sessionDirectory);
	stock.appendCustomEntry("stock", {});
	await stock.ensureOnDisk();
	await stock.close();
	const file = stock.getSessionFile()!;

	// Hand-build exactly the artefacts an attacker could leave lying around:
	// an unlocked sidecar and a header-shaped marker. Neither is an enrollment.
	mkdirSync(path.join(place.ownershipDirectory, "leases"), { recursive: true, mode: 0o700 });
	writeFileSync(path.join(place.ownershipDirectory, "leases", "free.lock"), "");
	const participation = await inspectOriginalParticipation(place.ownershipDirectory, {
		originalFile: file,
		nativeId: stock.getSessionId(),
		recordedCwd: place.cwd,
		canonicalCwd: place.cwd,
		contentSha256: digestOf(file),
		fileIdentity: identityOf(file),
	});
	assert.equal(participation.ok, false);
	assert.equal(participation.reason, "not-enrolled");
});

await check("a created original is enrolled, marked and owned before its first header", async () => {
	const place = arena();
	const { manager, binding } = await createCooperativeOriginal(place);
	try {
		assert.equal(binding.protocol, ORIGINAL_SESSION_OWNERSHIP_PROTOCOL);
		const ownershipView = manager.getOriginalOwnership();
		assert.equal(ownershipView.held, true);
		assert.equal(ownershipView.originalFile, binding.originalFile);
		assert.ok(
			existsSync(path.join(path.dirname(binding.originalFile), `.${path.basename(binding.originalFile)}.original-enrollment.json`)),
			"the durable enrollment marker must sit beside the transcript",
		);
		assert.equal(manager.getSessionId(), binding.nativeId);
		assert.equal(manager.getRecordedCwd(), binding.recordedCwd);
	} finally {
		manager.seal();
		await manager.close();
	}
});

// ---------------------------------------------------------------------------
// Real competing writers
// ---------------------------------------------------------------------------

await check("an active writer process rejects a second admission, then a release admits it", async () => {
	const { place, binding, source } = await seedOriginal();
	const request = await admissionRequestFile("active-writer", {
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source,
		commandId: "command-active-a",
	});

	const first = spawnActor(request);
	const ready = await first.next();
	assert.equal(ready.type, "ready");
	assert.equal(ready.nativeId, binding.nativeId);

	if (kernelNamedLocks) {
		assert.equal(readdirSync(path.join(place.ownershipDirectory, "leases")).length, 0,
			"kernel-name ownership must not be replaced with a fabricated filesystem sidecar");
	}
	// Same-process attempt.
	await expectRefusal(
		() => openAdmittedOriginal({ ownershipDirectory: place.ownershipDirectory, binding, source, commandId: "command-active-b" }),
		["active-writer"],
		"in-process admission while another process owns the original",
	);

	// Second real process.
	const second = spawnActor(request);
	const refused = await second.next();
	assert.equal(refused.type, "rejected");
	assert.equal(refused.code, "ORIGINAL_SESSION_NOT_SUBMITTED");
	assert.equal(refused.reason, "active-writer");
	assert.equal(await second.exited, 73);

	first.send({ type: "append", text: "under the first owner" });
	assert.equal((await first.next()).type, "appended");
	first.send({ type: "close" });
	assert.equal((await first.next()).type, "closed");
	await first.exited;

	// Released: the same original is admissible again, with its own identity.
	const refreshed = await observeEnrolledOriginal(place.ownershipDirectory, binding);
	const resumed = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source: refreshed,
		commandId: "command-active-c",
	});
	try {
		assert.equal(resumed.getSessionId(), binding.nativeId);
		assert.equal(path.resolve(resumed.getSessionFile()), binding.originalFile);
		assert.equal(path.resolve(resumed.getRecordedCwd()), binding.recordedCwd);
		assert.ok(
			resumed.getEntries().some((entry: { type: string }) => entry.type === "custom"),
			"the resumed original must retain the history written by the previous owner",
		);
	} finally {
		resumed.seal();
		await resumed.close();
	}
});

await check("a crashed owner's OS lock is released and the original is admissible again", async () => {
	const { place, binding, source } = await seedOriginal();
	const request = await admissionRequestFile("crash", {
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source,
		commandId: "command-crash-a",
	});
	const owner = spawnActor(request);
	assert.equal((await owner.next()).type, "ready");
	owner.kill();
	await owner.exited;

	const refreshed = await observeEnrolledOriginal(place.ownershipDirectory, binding);
	const successor = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source: refreshed,
		commandId: "command-crash-b",
	});
	try {
		assert.equal(successor.getSessionId(), binding.nativeId);
	} finally {
		successor.seal();
		await successor.close();
	}
});

await check("terminal close hands ownership back; seal alone does not", async () => {
	const { place, binding, source } = await seedOriginal();
	const manager = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source,
		commandId: "command-terminal",
	});
	manager.seal();
	assert.equal(manager.getOriginalOwnership().held, true, "seal must not release ownership");
	await manager.close();
	assert.equal(manager.getOriginalOwnership().held, false, "a drained terminal close releases the lease");

	const refreshed = await observeEnrolledOriginal(place.ownershipDirectory, binding);
	const successor = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source: refreshed,
		commandId: "command-terminal-successor",
	});
	successor.seal();
	await successor.close();
});

// ---------------------------------------------------------------------------
// Ordinary owned work, without any provider
// ---------------------------------------------------------------------------

await check("append and title persist under ownership with no provider involved", async () => {
	const { place, binding, source } = await seedOriginal();
	const manager = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source,
		commandId: "command-write",
	});
	try {
		manager.appendCustomEntry("owned-append", { index: 1 });
		manager.appendCustomEntry("owned-append", { index: 2 });
		await manager.setSessionName("owned title", "auto");
		await manager.flush();

		const content = readFileSync(binding.originalFile, "utf-8");
		assert.ok(content.includes("owned-append"), "owned appends must reach the transcript");
		assert.ok(content.includes("owned title"), "the owned title must reach the title slot");
		assert.equal(manager.getSessionId(), binding.nativeId);
		assert.equal(path.resolve(manager.getSessionFile()), binding.originalFile);
	} finally {
		manager.seal();
		await manager.close();
	}
	assert.equal(result.providerCalls, false);
});

await check("an unrelated unenrolled manager stays fully writable while a lease is held", async () => {
	const { place, binding, source } = await seedOriginal();
	const held = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source,
		commandId: "command-coexist",
	});
	try {
		const legacyPlace = arena();
		const legacy = SessionManager.create(legacyPlace.cwd, legacyPlace.sessionDirectory);
		legacy.appendCustomEntry("legacy", {});
		await legacy.ensureOnDisk();
		await legacy.setSessionName("legacy title", "auto");
		await legacy.flush();
		assert.equal(legacy.getOriginalOwnership(), undefined, "an app-owned manager must never look enrolled");
		// Its ordinary transitions are untouched by the regime.
		await legacy.newSession();
		await legacy.close();
	} finally {
		held.seal();
		await held.close();
	}
});

// ---------------------------------------------------------------------------
// Stale review material
// ---------------------------------------------------------------------------

await check("a stale identity, digest or missing file refuses before any writable open", async () => {
	const { place, binding, source } = await seedOriginal();

	// Stale identity: an outside append moves size/mtime/ctime.
	writeFileSync(binding.originalFile, `${readFileSync(binding.originalFile, "utf-8")}{"type":"custom","id":"x"}\n`);
	await expectRefusal(
		() => openAdmittedOriginal({ ownershipDirectory: place.ownershipDirectory, binding, source, commandId: "stale-identity" }),
		["identity-mismatch"],
		"admission with a stale reviewed identity",
	);

	// Stale digest with a current identity: the reviewed digest itself is wrong.
	const current = await observeEnrolledOriginal(place.ownershipDirectory, binding);
	await expectRefusal(
		() =>
			openAdmittedOriginal({
				ownershipDirectory: place.ownershipDirectory,
				binding,
				source: { ...current, contentSha256: "0".repeat(64) },
				commandId: "stale-digest",
			}),
		["digest-mismatch"],
		"admission with a stale reviewed digest",
	);

	// Missing file.
	rmSync(binding.originalFile);
	await expectRefusal(
		() =>
			openAdmittedOriginal({
				ownershipDirectory: place.ownershipDirectory,
				binding,
				source: current,
				commandId: "stale-missing",
			}),
		["original-missing"],
		"admission of a deleted original",
	);
});

await check("a retargeted recorded working directory refuses before any writable open", async () => {
	const { place, binding, source } = await seedOriginal();
	renameSync(place.cwd, `${place.cwd}-moved`);
	try {
		await expectRefusal(
			() => openAdmittedOriginal({ ownershipDirectory: place.ownershipDirectory, binding, source, commandId: "stale-cwd" }),
			["cwd-unusable", "cwd-mismatch"],
			"admission whose recorded working directory vanished",
		);
	} finally {
		renameSync(`${place.cwd}-moved`, place.cwd);
	}
});

await check("aliases of an enrolled original are refused", async () => {
	const { place, binding, source } = await seedOriginal();

	// A symlink at a different path is simply not the enrolled canonical file.
	const aliasPath = path.join(path.dirname(binding.originalFile), "alias.jsonl");
	symlinkSync(binding.originalFile, aliasPath);
	const aliasParticipation = await inspectOriginalParticipation(place.ownershipDirectory, { ...source, originalFile: aliasPath });
	assert.equal(aliasParticipation.ok, false);
	assert.ok(["duplicate-native-id", "not-enrolled"].includes(aliasParticipation.reason));

	// A hard link makes a second name alias the owned bytes without contending
	// for the sidecar, so the canonical path stops being a safe target.
	const linkPath = path.join(path.dirname(binding.originalFile), "hardlink.jsonl");
	linkSync(binding.originalFile, linkPath);
	try {
		await expectRefusal(
			() => openAdmittedOriginal({ ownershipDirectory: place.ownershipDirectory, binding, source, commandId: "alias" }),
			["unsafe-alias"],
			"admission of a hard-linked original",
		);
	} finally {
		rmSync(linkPath);
	}
});

await check("a duplicate native id pointing at another transcript is refused", async () => {
	const { place, binding, source } = await seedOriginal();
	// Copy the transcript and claim the SAME enrollment for the copy.
	const copyPath = path.join(path.dirname(binding.originalFile), "duplicate.jsonl");
	writeFileSync(copyPath, readFileSync(binding.originalFile));
	const fileKey = createHash("sha256")
		.update(`omp-original-session-ownership\u0000${ORIGINAL_SESSION_OWNERSHIP_PROTOCOL}\u0000file\u0000${copyPath}`)
		.digest("hex");
	writeFileSync(path.join(place.ownershipDirectory, "files", `${fileKey}.json`), JSON.stringify({ registryId: binding.registryId }));

	const participation = await inspectOriginalParticipation(place.ownershipDirectory, {
		...source,
		originalFile: copyPath,
		contentSha256: digestOf(copyPath),
		fileIdentity: identityOf(copyPath),
	});
	assert.equal(participation.ok, false);
	assert.equal(participation.reason, "duplicate-native-id");
});

// ---------------------------------------------------------------------------
// Unsupported transitions, refused before effects
// ---------------------------------------------------------------------------

await check("every unsupported transition refuses before touching the original", async () => {
	const { place, binding, source } = await seedOriginal();
	const manager = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source,
		commandId: "command-transitions",
	});
	const before = { digest: digestOf(binding.originalFile), identity: identityOf(binding.originalFile) };
	const elsewhere = arena();
	try {
		const attempts: Array<[string, () => Promise<unknown>]> = [
			["newSession", () => manager.newSession()],
			["fork", () => manager.fork()],
			["moveTo", () => manager.moveTo(elsewhere.cwd)],
			["persistCopy", () => manager.persistCopy()],
			["dropSession", () => manager.dropSession(binding.originalFile)],
			["setSessionFile", () => manager.setSessionFile(path.join(elsewhere.sessionDirectory, "other.jsonl"))],
			["createBranchedSession", async () => manager.createBranchedSession(manager.getLeafId())],
			["cloneCurrentSession", async () => manager.cloneCurrentSession()],
			["setCwdWithoutRelocation", async () => manager.setCwdWithoutRelocation(elsewhere.cwd)],
		];
		for (const [name, attempt] of attempts) {
			await expectRefusal(attempt, ["unsupported-transition"], `${name} on a cooperating original`);
		}
		assert.equal(digestOf(binding.originalFile), before.digest, "no refused transition may change the transcript");
		assert.deepEqual(identityOf(binding.originalFile), before.identity, "no refused transition may change file identity");
		assert.equal(manager.getSessionId(), binding.nativeId);
		assert.equal(path.resolve(manager.getSessionFile()), binding.originalFile);
	} finally {
		manager.seal();
		await manager.close();
	}
});

await check("an unmanaged patched open of an enrolled source refuses, in-process and cross-process", async () => {
	const { place, binding, source } = await seedOriginal();

	// Nobody holds the lease here: recognition must come from the durable
	// marker, not from process-local state.
	await expectRefusal(
		() => SessionManager.open(binding.originalFile),
		["enrolled-source-requires-admission"],
		"ordinary SessionManager.open of an enrolled source",
	);
	await expectRefusal(
		() => SessionManager.forkFrom(binding.originalFile, place.cwd, place.sessionDirectory),
		["enrolled-source-requires-admission"],
		"source-based forkFrom of an enrolled source",
	);

	// Same refusal from a separate process with no admitted context at all.
	const probe = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const { SessionManager } = await import(${JSON.stringify(path.join(packageRoot, "src/session/session-manager.ts"))});
			 try { await SessionManager.open(${JSON.stringify(binding.originalFile)}); console.log(JSON.stringify({ refused: false })); }
			 catch (error) { console.log(JSON.stringify({ refused: true, code: error.code, reason: error.reason })); }`,
		],
		{ cwd: root, env: { ...process.env }, stdout: "pipe", stderr: "inherit" },
	);
	const probed = JSON.parse((await new Response(probe.stdout).text()).trim());
	assert.equal(probed.refused, true, "a separate patched process must also refuse");
	assert.equal(probed.code, "ORIGINAL_SESSION_NOT_SUBMITTED");
	assert.equal(probed.reason, "enrolled-source-requires-admission");

	// And the admitted path still works afterwards.
	const admitted = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source,
		commandId: "command-after-probe",
	});
	admitted.seal();
	await admitted.close();
});

// ---------------------------------------------------------------------------
// Failure retains ownership
// ---------------------------------------------------------------------------

await check("a failed terminal drain retains ownership and keeps competitors out", async () => {
	if (process.getuid?.() === 0) {
		result.knownLimitations.push("Skipped the read-only-directory drain failure: running as root defeats the permission gate.");
		return;
	}
	const { place, binding, source } = await seedOriginal();
	const manager = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source,
		commandId: "command-drain-failure",
	});
	const sessionDirectory = path.dirname(binding.originalFile);
	let restored = false;
	try {
		// A genuinely unwritable directory: the atomic republish cannot stage
		// its temp file. No storage subclass, no injected error.
		chmodSync(sessionDirectory, 0o500);
		await assert.rejects(() => manager.rewriteEntries(), "the rewrite must fail against a read-only directory");

		manager.seal();
		await assert.rejects(() => manager.close(), "a close with a latched disk failure must throw");
		assert.equal(manager.getOriginalOwnership().held, true, "a failed terminal drain must retain ownership");

		chmodSync(sessionDirectory, 0o700);
		restored = true;

		const refreshed = await observeEnrolledOriginal(place.ownershipDirectory, binding);
		const request = await admissionRequestFile("drain-failure", {
			ownershipDirectory: place.ownershipDirectory,
			binding,
			source: refreshed,
			commandId: "command-drain-competitor",
		});
		const competitor = spawnActor(request);
		const refused = await competitor.next();
		assert.equal(refused.type, "rejected");
		assert.equal(refused.reason, "active-writer", "retained ownership must keep a real competing process out");
		await competitor.exited;
	} finally {
		if (!restored) chmodSync(sessionDirectory, 0o700);
	}
});

// ---------------------------------------------------------------------------
// Readonly helpers stay readonly
// ---------------------------------------------------------------------------

await check("inspection and observation never mutate the original", async () => {
	const { place, binding, source } = await seedOriginal();
	const before = identityOf(binding.originalFile);
	const participation = await inspectOriginalParticipation(place.ownershipDirectory, source);
	assert.equal(participation.ok, true);
	assert.equal(participation.binding.enrollmentId, binding.enrollmentId);
	const observed = await observeEnrolledOriginal(place.ownershipDirectory, binding);
	assert.equal(observed.nativeId, binding.nativeId);
	assert.equal(observed.contentSha256, source.contentSha256);
	assert.deepEqual(identityOf(binding.originalFile), before, "readonly helpers must not touch the transcript");
});

await check("a directory scan never restores an orphaned backup onto an enrolled original", async () => {
	const { place, binding } = await seedOriginal();
	// The transcript is gone and a plausible `.bak` sits beside it. A stock scan
	// would promote the backup back onto the primary path; that would be a
	// native file effect on an enrolled source with nobody holding its lease.
	const backup = `${binding.originalFile}.1.bak`;
	writeFileSync(backup, readFileSync(binding.originalFile));
	rmSync(binding.originalFile);

	await SessionManager.list(place.cwd, path.dirname(binding.originalFile));
	assert.ok(!existsSync(binding.originalFile), "the enrolled path must not be repopulated by a scan");
	assert.ok(existsSync(backup), "the backup is left in place for inspection, never consumed");
});

// ---------------------------------------------------------------------------
// High-level AgentSession refusals, against a real SDK session
// ---------------------------------------------------------------------------

await check("a real AgentSession refuses switch, move and fork on an admitted original", async () => {
	// Runtime-selected: these live in the freshly patched disposable copy.
	const { Agent } = await import("@oh-my-pi/pi-agent-core");
	const { Database } = await import("bun:sqlite");
	const { AgentSession } = await import(path.join(packageRoot, "src/session/agent-session.ts"));
	const { AuthStorage, SqliteAuthCredentialStore } = await import(path.join(packageRoot, "src/session/auth-storage.ts"));
	const { ModelRegistry } = await import(path.join(packageRoot, "src/config/model-registry.ts"));
	const { Settings } = await import(path.join(packageRoot, "src/config/settings.ts"));
	const { bindPreparedExtensions } = await import(path.join(packageRoot, "src/extensibility/extensions/loader.ts"));
	const { ExtensionRunner } = await import(path.join(packageRoot, "src/extensibility/extensions/runner.ts"));

	const { place, binding, source } = await seedOriginal();
	const sessionManager = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory,
		binding,
		source,
		commandId: "command-agent-session",
	});

	// No credentials are seeded or loaded from a retained profile; the bundled
	// catalog model is never prompted.
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.getAll()[0];
	assert.ok(model, "the bundled catalog must offer a model to construct an agent with");
	const settings = await Settings.init({ cwd: place.cwd });
	const hookEvents: string[] = [];
	const loaded = await bindPreparedExtensions([{
		path: "<original-admission-hook>", resolvedPath: "<original-admission-hook>", error: null,
		factory: (api: { on: (event: string, handler: (event: { reason: string }) => { cancel: boolean }) => void }) => {
			api.on("session_before_switch", event => { hookEvents.push(event.reason); return { cancel: true }; });
		},
	}], place.cwd);
	assert.deepEqual(loaded.errors, []);
	const extensionRunner = new ExtensionRunner(loaded.extensions, loaded.runtime, place.cwd, sessionManager, modelRegistry, undefined, settings);
	assert.deepEqual(await extensionRunner.emit({ type: "session_before_switch", reason: "resume", targetSessionFile: binding.originalFile }), { cancel: true });
	assert.deepEqual(hookEvents, ["resume"], "the real registered handler must be callable before testing non-entry");
	hookEvents.length = 0;
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
		sessionManager,
		settings,
		modelRegistry,
		extensionRunner,
	});

	const elsewhere = arena();
	const destinationFile = path.join(elsewhere.sessionDirectory, "destination.jsonl");
	const before = { digest: digestOf(binding.originalFile), identity: identityOf(binding.originalFile) };
	const sourceDirBefore = new Set(readdirSync(path.dirname(binding.originalFile)));
	try {
		// The live cancelling extension must not be invoked: original ownership
		// refusal wins before the hook or any source/destination effect.
		await expectRefusal(
			() => session.switchSession(destinationFile),
			["unsupported-transition"],
			"AgentSession.switchSession on a cooperating original",
		);
		await expectRefusal(
			() => session.moveSession(elsewhere.cwd),
			["unsupported-transition"],
			"AgentSession.moveSession on a cooperating original",
		);
		await expectRefusal(() => session.fork(), ["unsupported-transition"], "AgentSession.fork on a cooperating original");
		assert.deepEqual(hookEvents, [], "unsupported original transitions must refuse before a registered hook runs");

		assert.equal(digestOf(binding.originalFile), before.digest, "no high-level refusal may change the original");
		assert.deepEqual(identityOf(binding.originalFile), before.identity, "no high-level refusal may change file identity");
		assert.deepEqual(
			new Set(readdirSync(path.dirname(binding.originalFile))),
			sourceDirBefore,
			"no high-level refusal may mint a sibling transcript",
		);
		assert.ok(!existsSync(destinationFile), "the switch destination must never be created");
		assert.deepEqual(readdirSync(elsewhere.sessionDirectory), [], "the move/fork destination directory must stay empty");
		assert.equal(sessionManager.getSessionId(), binding.nativeId);
		assert.equal(path.resolve(sessionManager.getSessionFile()), binding.originalFile);
		assert.equal(sessionManager.getOriginalOwnership().held, true, "a refused high-level transition retains ownership");
	} finally {
		sessionManager.seal();
		await sessionManager.close();
	}
});

await check("a replaced filesystem lock sidecar refuses an already-open writer", async () => {
	const { place, binding, source } = await seedOriginal();
	const manager = await openAdmittedOriginal({
		ownershipDirectory: place.ownershipDirectory, binding, source, commandId: "sidecar-replacement",
	});
	manager.appendCustomEntry("warm-writer", { persisted: true });
	await manager.flush();
	const before = { digest: digestOf(binding.originalFile), identity: identityOf(binding.originalFile) };
	const lockPath = manager.getOriginalOwnership().lockPath;
	const heldPath = `${lockPath}.held`;
	const heldIdentity = identityOf(lockPath);
	let replaced = false, refused = false;
	try {
		renameSync(lockPath, heldPath);
		replaced = true;
		writeFileSync(lockPath, "replacement inode\n", { flag: "wx", mode: 0o600 });
		assert.notEqual(lstatSync(lockPath).ino, heldIdentity.ino);
		await expectRefusal(async () => {
			manager.appendCustomEntry("must-not-persist", { afterReplacement: true });
			await manager.flush();
		}, ["sidecar-retargeted"], "append through a writer opened before lock-sidecar replacement");
		refused = true;
		assert.equal(digestOf(binding.originalFile), before.digest);
		assert.deepEqual(identityOf(binding.originalFile), before.identity);
		assert.equal(manager.getOriginalOwnership().held, true, "the original kernel lock is still held");
	} finally {
		if (replaced) {
			rmSync(lockPath, { force: true });
			renameSync(heldPath, lockPath);
		}
		manager.seal();
		if (refused) {
			await assert.rejects(() => manager.close(), "the refused append latches a real persistence failure");
			assert.equal(manager.getOriginalOwnership().held, true, "failed drain must not optimistically release ownership");
		} else {
			await manager.close();
		}
	}
}, kernelNamedLocks ? "The pinned backend owns a kernel name, not a filesystem sidecar." : undefined);

result.knownLimitations.push(
	`This run is ${process.platform}/${process.arch}. Only the listed executed checks establish coverage; skipped checks and other platforms are not inferred.`,
	"AgentSession switch/move/fork refusals are driven against a real SDK session under an empty disposable config with an in-memory credential store. newSession/branch/branchFromBtw delegate to the same guard but are exercised only at the SessionManager level.",
	"High-level switch/move/fork refusals precede a real registered session_before_switch handler; the handler is first invoked directly to prove it is live.",
	"Establishes nothing about unpatched stock programs, direct FileSessionStorage/openWriter writers, non-file storage backends, in-memory replication, or an outside actor deleting the enrollment marker.",
	"digest-mismatch is proven with a source whose reviewed digest is wrong; a content change that leaves every stat field identical is not producible portably, so that path is covered by construction rather than by mutation.",
	"No provider turn or retained profile/credential access is performed. Native file/identity/ownership evidence uses disposable settings and an empty in-memory credential store.",
);

result.passed = result.checks.filter(entry => entry.status === "passed").length;
result.failed = result.checks.filter(entry => entry.status === "failed").length;
result.skipped = result.checks.filter(entry => entry.status === "skipped").length;
if (selectedCheck && result.checks.length === 0) throw new Error(`Unknown native admission check: ${selectedCheck}`);
await mkdir(path.dirname(output), { recursive: true });
await save();
console.log(JSON.stringify({ output, passed: result.passed, failed: result.failed, skipped: result.skipped }, null, 2));
process.exitCode = result.failed ? 1 : 0;
