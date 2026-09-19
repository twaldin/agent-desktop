import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const packageRoot = process.env.PI_AI_EVIDENCE_PACKAGE ?? resolve(import.meta.dir, "../../node_modules/@oh-my-pi/pi-ai");
const { AuthStorage, SqliteAuthCredentialStore } = await import(`${packageRoot}/src/auth-storage.ts`);
const provider = "openai-codex";
const fixture = (expires = Date.now() + 3_600_000) => ({ type: "oauth" as const, access: "controlled-access", refresh: "controlled-refresh", expires, accountId: "account-a", email: "fixture@example.invalid", projectId: "project-a", orgId: "org-a" });
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function database() {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-ai-reset-evidence-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return resolve(directory, "credentials.db");
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("exact reset account evidence at consume", () => {
  test("exposes secret-free original-row proof at the final consume boundary", async () => {
    let posts = 0;
    const auth = await AuthStorage.create(await database(), {
      usageFetch: async () => { posts++; return Response.json({ code: "reset" }); },
    });
    cleanup.push(() => auth.close());
    await auth.set(provider, fixture());
    const [{ credentialId }] = auth.listOAuthAccounts(provider);
    const evidence = auth.getResetAccountEvidence(provider, credentialId);
    expect(evidence).toMatchObject({ version: 1, provider, credentialId, accountId: "account-a", email: "fixture@example.invalid", projectId: "project-a", orgId: "org-a" });
    expect(JSON.stringify(evidence)).not.toContain("controlled-access");
    expect(JSON.stringify(evidence)).not.toContain("controlled-refresh");
    expect(auth.getResetAccountEvidence("other-provider", credentialId)).toBeUndefined();
    let boundary = false;
    const result = await auth.redeemResetCredit({
      target: { credentialId }, creditId: "controlled-credit", expectedAccountEvidence: evidence,
      requireExplicitOutcome: true,
      beforeConsume: identity => { boundary = true; expect(identity.resetAccountEvidence).toEqual(evidence); return true; },
    });
    expect(result.code).toBe("reset");
    expect(boundary).toBe(true);
    expect(posts).toBe(1);
  });

  test("rejects a same-account relink while token refresh is awaiting", async () => {
    const file = await database(), entered = deferred(), release = deferred();
    let posts = 0, boundary = false;
    const auth = await AuthStorage.create(file, {
      usageFetch: async () => { posts++; return Response.json({ code: "reset" }); },
      refreshOAuthCredential: async () => { entered.resolve(); await release.promise; return { ...fixture(), access: "controlled-refreshed-access" }; },
    });
    cleanup.push(() => auth.close());
    await auth.set(provider, fixture(0));
    const [{ credentialId }] = auth.listOAuthAccounts(provider);
    const evidence = auth.getResetAccountEvidence(provider, credentialId);
    const pending = auth.redeemResetCredit({ target: { credentialId }, creditId: "controlled-credit", expectedAccountEvidence: evidence, beforeConsume: () => { boundary = true; return true; } });
    await entered.promise;
    const peer = await SqliteAuthCredentialStore.open(file);
    cleanup.push(() => peer.close());
    peer.upsertAuthCredentialForProvider(provider, { ...fixture(), access: "controlled-relinked-access" });
    release.resolve();
    expect((await pending).code).toBe("admission_rejected");
    expect(boundary).toBe(false);
    expect(posts).toBe(0);
  });

  test("ordinary token-only refresh preserves account evidence", async () => {
    let posts = 0;
    const auth = await AuthStorage.create(await database(), {
      usageFetch: async () => { posts++; return Response.json({ code: "reset" }); },
      refreshOAuthCredential: async () => ({ ...fixture(), access: "controlled-rotated-access", refresh: "controlled-rotated-refresh" }),
    });
    cleanup.push(() => auth.close());
    await auth.set(provider, fixture(0));
    const [{ credentialId }] = auth.listOAuthAccounts(provider);
    const evidence = auth.getResetAccountEvidence(provider, credentialId);
    const result = await auth.redeemResetCredit({ target: { credentialId }, creditId: "controlled-credit", expectedAccountEvidence: evidence, beforeConsume: identity => { expect(identity.resetAccountEvidence).toEqual(evidence); return true; } });
    expect(result.code).toBe("reset");
    expect(auth.getResetAccountEvidence(provider, credentialId)).toEqual(evidence);
    expect(posts).toBe(1);
  });

  test("rejects a synchronous relink inside an otherwise accepting admission callback", async () => {
    let posts = 0;
    const auth = await AuthStorage.create(await database(), {
      usageFetch: async () => { posts++; return Response.json({ code: "reset" }); },
    });
    cleanup.push(() => auth.close());
    await auth.set(provider, fixture());
    const [{ credentialId }] = auth.listOAuthAccounts(provider);
    const evidence = auth.getResetAccountEvidence(provider, credentialId);
    const result = await auth.redeemResetCredit({
      target: { credentialId }, creditId: "controlled-credit", expectedAccountEvidence: evidence,
      beforeConsume: () => {
        auth.upsertCredential(provider, { ...fixture(), access: "controlled-relinked-in-callback" });
        return true;
      },
    });
    expect(result.code).toBe("admission_rejected");
    expect(posts).toBe(0);
  });

  test("unsupported backend cannot provide proof but retains default redemption", async () => {
    const store = await SqliteAuthCredentialStore.open(await database());
    const unsupported = new Proxy(store, { get(target, key) { if (key === "getResetAccountEvidence") return undefined; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
    let posts = 0;
    const auth = new AuthStorage(unsupported, { usageFetch: async () => { posts++; return Response.json({ code: "reset" }); } });
    cleanup.push(() => auth.close());
    await auth.set(provider, fixture());
    const [{ credentialId }] = auth.listOAuthAccounts(provider);
    expect(auth.getResetAccountEvidence(provider, credentialId)).toBeUndefined();
    const backendEvidence = store.getResetAccountEvidence(provider, credentialId);
    if (!backendEvidence) throw new Error("controlled backend fixture needs evidence");
    const rejected = await auth.redeemResetCredit({
      target: { credentialId }, creditId: "controlled-credit", expectedAccountEvidence: backendEvidence,
    });
    expect(rejected.code).toBe("admission_rejected");
    expect(posts).toBe(0);
    const result = await auth.redeemResetCredit({ target: { credentialId }, creditId: "controlled-credit", beforeConsume: identity => { expect(identity.resetAccountEvidence).toBeUndefined(); return true; } });
    expect(result.code).toBe("reset");
    expect(posts).toBe(1);
  });
});
