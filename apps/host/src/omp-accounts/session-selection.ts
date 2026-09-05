import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { recordCredentialPin } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { sessionAccount } from "./projection";
import type { AccountSelectionBridge, SessionAccountList } from "./types";

/** Run inside the owning native session worker, not against a second auth store. */
export function createNativeAccountSelectionBridge(
  resolveSession: (sessionId: string) => Promise<AgentSession>,
): AccountSelectionBridge {
  const list = async (sessionId: string): Promise<SessionAccountList> => {
    const session = await resolveSession(sessionId);
    if (session.sessionId !== sessionId) throw new Error("Native session identity changed");
    const result = await session.listCurrentProviderOAuthAccounts();
    return { sessionId, providerId: result?.provider ?? null,
      accounts: result ? result.accounts.map(account => sessionAccount(result.provider, account)) : [] };
  };
  return {
    list,
    pin: async (sessionId, credentialId) => {
      const session = await resolveSession(sessionId);
      if (session.sessionId !== sessionId) throw new Error("Native session identity changed");
      if (session.isStreaming || session.hasPostPromptWork) throw new Error("Cannot pin an account while its native session is running");
      if (!Number.isSafeInteger(credentialId) || credentialId <= 0) throw new Error("Invalid native credential ID");
      await session.listCurrentProviderOAuthAccounts();
      if (!session.pinCurrentProviderOAuthAccount(credentialId)) throw new Error("Native account is unavailable for this session");
      // Use OMP's own hashed credential-pin entry so a user selection survives
      // restart in broker mode even before another assistant turn has served.
      if (session.model) recordCredentialPin(session.modelRegistry.authStorage, session.sessionManager, sessionId, session.model.provider);
      await session.sessionManager.flush();
      return list(sessionId);
    },
  };
}
