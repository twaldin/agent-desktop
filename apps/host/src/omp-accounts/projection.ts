import { toSessionPinAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";
import type { OAuthAccountSummary, StoredAuthCredential } from "@oh-my-pi/pi-ai";
import type { DisabledCredentialSummary } from "@oh-my-pi/pi-ai/auth-storage";
import type { AccountIdentity, AccountInfo, LoginIdentity } from "./types";

export function identity(value: AccountIdentity): AccountIdentity {
  return {
    ...(value.email !== undefined ? { email: value.email } : {}),
    ...(value.accountId !== undefined ? { accountId: value.accountId } : {}),
    ...(value.projectId !== undefined ? { projectId: value.projectId } : {}),
    ...(value.orgId !== undefined ? { orgId: value.orgId } : {}),
    ...(value.orgName !== undefined ? { orgName: value.orgName } : {}),
  };
}
export function storedAccount(row: StoredAuthCredential): AccountInfo {
  return {
    credentialId: row.id, providerId: row.provider, type: row.credential.type, disabled: false,
    ...(row.credential.type === "oauth" ? identity(row.credential) : {}),
  };
}
export function disabledAccount(row: DisabledCredentialSummary): AccountInfo {
  return {
    credentialId: row.id, providerId: row.provider, type: row.type, disabled: true,
    ...identity(row), ...(row.disabledAtMs !== undefined ? { disabledAt: row.disabledAtMs } : {}),
  };
}
export function sessionAccount(providerId: string, account: OAuthAccountSummary): AccountInfo {
  return {
    credentialId: account.credentialId, providerId, type: "oauth", disabled: false,
    active: account.active, position: account.position, label: toSessionPinAccounts([account])[0]!.label, ...identity(account),
  };
}
export function loginIdentity(value: LoginIdentity): LoginIdentity {
  return { type: value.type, ...identity(value) };
}

/** Native error bodies can contain provider responses or supplied secrets. */
export function publicAuthError(error: unknown, operation: string): { code: string; message: string; status?: number } {
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status : undefined;
  return {
    code: "native_auth_error", message: `Native ${operation} failed`,
    ...(status !== undefined ? { status } : {}),
  };
}
