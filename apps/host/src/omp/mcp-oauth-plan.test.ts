import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { completeNativeMcpOAuthConfig, prepareNativeMcpOAuth } from "./mcp-oauth-plan";
import { runNativeMcpOAuth } from "./mcp-oauth-flow";
import { NativeLogin } from "../omp-accounts/login";
import type { LoginSnapshot } from "../omp-accounts/types";

const servers: Bun.Server<unknown>[] = [];
const databases: Database[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => server.stop(true)));
	for (const db of databases.splice(0)) db.close();
});

function context() {
	const db = new Database(":memory:"); databases.push(db);
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(db));
	const manager = new MCPManager(import.meta.dir, null);
	manager.setAuthStorage(authStorage);
	return { manager, authStorage, signal: new AbortController().signal };
}

function resourceServer(options: { protected?: boolean; dcr?: boolean; noMetadata?: boolean; slowMetadata?: boolean; scopes?: boolean; protectedTool?: boolean } = {}) {
	const requests: { path: string; method?: string; authorization: string | null }[] = [];
	const metadataStarted = Promise.withResolvers<void>();
	const metadataReleased = Promise.withResolvers<void>();
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const url = new URL(request.url), origin = url.origin;
		if (url.pathname === "/mcp") {
			if (request.method === "GET" && options.protected) {
				requests.push({ path: url.pathname, method: "legacy-get", authorization: request.headers.get("authorization") });
				return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/protected", scope="challenge:read"` } });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = await request.json() as { id?: number; method: string };
			requests.push({ path: url.pathname, method: body.method, authorization: request.headers.get("authorization") });
			if (options.protected) return new Response("Unauthorized", { status: 401, headers: {
				"WWW-Authenticate": `Bearer resource_metadata="${origin}/protected", scope="challenge:read"`,
			} });
			if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: {
				protocolVersion: "2025-03-26", capabilities: options.protectedTool ? { tools: {} } : {}, serverInfo: { name: "oauth-discovery-fixture", version: "1" },
			} });
			if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "protected_read", description: "Read the local fixture", inputSchema: { type: "object", properties: {} } }] } });
			if (body.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, result: request.headers.get("authorization") === "Bearer fixture-issued-access"
				? { content: [{ type: "text", text: "Native protected read completed." }] }
				: { isError: true, content: [{ type: "text", text: "Authorization required." }], _meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${origin}/protected", scope="resource:read"`] } } });
			return new Response(null, { status: 202 });
		}
		requests.push({ path: url.pathname, authorization: request.headers.get("authorization") });
		if (options.protectedTool && url.pathname === "/authorize") {
			const redirect = new URL(url.searchParams.get("redirect_uri")!);
			redirect.searchParams.set("code", "fixture-issued-code");
			redirect.searchParams.set("state", url.searchParams.get("state")!);
			return Response.redirect(redirect);
		}
		if (options.protectedTool && url.pathname === "/token") return Response.json({ access_token: "fixture-issued-access", refresh_token: "fixture-issued-refresh", expires_in: 3600, token_type: "Bearer" });
		if (options.noMetadata) return new Response(null, { status: 404 });
		if (url.pathname === "/protected" || url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			metadataStarted.resolve();
			if (options.slowMetadata) await metadataReleased.promise;
			return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], ...(options.scopes === false ? {} : { scopes_supported: ["resource:read"] }) });
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({
			issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, client_id: "metadata-client",
			...(options.dcr ? { registration_endpoint: `${origin}/register` } : {}),
		});
		return new Response(null, { status: 404 });
	} });
	servers.push(server);
	const origin = `http://127.0.0.1:${server.port}`;
	return { origin, requests, config: { type: "http", url: `${origin}/mcp` } as const, metadataStarted, metadataReleased };
}

test("actual anonymous MCP initialize still discovers protected OAuth and never injects stored tokens", async () => {
	const fixture = resourceServer(), ctx = context();
	const id = mcpOAuthCredentialId(fixture.config.url);
	const old = { type: "oauth" as const, access: "private-old-access", refresh: "private-old-refresh", expires: Date.now() - 1000 };
	await ctx.authStorage.set(id, old);
	const config = { ...fixture.config, oauth: { scope: "configured:scope" } };
	const before = JSON.stringify(config);
	const plan = await prepareNativeMcpOAuth({ ...ctx, config });
	expect(plan.flowConfig).toMatchObject({ authorizationUrl: `${fixture.origin}/authorize`, tokenUrl: `${fixture.origin}/token`, clientId: "metadata-client", scopes: "resource:read", resource: fixture.config.url, stripSameOriginResource: false });
	expect(fixture.requests.filter(row => row.method === "initialize")).toHaveLength(1);
	expect(fixture.requests.every(row => row.authorization === null)).toBe(true);
	expect(fixture.requests.some(row => row.path === "/token" || row.path === "/authorize")).toBe(false);
	expect(ctx.authStorage.get(id)).toEqual(old);
	expect(JSON.stringify(config)).toBe(before);
	const completed = completeNativeMcpOAuthConfig(plan, { credentialId: id, clientId: "metadata-client" });
	expect(completed).toEqual({ config, persist: false });
});

test("native 401 discovery follows resource metadata and carries challenge scope when metadata has none", async () => {
	const fixture = resourceServer({ protected: true, scopes: false });
	const plan = await prepareNativeMcpOAuth({ ...context(), config: fixture.config });
	expect(plan.flowConfig.scopes).toBe("challenge:read");
	expect(fixture.requests.map(row => row.path)).toContain("/protected");
	expect(plan.flowConfig.resource).toBe(fixture.config.url);
});

test("actual successful initialize does not suppress a tool-level authentication challenge", async () => {
	const fixture = resourceServer({ scopes: false });
	const plan = await prepareNativeMcpOAuth({ ...context(), config: fixture.config, challenge: {
		wwwAuthenticate: [`Bearer resource_metadata="${fixture.origin}/protected", scope="tool:write"`],
	} });
	expect(plan.flowConfig.scopes).toBe("tool:write");
	expect(fixture.requests.filter(row => row.method === "initialize")).toHaveLength(1);
	expect(fixture.requests.some(row => row.path === "/protected")).toBe(true);
});

test("actual legacy SSE handshake retains its private resource metadata challenge", async () => {
	const fixture = resourceServer({ protected: true, scopes: false });
	const plan = await prepareNativeMcpOAuth({ ...context(), config: { ...fixture.config, type: "sse" } });
	expect(plan.flowConfig.scopes).toBe("challenge:read");
	expect(fixture.requests.filter(row => row.method === "legacy-get")).toHaveLength(1);
	expect(fixture.requests.map(row => row.path)).toContain("/protected");
});

test("native DCR preference and configured/persisted/stored client pairs retain their matching secrets", async () => {
	const fixture = resourceServer({ dcr: true });
	const cases: { oauth?: MCPServerConfig["oauth"]; auth?: MCPServerConfig["auth"]; stored?: { clientId: string; clientSecret: string }; expectedId: string; expectedSecret: string }[] = [
		{ expectedId: "", expectedSecret: "" },
		{ stored: { clientId: "stored", clientSecret: "stored-secret" }, expectedId: "stored", expectedSecret: "stored-secret" },
		{ auth: { type: "oauth", credentialId: "mcp_oauth:legacy", clientId: "persisted", clientSecret: "persisted-secret" }, stored: { clientId: "stored", clientSecret: "stored-secret" }, expectedId: "persisted", expectedSecret: "persisted-secret" },
		{ oauth: { clientId: "configured", clientSecret: "configured-secret" }, auth: { type: "oauth", credentialId: "mcp_oauth:legacy", clientId: "persisted", clientSecret: "persisted-secret" }, stored: { clientId: "stored", clientSecret: "stored-secret" }, expectedId: "configured", expectedSecret: "configured-secret" },
		{ oauth: { clientId: "configured" }, stored: { clientId: "different", clientSecret: "must-not-pair" }, expectedId: "configured", expectedSecret: "" },
	];
	for (const item of cases) {
		const ctx = context();
		if (item.stored) await ctx.authStorage.set(item.auth?.credentialId ?? mcpOAuthCredentialId(fixture.config.url), {
			type: "oauth", access: "old", refresh: "old-refresh", expires: Date.now() + 60_000, ...item.stored,
		});
		const plan = await prepareNativeMcpOAuth({ ...ctx, config: { ...fixture.config, oauth: item.oauth, auth: item.auth } });
		expect(plan.flowConfig.clientId).toBe(item.expectedId);
		expect(plan.flowConfig.clientSecret).toBe(item.expectedSecret);
		expect(plan.flowConfig.registrationUrl).toBe(`${fixture.origin}/register`);
	}
});

test("environment values are used privately but raw secret placeholders survive native config write-back", async () => {
	const fixture = resourceServer(), ctx = context();
	const saved = { url: process.env.AGENT_DESKTOP_OAUTH_PLAN_URL, secret: process.env.AGENT_DESKTOP_OAUTH_PLAN_SECRET };
	process.env.AGENT_DESKTOP_OAUTH_PLAN_URL = fixture.config.url;
	process.env.AGENT_DESKTOP_OAUTH_PLAN_SECRET = "resolved-private-secret";
	try {
		const config: MCPServerConfig = { type: "http", url: "${AGENT_DESKTOP_OAUTH_PLAN_URL}", oauth: { clientId: "configured", clientSecret: "${AGENT_DESKTOP_OAUTH_PLAN_SECRET}" }, auth: { type: "oauth", credentialId: "mcp_oauth:legacy", resource: `${fixture.origin}/explicit-resource` } };
		const plan = await prepareNativeMcpOAuth({ ...ctx, config });
		expect(plan.flowConfig.clientSecret).toBe("resolved-private-secret");
		expect(plan.serverUrl).toBe(fixture.config.url);
		const written = completeNativeMcpOAuthConfig(plan, { credentialId: mcpOAuthCredentialId(plan.serverUrl), clientId: "configured", resource: fixture.config.url });
		expect(written.persist).toBe(true);
		expect("url" in written.config && written.config.url).toBe("${AGENT_DESKTOP_OAUTH_PLAN_URL}");
		expect(written.config.auth?.clientSecret).toBe("${AGENT_DESKTOP_OAUTH_PLAN_SECRET}");
		expect(JSON.stringify(written)).not.toContain("resolved-private-secret");
		expect(config.auth?.credentialId).toBe("mcp_oauth:legacy");
	} finally {
		if (saved.url === undefined) delete process.env.AGENT_DESKTOP_OAUTH_PLAN_URL; else process.env.AGENT_DESKTOP_OAUTH_PLAN_URL = saved.url;
		if (saved.secret === undefined) delete process.env.AGENT_DESKTOP_OAUTH_PLAN_SECRET; else process.env.AGENT_DESKTOP_OAUTH_PLAN_SECRET = saved.secret;
	}
});

test("JSON error endpoints retain protected metadata scopes without pairing a secret-only config to the metadata client", async () => {
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		const url = new URL(request.url); requests.push(url.pathname);
		if (url.pathname === "/protected") return Response.json({ scopes_supported: ["protected:read"] });
		return Response.json({ oauth: { authorization_url: `${url.origin}/authorize?client_id=metadata-client`, token_url: `${url.origin}/token` } }, {
			status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/protected"` },
		});
	} });
	servers.push(server);
	const config: MCPServerConfig = { type: "http", url: `http://127.0.0.1:${server.port}/mcp`,
		oauth: { clientSecret: "configured-only-secret" }, auth: { type: "oauth", credentialId: "mcp_oauth:legacy" },
	};
	const plan = await prepareNativeMcpOAuth({ ...context(), config });
	expect(plan.flowConfig).toMatchObject({ clientId: "metadata-client", clientSecret: "", scopes: "protected:read", resource: config.url, stripSameOriginResource: true });
	expect(requests).toEqual(["/mcp", "/protected"]);
	const completed = completeNativeMcpOAuthConfig(plan, { credentialId: mcpOAuthCredentialId(plan.serverUrl), clientId: "metadata-client" });
	expect(completed.persist).toBe(true);
	expect(completed.config.auth).toMatchObject({ type: "oauth", clientId: "metadata-client" });
	expect(completed.config.auth?.clientSecret).toBeUndefined();
	expect(completed.config.auth?.resource).toBeUndefined();
	expect(completed.config.oauth?.clientId).toBeUndefined();
	expect(completed.config.oauth?.clientSecret).toBe("configured-only-secret");
});

test("stdio, disabled, and pre-aborted requests fail before any native connection or command", async () => {
	const fixture = resourceServer(), ctx = context();
	await expect(prepareNativeMcpOAuth({ ...ctx, config: { type: "stdio", command: "must-never-run" } })).rejects.toThrow("own process");
	await expect(prepareNativeMcpOAuth({ ...ctx, config: { ...fixture.config, enabled: false } })).rejects.toThrow("Enable");
	await expect(prepareNativeMcpOAuth({ ...ctx, signal: AbortSignal.abort(new Error("cancelled fixture")), config: fixture.config })).rejects.toThrow("cancelled fixture");
	expect(fixture.requests).toHaveLength(0);
});

test("cancelled native metadata discovery returns no plan and changes no existing credential", async () => {
	const fixture = resourceServer({ slowMetadata: true }), ctx = context(), abort = new AbortController();
	const id = mcpOAuthCredentialId(fixture.config.url);
	const old = { type: "oauth" as const, access: "old", refresh: "old-refresh", expires: Date.now() + 60_000 };
	await ctx.authStorage.set(id, old);
	const pending = prepareNativeMcpOAuth({ ...ctx, config: fixture.config, signal: abort.signal });
	await fixture.metadataStarted.promise;
	abort.abort(new Error("cancelled metadata fixture"));
	await expect(pending).rejects.toThrow("cancelled metadata fixture");
	fixture.metadataReleased.resolve();
	expect(ctx.authStorage.get(id)).toEqual(old);
	expect(fixture.requests.some(row => row.path === "/authorize" || row.path === "/token")).toBe(false);
});

test("an unprotected server with no metadata is not falsely marked authorized", async () => {
	const fixture = resourceServer({ noMetadata: true });
	await expect(prepareNativeMcpOAuth({ ...context(), config: fixture.config })).rejects.toThrow("advertises no OAuth");
});

test("cancellation interrupts a held native SSE handshake even with native timeouts disabled", async () => {
	const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
		started.resolve();
		await release.promise;
		return new Response(null, { status: 401 });
	} });
	servers.push(server);
	const abort = new AbortController();
	const pending = prepareNativeMcpOAuth({ ...context(), signal: abort.signal, config: { type: "sse", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 0 } });
	const outcome = pending.then(() => "unexpected-plan", () => "cancelled");
	try {
		await started.promise;
		abort.abort(new Error("cancelled SSE fixture"));
		expect(await Promise.race([outcome, Bun.sleep(1000).then(() => "still-pending")])).toBe("cancelled");
	} finally { release.resolve(); await outcome; }
});

test.each(["initial", "refreshed"])("actual %s native tool challenge authorizes through callbacks, reconnects, and retries the protected read once", async mode => {
	const fixture = resourceServer({ protectedTool: true }), ctx = context();
	const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
	const callbackPort = reserve.port!;
	await reserve.stop(true);
	const config = { ...fixture.config, oauth: { clientId: "fixture-client", callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback` } };
	const manager = new MCPManager(import.meta.dir, null, async () => ({
		configs: { fixture: config }, sources: { fixture: { provider: "fixture", providerName: "Disposable OAuth fixture", path: "/fixture/mcp.json", level: "project" } }, exaApiKeys: [],
	}));
	manager.setAuthStorage(ctx.authStorage);
	const snapshots: LoginSnapshot[] = [];
	const callbackErrors: unknown[] = [];
	let callbacks = 0, authorizationRequests = 0;
	manager.setAuthHandler(async (name, challenge) => {
		try {
		callbacks += 1;
		const plan = await prepareNativeMcpOAuth({ ...ctx, manager, config: manager.getServerConfig(name)!, challenge });
		let completed: ReturnType<typeof completeNativeMcpOAuthConfig> | undefined;
		let navigation: Promise<Response> | undefined;
		const login = new NativeLogin("mcp-fixture", async loginCallbacks => {
			const result = await runNativeMcpOAuth({ serverUrl: plan.serverUrl, config: plan.flowConfig, authStorage: ctx.authStorage, callbacks: loginCallbacks });
			completed = completeNativeMcpOAuthConfig(plan, result);
			return { type: "oauth" };
		}, snapshot => {
			snapshots.push(snapshot);
			if (snapshot.auth && !navigation) {
				authorizationRequests += 1;
				navigation = fetch(snapshot.auth.url);
				void navigation.catch(() => undefined);
			}
		});
		expect((await login.completion).status).toBe("succeeded");
		await navigation;
		expect(completed?.persist).toBe(false);
		return completed?.config;
		} catch (error) { callbackErrors.push(error instanceof Error ? error.message : String(error)); throw error; }
	});
	try {
		await manager.discoverAndConnect();
		await manager.waitForConnection("fixture");
		for (let attempt = 0; !manager.getTools().length && attempt < 200; attempt++) await Bun.sleep(5);
		if (mode === "refreshed") await manager.refreshServerTools("fixture");
		expect(manager.getTools()).toHaveLength(1);
		const result = await manager.getTools()[0]!.execute("native-oauth-fixture-read", {}, undefined, {} as never);
		expect(callbackErrors).toEqual([]);
		expect(result.content).toEqual([{ type: "text", text: "Native protected read completed." }]);
		expect(callbacks).toBe(1);
		expect(authorizationRequests).toBe(1);
		expect(fixture.requests.filter(row => row.path === "/token")).toHaveLength(1);
		expect(fixture.requests.filter(row => row.method === "tools/call").map(row => row.authorization)).toEqual([null, "Bearer fixture-issued-access"]);
		expect(manager.getConnectionStatus("fixture")).toBe("connected");
		expect(JSON.stringify(snapshots)).not.toContain("fixture-issued-access");
		expect(JSON.stringify(snapshots)).not.toContain("fixture-issued-refresh");
		expect(JSON.stringify(snapshots)).not.toContain("fixture-issued-code");
	} finally { await manager.disconnectAll(); }
});
