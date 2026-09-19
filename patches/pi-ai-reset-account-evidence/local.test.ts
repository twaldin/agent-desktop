/**
 * Reset-account evidence: SQLite backend contract.
 *
 * Exercises the durable (namespace, row incarnation) binding through the
 * public AuthStorage / SqliteAuthCredentialStore surface on fresh temp
 * databases. Nothing here touches provider, broker, or profile state.
 *
 * `PI_AI_EVIDENCE_PACKAGE` (absolute package root) selects the pi-ai package
 * under test; defaults to the installed `@oh-my-pi/pi-ai`.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as AuthStorageModule from "@oh-my-pi/pi-ai/auth-storage";
import type { AuthCredential, OAuthCredential, ResetAccountEvidence } from "@oh-my-pi/pi-ai/auth-storage";
import type * as SqliteStoreModule from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";

const packageRoot = path.resolve(
	import.meta.dir,
	process.env.PI_AI_EVIDENCE_PACKAGE ?? "../../node_modules/@oh-my-pi/pi-ai",
);

type EvidenceModule = {
	sameResetAccountEvidence(a: ResetAccountEvidence | undefined, b: ResetAccountEvidence | undefined): boolean;
	matchesResetAccountCredential(
		evidence: ResetAccountEvidence | undefined,
		provider: string,
		credentialId: number,
		credential: AuthCredential,
	): boolean;
};

// Dynamic imports: the package under test is runtime-selected (authored
// checkout vs installed copy) via PI_AI_EVIDENCE_PACKAGE.
const authStorageModule = (await import(
	pathToFileURL(path.join(packageRoot, "src/auth-storage.ts")).href
)) as typeof AuthStorageModule;
const sqliteStoreModule = (await import(
	pathToFileURL(path.join(packageRoot, "src/auth/sqlite-credential-store.ts")).href
)) as typeof SqliteStoreModule;
const evidenceModule = (await import(
	pathToFileURL(path.join(packageRoot, "src/auth/reset-account-evidence.ts")).href
)) as EvidenceModule;
const { AuthStorage } = authStorageModule;
const { SqliteAuthCredentialStore, serializeCredential } = sqliteStoreModule;
const { sameResetAccountEvidence, matchesResetAccountCredential } = evidenceModule;
const PROVIDER = "evidence-provider";
const OTHER_PROVIDER = "evidence-other-provider";

function oauth(access: string, overrides: Partial<Omit<OAuthCredential, "type">> = {}): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh: `refresh-${access}`,
		expires: 4_102_444_800_000,
		accountId: "acct-001",
		email: "user@example.com",
		...overrides,
	};
}

type Opened = {
	store: InstanceType<typeof SqliteAuthCredentialStore>;
	storage: InstanceType<typeof AuthStorage>;
	evidence(credentialId: number, provider?: string): ResetAccountEvidence | undefined;
	close(): void;
};

async function open(dbPath: string): Promise<Opened> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	const storage = new AuthStorage(store);
	await storage.reload();
	return {
		store,
		storage,
		evidence: (credentialId, provider = PROVIDER) => storage.getResetAccountEvidence(provider, credentialId),
		close: () => storage.close(),
	};
}

function requireEvidence(evidence: ResetAccountEvidence | undefined): ResetAccountEvidence {
	expect(evidence).toBeDefined();
	return evidence as ResetAccountEvidence;
}

let root: string;
let counter = 0;
const opened: Opened[] = [];

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-ai-reset-evidence-"));
});
afterAll(async () => {
	for (const handle of opened.splice(0)) {
		try {
			handle.close();
		} catch {
			// Already closed by the test.
		}
	}
	await rm(root, { recursive: true, force: true });
});

function freshPath(label: string): string {
	counter += 1;
	return path.join(root, `${label}-${counter}.sqlite`);
}

async function openFresh(label: string): Promise<{ dbPath: string; handle: Opened }> {
	const dbPath = freshPath(label);
	const handle = await open(dbPath);
	opened.push(handle);
	return { dbPath, handle };
}

/** First active row id for the provider after an upsert. */
function upsertOne(handle: Opened, credential: AuthCredential, provider = PROVIDER): number {
	const rows = handle.storage.upsertCredential(provider, credential);
	expect(rows.length).toBe(1);
	return rows[0]!.id;
}

describe("reset-account evidence: namespace", () => {
	test("independent databases with colliding row ids yield distinct proofs", async () => {
		const a = await openFresh("collide-a");
		const b = await openFresh("collide-b");
		const credential = oauth("token-a");
		const idA = upsertOne(a.handle, credential);
		const idB = upsertOne(b.handle, credential);
		expect(idA).toBe(idB);

		const proofA = requireEvidence(a.handle.evidence(idA));
		const proofB = requireEvidence(b.handle.evidence(idB));
		expect(proofA.credentialId).toBe(idA);
		expect(proofB.credentialId).toBe(idB);
		expect(proofA.authAuthority).not.toBe(proofB.authAuthority);
		expect(proofA.credentialFingerprint).not.toBe(proofB.credentialFingerprint);
		expect(sameResetAccountEvidence(proofA, proofB)).toBe(false);
		expect(matchesResetAccountCredential(proofA, PROVIDER, idA, credential)).toBe(true);
		expect(matchesResetAccountCredential(proofB, PROVIDER, idB, credential)).toBe(true);
	});

	test("proofs carry no bearer material", async () => {
		const { handle } = await openFresh("secret-free");
		const credential = oauth("very-secret-access-token", { refresh: "very-secret-refresh-token" });
		const id = upsertOne(handle, credential);
		const serialized = JSON.stringify(requireEvidence(handle.evidence(id)));
		expect(serialized).not.toContain("very-secret-access-token");
		expect(serialized).not.toContain("very-secret-refresh-token");
	});

	test("a second handle and a reopen on the same file agree", async () => {
		const { dbPath, handle } = await openFresh("reopen");
		const id = upsertOne(handle, oauth("token-1"));
		const first = requireEvidence(handle.evidence(id));

		const second = await open(dbPath);
		opened.push(second);
		expect(sameResetAccountEvidence(first, second.evidence(id))).toBe(true);
		expect(sameResetAccountEvidence(first, second.store.getResetAccountEvidence(PROVIDER, id))).toBe(true);

		handle.close();
		second.close();
		const reopened = await open(dbPath);
		opened.push(reopened);
		expect(sameResetAccountEvidence(first, reopened.evidence(id))).toBe(true);

		// A steady-state open must not re-mint anything: a third open still agrees.
		reopened.close();
		const again = await open(dbPath);
		opened.push(again);
		expect(sameResetAccountEvidence(first, again.evidence(id))).toBe(true);
	});

	test("a byte-for-byte copy of the database is a different namespace", async () => {
		const { dbPath, handle } = await openFresh("clone-src");
		const id = upsertOne(handle, oauth("token-1"));
		const original = requireEvidence(handle.evidence(id));
		handle.close();

		const clonePath = freshPath("clone-dst");
		await copyFile(dbPath, clonePath);
		const clone = await open(clonePath);
		opened.push(clone);
		const cloned = requireEvidence(clone.evidence(id));
		expect(cloned.credentialId).toBe(id);
		expect(cloned.authAuthority).not.toBe(original.authAuthority);
		expect(sameResetAccountEvidence(original, cloned)).toBe(false);

		// The source file, reopened, still owns its original namespace.
		const source = await open(dbPath);
		opened.push(source);
		expect(sameResetAccountEvidence(original, source.evidence(id))).toBe(true);
	});

	test("a database restored under a new path is a different namespace", async () => {
		const { dbPath, handle } = await openFresh("restore-src");
		const id = upsertOne(handle, oauth("token-1"));
		const original = requireEvidence(handle.evidence(id));
		handle.close();

		const restoredPath = freshPath("restore-dst");
		await rename(dbPath, restoredPath);
		const restored = await open(restoredPath);
		opened.push(restored);
		expect(sameResetAccountEvidence(original, restored.evidence(id))).toBe(false);
	});
});

describe("reset-account evidence: lookup boundaries", () => {
	test("lookup is exact on provider and id, and excludes non-OAuth rows", async () => {
		const { handle } = await openFresh("exact");
		const id = upsertOne(handle, oauth("token-1"));
		const apiKeyId = upsertOne(handle, { type: "api_key", key: "sk-test" }, OTHER_PROVIDER);

		expect(handle.evidence(id)).toBeDefined();
		expect(handle.evidence(id, OTHER_PROVIDER)).toBeUndefined();
		expect(handle.store.getResetAccountEvidence(OTHER_PROVIDER, id)).toBeUndefined();
		expect(handle.store.getResetAccountEvidence(PROVIDER, id + 1000)).toBeUndefined();
		expect(handle.store.getResetAccountEvidence(PROVIDER, 0)).toBeUndefined();
		expect(handle.store.getResetAccountEvidence(PROVIDER, -1)).toBeUndefined();
		expect(handle.store.getResetAccountEvidence(PROVIDER, 1.5)).toBeUndefined();
		expect(handle.store.getResetAccountEvidence("", id)).toBeUndefined();
		expect(handle.evidence(apiKeyId, OTHER_PROVIDER)).toBeUndefined();
	});

	test("rows without an account identity carry no evidence", async () => {
		const { handle } = await openFresh("unresolved");
		const id = upsertOne(handle, oauth("token-1", { accountId: undefined, email: undefined }));
		expect(handle.evidence(id)).toBeUndefined();
		expect(handle.store.listAuthCredentials(PROVIDER)[0]?.resetAccountEvidence).toBeUndefined();
	});

	test("store results carry the same-snapshot proof", async () => {
		const { handle } = await openFresh("snapshot");
		const credential = oauth("token-1");
		const upserted = handle.store.upsertAuthCredentialForProvider(PROVIDER, credential);
		expect(upserted.length).toBe(1);
		const id = upserted[0]!.id;
		const snapshot = requireEvidence(upserted[0]!.resetAccountEvidence);
		expect(sameResetAccountEvidence(snapshot, handle.store.getResetAccountEvidence(PROVIDER, id))).toBe(true);
		expect(sameResetAccountEvidence(snapshot, handle.store.listAuthCredentials(PROVIDER)[0]?.resetAccountEvidence)).toBe(
			true,
		);

		const replaced = handle.store.replaceAuthCredentialsForProvider(PROVIDER, [oauth("token-2")]);
		expect(replaced.length).toBe(1);
		expect(replaced[0]!.id).toBe(id);
		const replacedProof = requireEvidence(replaced[0]!.resetAccountEvidence);
		expect(sameResetAccountEvidence(replacedProof, handle.store.getResetAccountEvidence(PROVIDER, id))).toBe(true);
		expect(sameResetAccountEvidence(snapshot, replacedProof)).toBe(false);
	});
});

describe("reset-account evidence: incarnation lifecycle", () => {
	test("token-only refresh preserves the binding", async () => {
		const { handle } = await openFresh("refresh");
		const initial = oauth("token-1");
		const id = upsertOne(handle, initial);
		const pinned = requireEvidence(handle.evidence(id));

		const refreshedOnce = oauth("token-2", { expires: initial.expires + 60_000 });
		handle.store.updateAuthCredential(id, refreshedOnce);
		await handle.storage.reload();
		expect(sameResetAccountEvidence(pinned, handle.evidence(id))).toBe(true);
		expect(matchesResetAccountCredential(pinned, PROVIDER, id, refreshedOnce)).toBe(true);

		const refreshedTwice = oauth("token-3", { expires: initial.expires + 120_000 });
		const expected = serializeCredential(PROVIDER, refreshedOnce);
		expect(expected).not.toBeNull();
		expect(handle.store.tryUpdateAuthCredentialIfMatches(id, expected!.data, refreshedTwice)).toBe(true);
		await handle.storage.reload();
		expect(sameResetAccountEvidence(pinned, handle.evidence(id))).toBe(true);
		expect(sameResetAccountEvidence(pinned, handle.store.getResetAccountEvidence(PROVIDER, id))).toBe(true);

		// Cosmetic org name is not account scope.
		handle.store.updateAuthCredential(id, oauth("token-4", { orgName: "Renamed Workspace" }));
		await handle.storage.reload();
		expect(sameResetAccountEvidence(pinned, handle.evidence(id))).toBe(true);
	});

	test("a refresh that moves account scope invalidates the pinned proof", async () => {
		const { handle } = await openFresh("scope-change");
		const initial = oauth("token-1");
		const id = upsertOne(handle, initial);
		const pinned = requireEvidence(handle.evidence(id));

		const moved = oauth("token-2", { orgId: "org-b" });
		const expected = serializeCredential(PROVIDER, initial);
		expect(handle.store.tryUpdateAuthCredentialIfMatches(id, expected!.data, moved)).toBe(true);
		// The in-memory row still holds the pre-move proof; the backend no longer agrees.
		expect(handle.evidence(id)).toBeUndefined();
		const current = requireEvidence(handle.store.getResetAccountEvidence(PROVIDER, id));
		expect(sameResetAccountEvidence(pinned, current)).toBe(false);
		expect(matchesResetAccountCredential(pinned, PROVIDER, id, moved)).toBe(false);
		expect(matchesResetAccountCredential(current, PROVIDER, id, moved)).toBe(true);

		await handle.storage.reload();
		expect(sameResetAccountEvidence(current, handle.evidence(id))).toBe(true);

		const remailed = oauth("token-3", { orgId: "org-b", email: "other@example.com" });
		handle.store.updateAuthCredential(id, remailed);
		expect(sameResetAccountEvidence(current, handle.store.getResetAccountEvidence(PROVIDER, id))).toBe(false);
	});

	test("explicit same-account upsert and replacement rotate the binding", async () => {
		const { handle } = await openFresh("relink");
		const credential = oauth("token-1");
		const id = upsertOne(handle, credential);
		const first = requireEvidence(handle.evidence(id));

		expect(upsertOne(handle, oauth("token-2"))).toBe(id);
		const afterUpsert = requireEvidence(handle.evidence(id));
		expect(sameResetAccountEvidence(first, afterUpsert)).toBe(false);
		expect(matchesResetAccountCredential(afterUpsert, PROVIDER, id, credential)).toBe(true);

		await handle.storage.set(PROVIDER, oauth("token-3"));
		const rows = handle.storage.listStoredCredentials(PROVIDER);
		expect(rows.map(row => row.id)).toEqual([id]);
		const afterReplace = requireEvidence(handle.evidence(id));
		expect(sameResetAccountEvidence(afterUpsert, afterReplace)).toBe(false);
		expect(sameResetAccountEvidence(first, afterReplace)).toBe(false);

		// Byte-identical re-login is still an explicit relink, not a refresh.
		expect(upsertOne(handle, oauth("token-3"))).toBe(id);
		expect(sameResetAccountEvidence(afterReplace, handle.evidence(id))).toBe(false);
	});

	test("removal invalidates; the account's replacement row is a new binding", async () => {
		const { handle } = await openFresh("remove");
		const id = upsertOne(handle, oauth("token-1"));
		const pinned = requireEvidence(handle.evidence(id));

		expect(await handle.storage.removeCredential(PROVIDER, id)).toBe(true);
		expect(handle.evidence(id)).toBeUndefined();
		expect(handle.store.getResetAccountEvidence(PROVIDER, id)).toBeUndefined();

		const replacementId = upsertOne(handle, oauth("token-2"));
		const replacement = requireEvidence(handle.evidence(replacementId));
		expect(sameResetAccountEvidence(pinned, replacement)).toBe(false);
		expect(sameResetAccountEvidence(pinned, handle.store.getResetAccountEvidence(PROVIDER, id))).toBe(false);
	});

	test("provider-wide removal invalidates every row", async () => {
		const { handle } = await openFresh("remove-provider");
		const id = upsertOne(handle, oauth("token-1"));
		expect(handle.evidence(id)).toBeDefined();
		await handle.storage.remove(PROVIDER);
		expect(handle.evidence(id)).toBeUndefined();
		expect(handle.store.getResetAccountEvidence(PROVIDER, id)).toBeUndefined();
	});

	test("a peer handle's scope change is seen by the pinned handle", async () => {
		const { dbPath, handle } = await openFresh("peer");
		const initial = oauth("token-1");
		const id = upsertOne(handle, initial);
		const pinned = requireEvidence(handle.evidence(id));

		const peer = await open(dbPath);
		opened.push(peer);
		peer.store.updateAuthCredential(id, oauth("token-2"));
		expect(sameResetAccountEvidence(pinned, handle.evidence(id))).toBe(true);

		peer.store.updateAuthCredential(id, oauth("token-3", { projectId: "proj-9" }));
		expect(handle.evidence(id)).toBeUndefined();
		expect(sameResetAccountEvidence(pinned, handle.store.getResetAccountEvidence(PROVIDER, id))).toBe(false);
	});
});

describe("reset-account evidence: writers outside the native store", () => {
	test("unclassified legacy writes, scope updates, disable, and re-enable invalidate pinned proof", async () => {
		const { dbPath, handle } = await openFresh("legacy-update");
		const id = upsertOne(handle, oauth("token-1"));
		const pinned = requireEvidence(handle.evidence(id));

		const raw = new Database(dbPath);
		try {
			raw.query("UPDATE auth_credentials SET data = json_set(data, '$.access', 'rotated-by-legacy') WHERE id = ?").run(id);
			expect(handle.evidence(id)).toBeUndefined();
			await handle.storage.reload();
			const legacyRelinked = requireEvidence(handle.evidence(id));
			expect(legacyRelinked.accountId).toBe(pinned.accountId);
			expect(sameResetAccountEvidence(pinned, legacyRelinked)).toBe(false);

			raw.query("UPDATE auth_credentials SET data = json_set(data, '$.accountId', 'acct-legacy') WHERE id = ?").run(id);
			expect(handle.evidence(id)).toBeUndefined();
			await handle.storage.reload();
			const moved = requireEvidence(handle.evidence(id));
			expect(sameResetAccountEvidence(pinned, moved)).toBe(false);
			expect(moved.accountId).toBe("acct-legacy");

			raw.query("UPDATE auth_credentials SET disabled_cause = 'legacy disable' WHERE id = ?").run(id);
			expect(handle.store.getResetAccountEvidence(PROVIDER, id)).toBeUndefined();

			raw.query("UPDATE auth_credentials SET disabled_cause = NULL WHERE id = ?").run(id);
			await handle.storage.reload();
			const reenabled = requireEvidence(handle.evidence(id));
			expect(sameResetAccountEvidence(moved, reenabled)).toBe(false);
			expect(sameResetAccountEvidence(pinned, reenabled)).toBe(false);
		} finally {
			raw.close();
		}
	});

	test("a row recreated under the same id, even as a full copy, cannot inherit the old proof", async () => {
		const { dbPath, handle } = await openFresh("legacy-recreate");
		const id = upsertOne(handle, oauth("token-1"));
		const pinned = requireEvidence(handle.evidence(id));

		const raw = new Database(dbPath);
		try {
			raw.query("CREATE TEMP TABLE kept AS SELECT * FROM auth_credentials WHERE id = ?").run(id);
			raw.query("DELETE FROM auth_credentials WHERE id = ?").run(id);
			expect(handle.store.getResetAccountEvidence(PROVIDER, id)).toBeUndefined();
			raw.run("INSERT INTO auth_credentials SELECT * FROM kept");
		} finally {
			raw.close();
		}
		await handle.storage.reload();
		const recreated = requireEvidence(handle.evidence(id));
		expect(recreated.credentialId).toBe(id);
		expect(sameResetAccountEvidence(pinned, recreated)).toBe(false);
	});

	test("a primary-key move away and back cannot restore a pinned incarnation", async () => {
		const { dbPath, handle } = await openFresh("primary-key-aba");
		const id = upsertOne(handle, oauth("token-1"));
		const pinned = requireEvidence(handle.evidence(id));
		const raw = new Database(dbPath);
		try {
			raw.transaction(() => {
				raw.query("UPDATE auth_credentials SET id = ? WHERE id = ?").run(id + 100, id);
				raw.query("UPDATE auth_credentials SET id = ? WHERE id = ?").run(id, id + 100);
			})();
		} finally {
			raw.close();
		}
		expect(handle.evidence(id)).toBeUndefined();
		await handle.storage.reload();
		expect(sameResetAccountEvidence(pinned, requireEvidence(handle.evidence(id)))).toBe(false);
	});
});

describe("reset-account evidence: migration from older schemas", () => {
	const credentialData = (credential: OAuthCredential): string => {
		const { type: _type, ...rest } = credential;
		return JSON.stringify(rest);
	};

	/** Hand-built fixture in the shape an older pi-ai wrote, without any evidence objects. */
	function writeLegacyFixture(dbPath: string, version: 3 | 7): void {
		const db = new Database(dbPath);
		try {
			db.run(`
				CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					identity_key TEXT DEFAULT NULL,
					created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
					updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
				);
			`);
			db.query("INSERT INTO auth_schema_version (id, version) VALUES (1, ?)").run(version);
			if (version === 7) {
				db.run(`
					CREATE TABLE auth_credential_blocks (
						credential_id INTEGER NOT NULL,
						provider_key TEXT NOT NULL,
						block_scope TEXT NOT NULL DEFAULT '',
						blocked_until_ms INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						PRIMARY KEY (credential_id, provider_key, block_scope)
					);
					CREATE TABLE auth_credential_refresh_leases (
						credential_id INTEGER PRIMARY KEY,
						owner TEXT NOT NULL,
						expires_at_ms INTEGER NOT NULL,
						updated_at INTEGER NOT NULL
					);
					CREATE TABLE auth_change_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
					INSERT INTO auth_change_revision (id, revision) VALUES (1, 41);
				`);
			}
			const insert = db.prepare(
				"INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key) VALUES (?, ?, ?, ?, ?, ?)",
			);
			insert.run(1, PROVIDER, "oauth", credentialData(oauth("legacy-1")), null, "account:acct-001");
			insert.run(2, PROVIDER, "api_key", JSON.stringify({ key: "sk-legacy" }), null, null);
			insert.run(3, PROVIDER, "oauth", credentialData(oauth("legacy-3", { accountId: "acct-003" })), "disabled by user", null);
			insert.run(4, PROVIDER, "oauth", credentialData(oauth("legacy-4", { accountId: undefined, email: undefined })), null, null);
			insert.run(5, OTHER_PROVIDER, "oauth", credentialData(oauth("legacy-5", { accountId: "acct-005", email: "five@example.com" })), null, null);
			insert.finalize();
		} finally {
			db.close();
		}
	}

	for (const version of [3, 7] as const) {
		test(`schema v${version} fixture gains stable evidence on first open`, async () => {
			const dbPath = freshPath(`legacy-v${version}`);
			writeLegacyFixture(dbPath, version);

			const first = await open(dbPath);
			opened.push(first);
			const proof1 = requireEvidence(first.evidence(1));
			expect(proof1.credentialId).toBe(1);
			expect(proof1.accountId).toBe("acct-001");
			expect(first.evidence(2)).toBeUndefined();
			expect(first.evidence(3)).toBeUndefined();
			expect(first.store.getResetAccountEvidence(PROVIDER, 3)).toBeUndefined();
			expect(first.evidence(4)).toBeUndefined();
			const proof5 = requireEvidence(first.evidence(5, OTHER_PROVIDER));
			expect(first.evidence(5)).toBeUndefined();
			expect(proof5.authAuthority).toBe(proof1.authAuthority);
			expect(proof5.credentialFingerprint).not.toBe(proof1.credentialFingerprint);
			first.close();

			const second = await open(dbPath);
			opened.push(second);
			expect(sameResetAccountEvidence(proof1, second.evidence(1))).toBe(true);
			expect(sameResetAccountEvidence(proof5, second.evidence(5, OTHER_PROVIDER))).toBe(true);

			// Migrated rows behave like native rows afterwards.
			second.store.updateAuthCredential(1, oauth("legacy-1-refreshed"));
			await second.storage.reload();
			expect(sameResetAccountEvidence(proof1, second.evidence(1))).toBe(true);
			// Row 4 (no account identity) stays active alongside row 1, so the
			// upsert returns both; only row 1 is the relinked account.
			const relogin = second.storage.upsertCredential(PROVIDER, oauth("legacy-1-relogin"));
			expect(relogin.map(row => row.id)).toContain(1);
			expect(sameResetAccountEvidence(proof1, second.evidence(1))).toBe(false);
			expect(matchesResetAccountCredential(second.evidence(1), PROVIDER, 1, oauth("legacy-1-relogin"))).toBe(true);
		});
	}
});
