/**
 * Selection-fence lifecycle: what invalidates an OAuth selection observation,
 * what must preserve it, and how it stays distinct from the row-incarnation
 * proof. Public native surface only; refresh outcomes are injected through the
 * `refreshOAuthCredential` option. Modern API only (skipped under the legacy
 * comparator observer).
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { OAuthCredential, SessionCredentialSelectionObservation } from "@oh-my-pi/pi-ai/auth-storage";
import {
	LEGACY_OBSERVER,
	OTHER_PROVIDER,
	PEER_SESSION,
	PROVIDER,
	SESSION,
	activeCredentialId,
	capture,
	closeAll,
	current,
	must,
	oauth,
	openPeer,
	openStorage,
	pin,
	sameResetAccountEvidence,
	secretsOf,
	seed,
} from "./selection-harness";

afterAll(closeAll);

const OBSERVATION_KEYS = ["version", "provider", "sessionId", "revision", "origin", "credentialId"] as const;

function expectOAuthObservation(
	observation: SessionCredentialSelectionObservation,
	provider: string,
	sessionId: string,
	credentialId: number,
): void {
	expect(Object.isFrozen(observation)).toBe(true);
	expect(Object.keys(observation).sort()).toEqual([...OBSERVATION_KEYS].sort());
	expect(observation.version).toBe(1);
	expect(observation.provider).toBe(provider);
	expect(observation.sessionId).toBe(sessionId);
	expect(observation.origin).toBe("oauth");
	expect(observation.credentialId).toBe(credentialId);
	expect(typeof observation.revision).toBe("string");
	expect(observation.revision.length).toBeGreaterThan(0);
}

describe.skipIf(LEGACY_OBSERVER)("selection fence: capture", () => {
	test("captures are frozen, redacted, stable while unchanged, and absent without a selection", async () => {
		const { storage } = await openStorage();
		const credential = oauth("a");
		const [a] = seed(storage, PROVIDER, [credential]);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();
		pin(storage, PROVIDER, SESSION, a);

		const observation = capture(storage, PROVIDER, SESSION);
		expectOAuthObservation(observation, PROVIDER, SESSION, a);
		const serialized = JSON.stringify(observation);
		for (const secret of secretsOf(credential)) expect(serialized).not.toContain(secret);
		expect(current(storage, observation)).toBe(true);

		// Stable state, stable observation: no new revision is minted per call.
		expect(capture(storage, PROVIDER, SESSION)).toEqual(observation);
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("a-access");
		expect(capture(storage, PROVIDER, SESSION).revision).toBe(observation.revision);
		expect(current(storage, observation)).toBe(true);

		// Capturing an unselected session is not a selection.
		expect(storage.captureSessionCredentialSelection(PROVIDER, PEER_SESSION)).toBeUndefined();
		expect(storage.releaseSessionCredentialForReselection(PROVIDER, PEER_SESSION)).toBe(false);
		expect(storage.captureSessionCredentialSelection(OTHER_PROVIDER, SESSION)).toBeUndefined();
	});
});

describe.skipIf(LEGACY_OBSERVER)("selection fence: reselection paths", () => {
	test("release, reselect, and re-pin to the same row never revive an earlier observation", async () => {
		const { storage } = await openStorage();
		const [a, b] = seed(storage, PROVIDER, [oauth("a"), oauth("b")]);
		pin(storage, PROVIDER, SESSION, a);
		pin(storage, PROVIDER, PEER_SESSION, b);
		const first = capture(storage, PROVIDER, SESSION);
		const peer = capture(storage, PROVIDER, PEER_SESSION);

		expect(storage.releaseSessionCredentialForReselection(PROVIDER, SESSION)).toBe(true);
		expect(current(storage, first)).toBe(false);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();

		// Real reselection through resolution.
		const key = must(await storage.getApiKey(PROVIDER, SESSION), "resolved key");
		const reselectedId = key === "a-access" ? a : b;
		expect([a, b]).toContain(reselectedId);
		const reselected = capture(storage, PROVIDER, SESSION);
		expectOAuthObservation(reselected, PROVIDER, SESSION, reselectedId);
		expect(current(storage, reselected)).toBe(true);
		expect(current(storage, first)).toBe(false);

		// Release and pin the very same row again: a new selection, new revision.
		expect(storage.releaseSessionCredentialForReselection(PROVIDER, SESSION)).toBe(true);
		pin(storage, PROVIDER, SESSION, reselectedId);
		const repinned = capture(storage, PROVIDER, SESSION);
		expect(repinned.credentialId).toBe(reselectedId);
		expect(repinned.revision).not.toBe(reselected.revision);
		expect(current(storage, repinned)).toBe(true);
		expect(current(storage, reselected)).toBe(false);
		expect(current(storage, first)).toBe(false);
		expect(current(storage, peer)).toBe(true);
	});

	test("usage-limit block alone preserves; the automatic re-route to a sibling invalidates", async () => {
		const { storage } = await openStorage();
		const [a, b] = seed(storage, PROVIDER, [oauth("a"), oauth("b")]);
		pin(storage, PROVIDER, SESSION, a);
		pin(storage, PROVIDER, PEER_SESSION, a);
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("a-access");
		const observation = capture(storage, PROVIDER, SESSION);
		const peer = capture(storage, PROVIDER, PEER_SESSION);

		expect(await storage.markUsageLimitReached(PROVIDER, SESSION, { retryAfterMs: 60_000 })).toEqual({ switched: true });
		// Blocking is credential evidence, not a reselection: the sticky still names row A.
		expect(current(storage, observation)).toBe(true);

		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("b-access");
		expect(current(storage, observation)).toBe(false);
		const rerouted = capture(storage, PROVIDER, SESSION);
		expectOAuthObservation(rerouted, PROVIDER, SESSION, b);
		expect(current(storage, rerouted)).toBe(true);
		// The peer session shares the blocked row but was not re-routed.
		expect(current(storage, peer)).toBe(true);
	});

	test("hard-auth rotation and explicit invalidation clear the selection", async () => {
		const { storage } = await openStorage();
		const [a, b] = seed(storage, PROVIDER, [oauth("a"), oauth("b")]);
		pin(storage, PROVIDER, SESSION, a);
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("a-access");
		const observation = capture(storage, PROVIDER, SESSION);

		const unauthorized = Object.assign(new Error("unauthorized"), { status: 401 });
		expect(await storage.rotateSessionCredential(PROVIDER, SESSION, { error: unauthorized, apiKey: "a-access" })).toBe(true);
		expect(current(storage, observation)).toBe(false);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();

		pin(storage, PROVIDER, SESSION, b);
		const second = capture(storage, PROVIDER, SESSION);
		expect(second.credentialId).toBe(b);
		expect(await storage.invalidateCredentialMatching(PROVIDER, "b-access", { sessionId: SESSION })).toBe(true);
		expect(current(storage, second)).toBe(false);
		expect(current(storage, observation)).toBe(false);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();
	});

	test("routing into the fallback resolver clears the stale OAuth selection", async () => {
		let refreshAttempts = 0;
		const { storage } = await openStorage({
			refreshOAuthCredential: async () => {
				refreshAttempts += 1;
				throw new Error("simulated network failure during refresh");
			},
		});
		storage.setFallbackResolver(() => "fallback-secret");
		// Inside the refresh skew: the next resolve must refresh, and the refresh fails transiently.
		const [a] = seed(storage, PROVIDER, [oauth("a", { expires: Date.now() + 30_000 })]);
		pin(storage, PROVIDER, SESSION, a);
		const observation = capture(storage, PROVIDER, SESSION);
		expect(refreshAttempts).toBe(0);

		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("fallback-secret");
		expect(refreshAttempts).toBe(1);
		expect(current(storage, observation)).toBe(false);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();
		expect(activeCredentialId(storage, PROVIDER, SESSION)).toBeUndefined();
	});
});

describe.skipIf(LEGACY_OBSERVER)("selection fence: provider resets and reloads", () => {
	test("provider assignment resets invalidate every session and purge cached stickies; other providers stay stable", async () => {
		const handle = await openStorage();
		const { storage } = handle;
		const [a, b] = seed(storage, PROVIDER, [oauth("a"), oauth("b")]);
		const [other] = seed(storage, OTHER_PROVIDER, [oauth("other")]);
		pin(storage, PROVIDER, SESSION, a);
		pin(storage, PROVIDER, PEER_SESSION, b);
		pin(storage, OTHER_PROVIDER, SESSION, other);
		const first = capture(storage, PROVIDER, SESSION);
		const peer = capture(storage, PROVIDER, PEER_SESSION);
		const unrelated = capture(storage, OTHER_PROVIDER, SESSION);

		storage.upsertCredential(PROVIDER, oauth("c"));
		expect(current(storage, first)).toBe(false);
		expect(current(storage, peer)).toBe(false);
		expect(current(storage, unrelated)).toBe(true);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();
		// The persisted sticky is gone too: a fresh handle over the same database sees no active row.
		const rehydrated = await openPeer(handle);
		expect(activeCredentialId(rehydrated.storage, PROVIDER, SESSION)).toBeUndefined();
		expect(activeCredentialId(rehydrated.storage, OTHER_PROVIDER, SESSION)).toBe(other);

		// Removing an unselected sibling still resets the provider's assignments.
		pin(storage, PROVIDER, SESSION, a);
		const repinned = capture(storage, PROVIDER, SESSION);
		expect(await storage.removeCredential(PROVIDER, b)).toBe(true);
		expect(current(storage, repinned)).toBe(false);
		expect(current(storage, unrelated)).toBe(true);
	});

	test("an external row change at the sticky index invalidates, even when it moves away and back unobserved", async () => {
		const handle = await openStorage();
		const { storage } = handle;
		const [a] = seed(storage, PROVIDER, [oauth("a"), oauth("b")]);
		pin(storage, PROVIDER, SESSION, a);
		const observation = capture(storage, PROVIDER, SESSION);
		const external = await openPeer(handle);

		// Away: row A becomes an api_key row. Back: it becomes OAuth again. No check in between.
		external.store.updateAuthCredential(a, { type: "api_key", key: "swapped-key" });
		await storage.reload();
		external.store.updateAuthCredential(a, oauth("a"));
		await storage.reload();
		expect(storage.listStoredCredentials(PROVIDER).find(row => row.id === a)?.credential.type).toBe("oauth");
		expect(current(storage, observation)).toBe(false);

		// Removal shifts the sibling into the sticky index: a different row, not the selection.
		pin(storage, PROVIDER, SESSION, a);
		const repinned = capture(storage, PROVIDER, SESSION);
		external.store.deleteAuthCredential(a, "external removal");
		await storage.reload();
		expect(storage.listStoredCredentials(PROVIDER).some(row => row.id === a)).toBe(false);
		expect(current(storage, repinned)).toBe(false);
	});
});

describe.skipIf(LEGACY_OBSERVER)("selection fence: preservation and proof distinction", () => {
	test("same-row token refresh and timestamp-only repins preserve both the selection and the row proof", async () => {
		const refreshed: Array<{ credentialId: number; access: string }> = [];
		const { storage } = await openStorage({
			refreshOAuthCredential: async (_provider, credentialId, credential: OAuthCredential) => {
				refreshed.push({ credentialId, access: credential.access });
				return {
					access: `${credential.access}+rotated`,
					refresh: credential.refresh,
					expires: Date.now() + 7_200_000,
					accountId: credential.accountId,
					email: credential.email,
				};
			},
		});
		const [a] = seed(storage, PROVIDER, [oauth("a", { expires: Date.now() + 30_000 }), oauth("b")]);
		pin(storage, PROVIDER, SESSION, a);
		const observation = capture(storage, PROVIDER, SESSION);
		const rowProof = must(storage.getResetAccountEvidence(PROVIDER, a), "row proof");

		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("a-access+rotated");
		expect(refreshed).toEqual([{ credentialId: a, access: "a-access" }]);
		expect(current(storage, observation)).toBe(true);
		expect(capture(storage, PROVIDER, SESSION).revision).toBe(observation.revision);
		expect(sameResetAccountEvidence(rowProof, storage.getResetAccountEvidence(PROVIDER, a))).toBe(true);

		// Backdated and plain re-pins of the already-selected row only touch the timestamp.
		pin(storage, PROVIDER, SESSION, a);
		expect(storage.pinSessionOAuthAccount(PROVIDER, SESSION, a, { lastUsedAtMs: Date.now() - 5_000 })).toBe(true);
		expect(current(storage, observation)).toBe(true);
		expect(activeCredentialId(storage, PROVIDER, SESSION)).toBe(a);
	});

	test("row proof and selection proof rotate independently", async () => {
		const handle = await openStorage();
		const { storage } = handle;
		const [a, b] = seed(storage, PROVIDER, [oauth("a"), oauth("b")]);
		pin(storage, PROVIDER, SESSION, a);
		const observation = capture(storage, PROVIDER, SESSION);
		const rowProof = must(storage.getResetAccountEvidence(PROVIDER, a), "row proof");

		// Selection moves, row incarnation does not.
		pin(storage, PROVIDER, SESSION, b);
		pin(storage, PROVIDER, SESSION, a);
		expect(sameResetAccountEvidence(rowProof, storage.getResetAccountEvidence(PROVIDER, a))).toBe(true);
		expect(current(storage, observation)).toBe(false);

		// Row incarnation moves (external scope change on the same durable row), selection does not.
		const second = capture(storage, PROVIDER, SESSION);
		const external = await openPeer(handle);
		external.store.updateAuthCredential(a, oauth("a", { orgId: "org-moved" }));
		await storage.reload();
		expect(sameResetAccountEvidence(rowProof, storage.getResetAccountEvidence(PROVIDER, a))).toBe(false);
		expect(current(storage, second)).toBe(true);
		expect(capture(storage, PROVIDER, SESSION).credentialId).toBe(a);
	});

	test("close ends every observation", async () => {
		const { storage } = await openStorage();
		const [a] = seed(storage, PROVIDER, [oauth("a")]);
		pin(storage, PROVIDER, SESSION, a);
		const observation = capture(storage, PROVIDER, SESSION);
		storage.close();
		expect(current(storage, observation)).toBe(false);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();
	});
});
