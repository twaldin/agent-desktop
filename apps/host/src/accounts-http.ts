import type { AccountAction, AccountActionResult, AccountSelectionBridge, LoginSnapshot, SessionAccountList } from "@agent-desktop/shared";
import type { OmpAccounts } from "./omp-accounts";

class AccountRequestError extends Error {}
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AccountRequestError(`Invalid ${name}.`);
  return value;
}
function credential(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new AccountRequestError("Invalid credential ID.");
  return value;
}

export function parseAccountAction(input: unknown): AccountAction {
  if (!input || typeof input !== "object") throw new AccountRequestError("Invalid account action.");
  const value = input as Record<string, unknown>;
  switch (value.type) {
    case "login.start": return { type: value.type, providerId: text(value.providerId, "provider ID") };
    case "login.cancel": return { type: value.type, loginId: text(value.loginId, "login ID") };
    case "login.respond": {
      const response = value.response as Record<string, unknown> | undefined;
      if (!response || typeof response !== "object" || (response.cancel !== true && (typeof response.value !== "string" || response.value.length > 1024 * 1024))) {
        throw new AccountRequestError("Invalid login response.");
      }
      return { type: value.type, loginId: text(value.loginId, "login ID"), requestId: text(value.requestId, "request ID"),
        response: response.cancel === true ? { cancel: true } : { value: response.value as string } };
    }
    case "key.set": return { type: value.type, providerId: text(value.providerId, "provider ID"), key: text(value.key, "API key", 1024 * 1024) };
    case "credential.remove": return { type: value.type, providerId: text(value.providerId, "provider ID"), credentialId: credential(value.credentialId) };
    case "session.pin": return { type: value.type, sessionId: text(value.sessionId, "session ID"), credentialId: credential(value.credentialId) };
    case "session.release": return { type: value.type, sessionId: text(value.sessionId, "session ID") };
    default: throw new AccountRequestError("Unknown account action.");
  }
}

/** Login callbacks stay in memory; only credential-free invalidation events are journalled. */
export class AccountsHttp {
  #opening?: Promise<OmpAccounts>;
  #logins = new Map<string, LoginSnapshot>();
  #stopping = false;
  constructor(private options: {
    agentDir?: string; cwd: string; selection: AccountSelectionBridge;
    release(sessionId: string): Promise<SessionAccountList>;
    changed(refreshModels: boolean): void;
  }) {}

  #backend(): Promise<OmpAccounts> {
    if (this.#stopping) throw new AccountRequestError("The host is stopping.");
    if (!this.#opening) {
      const pending = import("./omp-accounts").then(({ OmpAccounts }) => OmpAccounts.open({
        agentDir: this.options.agentDir, cwd: this.options.cwd, selectionBridge: this.options.selection,
      })).then(accounts => {
        accounts.subscribe(event => {
          if (event.type === "login.changed") {
            this.#logins.set(event.login.loginId, event.login);
            for (const [id, login] of this.#logins) {
              if (this.#logins.size <= 32) break;
              if (login.status !== "running" && login.status !== "cancelling") this.#logins.delete(id);
            }
          }
          this.options.changed(event.type === "accounts.changed");
        });
        return accounts;
      });
      this.#opening = pending;
      void pending.catch(() => { if (this.#opening === pending) this.#opening = undefined; });
    }
    return this.#opening;
  }

  async #act(action: AccountAction): Promise<AccountActionResult> {
    const accounts = await this.#backend();
    switch (action.type) {
      case "login.start": {
        const run = accounts.startLogin(action.providerId);
        const login = accounts.pendingLogin(run.loginId);
        this.#logins.set(run.loginId, login);
        return { login };
      }
      case "login.respond": accounts.respond(action.loginId, action.requestId, action.response); return { login: accounts.pendingLogin(action.loginId) };
      case "login.cancel": accounts.cancelLogin(action.loginId); return { login: accounts.pendingLogin(action.loginId) };
      case "key.set": await accounts.setApiKey(action.providerId, action.key); return { accounts: await accounts.listAccounts(action.providerId) };
      case "credential.remove": await accounts.removeCredential(action.providerId, action.credentialId); return { accounts: await accounts.listAccounts(action.providerId) };
      case "session.pin": {
        const selection = await accounts.pinSessionAccount(action.sessionId, action.credentialId);
        this.options.changed(false); return { selection };
      }
      case "session.release": {
        const selection = await this.options.release(action.sessionId);
        this.options.changed(false); return { selection };
      }
    }
  }

  async route(request: Request, url: URL): Promise<Response | undefined> {
    const isAccountPath = url.pathname.startsWith("/v1/accounts/");
    const sessionPath = /^\/v1\/sessions\/([^/]+)\/accounts$/.exec(url.pathname);
    if (!isAccountPath && !sessionPath) return;
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    try {
      if (request.method === "GET") {
        if (url.pathname === "/v1/accounts/providers") return json(await (await this.#backend()).listProviders());
        if (url.pathname === "/v1/accounts/logins") return json([...this.#logins.values()].sort((a, b) => b.startedAt - a.startedAt));
        if (url.pathname === "/v1/accounts/credentials") return json(await (await this.#backend()).listAccounts(text(url.searchParams.get("provider"), "provider ID")));
        if (sessionPath) return json(await (await this.#backend()).listSessionAccounts(text(decodeURIComponent(sessionPath[1]!), "session ID")));
      }
      if (request.method === "POST" && url.pathname === "/v1/accounts/actions") return json(await this.#act(parseAccountAction(await request.json())));
      return json({ error: "Not found" }, 404);
    } catch (error) {
      // Provider or transport exception strings can contain credentials. The native backend's
      // AccountOperationError is already projected; all other exceptions remain private.
      const safe = error instanceof AccountRequestError || (error instanceof Error && error.name === "AccountOperationError");
      return json({ error: safe ? (error as Error).message : "Native account request failed. Refresh account state before retrying." }, 400);
    }
  }

  async dispose(): Promise<void> {
    this.#stopping = true;
    if (this.#opening) await (await this.#opening.catch(() => undefined))?.dispose();
    this.#logins.clear();
  }
}
