import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { LoginResponse } from "../omp-accounts/types";
import { NativeLogin } from "../omp-accounts/login";
import { captureNativeMcpOAuthConfig, type NativeMcpOAuthConfigTarget } from "./mcp-oauth-config";
import { runNativeMcpOAuth, type NativeMcpOAuthResult } from "./mcp-oauth-flow";
import { prepareNativeMcpOAuth, completeNativeMcpOAuthConfig, type NativeMcpOAuthPlan } from "./mcp-oauth-plan";

export type { NativeMcpAuthorizationSnapshot } from "../../../../packages/shared/src/session-mcp-authorization";
import type { NativeMcpAuthorizationSnapshot } from "../../../../packages/shared/src/session-mcp-authorization";

/** One explicit authorization, held inside its session's MCP mutation queue.
 * Only callback UI state leaves this object. Raw configs, grants and responses
 * never enter session messages or command receipts. */
export class NativeMcpAuthorization {
  readonly #abort = new AbortController();
  readonly #login: NativeLogin;
  readonly completion: Promise<NativeMcpAuthorizationSnapshot>;
  #status: NativeMcpAuthorizationSnapshot["status"] = "running";
  #phase: NativeMcpAuthorizationSnapshot["phase"] = "queued";
  #credentialsStored = false;
  #credentialWrite: NativeMcpAuthorizationSnapshot["credentialWrite"] = "not-started";
  #configuration: NativeMcpAuthorizationSnapshot["configuration"] = "untouched";
  #reconnected = false;
  #error?: string;
  #terminal = false;

  constructor(private readonly input: {
    cwd: string;
    commandId?: string;
    serverName: string;
    manager: MCPManager;
    authStorage: AuthStorage;
    ready: Promise<void>;
    assertOwner(): void;
    reload(): Promise<void>;
    notify?(snapshot: NativeMcpAuthorizationSnapshot): void;
  }) {
    let target: NativeMcpOAuthConfigTarget;
    let plan: NativeMcpOAuthPlan;
    let result: NativeMcpOAuthResult;
    let managerIdentity: string;
    const assertCurrent = async () => {
      input.assertOwner();
      this.#abort.signal.throwIfAborted();
      if (this.#managerIdentity() !== managerIdentity) throw new Error("MCP server source changed.");
      await target.assertCurrent();
      input.assertOwner();
      this.#abort.signal.throwIfAborted();
    };
    this.#login = new NativeLogin(`mcp:${input.serverName}`, async callbacks => {
      await input.ready;
      input.assertOwner();
      this.#abort.signal.throwIfAborted();
      managerIdentity = this.#managerIdentity();
      target = await captureNativeMcpOAuthConfig(input);
      await assertCurrent();
      this.#phase = "discovering";
      this.#emit();
      const signal = AbortSignal.any([this.#abort.signal, callbacks.signal!]);
      plan = await prepareNativeMcpOAuth({ config: target.config, manager: input.manager, authStorage: input.authStorage, signal });
      await assertCurrent();
      this.#phase = "authorizing";
      this.#emit();
      result = await runNativeMcpOAuth({
        serverUrl: plan.serverUrl, config: plan.flowConfig, authStorage: input.authStorage,
        callbacks: { ...callbacks, signal }, beforeStore: assertCurrent,
        onStoreStart: () => { this.#credentialWrite = "unknown"; },
      });
      this.#credentialsStored = true;
      this.#credentialWrite = "stored";
      return { type: "oauth" };
    }, () => this.#emit());

    this.completion = this.#login.completion.then(async login => {
      try {
        if (login.status !== "succeeded" || !this.#credentialsStored) {
          throw new Error("Native MCP authorization did not store credentials.");
        }
        await assertCurrent();
        const updated = completeNativeMcpOAuthConfig(plan, result);
        this.#phase = "saving";
        this.#emit();
        await assertCurrent();
        if (updated.persist) {
          this.#configuration = "unknown";
          await target.commit(updated.config, this.#abort.signal);
          this.#configuration = "saved";
        } else this.#configuration = "not-needed";
        // Cancellation after a successful store/commit retains those truthful
        // outcomes but cannot start a fresh connection. An in-flight native
        // reload is drained; its successful result wins a later cancellation.
        input.assertOwner();
        this.#abort.signal.throwIfAborted();
        this.#phase = "reconnecting";
        this.#emit();
        input.assertOwner();
        this.#abort.signal.throwIfAborted();
        await input.reload();
        this.#reconnected = input.manager.getConnectionStatus(input.serverName) === "connected";
        if (!this.#reconnected) throw new Error("Native MCP server did not reconnect.");
        this.#status = "succeeded";
      } catch {
        this.#status = this.#abort.signal.aborted || login.status === "cancelled" ? "cancelled" : "failed";
        this.#error = this.#credentialsStored
          ? "Credentials were stored, but server authorization did not finish. Check the configuration and reconnect."
          : this.#credentialWrite === "unknown" ? "The credential store did not confirm the write. Check accounts before authorizing again."
          : this.#status === "cancelled" ? "MCP authorization cancelled." : "MCP authorization failed. Existing credentials were retained.";
      } finally {
        this.#terminal = true;
        this.#phase = "finished";
        this.#emit();
      }
      return this.snapshot();
    });
  }

  #managerIdentity(): string {
    return JSON.stringify([this.input.manager.getServerConfig(this.input.serverName), this.input.manager.getSource(this.input.serverName)]);
  }

  get id(): string { return this.#login.id; }
  get pending(): boolean { return !this.#terminal; }
  snapshot(): NativeMcpAuthorizationSnapshot {
    return {
      authorizationId: this.id, serverName: this.input.serverName, ...(this.input.commandId ? {commandId:this.input.commandId} : {}),
      status: this.#status, phase: this.#phase, credentialsStored: this.#credentialsStored,
      credentialWrite: this.#credentialWrite,
      configuration: this.#configuration, reconnected: this.#reconnected,
      login: this.#login.snapshot(), ...(this.#error ? { error: this.#error } : {}),
    };
  }
  #emit(): void {
    // Observers can disappear during reconnect/disposal. A failed observer
    // must not cancel the native write or prevent lifecycle cleanup.
    try { this.input.notify?.(this.snapshot()); } catch { /* State remains available through snapshot(). */ }
  }
  respond(requestId: string, response: LoginResponse): void {
    if (this.#terminal || this.#abort.signal.aborted) throw new Error("MCP authorization is no longer pending.");
    if ("cancel" in response) { this.cancel(); return; }
    this.#login.respond(requestId, response);
  }
  cancel(): void {
    if (this.#terminal || this.#abort.signal.aborted) return;
    this.#status = "cancelling";
    this.#abort.abort(new Error("MCP authorization cancelled."));
    this.#login.cancel();
    this.#emit();
  }
}
