/**
 * Selection-fence origin boundary: runtime/config override observations
 * (including their own A->B->A), unsupported origins, the no-I/O capture
 * contract, and observation validity (detached, malformed, foreign). Public
 * native surface only. Modern API only (skipped under the legacy comparator).
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
	seed,
} from "./selection-harness";

afterAll(closeAll);

const THIRD_PROVIDER = "selection-third-provider";

function expectOverrideObservation(
	observation: SessionCredentialSelectionObservation,
	origin: "runtime" | "config",
	secret: string,
): void {
	expect(Object.isFrozen(observation)).toBe(true);
	expect(Object.keys(observation).sort()).toEqual(["origin", "provider", "revision", "sessionId", "version"]);
	expect(observation.version).toBe(1);
	expect(observation.provider).toBe(PROVIDER);
	expect(observation.sessionId).toBe(SESSION);
	expect(observation.origin).toBe(origin);
	expect(observation.revision.length).toBeGreaterThan(0);
	expect(JSON.stringify(observation)).not.toContain(secret);
}

describe.skipIf(LEGACY_OBSERVER)("selection fence: runtime and config overrides", () => {
	test("override observations follow the effective override only; shadowed, no-op, and unrelated changes preserve", async () => {
		const { storage } = await openStorage();
		const [a] = seed(storage, PROVIDER, [oauth("a")]);
		const [other] = seed(storage, OTHER_PROVIDER, [oauth("other")]);
		pin(storage, OTHER_PROVIDER, SESSION, other);
		const unrelated = capture(storage, OTHER_PROVIDER, SESSION);

		storage.setRuntimeApiKey(PROVIDER, "runtime-secret-1");
		const runtime = capture(storage, PROVIDER, SESSION);
		expectOverrideObservation(runtime, "runtime", "runtime-secret-1");
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("runtime-secret-1");
		expect(current(storage, runtime)).toBe(true);

		// Nothing below changes what the session is routed to.
		storage.setRuntimeApiKey(PROVIDER, "runtime-secret-1");
		storage.setConfigApiKey(PROVIDER, "config-secret-1");
		storage.upsertCredential(PROVIDER, oauth("b"));
		expect(storage.pinSessionOAuthAccount(PROVIDER, SESSION, a)).toBe(false);
		storage.setRuntimeApiKey(THIRD_PROVIDER, "runtime-third");
		storage.setConfigApiKey(THIRD_PROVIDER, "config-third");
		storage.removeRuntimeApiKey(THIRD_PROVIDER);
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("runtime-secret-1");
		expect(current(storage, runtime)).toBe(true);
		expect(capture(storage, PROVIDER, SESSION).revision).toBe(runtime.revision);
		expect(current(storage, unrelated)).toBe(true);

		// Runtime A -> B -> A: the value round-trips, the observation does not.
		storage.setRuntimeApiKey(PROVIDER, "runtime-secret-2");
		storage.setRuntimeApiKey(PROVIDER, "runtime-secret-1");
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("runtime-secret-1");
		expect(current(storage, runtime)).toBe(false);
		const runtimeAgain = capture(storage, PROVIDER, SESSION);
		expectOverrideObservation(runtimeAgain, "runtime", "runtime-secret-1");
		expect(runtimeAgain.revision).not.toBe(runtime.revision);
		expect(current(storage, runtimeAgain)).toBe(true);

		// Removing the runtime override exposes the config override: a different effective origin.
		storage.removeRuntimeApiKey(PROVIDER);
		expect(current(storage, runtimeAgain)).toBe(false);
		const config = capture(storage, PROVIDER, SESSION);
		expectOverrideObservation(config, "config", "config-secret-1");
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("config-secret-1");
		storage.setConfigApiKey(PROVIDER, "config-secret-1");
		storage.setConfigApiKey(THIRD_PROVIDER, "config-third-2");
		storage.removeConfigApiKey(THIRD_PROVIDER);
		expect(current(storage, config)).toBe(true);

		// A runtime override arriving above config changes the effective origin both ways.
		storage.setRuntimeApiKey(PROVIDER, "runtime-secret-3");
		expect(current(storage, config)).toBe(false);
		const shadowing = capture(storage, PROVIDER, SESSION);
		expect(shadowing.origin).toBe("runtime");
		storage.removeRuntimeApiKey(PROVIDER);
		expect(current(storage, shadowing)).toBe(false);
		const configAgain = capture(storage, PROVIDER, SESSION);
		expect(configAgain.origin).toBe("config");
		expect(configAgain.revision).not.toBe(config.revision);

		// Clearing config falls back to stored OAuth, which this session never materialized.
		storage.clearConfigApiKeys();
		expect(current(storage, configAgain)).toBe(false);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();
		const key = must(await storage.getApiKey(PROVIDER, SESSION), "oauth key");
		expect(["a-access", "b-access"]).toContain(key);
		expect(capture(storage, PROVIDER, SESSION).origin).toBe("oauth");
		expect(current(storage, unrelated)).toBe(true);
	});
});

describe.skipIf(LEGACY_OBSERVER)("selection fence: unsupported origins", () => {
	test("stored api keys (plain and login), env, and fallback resolve but are never observable", async () => {
		const { storage } = await openStorage();
		seed(storage, PROVIDER, [
			{ type: "api_key", key: "static-secret-1" },
			{ type: "api_key", key: "static-secret-2" },
		]);
		seed(storage, OTHER_PROVIDER, [{ type: "api_key", key: "login-secret", source: "login" }]);
		storage.setFallbackResolver(provider => (provider === THIRD_PROVIDER ? "fallback-secret" : undefined));

		// Plain stored keys: repeated resolves keep the static sticky that usage-limit routing targets.
		const first = must(await storage.getApiKey(PROVIDER, SESSION), "static key");
		expect(["static-secret-1", "static-secret-2"]).toContain(first);
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe(first);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();
		expect(await storage.markUsageLimitReached(PROVIDER, SESSION, { retryAfterMs: 60_000 })).toEqual({ switched: true });
		expect(await storage.getApiKey(PROVIDER, SESSION)).not.toBe(first);
		expect(storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();

		expect(await storage.getApiKey(OTHER_PROVIDER, SESSION)).toBe("login-secret");
		expect(storage.captureSessionCredentialSelection(OTHER_PROVIDER, SESSION)).toBeUndefined();

		expect(await storage.getApiKey(THIRD_PROVIDER, SESSION)).toBe("fallback-secret");
		expect(storage.captureSessionCredentialSelection(THIRD_PROVIDER, SESSION)).toBeUndefined();

		const previousEnv = Bun.env.OPENAI_API_KEY;
		Bun.env.OPENAI_API_KEY = "env-secret";
		try {
			expect(await storage.getApiKey("openai", SESSION)).toBe("env-secret");
			expect(storage.captureSessionCredentialSelection("openai", SESSION)).toBeUndefined();
		} finally {
			if (previousEnv === undefined) delete Bun.env.OPENAI_API_KEY;
			else Bun.env.OPENAI_API_KEY = previousEnv;
		}
	});

	test("a persisted-only sticky is unsupported until this process materializes it", async () => {
		const handle = await openStorage();
		const [a] = seed(handle.storage, PROVIDER, [oauth("a"), oauth("b")]);
		pin(handle.storage, PROVIDER, SESSION, a);
		const original = capture(handle.storage, PROVIDER, SESSION);

		const peer = await openPeer(handle);
		expect(peer.storage.captureSessionCredentialSelection(PROVIDER, SESSION)).toBeUndefined();
		expect(peer.storage.isSessionCredentialSelectionCurrent(original)).toBe(false);

		// Reading the account list materializes the persisted sticky in the peer.
		expect(activeCredentialId(peer.storage, PROVIDER, SESSION)).toBe(a);
		const materialized = capture(peer.storage, PROVIDER, SESSION);
		expect(materialized.credentialId).toBe(a);
		expect(current(peer.storage, materialized)).toBe(true);
		expect(current(handle.storage, materialized)).toBe(false);
		expect(current(handle.storage, original)).toBe(true);
	});
});

describe.skipIf(LEGACY_OBSERVER)("selection fence: capture is a pure read", () => {
	test("capture and current never refresh, resolve, fall back, reselect, or write", async () => {
		let refreshCalls = 0;
		let fallbackCalls = 0;
		const { storage } = await openStorage({
			refreshOAuthCredential: async (_provider, _credentialId, credential: OAuthCredential) => {
				refreshCalls += 1;
				return { ...credential, access: `${credential.access}+rotated`, expires: Date.now() + 7_200_000 };
			},
		});
		storage.setFallbackResolver(() => {
			fallbackCalls += 1;
			return "fallback-secret";
		});
		// Row A is inside the refresh skew: any resolve would refresh it.
		const [a] = seed(storage, PROVIDER, [oauth("a", { expires: Date.now() + 30_000 }), oauth("b")]);
		pin(storage, PROVIDER, SESSION, a);
		const generation = storage.getGeneration();

		const observation = capture(storage, PROVIDER, SESSION);
		expect(current(storage, observation)).toBe(true);
		expect(capture(storage, PROVIDER, SESSION)).toEqual(observation);
		expect(storage.captureSessionCredentialSelection(PROVIDER, PEER_SESSION)).toBeUndefined();
		expect(refreshCalls).toBe(0);
		expect(fallbackCalls).toBe(0);
		expect(storage.getGeneration()).toBe(generation);
		expect(activeCredentialId(storage, PROVIDER, SESSION)).toBe(a);
		expect(storage.releaseSessionCredentialForReselection(PROVIDER, PEER_SESSION)).toBe(false);

		// A blocked selection is still the selection: capture reports it rather than routing around it.
		expect(await storage.markUsageLimitReached(PROVIDER, SESSION, { retryAfterMs: 60_000 })).toEqual({ switched: true });
		expect(capture(storage, PROVIDER, SESSION).credentialId).toBe(a);
		expect(current(storage, observation)).toBe(true);
		expect(refreshCalls).toBe(0);
		expect(fallbackCalls).toBe(0);
	});
});

describe.skipIf(LEGACY_OBSERVER)("selection fence: observation validity", () => {
	test("detached copies verify on their origin storage only; altered, malformed, and foreign values are false", async () => {
		const { storage } = await openStorage();
		const [a, b] = seed(storage, PROVIDER, [oauth("a"), oauth("b")]);
		pin(storage, PROVIDER, SESSION, a);
		pin(storage, PROVIDER, PEER_SESSION, a);
		const observation = capture(storage, PROVIDER, SESSION);
		const peer = capture(storage, PROVIDER, PEER_SESSION);

		const detached = JSON.parse(JSON.stringify(observation)) as SessionCredentialSelectionObservation;
		expect(detached).toEqual(observation);
		expect(current(storage, detached)).toBe(true);
		expect(() => {
			(observation as { revision: string }).revision = "tampered";
		}).toThrow();

		const { credentialId: _dropped, ...withoutCredentialId } = observation;
		const altered: unknown[] = [
			{ ...observation, version: 2 },
			{ ...observation, sessionId: PEER_SESSION },
			{ ...observation, provider: OTHER_PROVIDER },
			{ ...observation, revision: `${observation.revision}x` },
			{ ...observation, revision: "" },
			{ ...observation, origin: "runtime" },
			{ ...observation, credentialId: b },
			withoutCredentialId,
			{ ...peer, sessionId: SESSION },
			null,
			undefined,
			42,
			"observation",
			{},
			[],
		];
		for (const value of altered) expect(current(storage, value)).toBe(false);

		// Same rows, same ids, same pin in another database: a different storage, so never current.
		const foreign = await openStorage({}, "foreign");
		const [foreignA] = seed(foreign.storage, PROVIDER, [oauth("a"), oauth("b")]);
		expect(foreignA).toBe(a);
		pin(foreign.storage, PROVIDER, SESSION, foreignA);
		const foreignObservation = capture(foreign.storage, PROVIDER, SESSION);
		expect(current(foreign.storage, observation)).toBe(false);
		expect(current(storage, foreignObservation)).toBe(false);
		expect(current(foreign.storage, foreignObservation)).toBe(true);

		// Probing never disturbed the real selections.
		expect(current(storage, observation)).toBe(true);
		expect(current(storage, peer)).toBe(true);
	});
});
