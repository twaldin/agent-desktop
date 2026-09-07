import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth";
import {
  MCPOAuthFlow,
  mcpOAuthCredentialId,
  type MCPOAuthConfig,
  type MCPStoredOAuthCredential,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const OAUTH_TIMEOUT_MS = 5 * 60_000;

export interface NativeMcpOAuthInput {
  serverUrl: string;
  config: MCPOAuthConfig;
  authStorage: AuthStorage;
  callbacks: OAuthLoginCallbacks;
}

export interface NativeMcpOAuthResult {
  credentialId: string;
  clientId?: string;
  resource?: string;
}

/** Run OMP's MCP OAuth flow and persist its complete refresh material privately. */
export async function runNativeMcpOAuth(input: NativeMcpOAuthInput): Promise<NativeMcpOAuthResult> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("MCP OAuth timed out")), OAUTH_TIMEOUT_MS);
  timer.unref();
  const signal = input.callbacks.signal
    ? AbortSignal.any([input.callbacks.signal, deadline.signal])
    : deadline.signal;

  try {
    const flow = new MCPOAuthFlow(input.config, { ...input.callbacks, signal });
    const credentials = await flow.login();

    // Cancellation before durable storage must not replace an existing grant.
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("MCP OAuth cancelled");

    const clientId = flow.resolvedClientId?.trim() || input.config.clientId?.trim() || undefined;
    const clientSecret = flow.registeredClientSecret ?? input.config.clientSecret;
    const stored: MCPStoredOAuthCredential = {
      type: "oauth",
      ...credentials,
      tokenUrl: input.config.tokenUrl,
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(flow.resource ? { resource: flow.resource } : {}),
      authorizationUrl: flow.authorizationUrl,
    };
    const credentialId = mcpOAuthCredentialId(input.serverUrl);

    // Once the storage write starts, its actual result is authoritative. A late
    // abort cannot safely reinterpret a successfully replaced credential.
    await input.authStorage.set(credentialId, stored);
    return {
      credentialId,
      ...(clientId ? { clientId } : {}),
      ...(flow.resource ? { resource: flow.resource } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
