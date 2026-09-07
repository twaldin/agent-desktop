import { randomUUID } from "node:crypto";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { connectToServer, disconnectServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { getMcpTransportAuthHints } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { lookupMcpOAuthCredentialForServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import { analyzeAuthError, discoverOAuthEndpoints, fetchResourceMetadataScopes, type OAuthEndpoints } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { mcpOAuthCredentialId, type MCPOAuthConfig } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPAuthChallenge, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

/** Worker-private authorization material. Never serialize this plan to clients,
 * transcripts, command receipts, or logs: flowConfig may contain a client secret. */
export interface NativeMcpOAuthPlan {
	serverUrl: string;
	baseConfig: MCPServerConfig;
	flowConfig: MCPOAuthConfig;
	hadAuth: boolean;
	previousCredentialId?: string;
	userClientSecret?: string;
	persistOAuthClientId: boolean;
	discoveredClientId?: string;
}

function requireRemote(config: MCPServerConfig, validateUrl = true): asserts config is MCPServerConfig & { type: "http" | "sse"; url: string } {
	if (config.type !== "http" && config.type !== "sse") throw new Error("This server manages authentication in its own process. App-managed OAuth requires an HTTP or SSE server.");
	if (config.enabled === false) throw new Error("Enable the MCP server before authorizing it.");
	if (!validateUrl) return;
	let url: URL;
	try { url = new URL(config.url); } catch { throw new Error("The MCP server URL is invalid."); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The MCP server URL must use HTTP or HTTPS.");
}

/** Native HTTP/SSE initialization and metadata discovery. Like OMP's reauth
 * controller, skip managed OAuth injection but retain explicitly configured
 * headers. A successful anonymous initialize does not imply public tools. */
async function endpoints(manager: MCPManager, base: MCPServerConfig, signal: AbortSignal, challenge?: MCPAuthChallenge): Promise<OAuthEndpoints> {
	requireRemote(base);
	signal.throwIfAborted();
	const resolved = await manager.prepareConfig(base, { oauth: false });
	signal.throwIfAborted();
	requireRemote(resolved);
	let connectionError: Error | undefined;
	try {
		const connection = await connectToServer(`desktop-oauth-probe-${randomUUID()}`, resolved, { signal });
		await disconnectServer(connection);
	} catch (error) {
		signal.throwIfAborted();
		connectionError = error instanceof Error ? error : new Error("MCP initialization failed.");
	}
	signal.throwIfAborted();
	if (!connectionError && !challenge) {
		const found = await discoverOAuthEndpoints(base.url, undefined, undefined, { signal });
		signal.throwIfAborted();
		if (!found) throw new Error("The server accepts connections without OAuth and advertises no OAuth authorization endpoints.");
		return found;
	}
	// Native diagnostics redact Bearer tokens and URL secrets. Authorization
	// discovery needs the exact challenge identity, carried privately by the
	// pinned transport patch rather than recovered from a redacted log string.
	const hints = getMcpTransportAuthHints(connectionError);
	const authHeaders = challenge?.wwwAuthenticate ?? (hints?.wwwAuthenticate ? [hints.wwwAuthenticate] : []);
	const error = new Error([
		...authHeaders,
		...(hints?.mcpAuthServer ? [`Mcp-Auth-Server: ${hints.mcpAuthServer}`] : []),
		connectionError?.message ?? "HTTP 401",
	].join("\n"));
	const detected = analyzeAuthError(error, base.url);
	let found = detected.authType === "oauth" ? detected.oauth ?? null : null;
	if (!found) found = await discoverOAuthEndpoints(base.url, detected.authServerUrl, detected.resourceMetadataUrl, { signal, protectedScopes: detected.scopes });
	signal.throwIfAborted();
	if (found && !found.scopes && detected.resourceMetadataUrl) {
		const scopes = await fetchResourceMetadataScopes(detected.resourceMetadataUrl, { signal });
		signal.throwIfAborted();
		if (scopes) found = { ...found, scopes };
	}
	if (!found) throw new Error("The MCP server did not provide discoverable OAuth authorization endpoints.");
	return found;
}

/** Resolve the same client/resource precedence as the pinned OMP reauth
 * controller without starting browser authorization or changing credentials.
 * The caller owns the server/config revision and must retain it until commit.
 * Native command substitutions are awaited (they have no abort API); after
 * cancellation no further connection, discovery, or authorization is started. */
export async function prepareNativeMcpOAuth(options: {
	config: MCPServerConfig;
	manager: MCPManager;
	authStorage: AuthStorage;
	signal: AbortSignal;
	challenge?: MCPAuthChallenge;
}): Promise<NativeMcpOAuthPlan> {
	options.signal.throwIfAborted();
	const raw = structuredClone(options.config);
	requireRemote(raw, false);
	const { auth: currentAuth, ...baseConfig } = raw;
	const runtime = expandEnvVarsDeep(baseConfig);
	requireRemote(runtime);
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("MCP OAuth discovery timed out.")), 60_000);
	const signal = AbortSignal.any([options.signal, deadline.signal]);
	try {
		const oauth = await endpoints(options.manager, runtime, signal, options.challenge);
		signal.throwIfAborted();
		const runtimeAuth = currentAuth ? expandEnvVarsDeep(currentAuth) : undefined;
		const existing = lookupMcpOAuthCredentialForServer(options.authStorage, currentAuth, runtime.url)?.credential;
		const configuredId = runtime.oauth?.clientId?.trim() || undefined;
		const persistedId = runtimeAuth?.clientId?.trim() || undefined;
		const storedId = existing?.clientId?.trim() || undefined;
		const discoveredId = oauth.clientId?.trim() || undefined;
		const clientId = configuredId ?? persistedId ?? storedId ?? (oauth.registrationUrl ? undefined : discoveredId) ?? "";
		const clientSecret = (configuredId === clientId ? runtime.oauth?.clientSecret : undefined)
			?? (persistedId === clientId ? runtimeAuth?.clientSecret : undefined)
			?? (storedId === clientId ? existing?.clientSecret : undefined) ?? "";
		const userClientSecret = (configuredId === clientId ? raw.oauth?.clientSecret : undefined)
			?? (persistedId === clientId ? currentAuth?.clientSecret : undefined);
		const currentResource = runtimeAuth?.resource || undefined;
		return {
			serverUrl: runtime.url, baseConfig, hadAuth: currentAuth !== undefined,
			previousCredentialId: currentAuth?.type === "oauth" ? currentAuth.credentialId : undefined,
			userClientSecret, persistOAuthClientId: !(configuredId === undefined && runtime.oauth?.clientSecret !== undefined), discoveredClientId: oauth.clientId,
			flowConfig: {
				authorizationUrl: oauth.authorizationUrl, tokenUrl: oauth.tokenUrl,
				issuerUrl: oauth.issuerUrl, registrationUrl: oauth.registrationUrl,
				clientId, clientSecret, scopes: oauth.scopes || runtime.oauth?.scope || "",
				callbackPort: raw.oauth?.callbackPort, callbackPath: raw.oauth?.callbackPath,
				redirectUri: raw.oauth?.redirectUri, prompt: raw.oauth?.prompt,
				resource: oauth.resource ?? currentResource ?? runtime.url,
				stripSameOriginResource: !oauth.resource && !currentResource,
			},
		};
	} finally { clearTimeout(timer); }
}

/** Build the native write-back only after an actual credential-store receipt.
 * No files are written here. The caller must CAS the original configuration,
 * persist if requested, then reconnect and collect superseded credentials. */
export function completeNativeMcpOAuthConfig(plan: NativeMcpOAuthPlan, result: { credentialId: string; clientId?: string; resource?: string }): { config: MCPServerConfig; persist: boolean } {
	const persist = plan.hadAuth || result.credentialId !== mcpOAuthCredentialId(plan.serverUrl);
	if (!persist) return { config: structuredClone(plan.baseConfig), persist: false };
	const clientId = result.clientId?.trim() || plan.discoveredClientId?.trim() || plan.baseConfig.oauth?.clientId?.trim();
	return { persist: true, config: {
		...structuredClone(plan.baseConfig),
		auth: {
			type: "oauth", credentialId: result.credentialId, tokenUrl: plan.flowConfig.tokenUrl,
			clientId, clientSecret: plan.userClientSecret,
			resource: result.resource ?? (plan.flowConfig.stripSameOriginResource ? undefined : plan.flowConfig.resource),
		},
		oauth: { ...plan.baseConfig.oauth, clientId: plan.persistOAuthClientId ? clientId : undefined },
	} };
}
