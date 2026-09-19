/**
 * Shared native A->B->A scenario for per-session credential selection.
 *
 * The same test runs under two observers (see selection-harness.ts):
 * - default: `captureSessionCredentialSelection` / `isSessionCredentialSelectionCurrent`
 * - `PI_AI_SELECTION_LEGACY_OBSERVER=1`: the old public guard (generation +
 *   active durable row + credential evidence). After a real pin A->B->A every
 *   legacy signal reads identical, so its "stale" assertion fails: that failure
 *   is the documented blind spot this packet fences. Against a package without
 *   the fence the default observer fails on the missing API.
 *
 * Both proofs are asserted side by side so the row-incarnation proof
 * (`getResetAccountEvidence`) and the selection proof stay visibly distinct.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	PEER_SESSION,
	PROVIDER,
	SESSION,
	activeCredentialId,
	closeAll,
	must,
	oauth,
	observer,
	openStorage,
	pin,
	sameResetAccountEvidence,
	seed,
} from "./selection-harness";

afterAll(closeAll);

describe(`selection ABA: ${observer.name}`, () => {
	test("pin A -> B -> A stales the first observation while every row-level signal reads unchanged", async () => {
		const { storage } = await openStorage();
		const [a, b] = seed(storage, PROVIDER, [oauth("a"), oauth("b")]);
		pin(storage, PROVIDER, SESSION, a);
		pin(storage, PROVIDER, PEER_SESSION, a);

		const first = must(observer.capture(storage, PROVIDER, SESSION), "first observation");
		const peer = must(observer.capture(storage, PROVIDER, PEER_SESSION), "peer observation");
		const rowProof = must(storage.getResetAccountEvidence(PROVIDER, a), "row proof");

		// Resolving the pinned row is a same-row use (timestamp-only repin), not a reselection.
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("a-access");
		expect(observer.isCurrent(storage, first)).toBe(true);

		// Real round trip: the session is routed to B, then back to A.
		pin(storage, PROVIDER, SESSION, b);
		pin(storage, PROVIDER, SESSION, a);

		// Row-level truth is byte-for-byte what the first capture saw.
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("a-access");
		expect(activeCredentialId(storage, PROVIDER, SESSION)).toBe(a);
		expect(sameResetAccountEvidence(rowProof, storage.getResetAccountEvidence(PROVIDER, a))).toBe(true);

		// Selection-level truth is not: the selection was replaced twice in between.
		// (Legacy observer: this is the blind spot; every signal above reads identical.)
		expect(observer.isCurrent(storage, first)).toBe(false);

		// A fresh capture after the round trip is the current selection, and the
		// untouched peer session's observation never moved.
		const recaptured = must(observer.capture(storage, PROVIDER, SESSION), "recaptured observation");
		expect(observer.isCurrent(storage, recaptured)).toBe(true);
		expect(observer.isCurrent(storage, first)).toBe(false);
		expect(observer.isCurrent(storage, peer)).toBe(true);
	});
});
