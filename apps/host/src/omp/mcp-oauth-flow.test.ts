import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { mcpOAuthCredentialId, type MCPStoredOAuthCredential } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { LoginSnapshot } from "../omp-accounts/types";
import { NativeLogin } from "../omp-accounts/login";
import { runNativeMcpOAuth } from "./mcp-oauth-flow";

const privateValues = {
  access: "fixture-private-access",
  refresh: "fixture-private-refresh",
  code: "fixture-private-code",
  clientSecret: "fixture-private-client-secret",
};

const servers: Bun.Server<unknown>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function storage(): AuthStorage {
  return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
}

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("Fixture failed to reserve a callback port");
  return port;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function issuer(options: { dcr?: boolean } = {}) {
  const observed: { auth?: URL; token?: URLSearchParams; registrations: number } = { registrations: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/authorize") {
        observed.auth = url;
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", privateValues.code);
        redirect.searchParams.set("state", url.searchParams.get("state")!);
        return Response.redirect(redirect, 302);
      }
      if (url.pathname === "/register" && options.dcr) {
        observed.registrations += 1;
        return Response.json({ client_id: "fixture-dcr-client", client_secret: privateValues.clientSecret });
      }
      if (url.pathname === "/token") {
        observed.token = new URLSearchParams(await request.text());
        return Response.json({
          access_token: privateValues.access,
          refresh_token: privateValues.refresh,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  return { origin, observed };
}

describe("native MCP OAuth adapter", () => {
  test("runs the real callback/PKCE flow and exposes no credential material through NativeLogin snapshots", async () => {
    const { origin, observed } = issuer();
    const callbackPort = await unusedPort();
    const authStorage = storage();
    const snapshots: LoginSnapshot[] = [];
    let login!: NativeLogin;
    let driven = false;
    login = new NativeLogin("mcp-fixture", async callbacks => {
      const result = await runNativeMcpOAuth({
        serverUrl: `${origin}/mcp`, authStorage, callbacks,
        config: {
          authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`,
          clientId: "fixture-client", callbackPort,
          redirectUri: `http://127.0.0.1:${callbackPort}/callback`, resource: `${origin}/mcp`,
        },
      });
      expect(result.credentialId).toBe(mcpOAuthCredentialId(`${origin}/mcp`));
      return { type: "oauth" };
    }, snapshot => {
      snapshots.push(snapshot);
      if (snapshot.auth && !driven) {
        driven = true;
        void fetch(snapshot.auth.url, { redirect: "follow" });
      }
    });

    expect((await login.completion).status).toBe("succeeded");
    const credentialId = mcpOAuthCredentialId(`${origin}/mcp`);
    const stored = authStorage.get(credentialId) as MCPStoredOAuthCredential;
    expect(stored).toMatchObject({
      type: "oauth", access: privateValues.access, refresh: privateValues.refresh,
      tokenUrl: `${origin}/token`, clientId: "fixture-client",
      resource: `${origin}/mcp`, authorizationUrl: `${origin}/authorize`,
    });
    const verifier: string = observed.token?.get("code_verifier") ?? "";
    expect(verifier).toBeTruthy();
    if (!verifier) throw new Error("Fixture token request omitted its PKCE verifier");
    expect(observed.token?.get("code")).toBe(privateValues.code);
    const challenge = observed.auth?.searchParams.get("code_challenge") ?? "";
    expect(challenge).toBeTruthy();
    expect(base64url(createHash("sha256").update(verifier).digest())).toBe(challenge);
    expect(observed.auth?.searchParams.get("state")).toBeTruthy();
    const projection = JSON.stringify(snapshots);
    expect(projection).not.toContain(privateValues.access);
    expect(projection).not.toContain(privateValues.refresh);
    expect(projection).not.toContain(privateValues.code);
    expect(login.snapshot().auth).toBeUndefined();
  });

  test("accepts a manually pasted redirect and stores dynamic client registration material", async () => {
    const { origin, observed } = issuer({ dcr: true });
    const callbackPort = await unusedPort();
    const authStorage = storage();
    let authUrl: string | undefined;
    const result = await runNativeMcpOAuth({
      serverUrl: `${origin}/mcp`, authStorage,
      config: {
        authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, registrationUrl: `${origin}/register`,
        callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      },
      callbacks: {
        onAuth(info) { authUrl = info.url; },
        async onPrompt() { throw new Error("unexpected prompt"); },
        async onManualCodeInput() {
          while (!authUrl) await Bun.sleep(1);
          const url = new URL(authUrl);
          return `${url.searchParams.get("redirect_uri")}?code=${privateValues.code}&state=${url.searchParams.get("state")}`;
        },
      },
    });
    expect(result.clientId).toBe("fixture-dcr-client");
    expect(observed.registrations).toBe(1);
    expect(observed.token?.get("client_secret")).toBe(privateValues.clientSecret);
    expect(authStorage.get(result.credentialId)).toMatchObject({
      type: "oauth", clientId: "fixture-dcr-client", clientSecret: privateValues.clientSecret,
    });
  });

  test("cancellation closes the native callback wait and preserves an existing credential", async () => {
    const { origin } = issuer();
    const callbackPort = await unusedPort();
    const authStorage = storage();
    const credentialId = mcpOAuthCredentialId(`${origin}/mcp`);
    const old = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
    await authStorage.set(credentialId, old);
    const abort = new AbortController();
    const authReady = Promise.withResolvers<void>();
    const pending = runNativeMcpOAuth({
      serverUrl: `${origin}/mcp`, authStorage,
      config: {
        authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, clientId: "fixture-client",
        callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      },
      callbacks: {
        signal: abort.signal,
        onAuth() { authReady.resolve(); },
        async onPrompt() { throw new Error("unexpected prompt"); },
      },
    });
    await authReady.promise;
    abort.abort(new Error("fixture cancelled"));
    await expect(pending).rejects.toThrow();
    expect(authStorage.get(credentialId)).toEqual(old);
    const rebound = Bun.serve({ hostname: "127.0.0.1", port: callbackPort, fetch: () => new Response("rebound") });
    await rebound.stop(true);
  });

  test("a completed storage write wins cancellation raised by that write", async () => {
    const { origin } = issuer();
    const callbackPort = await unusedPort();
    const abort = new AbortController();
    let authUrl: string | undefined;
    let stored: MCPStoredOAuthCredential | undefined;
    const authStorage = {
      async set(_credentialId: string, credential: MCPStoredOAuthCredential) {
        stored = credential;
        abort.abort(new Error("late fixture cancellation"));
      },
    } as AuthStorage;
    const result = await runNativeMcpOAuth({
      serverUrl: `${origin}/mcp`, authStorage,
      config: {
        authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, clientId: "fixture-client",
        callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      },
      callbacks: {
        signal: abort.signal,
        onAuth(info) { authUrl = info.url; },
        async onPrompt() { throw new Error("unexpected prompt"); },
        async onManualCodeInput() {
          while (!authUrl) await Bun.sleep(1);
          const url = new URL(authUrl);
          return `${url.searchParams.get("redirect_uri")}?code=${privateValues.code}&state=${url.searchParams.get("state")}`;
        },
      },
    });
    expect(result.credentialId).toBe(mcpOAuthCredentialId(`${origin}/mcp`));
    expect(stored).toMatchObject({ access: privateValues.access, refresh: privateValues.refresh });
  });

  test("a pre-aborted request performs no native HTTP work or credential write", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { requests += 1; return new Response("unexpected", { status: 500 }); },
    });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const authStorage = storage();
    const credentialId = mcpOAuthCredentialId(`${origin}/mcp`);
    const old = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
    await authStorage.set(credentialId, old);
    const abort = new AbortController();
    abort.abort(new Error("already cancelled"));
    await expect(runNativeMcpOAuth({
      serverUrl: `${origin}/mcp`, authStorage,
      config: { authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, clientId: "fixture-client" },
      callbacks: { signal: abort.signal, onAuth() {}, async onPrompt() { throw new Error("unexpected prompt"); } },
    })).rejects.toThrow();
    expect(requests).toBe(0);
    expect(authStorage.get(credentialId)).toEqual(old);
  });

  test("cancellation during native dynamic registration closes the listener and preserves the old credential", async () => {
    const registrationStarted = Promise.withResolvers<void>();
    const issuerServer = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/register") return new Response("not found", { status: 404 });
        registrationStarted.resolve();
        await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        return new Response("cancelled", { status: 499 });
      },
    });
    servers.push(issuerServer);
    const origin = `http://127.0.0.1:${issuerServer.port}`;
    const callbackPort = await unusedPort();
    const authStorage = storage();
    const credentialId = mcpOAuthCredentialId(`${origin}/mcp`);
    const old = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
    await authStorage.set(credentialId, old);
    const abort = new AbortController();
    const pending = runNativeMcpOAuth({
      serverUrl: `${origin}/mcp`, authStorage,
      config: {
        authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, registrationUrl: `${origin}/register`,
        callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      },
      callbacks: { signal: abort.signal, onAuth() {}, async onPrompt() { throw new Error("unexpected prompt"); } },
    });
    await registrationStarted.promise;
    abort.abort(new Error("registration cancelled"));
    await expect(pending).rejects.toThrow();
    expect(authStorage.get(credentialId)).toEqual(old);
    const rebound = Bun.serve({ hostname: "127.0.0.1", port: callbackPort, fetch: () => new Response("rebound") });
    await rebound.stop(true);
  });

  test("cancellation during native registration discovery closes the listener and preserves the old credential", async () => {
    const discoveryStarted = Promise.withResolvers<void>();
    let discoveryRequests = 0;
    const issuerServer = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        discoveryRequests += 1;
        discoveryStarted.resolve();
        await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        return new Response("cancelled", { status: 499 });
      },
    });
    servers.push(issuerServer);
    const origin = `http://127.0.0.1:${issuerServer.port}`;
    const callbackPort = await unusedPort();
    const authStorage = storage();
    const credentialId = mcpOAuthCredentialId(`${origin}/mcp`);
    const old = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
    await authStorage.set(credentialId, old);
    const abort = new AbortController();
    const pending = runNativeMcpOAuth({
      serverUrl: `${origin}/mcp`, authStorage,
      config: {
        authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, issuerUrl: origin,
        callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      },
      callbacks: { signal: abort.signal, onAuth() {}, async onPrompt() { throw new Error("unexpected prompt"); } },
    });
    await discoveryStarted.promise;
    abort.abort(new Error("discovery cancelled"));
    await expect(pending).rejects.toThrow();
    expect(discoveryRequests).toBe(1);
    expect(authStorage.get(credentialId)).toEqual(old);
    const rebound = Bun.serve({ hostname: "127.0.0.1", port: callbackPort, fetch: () => new Response("rebound") });
    await rebound.stop(true);
  });

  test("cancellation during token exchange closes the listener and preserves the old credential", async () => {
    const tokenStarted = Promise.withResolvers<void>();
    let tokenRequests = 0;
    const issuerServer = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/authorize") {
          const redirect = new URL(url.searchParams.get("redirect_uri")!);
          redirect.searchParams.set("code", privateValues.code);
          redirect.searchParams.set("state", url.searchParams.get("state")!);
          return Response.redirect(redirect, 302);
        }
        if (url.pathname === "/token") {
          tokenRequests += 1;
          tokenStarted.resolve();
          await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
          return new Response("cancelled", { status: 499 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(issuerServer);
    const origin = `http://127.0.0.1:${issuerServer.port}`;
    const callbackPort = await unusedPort();
    const authStorage = storage();
    const credentialId = mcpOAuthCredentialId(`${origin}/mcp`);
    const old = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
    await authStorage.set(credentialId, old);
    const abort = new AbortController();
    let driven = false;
    const pending = runNativeMcpOAuth({
      serverUrl: `${origin}/mcp`, authStorage,
      config: {
        authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, clientId: "fixture-client",
        callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      },
      callbacks: {
        signal: abort.signal,
        onAuth(info) { if (!driven) { driven = true; void fetch(info.url, { redirect: "follow" }); } },
        async onPrompt() { throw new Error("unexpected prompt"); },
      },
    });
    await tokenStarted.promise;
    abort.abort(new Error("token exchange cancelled"));
    await expect(pending).rejects.toThrow();
    expect(tokenRequests).toBe(1);
    expect(authStorage.get(credentialId)).toEqual(old);
    const rebound = Bun.serve({ hostname: "127.0.0.1", port: callbackPort, fetch: () => new Response("rebound") });
    await rebound.stop(true);
  });

  test("a wrong-state manual callback never reaches token exchange or storage", async () => {
    const { origin, observed } = issuer();
    const callbackPort = await unusedPort();
    const authStorage = storage();
    const credentialId = mcpOAuthCredentialId(`${origin}/mcp`);
    const old = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
    await authStorage.set(credentialId, old);
    const abort = new AbortController();
    const wrongStateSubmitted = Promise.withResolvers<void>();
    let authUrl: string | undefined;
    let manualCalls = 0;
    const pending = runNativeMcpOAuth({
      serverUrl: `${origin}/mcp`, authStorage,
      config: {
        authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, clientId: "fixture-client",
        callbackPort, redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      },
      callbacks: {
        signal: abort.signal,
        onAuth(info) { authUrl = info.url; },
        async onPrompt() { throw new Error("unexpected prompt"); },
        async onManualCodeInput(signal) {
          manualCalls += 1;
          while (!authUrl) await Bun.sleep(1);
          if (manualCalls === 1) {
            wrongStateSubmitted.resolve();
            return `${new URL(authUrl).searchParams.get("redirect_uri")}?code=${privateValues.code}&state=wrong-state`;
          }
          await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
          return "";
        },
      },
    });
    await wrongStateSubmitted.promise;
    await Bun.sleep(5);
    abort.abort(new Error("wrong state refused"));
    await expect(pending).rejects.toThrow();
    expect(manualCalls).toBeGreaterThanOrEqual(2);
    expect(observed.token).toBeUndefined();
    expect(authStorage.get(credentialId)).toEqual(old);
  });
});
