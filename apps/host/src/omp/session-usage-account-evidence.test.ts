import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStorage, type AuthCredentialStore, type OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { sameResetAccountEvidence } from "@oh-my-pi/pi-ai/auth/reset-account-evidence";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { NativeSessionUsage } from "./session-usage";

const provider = "openai-codex";
const baseUrl = "https://chatgpt.com";
const roots: string[] = [];
const auths: AuthStorage[] = [];
afterEach(async () => {
  for (const auth of auths.splice(0)) auth.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const credential = (access = "controlled-access", expires = Date.now() + 86_400_000): OAuthCredential => ({
  type: "oauth", access, refresh: "controlled-refresh", expires,
  accountId: "account-a", email: "same@fixture.invalid", projectId: "project-a", orgId: "org-a",
});
const credits = () => ({ available_count: 1, credits: [{ id: "credit-a", status: "available", expires_at: "2099-01-01T00:00:00Z" }] });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function createAuth(fetch: typeof globalThis.fetch, options: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "session-usage-evidence-")); roots.push(root);
  const auth = await AuthStorage.create(path.join(root, "auth.db"), { usageFetch: fetch, ...options } as never); auths.push(auth);
  return auth;
}

function controlledFetch(control: { holdList?: boolean } = {}) {
  const entered = deferred(), release = deferred();
  const consumes: unknown[] = [];
  let holdList = control.holdList === true;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init); const url = new URL(request.url);
    if (url.origin !== baseUrl) throw new Error("Unexpected fixture origin");
    if (url.pathname.endsWith("/rate-limit-reset-credits")) {
      if (holdList) { holdList = false; entered.resolve(); await release.promise; }
      return Response.json(credits());
    }
    if (url.pathname.endsWith("/consume")) { consumes.push(JSON.parse(await request.text())); return Response.json({ code: "reset" }); }
    throw new Error(`Unexpected fixture path: ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { fetch, entered: entered.promise, release: release.resolve, holdNextList: () => { holdList = true; }, consumes };
}

function usage(auth: AuthStorage) {
  const modelRegistry = { authStorage: auth, getProviderBaseUrl: () => baseUrl };
  const session = {
    sessionId: "original-session",
    model: { provider: "fixture", id: "fixture" },
    modelRegistry,
    settings: { get: () => "production", getGroup: () => ({ autoRedeem: "unset", minBlockedMinutes: 60, keepCredits: 1, salvageHorizonHours: 12 }) },
    subscribe: () => () => {},
    listResetCredits: (signal?: AbortSignal) => modelRegistry.authStorage.listResetCredits({ baseUrlResolver: () => baseUrl, signal }),
  } as unknown as AgentSession;
  return { service: new NativeSessionUsage(session, () => {}, () => {}), modelRegistry };
}

function projectedUsage(rows: Awaited<ReturnType<AgentSession["listResetCredits"]>>) {
  const auth = {
    revalidateCredentials: async () => {},
    listOAuthAccounts: () => [],
    getResetAccountEvidence: () => undefined,
  };
  const session = {
    sessionId: "projection-session",
    model: { provider: "fixture", id: "fixture" },
    modelRegistry: { authStorage: auth, getProviderBaseUrl: () => baseUrl },
    settings: { get: () => "production", getGroup: () => ({ autoRedeem: "unset", minBlockedMinutes: 60, keepCredits: 1, salvageHorizonHours: 12 }) },
    subscribe: () => () => {},
    listResetCredits: async () => rows,
  } as unknown as AgentSession;
  return new NativeSessionUsage(session, () => {}, () => {});
}

async function readAccount(service: NativeSessionUsage) {
  const snapshot = await service.read("credits");
  if (!snapshot) throw new Error("Expected native usage snapshot");
  const account = snapshot.credits[0]; if (!account) throw new Error("Expected native credit account");
  return { snapshot, account, request: { sessionId: snapshot.sessionId, epoch: snapshot.epoch, revision: snapshot.revision, accountRef: account.accountRef } };
}

test("ticket keeps the original evidence through token-only refresh and native consume", async () => {
  const wire = controlledFetch();
  const auth = await createAuth(wire.fetch, { refreshOAuthCredential: async (_provider: string, _id: number, value: OAuthCredential) => ({ ...value, access: "controlled-refreshed", refresh: "controlled-refreshed-refresh", expires: Date.now() + 86_400_000 }) });
  await auth.set(provider, credential("controlled-expired", Date.now() - 1));
  const accountId = auth.listOAuthAccounts(provider)[0]!.credentialId;
  const originalEvidence = auth.getResetAccountEvidence(provider, accountId);
  const nativeRedeem = spyOn(auth, "redeemResetCredit");
  const { service } = usage(auth), { account, request } = await readAccount(service);
  expect(account.canPrepare).toBe(true);
  const prepared = await service.prepare(request);
  expect(await service.redeem(prepared.ticket, "stable-request")).toEqual({ state: "settled", outcome: "reset" });
  expect(sameResetAccountEvidence(nativeRedeem.mock.calls[0]![0].expectedAccountEvidence, originalEvidence)).toBe(true);
  expect(JSON.stringify(nativeRedeem.mock.calls[0]![0].expectedAccountEvidence)).not.toContain("controlled-");
  expect(wire.consumes).toEqual([{ credit_id: "credit-a", account_id: "account-a", redeem_request_id: "stable-request" }]);
  service.dispose();
});

test("credits expose exact native reset labels in native order while credential ids stay private", async () => {
  const wire = controlledFetch(); const auth = await createAuth(wire.fetch);
  await auth.set(provider, credential());
  const { service } = usage(auth); const snapshot = await service.read("credits");
  expect(snapshot?.resetCommandAccounts).toEqual([{ accountRef: snapshot!.credits[0]!.accountRef, label: "same@fixture.invalid", active: true,
    availableCount: 1, email: "same@fixture.invalid", accountId: "account-a" }]);
  expect(JSON.stringify(snapshot?.resetCommandAccounts)).not.toContain("credentialId");
  service.dispose();
});

test("credits retain native multi-account ordering and bind every command row to its source occurrence", async () => {
  const service = projectedUsage([
    { credentialId: 1, email: "z@fixture.invalid", availableCount: 5, active: false, credits: [] },
    { credentialId: 2, email: "b@fixture.invalid", availableCount: 1, active: true, credits: [] },
    { credentialId: 3, email: "a@fixture.invalid", availableCount: 1, active: true, credits: [] },
    { credentialId: 4, email: "c@fixture.invalid", availableCount: 9, active: false, credits: [] },
  ]);
  const snapshot = await service.read("credits");
  expect(snapshot?.resetCommandAccounts?.map(row => row.label)).toEqual([
    "a@fixture.invalid", "b@fixture.invalid", "c@fixture.invalid", "z@fixture.invalid",
  ]);
  for (const command of snapshot!.resetCommandAccounts!) {
    expect(snapshot!.credits.find(row => row.accountRef === command.accountRef)?.email).toBe(command.email);
    expect(snapshot!.credits.find(row => row.accountRef === command.accountRef)?.availableCount).toBe(command.availableCount);
  }
  service.dispose();
});

test("missing and duplicate credential ids remain visible with occurrence-exact opaque references", async () => {
  const service = projectedUsage([
    { email: "missing@fixture.invalid", availableCount: 3, active: false, credits: [] },
    { credentialId: 7, email: "first@fixture.invalid", availableCount: 2, active: false, credits: [] },
    { credentialId: 7, email: "second@fixture.invalid", availableCount: 1, active: true, credits: [] },
  ]);
  const snapshot = await service.read("credits");
  expect(snapshot?.resetCommandAccounts?.map(row => row.label)).toEqual([
    "second@fixture.invalid", "missing@fixture.invalid", "first@fixture.invalid",
  ]);
  expect(new Set(snapshot!.resetCommandAccounts!.map(row => row.accountRef)).size).toBe(3);
  for (const command of snapshot!.resetCommandAccounts!) {
    const source = snapshot!.credits.find(row => row.accountRef === command.accountRef);
    expect(source?.email).toBe(command.email);
    expect(source?.canPrepare).toBe(false);
  }
  service.dispose();
});

test("unsafe native matcher metadata rejects the whole command catalog without truncation", async () => {
  for (const email of ["x".repeat(4097), "bad\nemail@fixture.invalid"]) {
    const service = projectedUsage([{ credentialId: 1, email, availableCount: 1, active: false, credits: [] }]);
    await expect(service.read("credits")).rejects.toThrow(/Native reset (label|email) is invalid/);
    service.dispose();
  }
});

test("a metadata-identical relink held inside credits read is displayed but cannot be prepared", async () => {
  const wire = controlledFetch({ holdList: true }); const auth = await createAuth(wire.fetch); await auth.set(provider, credential());
  const { service } = usage(auth), reading = service.read("credits"); await wire.entered;
  auth.upsertCredential(provider, credential("controlled-relinked")); wire.release();
  const snapshot = await reading; expect(snapshot?.credits[0]?.canPrepare).toBe(false);
  const account = snapshot!.credits[0]!;
  await expect(service.prepare({ sessionId: snapshot!.sessionId, epoch: snapshot!.epoch, revision: snapshot!.revision, accountRef: account.accountRef })).rejects.toThrow("proof");
  expect(wire.consumes).toHaveLength(0); service.dispose();
});

test("held prepare rejects same-row credential-id ABA without consuming or recapturing", async () => {
  const wire = controlledFetch(); const auth = await createAuth(wire.fetch); await auth.set(provider, credential());
  const { service } = usage(auth), { request } = await readAccount(service);
  const credentialId = auth.listOAuthAccounts(provider)[0]!.credentialId;
  wire.holdNextList(); const pending = service.prepare(request); await wire.entered;
  expect(auth.upsertCredential(provider, credential("controlled-b"))[0]?.id).toBe(credentialId);
  expect(auth.upsertCredential(provider, credential("controlled-a-again"))[0]?.id).toBe(credentialId);
  wire.release(); await expect(pending).rejects.toThrow("proof");
  expect(wire.consumes).toHaveLength(0); service.dispose();
});

test("a ticket refuses a metadata-identical relink after confirmation and before redeem", async () => {
  const wire = controlledFetch(); const auth = await createAuth(wire.fetch); await auth.set(provider, credential());
  const { service } = usage(auth), { request } = await readAccount(service);
  const prepared = await service.prepare(request);
  auth.upsertCredential(provider, credential("controlled-relinked-after-confirmation"));
  expect(await service.redeem(prepared.ticket, "must-not-consume")).toEqual({ state: "rejected", outcome: "admission_rejected" });
  expect(wire.consumes).toHaveLength(0); service.dispose();
});

test("replacing the original AuthStorage with identical metadata rejects preparation", async () => {
  const wire = controlledFetch(); const original = await createAuth(wire.fetch); await original.set(provider, credential());
  const { service, modelRegistry } = usage(original), { request } = await readAccount(service);
  const replacement = await createAuth(wire.fetch); await replacement.set(provider, credential());
  modelRegistry.authStorage = replacement;
  await expect(service.prepare(request)).rejects.toThrow("authentication storage changed");
  expect(wire.consumes).toHaveLength(0); service.dispose();
});

test("an actual unsupported AuthStorage proof leaves the row non-preparable", async () => {
  const wire = controlledFetch();
  const root = await mkdtemp(path.join(tmpdir(), "session-usage-no-proof-")); roots.push(root);
  const store = await SqliteAuthCredentialStore.open(path.join(root, "auth.db"));
  const unsupported = new Proxy(store, { get(target, key) {
    if (key === "getResetAccountEvidence") return undefined;
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }) as AuthCredentialStore;
  const auth = new AuthStorage(unsupported, { usageFetch: wire.fetch }); auths.push(auth); await auth.reload(); await auth.set(provider, credential());
  const { service } = usage(auth), { account, request } = await readAccount(service);
  expect(account.canPrepare).toBe(false); await expect(service.prepare(request)).rejects.toThrow("proof");
  expect(wire.consumes).toHaveLength(0); service.dispose();
});
