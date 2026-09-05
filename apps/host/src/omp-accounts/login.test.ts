import { describe, expect, test } from "bun:test";
import { NativeLogin } from "./login";
import type { LoginSnapshot } from "./types";

describe("native login callback bridge contracts (no provider calls)", () => {
  test("supports prompt-before-URL, manual callback cancellation, and one-use responses", async () => {
    const updates: LoginSnapshot[] = [];
    let login!: NativeLogin;
    const seen = Promise.withResolvers<void>();
    login = new NativeLogin("contract", async callbacks => {
      const input = await callbacks.onPrompt({ message: "Secret field", allowEmpty: false });
      expect(input).toBe("contract-secret-input");
      callbacks.onAuth({ url: "https://example.invalid/authorize?state=contract", instructions: "Device code ABCD" });
      const manualAbort = new AbortController();
      const manual = callbacks.onManualCodeInput!(manualAbort.signal);
      manualAbort.abort();
      await expect(manual).rejects.toThrow("cancelled");
      seen.resolve();
      return { type: "oauth", email: "contract@example.invalid" };
    }, state => {
      updates.push(state);
      const prompt = state.prompts.find(prompt => prompt.kind === "prompt");
      if (prompt) {
        expect(prompt.sensitive).toBe(true);
        expect(() => login.respond(prompt.requestId, { value: "" })).toThrow("requires a value");
        login.respond(prompt.requestId, { value: "contract-secret-input" });
        expect(() => login.respond(prompt.requestId, { value: "duplicate" })).toThrow("no longer pending");
      }
    });
    await seen.promise;
    expect((await login.completion).status).toBe("succeeded");
    expect(JSON.stringify(updates)).not.toContain("contract-secret-input");
    expect(updates.some(update => update.auth?.instructions === "Device code ABCD")).toBe(true);
    expect(login.snapshot().auth).toBeUndefined();
  });

  test("reports no credentials instead of a fabricated successful login", async () => {
    const login = new NativeLogin("contract", async () => undefined, () => {});
    expect((await login.completion).status).toBe("no_credentials");
  });

  test("cancellation races preserve a real returned storage receipt", async () => {
    const stored = Promise.withResolvers<{ type: "api_key" }>();
    const login = new NativeLogin("contract", async () => stored.promise, () => {});
    login.cancel();
    stored.resolve({ type: "api_key" });
    const result = await login.completion;
    expect(result.status).toBe("succeeded");
    expect(result.cancellationRequested).toBe(true);
  });

  test("native errors cannot echo entered or provider credential material", async () => {
    const login = new NativeLogin("contract", async () => { throw new Error("access=contract-private-access"); }, () => {});
    const result = await login.completion;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("native_auth_error");
    expect(JSON.stringify(result)).not.toContain("contract-private-access");
  });
});
