import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { mcpOAuthCredentialIdsForServerUrl, removeManagedMcpOAuthCredential } from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { captureNativeMcpOAuthConfig } from "./mcp-oauth-config";

/** Clear the same profile-owned material as native /mcp unauth. This does not
 * revoke a remote token or erase explicit headers/environment credentials.
 * The caller serializes this with authorization/reload and joins it on dispose. */
export async function clearNativeMcpAuthorization(options: {
  cwd: string;
  serverName: string;
  manager: Pick<MCPManager, "getServerConfig" | "getSource">;
  authStorage: AuthStorage;
  assertOwner(): void;
  reload(): Promise<void>;
}): Promise<{ changed: boolean }> {
  options.assertOwner();
  const target = await captureNativeMcpOAuthConfig(options);
  options.assertOwner();
  const check = async () => {
    options.assertOwner();
    await target.assertCurrent();
    options.assertOwner();
  };
  await check();
  const auth = target.config.auth;
  const explicit = auth?.type === "oauth" ? auth.credentialId : undefined;
  const urlIds = target.config.type === "http" || target.config.type === "sse"
    ? mcpOAuthCredentialIdsForServerUrl(target.config.url) : [];
  let attemptedMutation = false;
  let removedUrlCredential = false;
  try {
    if (explicit) {
      await check();
      attemptedMutation = true;
      await removeManagedMcpOAuthCredential(options.authStorage, explicit);
      await check();
    }
    for (const id of urlIds) {
      await check();
      attemptedMutation = true;
      removedUrlCredential = await removeManagedMcpOAuthCredential(options.authStorage, id) || removedUrlCredential;
      await check();
    }
    // Native discovered sources without an OAuth block must not be copied into
    // user configuration merely to remove a credential that is already absent.
    if (target.source.discovered && auth?.type !== "oauth") {
      if (!removedUrlCredential) return { changed: false };
    } else {
      const { auth: _auth, ...updated } = target.config;
      await check();
      attemptedMutation = true;
      await target.commit(updated);
    }
    options.assertOwner();
    await options.reload();
    options.assertOwner();
    return { changed: true };
  } catch {
    // Credential and config stores are separate native writes. Neither a late
    // reload error nor owner loss makes an earlier removal a rollback.
    throw new Error(attemptedMutation
      ? "MCP authorization clearing did not finish. Native credentials or configuration may already have changed. Inspect the original result before trying again."
      : "MCP authorization could not be cleared. Refresh the original server configuration before trying again.");
  }
}
