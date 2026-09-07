import { expect, test } from "bun:test";
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

function protectedMcp() {
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
				protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "worker-oauth", version: "1" },
			} });
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
	return { server, origin: `http://127.0.0.1:${server.port}`, requests, tokenExchanges: () => tokenExchanges };
}

async function fixture() {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-mcp-authorization-worker-")));
	const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	const remote = protectedMcp();
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
	const runtime = new WorkerRuntime({
		agentDir,
		workerPath: path.join(import.meta.dir, "fixtures", "no-provider-worker.ts"),
		environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" },
	});
	return { root, agentDir, cwd, remote, callbackPort, runtime };
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
