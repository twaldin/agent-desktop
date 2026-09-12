import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { recordCredentialPin } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { sessionAccount } from "./projection";
import type { SessionAccountList, SessionAccountSelection } from "./types";

/** Native session-local choices. Revisions name this owner, never credentials. */
export function createNativeAccountSelectionBridge(
  resolveSession: (sessionId: string) => Promise<AgentSession>,
  options: { assertActive?(): void; revalidate?(): Promise<void> } = {},
) {
  let owner: AgentSession | undefined, revision = crypto.randomUUID(), stopped = false;
  let unsubscribe: (() => void) | undefined;
  let accountFingerprint: string | undefined;
  function observeAccounts(provider: string | undefined, accounts: SessionAccountList["accounts"]) {
    const next = JSON.stringify({ provider, accounts });
    if (accountFingerprint !== undefined && accountFingerprint !== next) revision = crypto.randomUUID();
    accountFingerprint = next;
  }
  const active = () => { options.assertActive?.(); if (stopped) throw new Error("Native account selection is closed"); };
  async function capture(sessionId: string, expected?: SessionAccountSelection) {
    active(); const session = await resolveSession(sessionId); active();
    if (session.sessionId !== sessionId || owner && owner !== session) throw new Error("Native session identity changed");
    if (!owner) {
      owner = session;
      unsubscribe = session.subscribe(event => { if (event.type === "model_changed") revision = crypto.randomUUID(); });
    }
    const model = session.model, capturedRevision = revision;
    if (expected && (!model || expected.revision !== revision || expected.model.provider !== model.provider || expected.model.id !== model.id)) throw new Error("Native account selection changed; refresh before choosing an account");
    const current = () => { active(); if (owner !== session || session.sessionId !== sessionId || session.model !== model || revision !== capturedRevision) throw new Error("Native account selection changed; refresh before choosing an account"); };
    return { session, model, current, capturedRevision };
  }
  async function list(sessionId: string): Promise<SessionAccountList> {
    const read = await capture(sessionId);
    await options.revalidate?.(); read.current();
    const result = await read.session.listCurrentProviderOAuthAccounts(); read.current();
    if (result && result.provider !== read.model?.provider) throw new Error("Native account provider changed");
    const accounts = result ? result.accounts.map(account => sessionAccount(result.provider, account)) : [];
    observeAccounts(result?.provider, accounts);
    return { sessionId, providerId: result?.provider ?? null, accounts,
      ...(read.model ? { selection: { model: { provider: read.model.provider, id: read.model.id }, revision } } : {}) };
  }
  async function mutate(sessionId: string, credentialId: number | undefined, expected?: SessionAccountSelection) {
    const selected = await capture(sessionId, expected), session = selected.session;
    if (session.isStreaming || session.hasPostPromptWork) throw new Error("Cannot select an account while its native session is running");
    if (credentialId !== undefined && (!Number.isSafeInteger(credentialId) || credentialId <= 0)) throw new Error("Invalid native credential ID");
    await options.revalidate?.(); selected.current();
    const available = await session.listCurrentProviderOAuthAccounts(); selected.current();
    observeAccounts(available?.provider, available ? available.accounts.map(account => sessionAccount(available.provider, account)) : []);
    selected.current();
    if (session.isStreaming || session.hasPostPromptWork) throw new Error("Cannot select an account while its native session is running");
    if (credentialId === undefined) {
      if (selected.model) session.modelRegistry.authStorage.releaseSessionCredentialForReselection(selected.model.provider, sessionId);
    } else {
      if (!session.pinCurrentProviderOAuthAccount(credentialId)) throw new Error("Native account is unavailable for this session");
      if (selected.model) recordCredentialPin(session.modelRegistry.authStorage, session.sessionManager, sessionId, selected.model.provider);
    }
    revision = crypto.randomUUID();
    const appliedRevision = revision;
    // Selection is already applied if flush fails: surface the error, never replay it.
    if (credentialId !== undefined) await session.sessionManager.flush();
    active();
    if (session.model !== selected.model || revision !== appliedRevision) throw new Error("Native account selection changed after applying; refresh its current state");
    return list(sessionId);
  }
  return {
    list,
    pin: (sessionId: string, credentialId: number, expected?: SessionAccountSelection) => mutate(sessionId, credentialId, expected),
    release: (sessionId: string, expected?: SessionAccountSelection) => mutate(sessionId, undefined, expected),
    dispose() { stopped = true; unsubscribe?.(); unsubscribe = undefined; },
  };
}
