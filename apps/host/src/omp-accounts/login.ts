import { randomUUID } from "node:crypto";
import type { OAuthLoginCallbacks, OAuthPrompt } from "@oh-my-pi/pi-ai/oauth";
import type { LoginIdentity, LoginPrompt, LoginResponse, LoginSnapshot } from "./types";
import { loginIdentity, publicAuthError } from "./projection";

/** Native callback bridge. Submitted input is resolved directly and never retained in snapshots. */
export class NativeLogin {
  #controller = new AbortController();
  #snapshot: LoginSnapshot;
  #pending = new Map<string, { resolve(value: string): void; reject(error: unknown): void; cleanup(): void }>();
  #notify: (snapshot: LoginSnapshot) => void;
  #deadline: ReturnType<typeof setTimeout>;
  #terminal = false;
  readonly completion: Promise<LoginSnapshot>;

  constructor(
    providerId: string,
    run: (callbacks: OAuthLoginCallbacks) => Promise<LoginIdentity | undefined>,
    notify: (snapshot: LoginSnapshot) => void,
    timeoutMs = 10 * 60_000,
  ) {
    this.#notify = notify;
    const now = Date.now();
    this.#snapshot = {
      loginId: randomUUID(), providerId, status: "running", startedAt: now, updatedAt: now,
      cancellationRequested: false, prompts: [],
    };
    this.#deadline = setTimeout(() => this.cancel(), timeoutMs);
    this.#deadline.unref();
    this.completion = Promise.resolve().then(async () => {
      this.#emit();
      try {
        const result = await run({
          signal: this.#controller.signal,
          onAuth: info => {
            if (this.#terminal || this.#controller.signal.aborted) return;
            this.#snapshot.auth = {
              url: info.url, ...(info.launchUrl ? { launchUrl: info.launchUrl } : {}),
              ...(info.instructions ? { instructions: info.instructions } : {}), callbackOnOwningHost: true,
            };
            this.#emit();
          },
          onPrompt: prompt => this.#prompt(prompt, "prompt"),
          onManualCodeInput: signal => this.#prompt({ message: "Paste the authorization code or complete redirect URL" }, "manual-code", signal),
          onProgress: progress => {
            if (this.#terminal || this.#controller.signal.aborted) return;
            this.#snapshot.progress = progress;
            this.#emit();
          },
        });
        // Cancellation can race a native credential write. An actual returned
        // stored identity takes precedence; never report cancelled after success.
        this.#snapshot.status = result ? "succeeded" : "no_credentials";
        if (result) this.#snapshot.identity = loginIdentity(result);
      } catch (error) {
        this.#snapshot.status = this.#controller.signal.aborted ? "cancelled" : "failed";
        this.#snapshot.error = this.#controller.signal.aborted
          ? { code: "login_cancelled", message: "Login cancelled" }
          : publicAuthError(error, "login");
      } finally {
        this.#terminal = true;
        clearTimeout(this.#deadline);
        for (const pending of this.#pending.values()) {
          pending.cleanup(); pending.reject(new Error("Native login finished"));
        }
        this.#pending.clear(); this.#snapshot.prompts = [];
        // Authorization artifacts are only useful while the login is pending.
        delete this.#snapshot.auth;
        this.#emit();
      }
      return this.snapshot();
    });
  }

  get id(): string { return this.#snapshot.loginId; }
  snapshot(): LoginSnapshot { return structuredClone(this.#snapshot); }
  #emit(): void { this.#snapshot.updatedAt = Date.now(); this.#notify(this.snapshot()); }

  #prompt(prompt: OAuthPrompt, kind: LoginPrompt["kind"], suppliedSignal?: AbortSignal): Promise<string> {
    const signal = suppliedSignal ? AbortSignal.any([this.#controller.signal, suppliedSignal]) : this.#controller.signal;
    if (this.#terminal || signal.aborted) return Promise.reject(new Error("Login input cancelled"));
    const requestId = randomUUID();
    const input = Promise.withResolvers<string>();
    // A native callback race can stop awaiting the manual-input branch after
    // HTTP wins. It still rejects for consumers, without becoming an unhandled
    // process rejection when the losing branch is cleaned up.
    void input.promise.catch(() => {});
    const onAbort = () => {
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      pending.cleanup(); this.#pending.delete(requestId);
      this.#snapshot.prompts = this.#snapshot.prompts.filter(item => item.requestId !== requestId);
      pending.reject(new Error("Login input cancelled")); this.#emit();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.#pending.set(requestId, { resolve: input.resolve, reject: input.reject, cleanup: () => signal.removeEventListener("abort", onAbort) });
    this.#snapshot.prompts.push({
      requestId, kind, message: prompt.message,
      ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
      allowEmpty: prompt.allowEmpty ?? false, sensitive: true,
    });
    this.#emit();
    return input.promise;
  }

  respond(requestId: string, response: LoginResponse): void {
    const pending = this.#pending.get(requestId);
    const prompt = this.#snapshot.prompts.find(item => item.requestId === requestId);
    if (!pending || !prompt || this.#terminal) throw new Error("Login prompt is no longer pending");
    if ("cancel" in response) { this.cancel(); return; }
    if (typeof response.value !== "string" || response.value.length > 1024 * 1024) throw new Error("Invalid login response");
    if (!prompt.allowEmpty && !response.value.trim()) throw new Error("This native login prompt requires a value");
    pending.cleanup(); this.#pending.delete(requestId);
    this.#snapshot.prompts = this.#snapshot.prompts.filter(item => item.requestId !== requestId);
    pending.resolve(response.value);
    this.#emit();
  }

  cancel(): void {
    if (this.#terminal || this.#controller.signal.aborted) return;
    this.#snapshot.cancellationRequested = true;
    this.#snapshot.status = "cancelling";
    this.#controller.abort(); this.#emit();
  }
}
