/**
 * Auth-broker reset-account-evidence contract: negotiated wire capability,
 * legacy strict clients, unsupported brokers, and RemoteAuthCredentialStore
 * proof lifecycle. Runs entirely in-process against temp native SQLite
 * AuthStorage instances behind real loopback `startAuthBroker` servers plus a
 * controlled `fetchImpl` transport; no provider, credit or profile calls.
 *
 * PI_AI_EVIDENCE_PACKAGE selects an authored or freshly installed package;
 * default is the checkout's installed package. Explicit absence assertions
 * defend the legacy wire shape even after this patch is installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthStorage as AuthStorageType, OAuthCredential, ResetAccountEvidence } from "@oh-my-pi/pi-ai/auth-storage";
import type { AuthBrokerClient as AuthBrokerClientType } from "@oh-my-pi/pi-ai/auth-broker/client";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker/server";
import type { RemoteAuthCredentialStore as RemoteStoreType } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import type { SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker/types";

const repository = path.resolve(import.meta.dir, "../..");
const packageRoot =
	process.env.PI_AI_EVIDENCE_PACKAGE ??
	path.join(repository, "node_modules/@oh-my-pi/pi-ai");

// Dynamic imports: the package under test is runtime-selected (isolated copy
// vs. authored checkout) so the same file exercises whichever root the harness
// prepared; a static specifier cannot express that.
const native = {
	authStorage: await import(path.join(packageRoot, "src/auth-storage.ts")),
	sqlite: await import(path.join(packageRoot, "src/auth/sqlite-credential-store.ts")),
	evidence: await import(path.join(packageRoot, "src/auth/reset-account-evidence.ts")),
	server: await import(path.join(packageRoot, "src/auth-broker/server.ts")),
	client: await import(path.join(packageRoot, "src/auth-broker/client.ts")),
	remote: await import(path.join(packageRoot, "src/auth-broker/remote-store.ts")),
	types: await import(path.join(packageRoot, "src/auth-broker/types.ts")),
	schemas: await import(path.join(packageRoot, "src/auth-broker/wire-schemas.ts")),
};

const PROVIDER = "anthropic";
const TOKEN = "broker-test-token";
const RESET_CAPABILITY: string = native.types.AUTH_BROKER_CAPABILITY_RESET_ACCOUNT_EVIDENCE_V1;
const CAPABILITIES_HEADER: string = native.types.AUTH_BROKER_CAPABILITIES_HEADER;
const REMOTE_SENTINEL: string = native.authStorage.REMOTE_REFRESH_SENTINEL;
const sameEvidence: (a: ResetAccountEvidence | undefined, b: ResetAccountEvidence | undefined) => boolean =
	native.evidence.sameResetAccountEvidence;

function oauth(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
	return {
		type: "oauth",
		access: "access-1",
		refresh: "refresh-1",
		expires: Date.now() + 3_600_000,
		accountId: "acct-1",
		email: "one@example.com",
		...overrides,
	};
}

interface Fixture {
	dir: string;
	storage: AuthStorageType;
	broker: AuthBrokerServerHandle;
	credentialId: number;
}

/** Temp SQLite AuthStorage with a controlled in-process token rotation, served by a loopback broker. */
async function startFixture(): Promise<Fixture> {
	const dir = await mkdtemp(path.join(tmpdir(), "reset-account-evidence-broker-"));
	const store = new native.sqlite.SqliteAuthCredentialStore(new Database(path.join(dir, "broker.db")));
	const storage: AuthStorageType = new native.authStorage.AuthStorage(store, {
		refreshOAuthCredential: async (_provider: string, _id: number, credential: OAuthCredential) => ({
			access: `${credential.access}+rotated`,
			refresh: credential.refresh,
			expires: Date.now() + 7_200_000,
			accountId: credential.accountId,
			email: credential.email,
		}),
	});
	await storage.reload();
	const [entry] = storage.upsertCredential(PROVIDER, oauth());
	const broker: AuthBrokerServerHandle = native.server.startAuthBroker({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: [TOKEN],
		disableRefresher: true,
		streamKeepaliveMs: 50,
		externalChangePollMs: 50,
	});
	return { dir, storage, broker, credentialId: entry.id };
}

async function stopFixture(fixture: Fixture): Promise<void> {
	await fixture.broker.close();
	fixture.storage.close();
	await rm(fixture.dir, { recursive: true, force: true });
}

function newClient(url: string, fetchImpl?: typeof fetch): AuthBrokerClientType {
	return new native.client.AuthBrokerClient({ url, token: TOKEN, fetchImpl, maxRetries: 0 });
}

function newRemote(options: {
	client: AuthBrokerClientType;
	initialSnapshot?: SnapshotResponse;
	streamSnapshots: boolean;
}): RemoteStoreType {
	return new native.remote.RemoteAuthCredentialStore({ ...options, backgroundIdleMs: 30_000 });
}

/** Raw request as an older client would send it: bearer only, no capability header. */
async function legacyRequest(url: string, pathname: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${url}${pathname}`, {
		...init,
		headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", ...(init.headers ?? {}) },
	});
}

function serverEvidence(fixture: Fixture): ResetAccountEvidence {
	const evidence = fixture.storage.getResetAccountEvidence(PROVIDER, fixture.credentialId);
	if (!evidence) throw new Error("server storage produced no reset-account evidence");
	return evidence;
}

/**
 * Store state ingested from the background SSE consumer has no public
 * completion signal (the stream loop is internal and `onSnapshot` only fires
 * for full snapshots), so this is the one place the test polls; the wire-level
 * frame itself is awaited deterministically via `openSnapshotStream`.
 */
async function waitForStoreState(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("remote store did not ingest the expected stream state");
		await Bun.sleep(10);
	}
}

/** Minimal SSE reader for the legacy raw-stream check: yields parsed `data:` JSON payloads. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; data: unknown }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) return;
		buffer += decoder.decode(value, { stream: true });
		let separator = buffer.indexOf("\n\n");
		while (separator !== -1) {
			const frame = buffer.slice(0, separator);
			buffer = buffer.slice(separator + 2);
			separator = buffer.indexOf("\n\n");
			let event: string | null = null;
			const data: string[] = [];
			for (const line of frame.split("\n")) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
			}
			if (data.length > 0) yield { event, data: JSON.parse(data.join("\n")) };
		}
	}
}

describe("auth-broker reset-account evidence", () => {
	let fixture: Fixture;
	beforeAll(async () => {
		fixture = await startFixture();
	});
	afterAll(async () => {
		await stopFixture(fixture);
	});

	test("negotiated client receives the server-backed proof on the full snapshot and mirrors it exactly", async () => {
		const expected = serverEvidence(fixture);
		const client = newClient(fixture.broker.url);
		const result = await client.fetchSnapshot();
		if (result.status !== 200) throw new Error("expected 200 snapshot");
		const entry = result.snapshot.credentials.find(candidate => candidate.id === fixture.credentialId);
		expect(entry?.resetAccountEvidence).toEqual(expected);
		expect(entry?.credential.refresh).toBe(REMOTE_SENTINEL);

		const remote = newRemote({ client, initialSnapshot: result.snapshot, streamSnapshots: false });
		try {
			const mirrored = remote.getResetAccountEvidence(PROVIDER, fixture.credentialId);
			expect(sameEvidence(mirrored, expected)).toBe(true);
			expect(Object.isFrozen(mirrored)).toBe(true);
			expect(remote.listAuthCredentials(PROVIDER)[0]?.resetAccountEvidence).toEqual(expected);
			// Exact (provider, id) only — a colliding id under another provider is not this row.
			expect(remote.getResetAccountEvidence("openai-codex", fixture.credentialId)).toBeUndefined();
			expect(remote.getResetAccountEvidence(PROVIDER, fixture.credentialId + 1)).toBeUndefined();
		} finally {
			remote.close();
		}
	});

	test("legacy client without the capability gets the published strict shape everywhere", async () => {
		const snapshot = await legacyRequest(fixture.broker.url, "/v1/snapshot");
		expect(snapshot.status).toBe(200);
		const snapshotBody = native.schemas.snapshotResponseSchema.assert(await snapshot.json());
		expect(snapshotBody.credentials.some(entry => "resetAccountEvidence" in entry)).toBe(false);

		// Advertising only the older capability must not leak the newer field either.
		const partial = await legacyRequest(fixture.broker.url, "/v1/snapshot", {
			headers: { [CAPABILITIES_HEADER]: native.types.AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES },
		});
		const partialBody = native.schemas.snapshotResponseSchema.assert(await partial.json());
		expect(partialBody.credentials.some(entry => "resetAccountEvidence" in entry)).toBe(false);

		const refresh = await legacyRequest(fixture.broker.url, `/v1/credential/${fixture.credentialId}/refresh`, {
			method: "POST",
		});
		expect(refresh.status).toBe(200);
		const refreshBody = native.schemas.credentialRefreshResponseSchema.assert(await refresh.json());
		expect("resetAccountEvidence" in refreshBody.entry).toBe(false);

		const upload = await legacyRequest(fixture.broker.url, "/v1/credential", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				provider: PROVIDER,
				credential: oauth({ access: "access-2", refresh: "refresh-2", accountId: "acct-2", email: "two@example.com" }),
			}),
		});
		expect(upload.status).toBe(200);
		const uploadBody = native.schemas.credentialUploadResponseSchema.assert(await upload.json());
		expect(uploadBody.entries.some(entry => "resetAccountEvidence" in entry)).toBe(false);

		const controller = new AbortController();
		const stream = await fetch(`${fixture.broker.url}/v1/snapshot/stream`, {
			headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
			signal: controller.signal,
		});
		expect(stream.status).toBe(200);
		try {
			for await (const frame of readSse(stream.body!)) {
				const event = native.schemas.snapshotStreamEventSchema.assert(frame.data);
				expect(frame.event).toBe("snapshot");
				if (event.kind !== "snapshot") throw new Error("expected initial snapshot frame");
				expect(event.credentials.some(entry => "resetAccountEvidence" in entry)).toBe(false);
				break;
			}
		} finally {
			controller.abort();
		}
	});

	test("refresh and upload responses carry the row's own proof for negotiated clients", async () => {
		const client = newClient(fixture.broker.url);
		const before = serverEvidence(fixture);
		const { entry } = await client.refreshCredential(fixture.credentialId);
		// Token-only rotation keeps the incarnation: same proof, new bearer.
		expect(entry.credential.type).toBe("oauth");
		expect(sameEvidence(entry.resetAccountEvidence, before)).toBe(true);
		expect(sameEvidence(entry.resetAccountEvidence, serverEvidence(fixture))).toBe(true);

		const { entries } = await client.uploadCredential(PROVIDER, oauth({ accountId: "acct-3", email: "three@example.com" }));
		expect(entries.length).toBeGreaterThan(1);
		for (const row of entries) {
			expect(row.resetAccountEvidence).toEqual(fixture.storage.getResetAccountEvidence(PROVIDER, row.id));
			expect(row.resetAccountEvidence?.credentialId).toBe(row.id);
		}
	});

	test("remote store keeps proof across token-only updates and drops it on a scope change or foreign proof", async () => {
		const client = newClient(fixture.broker.url);
		const result = await client.fetchSnapshot();
		if (result.status !== 200) throw new Error("expected 200 snapshot");
		const remote = newRemote({ client, initialSnapshot: result.snapshot, streamSnapshots: false });
		try {
			const original = remote.getResetAccountEvidence(PROVIDER, fixture.credentialId);
			expect(original).toBeDefined();
			const current = remote.listAuthCredentials(PROVIDER).find(row => row.id === fixture.credentialId)!
				.credential as OAuthCredential;

			// Broker-routed refresh: the refresh response proof is the same incarnation.
			const refreshed = await remote.refreshOAuthCredential(PROVIDER, fixture.credentialId, current);
			expect(refreshed.refresh).toBe(REMOTE_SENTINEL);
			expect(sameEvidence(remote.getResetAccountEvidence(PROVIDER, fixture.credentialId), original)).toBe(true);

			// AuthStorage's follow-up mirror write with the merged token-only credential keeps it.
			remote.updateAuthCredential(fixture.credentialId, { ...current, access: refreshed.access, expires: refreshed.expires });
			expect(sameEvidence(remote.getResetAccountEvidence(PROVIDER, fixture.credentialId), original)).toBe(true);

			// A local mirror write that moves the account scope invalidates rather than recaptures.
			remote.updateAuthCredential(fixture.credentialId, { ...current, accountId: "someone-else" });
			expect(remote.getResetAccountEvidence(PROVIDER, fixture.credentialId)).toBeUndefined();
			const row = remote.listAuthCredentials(PROVIDER).find(candidate => candidate.id === fixture.credentialId);
			expect(row?.credential.type).toBe("oauth");
			expect(row?.resetAccountEvidence).toBeUndefined();
		} finally {
			remote.close();
		}

		// A proof naming a different row is rejected at ingestion; the credential stays usable.
		const foreign = structuredClone(result.snapshot);
		const target = foreign.credentials.find(entry => entry.id === fixture.credentialId)!;
		target.resetAccountEvidence = { ...target.resetAccountEvidence!, credentialId: target.id + 1000 };
		const tainted = newRemote({ client, initialSnapshot: foreign, streamSnapshots: false });
		try {
			expect(tainted.getResetAccountEvidence(PROVIDER, fixture.credentialId)).toBeUndefined();
			const row = tainted.listAuthCredentials(PROVIDER).find(entry => entry.id === fixture.credentialId);
			expect(row?.credential.type).toBe("oauth");
			expect(row?.resetAccountEvidence).toBeUndefined();
		} finally {
			tainted.close();
		}
	});

	test("SSE delivers a new proof for a relinked row even when the token bytes are unchanged", async () => {
		const client = newClient(fixture.broker.url);
		const controller = new AbortController();
		const frames = client.openSnapshotStream({ signal: controller.signal });
		const remote = newRemote({ client, streamSnapshots: true });
		try {
			const first = await frames.next();
			if (first.done || first.value.kind !== "snapshot") throw new Error("expected initial snapshot frame");
			const wireBefore = first.value.credentials.find(entry => entry.id === fixture.credentialId)!;
			const before = serverEvidence(fixture);
			expect(sameEvidence(wireBefore.resetAccountEvidence, before)).toBe(true);
			await waitForStoreState(() => sameEvidence(remote.getResetAccountEvidence(PROVIDER, fixture.credentialId), before));

			// Explicit same-account relink on the broker host: same row id, new
			// incarnation, byte-identical redacted credential on the wire.
			const [relinked] = fixture.storage.upsertCredential(PROVIDER, {
				...(wireBefore.credential as OAuthCredential),
				refresh: "refresh-relinked",
			});
			expect(relinked.id).toBe(fixture.credentialId);
			const after = serverEvidence(fixture);
			expect(sameEvidence(after, before)).toBe(false);
			expect(after.authAuthority).toBe(before.authAuthority);
			expect(after.accountId).toBe(before.accountId);

			let delivered: ResetAccountEvidence | undefined;
			for await (const frame of frames) {
				if (frame.kind !== "entry" || frame.entry.id !== fixture.credentialId) continue;
				expect(frame.entry.credential).toEqual(wireBefore.credential);
				delivered = frame.entry.resetAccountEvidence;
				break;
			}
			expect(sameEvidence(delivered, after)).toBe(true);

			await waitForStoreState(() => sameEvidence(remote.getResetAccountEvidence(PROVIDER, fixture.credentialId), after));
			expect(sameEvidence(remote.getResetAccountEvidence(PROVIDER, fixture.credentialId), before)).toBe(false);
			expect(remote.listAuthCredentials(PROVIDER).find(row => row.id === fixture.credentialId)?.resetAccountEvidence).toEqual(
				after,
			);
		} finally {
			controller.abort();
			remote.close();
		}
	});

	test("negotiated stream schema accepts the v1 proof and rejects other versions or extra keys", () => {
		const evidence = serverEvidence(fixture);
		const frame = {
			kind: "entry",
			generation: 1,
			serverNowMs: 1,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
			entry: {
				id: fixture.credentialId,
				provider: PROVIDER,
				credential: { ...oauth(), refresh: REMOTE_SENTINEL },
				identityKey: "x",
				rotatesInMs: null,
				resetAccountEvidence: evidence,
			},
		};
		expect(native.schemas.snapshotStreamEventSchema.allows(frame)).toBe(true);
		expect(
			native.schemas.snapshotStreamEventSchema.allows({
				...frame,
				entry: { ...frame.entry, resetAccountEvidence: { ...evidence, version: 2 } },
			}),
		).toBe(false);
		expect(
			native.schemas.snapshotStreamEventSchema.allows({
				...frame,
				entry: { ...frame.entry, resetAccountEvidence: { ...evidence, access: "leak" } },
			}),
		).toBe(false);
		expect(native.schemas.resetAccountEvidenceSchema.allows({ ...evidence, credentialId: 0 })).toBe(false);
	});
});

describe("older broker without reset-account evidence", () => {
	test("new client advertises the capability, validates the legacy shape and reads undefined proof", async () => {
		const seen: Headers[] = [];
		const legacySnapshot: SnapshotResponse = {
			generation: 3,
			generatedAt: 1,
			serverNowMs: 1,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [
				{
					id: 7,
					provider: PROVIDER,
					credential: { ...oauth(), refresh: REMOTE_SENTINEL },
					identityKey: "anthropic:acct-1",
					rotatesInMs: null,
				},
			],
		};
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const headers = new Headers(init?.headers);
			seen.push(headers);
			if (url.pathname === "/v1/snapshot") {
				// Old broker long-poll: an up-to-date client parks until its own signal aborts.
				if (headers.get("If-None-Match") === '"3"' && url.searchParams.has("wait") && init?.signal) {
					const parked = init.signal;
					await new Promise<void>(resolve => {
						if (parked.aborted) resolve();
						else parked.addEventListener("abort", () => resolve(), { once: true });
					});
					return new Response(null, { status: 304, headers: { ETag: '"3"' } });
				}
				return Response.json(legacySnapshot, { headers: { ETag: '"3"' } });
			}
			if (url.pathname === "/v1/credential/7/refresh") {
				const { rotatesInMs: _wire, ...entry } = legacySnapshot.credentials[0]!;
				return Response.json({ entry: { ...entry, credential: { ...entry.credential, access: "access-1+rotated" } } });
			}
			return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
		};
		const client = newClient("http://broker.invalid", fetchImpl);
		const remote = newRemote({ client, streamSnapshots: false });
		try {
			await remote.refreshSnapshot();
			const rows = remote.listAuthCredentials(PROVIDER);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.credential.type).toBe("oauth");
			expect(rows[0]?.resetAccountEvidence).toBeUndefined();
			expect(remote.getResetAccountEvidence(PROVIDER, 7)).toBeUndefined();

			const refreshed = await remote.refreshOAuthCredential(PROVIDER, 7, oauth());
			expect(refreshed.access).toBe("access-1+rotated");
			expect(refreshed.refresh).toBe(REMOTE_SENTINEL);
			expect(remote.getResetAccountEvidence(PROVIDER, 7)).toBeUndefined();
		} finally {
			remote.close();
		}
		expect(seen.length).toBeGreaterThan(0);
		for (const headers of seen) {
			expect(headers.get(CAPABILITIES_HEADER)?.split(",").map(value => value.trim())).toContain(RESET_CAPABILITY);
		}
	});
});

describe("two broker namespaces with colliding rows", () => {
	let left: Fixture;
	let right: Fixture;
	beforeAll(async () => {
		[left, right] = await Promise.all([startFixture(), startFixture()]);
	});
	afterAll(async () => {
		await Promise.all([stopFixture(left), stopFixture(right)]);
	});

	test("identical id and account metadata still yield distinguishable server proofs", async () => {
		expect(left.credentialId).toBe(right.credentialId);
		const [a, b] = await Promise.all([
			newClient(left.broker.url).fetchSnapshot(),
			newClient(right.broker.url).fetchSnapshot(),
		]);
		if (a.status !== 200 || b.status !== 200) throw new Error("expected 200 snapshots");
		const proofA = a.snapshot.credentials[0]!.resetAccountEvidence!;
		const proofB = b.snapshot.credentials[0]!.resetAccountEvidence!;
		expect(proofA.credentialId).toBe(proofB.credentialId);
		expect(proofA.accountId).toBe(proofB.accountId);
		expect(proofA.email).toBe(proofB.email);
		expect(proofA.authAuthority).not.toBe(proofB.authAuthority);
		expect(proofA.credentialFingerprint).not.toBe(proofB.credentialFingerprint);
		expect(sameEvidence(proofA, proofB)).toBe(false);
		expect(sameEvidence(proofA, serverEvidence(left))).toBe(true);
		expect(sameEvidence(proofB, serverEvidence(right))).toBe(true);

		// A mirror of broker A must answer with A's proof, never B's, for the colliding row.
		const remote = newRemote({ client: newClient(left.broker.url), initialSnapshot: a.snapshot, streamSnapshots: false });
		try {
			const mirrored = remote.getResetAccountEvidence(PROVIDER, left.credentialId);
			expect(sameEvidence(mirrored, proofA)).toBe(true);
			expect(sameEvidence(mirrored, proofB)).toBe(false);
		} finally {
			remote.close();
		}
	});

	test("a replacement broker at the same generation cannot validate an old namespace as unchanged", async () => {
		let destination = left.broker.url;
		const client = newClient("http://controlled-route.invalid", async (input, init) => {
			const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return fetch(new URL(requested.pathname + requested.search, destination), init);
		});
		const original = await client.fetchSnapshot();
		if (original.status !== 200) throw new Error("expected original snapshot");
		expect(right.storage.getGeneration()).toBe(original.generation);
		const unchanged = await client.fetchSnapshot({ ifGenerationGt: original.generation, waitMs: 1 });
		expect(unchanged.status).toBe(304);
		destination = right.broker.url;
		const replacement = await client.fetchSnapshot({ ifGenerationGt: original.generation, waitMs: 1 });
		expect(replacement.status).toBe(200);
		if (replacement.status !== 200) throw new Error("replacement namespace was hidden by a numeric generation");
		expect(replacement.snapshot.credentials[0]!.resetAccountEvidence).toEqual(serverEvidence(right));
		expect(sameEvidence(original.snapshot.credentials[0]!.resetAccountEvidence,
			replacement.snapshot.credentials[0]!.resetAccountEvidence)).toBe(false);
	});
});
