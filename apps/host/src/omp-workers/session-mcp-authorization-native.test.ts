import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FileLock } from "@oh-my-pi/pi-natives";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { MCP_CONFIG_SCHEMA_URL } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeMcpAuthorizationSnapshot } from "@agent-desktop/shared";
import { WorkerRuntime, type WorkerSession } from "./runtime";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function unusedPort(): Promise<number> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
	const port = server.port!;
	await server.stop(true);
	return port;
}

function protectedMcp(resources = false) {
	const resourceEntered = Promise.withResolvers<void>(), resourceRelease = Promise.withResolvers<void>();
	const requests: Array<{ method: string; authorization: string | null }> = [];
	let tokenExchanges = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/mcp") {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = await request.json() as { id?: number; method: string };
			requests.push({ method: body.method, authorization: request.headers.get("authorization") });
			if (request.headers.get("authorization") !== "Bearer worker-oauth-access") return new Response("authorization required", {
				status: 401,
				headers: { "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/protected", scope="fixture:read"` },
			});
			if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: {
				protocolVersion: "2025-03-26", capabilities: resources ? { resources: {} } : {}, serverInfo: { name: "worker-oauth", version: "1" },
			} });
			if (resources && body.method === "resources/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { resources: [{ uri: "fixture://held", name: "Held resource" }] } });
			if (resources && body.method === "resources/templates/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { resourceTemplates: [] } });
			if (resources && body.method === "resources/read") {
				resourceEntered.resolve();
				await resourceRelease.promise;
				return Response.json({ jsonrpc: "2.0", id: body.id, result: { contents: [{ uri: "fixture://held", text: "Original held read completed" }] } });
			}
			return new Response(null, { status: 202 });
		}
		if (url.pathname === "/protected" || url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin], scopes_supported: ["fixture:read"] });
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({
			issuer: url.origin,
			authorization_endpoint: `${url.origin}/authorize`,
			token_endpoint: `${url.origin}/token`,
			client_id: "worker-oauth-client",
		});
		if (url.pathname === "/token") {
			tokenExchanges++;
			return Response.json({ access_token: "worker-oauth-access", refresh_token: "worker-oauth-refresh", expires_in: 3600, token_type: "Bearer" });
		}
		return new Response(null, { status: 404 });
	} });
	return { resourceEntered: resourceEntered.promise, releaseResource: () => resourceRelease.resolve(), server, origin: `http://127.0.0.1:${server.port}`, requests, tokenExchanges: () => tokenExchanges };
}

async function fixture(options: { resources?: boolean; observeForgetQueue?: boolean } = {}) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-mcp-authorization-worker-")));
	const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	const remote = protectedMcp(options.resources);
	const callbackPort = await unusedPort();
	// no-provider-worker blocks outbound fetch before importing the production
	// entrypoint. This isolated extension permits only the exact loopback MCP,
	// OAuth, and callback origins owned by this contract test.
	const loopback = path.join(root, "loopback-fetch.ts");
	const allowedOrigins = [remote.origin, `http://127.0.0.1:${callbackPort}`];
	await writeFile(loopback, `const nativeFetch=Bun.fetch.bind(Bun);\nconst allowed=new Set(${JSON.stringify(allowedOrigins)});\nexport default function(){globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{const raw=input instanceof Request?input.url:input instanceof URL?input.href:String(input);if(!allowed.has(new URL(raw).origin))throw new Error('Outbound fetch is disabled outside the owned OAuth fixture');return nativeFetch(input,init);},{preconnect:()=>{}}) as typeof fetch;}\n`);
	await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(loopback)}\nretry:\n  enabled: false\n`);
	await writeFile(path.join(agentDir, "mcp.json"), json({ marker: "preserved", mcpServers: { fixture: {
		type: "http", url: `${remote.origin}/mcp`,
		oauth: { clientId: "worker-oauth-client", callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback` },
	} } }));
	const forgetQueued = path.join(root, "forget-queued");
	let workerPath = path.join(import.meta.dir, "fixtures", "no-provider-worker.ts");
	if (options.observeForgetQueue) {
		// Observe the real queue boundary, without replacing its implementation or
		// introducing a production test hook. Outbound fetch is blocked first.
		const originalWorker = workerPath;
		workerPath = path.join(root, "observed-worker.ts");
		await writeFile(workerPath, `globalThis.fetch=Object.assign(async()=>{throw new Error('Outbound fetch disabled in owned fixture');},{preconnect:()=>{}}) as typeof fetch;
const {writeFileSync}=await import('node:fs');
const {NativeSessionMcp}=await import(${JSON.stringify(path.join(import.meta.dir, "../omp/mcp-session.ts"))});
const original=NativeSessionMcp.prototype.unauthorize;
NativeSessionMcp.prototype.unauthorize=function(...args){const result=original.apply(this,args);writeFileSync(${JSON.stringify(forgetQueued)},'queued');return result;};
await import(${JSON.stringify(originalWorker)});
`);
	}
	const runtime = new WorkerRuntime({
		agentDir,
		workerPath,
		environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" },
	});
	return { root, agentDir, cwd, remote, callbackPort, runtime, forgetQueued };
}

async function waitAuthorization(session: WorkerSession, predicate: (value: NativeMcpAuthorizationSnapshot) => boolean) {
	for (let attempt = 0; attempt < 600; attempt++) {
		const value = await session.getSessionMcpAuthorization();
		if (value && predicate(value)) return value;
		await Bun.sleep(5);
	}
	throw new Error("Native worker authorization did not reach the expected state.");
}

async function manualPrompt(session: WorkerSession) {
	return waitAuthorization(session, value => Boolean(value.login.auth && value.login.prompts.some(prompt => prompt.kind === "manual-code")));
}

function manualRedirect(snapshot: NativeMcpAuthorizationSnapshot): { requestId: string; value: string } {
	const requestId = snapshot.login.prompts.find(prompt => prompt.kind === "manual-code")!.requestId;
	const authorization = new URL(snapshot.login.auth!.url);
	const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
	redirect.searchParams.set("code", "worker-oauth-code");
	redirect.searchParams.set("state", authorization.searchParams.get("state")!);
	return { requestId, value: redirect.toString() };
}

test("real worker forgets its authorized MCP server, consumes the original revision and persists native slash output without a provider", async () => {
	const value = await fixture();
	let session: WorkerSession | undefined;
	try {
		session = await value.runtime.create({ cwd: value.cwd, interactions: true });
		const before = await session.getSessionMcp();
		expect(before.canForgetAuthorization).toBe(true);
		await session.startSessionMcpAuthorization({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" });
		const pending = await manualPrompt(session), input = manualRedirect(pending);
		await session.respondSessionMcpAuthorization({ authorizationId: pending.authorizationId, requestId: input.requestId, response: { value: input.value } });
		await waitAuthorization(session, snapshot => snapshot.status === "succeeded");
		const configPath = path.join(value.agentDir, "mcp.json");
		const configBefore = JSON.parse(await readFile(configPath, "utf8"));
		// Native URL OAuth stores a profile-scoped row without adding config.auth.
		expect(configBefore.mcpServers.fixture.auth).toBeUndefined();
		const credentialId = mcpOAuthCredentialId(`${value.remote.origin}/mcp`, "default");
		const credentialRows = (phase: string) => {
			const database = new Database(path.join(value.agentDir, "agent.db"), { readonly: true });
			try {
				// Observe durable native storage without reading or printing token data.
				const rows = database.query("SELECT credential_type, disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id")
					.all(credentialId);
				console.info("Owned MCP OAuth credential metadata", JSON.stringify({ phase, rows }));
				return rows;
			} finally { database.close(); }
		};
		expect(credentialRows("authorized")).toEqual([{ credential_type: "oauth", disabled_cause: null }]);
		const current = await session.getSessionMcp();
		const request = { epoch: current.epoch, expectedRevision: current.revision, serverName: "fixture" };
		expect(current.servers.find(server => server.name === "fixture")?.status).toBe("connected");
		const requestsBefore = value.remote.requests.length;
		const cleared = await session.unauthorizeSessionMcp(request);
		expect(cleared.epoch).toBe(current.epoch);
		expect(cleared.revision).toBeGreaterThan(current.revision);
		expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ $schema: MCP_CONFIG_SCHEMA_URL, ...configBefore });
		expect(credentialRows("forgotten through session RPC")).toEqual([{ credential_type: "oauth", disabled_cause: "deleted by user" }]);
		// Reload must challenge again, rather than reuse a cached access token.
		for (let attempt = 0; attempt < 600; attempt++) {
			const state = await session.getSessionMcp();
			if (state.servers.find(server => server.name === "fixture")?.status === "disconnected"
				&& value.remote.requests.slice(requestsBefore).some(request => request.method === "initialize")) break;
			await Bun.sleep(5);
		}
		expect((await session.getSessionMcp()).servers.find(server => server.name === "fixture")?.status).toBe("disconnected");
		const reloadedRequests = value.remote.requests.slice(requestsBefore);
		expect(reloadedRequests.some(request => request.method === "initialize")).toBe(true);
		expect(reloadedRequests.every(request => request.authorization === null)).toBe(true);
		expect(JSON.parse(await readFile(configPath, "utf8")).mcpServers.fixture.auth).toBeUndefined();
		expect(await session.getSessionMcpAuthorization()).toBeNull();
		await expect(session.unauthorizeSessionMcp(request)).rejects.toThrow("changed");
		expect(value.remote.tokenExchanges()).toBe(1);
		expect(await session.getMessages()).toEqual([]);
		// Reauthorize so the slash path also clears a real active credential,
		// rather than merely producing a receipt for an already-cleared server.
		const slashTicket = await session.getSessionMcp();
		await session.startSessionMcpAuthorization({ epoch: slashTicket.epoch, expectedRevision: slashTicket.revision, serverName: "fixture" });
		const slashPending = await manualPrompt(session), slashInput = manualRedirect(slashPending);
		await session.respondSessionMcpAuthorization({ authorizationId: slashPending.authorizationId, requestId: slashInput.requestId, response: { value: slashInput.value } });
		await waitAuthorization(session, snapshot => snapshot.status === "succeeded");
		expect(credentialRows("reauthorized before slash command")).toEqual([
			{ credential_type: "oauth", disabled_cause: "deleted by user" },
			{ credential_type: "oauth", disabled_cause: null },
		]);
		const run = session.startPrompt("/mcp unauth fixture");
		expect(await run.accepted).toMatchObject({ kind: "native-command", command: "mcp", output: 'Cleared stored OAuth authorization for "fixture".' });
		expect(await run.completion).toBe(false);
		expect((await session.getMessages()).filter(message => message.role === "user")).toHaveLength(0);
		const originalFile = session.sessionFile;
		await session.dispose();
		session = await value.runtime.open({ sessionFile: originalFile, interactions: true });
		expect(session.sessionFile).toBe(originalFile);
		expect((await session.getMessages()).some(message => message.commandOutput?.output === 'Cleared stored OAuth authorization for "fixture".')).toBe(true);
		expect(value.remote.tokenExchanges()).toBe(2);
		expect(credentialRows("reopened after slash command")).toEqual([
			{ credential_type: "oauth", disabled_cause: "deleted by user" },
			{ credential_type: "oauth", disabled_cause: "deleted by user" },
		]);
		expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ $schema: MCP_CONFIG_SCHEMA_URL, ...configBefore });
	} finally {
		await session?.dispose().catch(() => undefined);
		await value.runtime.dispose();
		await value.remote.server.stop(true);
		await rm(value.root, { recursive: true, force: true });
	}
}, 30_000);

test("real worker authorization fences native mutations, accepts one manual redirect, and reconnects without transcript writes", async () => {
	const value = await fixture();
	let session: WorkerSession | undefined;
	try {
		session = await value.runtime.create({ cwd: value.cwd, interactions: true, approvalOverride: "yolo" });
		const transcriptBefore = await readFile(session.sessionFile, "utf8");
		const ticket = await session.getSessionMcp();
		expect(ticket.servers.find(server => server.name === "fixture")).toBeDefined();
		const started = await session.startSessionMcpAuthorization({ epoch: ticket.epoch, expectedRevision: ticket.revision, serverName: "fixture" });
		expect(started).toMatchObject({ serverName: "fixture", status: "running" });
		const pending = await manualPrompt(session);
		const input = manualRedirect(pending);

		await expect(session.respondSessionMcpAuthorization({ authorizationId: "wrong-authorization", requestId: input.requestId, response: { value: input.value } }))
			.rejects.toThrow("owner changed");
		await expect(session.respondSessionMcpAuthorization({ authorizationId: pending.authorizationId, requestId: "wrong-request", response: { value: input.value } }))
			.rejects.toThrow("no longer pending");
		await expect(session.cancelSessionMcpAuthorization("wrong-authorization")).rejects.toThrow("owner changed");
		await expect(session.respondSessionMcpAuthorization({ authorizationId: pending.authorizationId, requestId: "bad\0request", response: { value: input.value } }))
			.rejects.toThrow("identity");

		const prompt = session.startPrompt("must not reach a provider");
		await expect(prompt.accepted).rejects.toThrow("busy");
		await prompt.completion.catch(() => false);
		await expect(session.setModel({ provider: "missing-provider", id: "missing-model" })).rejects.toThrow("busy");
		await expect(session.reloadSessionMcp({ epoch: ticket.epoch, expectedRevision: ticket.revision })).rejects.toThrow("busy");

		await session.respondSessionMcpAuthorization({ authorizationId: pending.authorizationId, requestId: input.requestId, response: { value: input.value } });
		await expect(session.respondSessionMcpAuthorization({ authorizationId: pending.authorizationId, requestId: input.requestId, response: { value: input.value } }))
			.rejects.toThrow("no longer pending");
		const complete = await waitAuthorization(session, snapshot => snapshot.status === "succeeded");
		expect(complete).toMatchObject({ phase: "finished", credentialsStored: true, reconnected: true });
		expect((await session.getSessionMcp()).servers.find(server => server.name === "fixture")?.status).toBe("connected");
		expect(value.remote.tokenExchanges()).toBe(1);
		expect(value.remote.requests.some(request => request.method === "initialize" && request.authorization === "Bearer worker-oauth-access")).toBe(true);
		expect(await session.getMessages()).toEqual([]);
		const transcriptAfter = await readFile(session.sessionFile, "utf8");
		expect(transcriptAfter).toBe(transcriptBefore);
		const publicBytes = transcriptAfter + await readFile(path.join(value.agentDir, "mcp.json"), "utf8") + JSON.stringify(complete);
		for (const secret of ["worker-oauth-access", "worker-oauth-refresh", "worker-oauth-code"]) expect(publicBytes).not.toContain(secret);
	} finally {
		await session?.dispose().catch(() => undefined);
		await value.runtime.dispose();
		await value.remote.server.stop(true);
		await rm(value.root, { recursive: true, force: true });
	}
}, 30_000);

test("cancel and worker disposal drain authorization, release callback ownership, and reject an old identity in a new generation", async () => {
	const value = await fixture();
	let session: WorkerSession | undefined;
	try {
		session = await value.runtime.create({ cwd: value.cwd, interactions: true });
		const ticket = await session.getSessionMcp();
		await session.startSessionMcpAuthorization({ epoch: ticket.epoch, expectedRevision: ticket.revision, serverName: "fixture" });
		const pending = await manualPrompt(session);
		expect((await session.cancelSessionMcpAuthorization(pending.authorizationId)).status).toBe("cancelling");
		const cancelled = await waitAuthorization(session, snapshot => snapshot.status === "cancelled");
		expect(cancelled).toMatchObject({ credentialsStored: false, reconnected: false });
		expect(value.remote.tokenExchanges()).toBe(0);
		let rebound = Bun.serve({ hostname: "127.0.0.1", port: value.callbackPort, fetch: () => new Response("released") });
		await rebound.stop(true);

		const secondTicket = await session.getSessionMcp();
		await session.startSessionMcpAuthorization({ epoch: secondTicket.epoch, expectedRevision: secondTicket.revision, serverName: "fixture" });
		await manualPrompt(session);
		await session.abort();
		const stopped = await waitAuthorization(session, snapshot => snapshot.status === "cancelled");
		expect(stopped).toMatchObject({ credentialsStored: false, reconnected: false });
		rebound = Bun.serve({ hostname: "127.0.0.1", port: value.callbackPort, fetch: () => new Response("released") });
		await rebound.stop(true);

		const thirdTicket = await session.getSessionMcp();
		await session.startSessionMcpAuthorization({ epoch: thirdTicket.epoch, expectedRevision: thirdTicket.revision, serverName: "fixture" });
		const disposed = await manualPrompt(session);
		const oldSessionFile = session.sessionFile;
		await session.dispose();
		session = undefined;
		rebound = Bun.serve({ hostname: "127.0.0.1", port: value.callbackPort, fetch: () => new Response("released") });
		await rebound.stop(true);

		const reopened = await value.runtime.open({ sessionFile: oldSessionFile, interactions: true });
		session = reopened;
		expect(await reopened.getSessionMcpAuthorization()).toBeNull();
		await expect(reopened.respondSessionMcpAuthorization({
			authorizationId: disposed.authorizationId,
			requestId: disposed.login.prompts[0]!.requestId,
			response: { value: "http://127.0.0.1/callback?code=old&state=old" },
		})).rejects.toThrow("owner changed");
		expect(await reopened.getMessages()).toEqual([]);
		expect(value.remote.tokenExchanges()).toBe(0);
	} finally {
		await session?.dispose().catch(() => undefined);
		await value.runtime.dispose();
		await value.remote.server.stop(true);
		await rm(value.root, { recursive: true, force: true });
	}
}, 30_000);

async function authorizeFixture(session: WorkerSession) {
	const before = await session.getSessionMcp();
	await session.startSessionMcpAuthorization({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" });
	const pending = await manualPrompt(session), input = manualRedirect(pending);
	await session.respondSessionMcpAuthorization({ authorizationId: pending.authorizationId, requestId: input.requestId, response: { value: input.value } });
	await waitAuthorization(session, snapshot => snapshot.status === "succeeded");
}

function activeFixtureCredentials(value: Awaited<ReturnType<typeof fixture>>) {
	const database = new Database(path.join(value.agentDir, "agent.db"), { readonly: true });
	try {
		return (database.query("SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL")
			.get(mcpOAuthCredentialId(`${value.remote.origin}/mcp`, "default")) as { count: number }).count;
	} finally { database.close(); }
}

async function waitForFixture(predicate: () => boolean | Promise<boolean>, description: string) {
	for (let attempt = 0; attempt < 600; attempt++) {
		if (await predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Owned fixture did not reach ${description}.`);
}

test("Stop prevents queued slash unauth from mutating after a held native resource read releases", async () => {
	const value = await fixture({ resources: true, observeForgetQueue: true });
	let session: WorkerSession | undefined;
	try {
		session = await value.runtime.create({ cwd: value.cwd, interactions: true });
		await authorizeFixture(session);
		await waitForFixture(async () => (await session!.getSessionMcp()).servers[0]?.resourceCount === 1, "resource catalog");
		const ticket = await session.getSessionMcp();
		const configBefore = await readFile(path.join(value.agentDir, "mcp.json"), "utf8");
		const transcriptBefore = await readFile(session.sessionFile, "utf8");
		const connectionsBefore = value.remote.requests.filter(request => request.method === "initialize").length;
		const reading = session.readSessionMcpResource({ epoch: ticket.epoch, expectedRevision: ticket.revision, serverName: "fixture", uri: "fixture://held" });
		await value.remote.resourceEntered;
		const run = session.startPrompt("/mcp unauth fixture");
		const accepted = run.accepted.then(receipt => ({ receipt, error: null }), error => ({ receipt: null, error }));
		const completed = run.completion.then(result => ({ result, error: null }), error => ({ result: null, error }));
		await waitForFixture(() => Bun.file(value.forgetQueued).exists(), "actual clearing queue admission");
		expect(activeFixtureCredentials(value)).toBe(1);
		await session.abort();
		value.remote.releaseResource();
		expect((await reading).contents).toEqual([{ uri: "fixture://held", text: "Original held read completed" }]);
		const outcome = await accepted;
		await completed;
		expect(outcome.receipt).toBeNull();
		expect(outcome.error).toBeInstanceOf(Error);
		expect(activeFixtureCredentials(value)).toBe(1);
		expect(await readFile(path.join(value.agentDir, "mcp.json"), "utf8")).toBe(configBefore);
		expect(await readFile(session.sessionFile, "utf8")).toBe(transcriptBefore);
		expect(value.remote.requests.filter(request => request.method === "initialize")).toHaveLength(connectionsBefore);
		// The next prompt owns a fresh signal: an explicit new command still works.
		const control = session.startPrompt("/mcp unauth fixture");
		expect(await control.accepted).toMatchObject({ kind: "native-command", command: "mcp", output: 'Cleared stored OAuth authorization for "fixture".' });
		expect(await control.completion).toBe(false);
		expect(activeFixtureCredentials(value)).toBe(0);
	} finally {
		value.remote.releaseResource();
		await session?.dispose().catch(() => undefined);
		await value.runtime.dispose();
		await value.remote.server.stop(true);
		await rm(value.root, { recursive: true, force: true });
	}
}, 30_000);

test("Stop during native config-lock wait retains completed credential removal but prevents later config writes and reload", async () => {
	const value = await fixture();
	let session: WorkerSession | undefined;
	let lock: ReturnType<typeof FileLock.tryAcquire> | undefined;
	try {
		session = await value.runtime.create({ cwd: value.cwd, interactions: true });
		await authorizeFixture(session);
		const file = path.join(value.agentDir, "mcp.json"), configBefore = await readFile(file, "utf8");
		const transcriptBefore = await readFile(session.sessionFile, "utf8");
		const connectionsBefore = value.remote.requests.filter(request => request.method === "initialize").length;
		lock = FileLock.tryAcquire(`${file}.lock`);
		expect(lock.acquired).toBe(true);
		const run = session.startPrompt("/mcp unauth fixture");
		const accepted = run.accepted.then(receipt => ({ receipt, error: null }), error => ({ receipt: null, error }));
		const completed = run.completion.then(result => ({ result, error: null }), error => ({ result: null, error }));
		await waitForFixture(() => activeFixtureCredentials(value) === 0, "durable native credential removal before config commit");
		expect(await readFile(file, "utf8")).toBe(configBefore);
		await session.abort();
		lock.release(); lock = undefined;
		const outcome = await accepted;
		await completed;
		expect(outcome.receipt).toBeNull();
		expect(outcome.error?.message).toContain("may already have changed");
		expect(activeFixtureCredentials(value)).toBe(0);
		expect(await readFile(file, "utf8")).toBe(configBefore);
		expect(await readFile(session.sessionFile, "utf8")).toBe(transcriptBefore);
		expect(value.remote.requests.filter(request => request.method === "initialize")).toHaveLength(connectionsBefore);
	} finally {
		lock?.release();
		await session?.dispose().catch(() => undefined);
		await value.runtime.dispose();
		await value.remote.server.stop(true);
		await rm(value.root, { recursive: true, force: true });
	}
}, 30_000);
