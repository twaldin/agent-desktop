/**
 * Shared harness for the per-session credential-selection fence fixtures.
 *
 * Everything runs in-process against disposable temp SQLite stores through the
 * public native AuthStorage surface; token refreshes are injected through the
 * public `refreshOAuthCredential` option. No provider, broker, credit, or
 * profile traffic.
 *
 * - `PI_AI_SELECTION_PACKAGE` (absolute package root) selects the pi-ai package
 *   under test; defaults to the checkout's installed `@oh-my-pi/pi-ai`.
 * - `PI_AI_SELECTION_LEGACY_OBSERVER=1` swaps the observer used by the shared
 *   A->B->A scenario for the pre-fence public guard (generation + active durable
 *   row + credential evidence). That comparator documents the old blind spot; it
 *   is a test-only baseline and never a production fallback. Modern-only suites
 *   skip under the legacy comparator so its run reports exactly the blind spot.
 */
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as AuthStorageModule from "@oh-my-pi/pi-ai/auth-storage";
import type {
	AuthCredential,
	AuthStorage,
	AuthStorageOptions,
	OAuthCredential,
	ResetAccountEvidence,
	SessionCredentialSelectionObservation,
} from "@oh-my-pi/pi-ai/auth-storage";
import type * as SqliteStoreModule from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";

export const packageRoot = path.resolve(
	import.meta.dir,
	process.env.PI_AI_SELECTION_PACKAGE ?? "../../node_modules/@oh-my-pi/pi-ai",
);

type EvidenceModule = {
	sameResetAccountEvidence(a: ResetAccountEvidence | undefined, b: ResetAccountEvidence | undefined): boolean;
};

// Dynamic imports: the package under test is runtime-selected (authored
// checkout vs. installed copy), which a static specifier cannot express.
const load = <T>(relative: string): Promise<T> =>
	import(pathToFileURL(path.join(packageRoot, relative)).href) as Promise<T>;
export const native = {
	authStorage: await load<typeof AuthStorageModule>("src/auth-storage.ts"),
	sqlite: await load<typeof SqliteStoreModule>("src/auth/sqlite-credential-store.ts"),
	evidence: await load<EvidenceModule>("src/auth/reset-account-evidence.ts"),
};
export const { sameResetAccountEvidence } = native.evidence;

export const LEGACY_OBSERVER = process.env.PI_AI_SELECTION_LEGACY_OBSERVER === "1";

/** Custom provider ids: no env var, no built-in OAuth definition, no default ranking strategy. */
export const PROVIDER = "selection-provider";
export const OTHER_PROVIDER = "selection-other-provider";
export const SESSION = "session-alpha";
export const PEER_SESSION = "session-beta";
export const FAR_FUTURE_MS = 4_102_444_800_000;

export function oauth(name: string, overrides: Partial<Omit<OAuthCredential, "type">> = {}): OAuthCredential {
	return {
		type: "oauth",
		access: `${name}-access`,
		refresh: `${name}-refresh`,
		expires: FAR_FUTURE_MS,
		accountId: `acct-${name}`,
		email: `${name}@example.com`,
		...overrides,
	};
}

/** Every secret-bearing value a fixture credential carries; observations must never serialize any of them. */
export function secretsOf(credential: OAuthCredential): string[] {
	return [credential.access, credential.refresh, credential.accountId, credential.email].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
}

export interface Opened {
	dir: string;
	dbPath: string;
	store: InstanceType<typeof native.sqlite.SqliteAuthCredentialStore>;
	storage: AuthStorage;
}

const opened: Opened[] = [];

/** Fresh temp SQLite store + reloaded AuthStorage, tracked for `closeAll`. */
export async function openStorage(options: AuthStorageOptions = {}, label = "selection"): Promise<Opened> {
	const dir = await mkdtemp(path.join(tmpdir(), `pi-ai-${label}-`));
	return openStorageAt(dir, path.join(dir, "auth.sqlite"), options);
}

/** Second AuthStorage over an existing database (peer process stand-in). */
export async function openPeer(handle: Opened, options: AuthStorageOptions = {}): Promise<Opened> {
	return openStorageAt(handle.dir, handle.dbPath, options);
}

async function openStorageAt(dir: string, dbPath: string, options: AuthStorageOptions): Promise<Opened> {
	const store = await native.sqlite.SqliteAuthCredentialStore.open(dbPath);
	const storage: AuthStorage = new native.authStorage.AuthStorage(store, options);
	await storage.reload();
	const handle: Opened = { dir, dbPath, store, storage };
	opened.push(handle);
	return handle;
}

export async function closeAll(): Promise<void> {
	const dirs = new Set<string>();
	for (const handle of opened.splice(0)) {
		dirs.add(handle.dir);
		try {
			handle.storage.close();
		} catch {
			// Already closed by the test.
		}
	}
	await Promise.all([...dirs].map(dir => rm(dir, { recursive: true, force: true })));
}

/** Upsert credentials in order and return their durable row ids in the same order. */
export function seed(storage: AuthStorage, provider: string, credentials: readonly AuthCredential[]): number[] {
	for (const credential of credentials) storage.upsertCredential(provider, credential);
	const rows = storage.listStoredCredentials(provider);
	return credentials.map(credential => {
		const row = rows.find(candidate => {
			if (candidate.credential.type !== credential.type) return false;
			return credential.type === "oauth"
				? candidate.credential.type === "oauth" && candidate.credential.accountId === credential.accountId
				: candidate.credential.type === "api_key" && candidate.credential.key === credential.key;
		});
		if (!row) throw new Error("seeded credential missing from storage");
		return row.id;
	});
}

export function must<T>(value: T | undefined, what = "value"): T {
	if (value === undefined) throw new Error(`expected ${what} to be defined`);
	return value;
}

/** Durable id of the OAuth row `listOAuthAccounts` reports active for the session. */
export function activeCredentialId(storage: AuthStorage, provider: string, sessionId: string): number | undefined {
	return storage.listOAuthAccounts(provider, sessionId).find(account => account.active)?.credentialId;
}

export function pin(storage: AuthStorage, provider: string, sessionId: string, credentialId: number): void {
	expect(storage.pinSessionOAuthAccount(provider, sessionId, credentialId)).toBe(true);
}

/** Capture that must succeed; returns the frozen public observation. */
export function capture(storage: AuthStorage, provider: string, sessionId: string): SessionCredentialSelectionObservation {
	return must(storage.captureSessionCredentialSelection(provider, sessionId), "selection observation");
}

export function current(storage: AuthStorage, observation: unknown): boolean {
	return storage.isSessionCredentialSelectionCurrent(observation as SessionCredentialSelectionObservation);
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparator observer for the shared A->B->A scenario
// ─────────────────────────────────────────────────────────────────────────────

/** Pre-fence public guard: generation + active durable row + row incarnation proof. */
type LegacyProof = {
	provider: string;
	sessionId: string;
	generation: number;
	credentialId: number;
	evidence: ResetAccountEvidence | undefined;
};
export type SelectionProof = SessionCredentialSelectionObservation | LegacyProof;

export interface SelectionObserver {
	readonly name: string;
	capture(storage: AuthStorage, provider: string, sessionId: string): SelectionProof | undefined;
	isCurrent(storage: AuthStorage, proof: SelectionProof): boolean;
}

const legacyObserver: SelectionObserver = {
	name: "legacy generation + active row + credential evidence (test-only comparator)",
	capture(storage, provider, sessionId) {
		const credentialId = activeCredentialId(storage, provider, sessionId);
		if (credentialId === undefined) return undefined;
		return {
			provider,
			sessionId,
			generation: storage.getGeneration(),
			credentialId,
			evidence: storage.getResetAccountEvidence(provider, credentialId),
		};
	},
	isCurrent(storage, proof) {
		const legacy = proof as LegacyProof;
		return (
			storage.getGeneration() === legacy.generation &&
			activeCredentialId(storage, legacy.provider, legacy.sessionId) === legacy.credentialId &&
			sameResetAccountEvidence(legacy.evidence, storage.getResetAccountEvidence(legacy.provider, legacy.credentialId))
		);
	},
};

const modernObserver: SelectionObserver = {
	name: "captureSessionCredentialSelection / isSessionCredentialSelectionCurrent",
	capture: (storage, provider, sessionId) => storage.captureSessionCredentialSelection(provider, sessionId),
	isCurrent: (storage, proof) => current(storage, proof),
};

export const observer: SelectionObserver = LEGACY_OBSERVER ? legacyObserver : modernObserver;
