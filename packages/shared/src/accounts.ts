export interface AccountIdentity {
  email?: string;
  accountId?: string;
  projectId?: string;
  orgId?: string;
  orgName?: string;
}
export interface AccountInfo extends AccountIdentity {
  credentialId: number;
  providerId: string;
  type: "oauth" | "api_key";
  disabled: boolean;
  disabledAt?: number;
  /** Omitted outside a particular running session; there is no global active account. */
  active?: boolean;
  position?: number;
}
export interface AuthOrigin {
  kind: "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";
  envVar?: string;
  commandBacked?: boolean;
}
export interface ProviderInfo {
  id: string;
  name: string;
  source: "builtin" | "runtime-oauth" | "configured-model" | "stored-only";
  available: boolean;
  disabledInSettings: boolean;
  loginSupported: boolean;
  visibleInNativeLoginList: boolean;
  storesCredentialsAs: string;
  callbackPort?: number;
  pasteCodeFlow: boolean;
  apiKeyStorageSupported: true;
  transportMayAuthenticateWithoutKey: boolean;
  configured: boolean;
  authOrigin?: AuthOrigin;
  storedCredentialCount: number;
  storedApiKeyConfigured: boolean;
  disabledCredentialCount: number;
  modelCount: number;
}
export interface ProviderCatalog {
  credentialLocation: { mode: "local" | "broker"; brokerOrigin?: string };
  providers: ProviderInfo[];
  sessionSelectionConnected: boolean;
  /** Workers must supply their extension registry; this service never silently loads user extensions. */
  extensionProviderCoverage: "registered-in-this-process-only";
}
export interface SessionAccountList { sessionId: string; providerId: string | null; accounts: AccountInfo[] }
export interface AccountSelectionBridge {
  list(sessionId: string): Promise<SessionAccountList>;
  pin(sessionId: string, credentialId: number): Promise<SessionAccountList>;
}
export interface LoginIdentity extends AccountIdentity { type: "oauth" | "api_key" }
export interface LoginPrompt {
  requestId: string;
  kind: "prompt" | "manual-code";
  message: string;
  placeholder?: string;
  allowEmpty: boolean;
  /** OMP supplies no field sensitivity descriptor. Treat all responses as write-only. */
  sensitive: true;
}
export type LoginStatus = "running" | "cancelling" | "succeeded" | "no_credentials" | "cancelled" | "failed";
export interface LoginSnapshot {
  loginId: string;
  providerId: string;
  status: LoginStatus;
  startedAt: number;
  updatedAt: number;
  cancellationRequested: boolean;
  auth?: { url: string; launchUrl?: string; instructions?: string; callbackOnOwningHost: true };
  progress?: string;
  prompts: LoginPrompt[];
  identity?: LoginIdentity;
  error?: { code: string; message: string; status?: number };
}
export type AccountEvent = { type: "login.changed"; login: LoginSnapshot } | { type: "accounts.changed"; providerId?: string };
export interface LoginRun { loginId: string; completion: Promise<LoginSnapshot> }
export type LoginResponse = { value: string } | { cancel: true };
